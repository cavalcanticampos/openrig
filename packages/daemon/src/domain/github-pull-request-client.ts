// Issue #2793 — the read-only GitHub client behind the `github-pull-request`
// watchdog policy.
//
// It reads exactly two things: a pull request, and the check runs plus commit
// statuses on one commit. Every request is conditional (If-None-Match against
// an in-memory ETag cache), so a scan of a pull request that hasn't changed is
// a 304, which GitHub doesn't count against an authenticated rate limit. Each
// call times out after 10s so a slow GitHub can't hold up the other watchdogs
// in a scheduler tick.
//
// The policy never sees HTTP: it gets typed results, and a failure is either
// `transient` (retry on the next scan) or `fatal` (the watch can't go on).
// Tests inject their own reader, so no test reaches the network.

import { loadConfig as loadSlackConfig } from "./gateway/slack/config.js";
import { resolveSecret } from "./gateway/slack/secrets.js";

/** How long one GitHub request may take before it counts as a transient failure. */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

export interface GithubPullSnapshot {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseRef: string | null;
  mergeCommitSha: string | null;
  mergedBy: string | null;
  url: string | null;
}

export interface GithubCheck {
  /** A check run's name, or a commit status's context. */
  name: string;
  kind: "check-run" | "status";
  /** True once the check has an outcome. */
  completed: boolean;
  /** The raw outcome as GitHub reports it (check run conclusion, or status state). Null while running. */
  conclusion: string | null;
}

export interface GithubChecksSnapshot {
  checks: GithubCheck[];
  /** True when GitHub reported more check runs than one page returned; the verdict then covers only the first page. */
  truncated: boolean;
}

export type GithubRead<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "transient" | "fatal"; status: number | null; detail: string };

export interface GithubPullRequestReader {
  pull(repo: string, pull: number): Promise<GithubRead<GithubPullSnapshot>>;
  checks(repo: string, sha: string): Promise<GithubRead<GithubChecksSnapshot>>;
}

export interface FetchGithubReaderOptions {
  /** Resolved at call time, so a token added after the daemon started is picked up. Null = no token. */
  token: () => string | null;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

interface CachedBody {
  etag: string;
  body: unknown;
}

/** A reader over the GitHub REST API using the daemon's own token (never the host's `gh` login). */
export function makeFetchGithubReader(opts: FetchGithubReaderOptions): GithubPullRequestReader {
  const base = (opts.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const cache = new Map<string, CachedBody>();

  async function getJson(path: string): Promise<GithubRead<unknown>> {
    const token = opts.token();
    if (!token) {
      return { ok: false, kind: "fatal", status: null, detail: "no GitHub token: set GITHUB_TOKEN or OPENRIG_GITHUB_TOKEN" };
    }
    const url = `${base}${path}`;
    const cached = cache.get(url);
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "openrig-daemon",
          ...(cached ? { "If-None-Match": cached.etag } : {}),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeouts, DNS and connection failures: try again next scan.
      return { ok: false, kind: "transient", status: null, detail: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 304 && cached) {
      void res.body?.cancel().catch(() => {});
      return { ok: true, value: cached.body };
    }
    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, kind: "transient", status: res.status, detail: "GitHub returned a body that isn't JSON" };
      }
      const etag = res.headers.get("etag");
      if (etag) cache.set(url, { etag, body });
      return { ok: true, value: body };
    }
    void res.body?.cancel().catch(() => {});
    // A rate limit is a wait, not a refusal: GitHub answers 403 or 429 with no remaining quota.
    const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
    if (rateLimited || res.status >= 500) {
      return { ok: false, kind: "transient", status: res.status, detail: rateLimited ? "rate limited" : `GitHub answered ${res.status}` };
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { ok: false, kind: "fatal", status: res.status, detail: `GitHub answered ${res.status}` };
    }
    return { ok: false, kind: "transient", status: res.status, detail: `GitHub answered ${res.status}` };
  }

  return {
    async pull(repo, pull) {
      const read = await getJson(`/repos/${repo}/pulls/${pull}`);
      if (!read.ok) return read;
      const parsed = parsePull(read.value);
      return parsed
        ? { ok: true, value: parsed }
        : { ok: false, kind: "transient", status: null, detail: "GitHub returned a pull request without a head commit" };
    },
    async checks(repo, sha) {
      const runs = await getJson(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
      if (!runs.ok) return runs;
      const statuses = await getJson(`/repos/${repo}/commits/${sha}/status?per_page=100`);
      if (!statuses.ok) return statuses;
      return { ok: true, value: parseChecks(runs.value, statuses.value) };
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parsePull(body: unknown): GithubPullSnapshot | null {
  if (!isRecord(body)) return null;
  const head = isRecord(body["head"]) ? body["head"] : null;
  const headSha = head ? str(head["sha"]) : null;
  if (!headSha) return null;
  const base = isRecord(body["base"]) ? body["base"] : null;
  const mergedBy = isRecord(body["merged_by"]) ? str(body["merged_by"]["login"]) : null;
  const merged = body["merged"] === true || str(body["merged_at"]) !== null;
  return {
    state: body["state"] === "closed" ? "closed" : "open",
    merged,
    headSha,
    baseRef: base ? str(base["ref"]) : null,
    mergeCommitSha: merged ? str(body["merge_commit_sha"]) : null,
    mergedBy,
    url: str(body["html_url"]),
  };
}

export function parseChecks(runsBody: unknown, statusBody: unknown): GithubChecksSnapshot {
  const checks: GithubCheck[] = [];
  let truncated = false;
  if (isRecord(runsBody) && Array.isArray(runsBody["check_runs"])) {
    const runs = runsBody["check_runs"] as unknown[];
    const total = typeof runsBody["total_count"] === "number" ? runsBody["total_count"] : runs.length;
    truncated = total > runs.length;
    for (const run of runs) {
      if (!isRecord(run)) continue;
      const name = str(run["name"]);
      if (!name) continue;
      const completed = run["status"] === "completed";
      checks.push({ name, kind: "check-run", completed, conclusion: completed ? str(run["conclusion"]) ?? "unknown" : null });
    }
  }
  if (isRecord(statusBody) && Array.isArray(statusBody["statuses"])) {
    for (const status of statusBody["statuses"] as unknown[]) {
      if (!isRecord(status)) continue;
      const name = str(status["context"]);
      const state = str(status["state"]);
      if (!name || !state) continue;
      const completed = state !== "pending";
      checks.push({ name, kind: "status", completed, conclusion: completed ? state : null });
    }
  }
  return { checks, truncated };
}

/**
 * The daemon's GitHub token: GITHUB_TOKEN, then OPENRIG_GITHUB_TOKEN, then the same 0600 secrets env file the Slack
 * gateway reads. Null when none is set. Never logged.
 */
export function resolveDaemonGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  let envFile: string | undefined;
  try {
    envFile = loadSlackConfig().secretsEnvFile ?? undefined;
  } catch {
    envFile = undefined;
  }
  return resolveSecret("GITHUB_TOKEN", { env, ...(envFile ? { envFile } : {}) });
}
