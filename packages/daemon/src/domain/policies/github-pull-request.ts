// Issue #2793 — `github-pull-request` watchdog policy.
//
// Watches one pull request and wakes its target seat ONCE, when the thing the
// seat is waiting for happens:
//
//   until: checks-settled — the checks on one commit have all finished and
//     stayed finished for `settle_for`. The commit is `sha` when the spec pins
//     one; otherwise it's the pull request's current head, and a new push
//     resets the wait (settle window and no-checks clock) for the new head.
//   until: closed — the pull request was merged or closed without merging.
//
// A wake carries one summary word (all-passed, some-failed, no-checks, merged,
// closed-unmerged, gave-up, cannot-watch) and the raw check conclusions. The
// policy reports and never acts: it merges, re-runs and comments on nothing.
//
// Once-only rides on the engine's condition receipt: the send proposes a
// receipt, the engine banks it only when delivery succeeded, and the next scan
// sees it and ends the job. A failed delivery leaves no receipt, so the next
// scan sends again instead of going silent.
//
// GitHub failures never throw out of evaluate(). Timeouts, 5xx and rate limits
// skip until the next scan (the first failure in a run is recorded, the rest
// are quiet); 401/403/404 wake the seat once with `cannot-watch` and end.
//
// Not in this slice: watching the base branch's runs on the merge commit after
// a merge (`until: base-runs-settled`), and reading required checks from branch
// protection in place of `expect`. Both are follow-ups named in the issue.

import type {
  GithubCheck,
  GithubPullRequestReader,
  GithubPullSnapshot,
  GithubRead,
} from "../github-pull-request-client.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

export const GITHUB_PULL_REQUEST_POLICY = "github-pull-request";

/** The lowest scan cadence a job may use: a pull request is polled, not streamed. */
export const GITHUB_PULL_REQUEST_MIN_SCAN_SECONDS = 30;

export const GITHUB_PULL_REQUEST_DEFAULTS = {
  settleForSeconds: 120,
  noChecksAfterSeconds: 600,
  maxWaitSeconds: { "checks-settled": 2 * 3600, closed: 7 * 86400 } as const,
};

export type GithubPullRequestUntil = "checks-settled" | "closed";

export type GithubPullRequestVerdict =
  | "all-passed"
  | "some-failed"
  | "no-checks"
  | "merged"
  | "closed-unmerged"
  | "gave-up"
  | "cannot-watch";

export interface GithubPullRequestSpec {
  repo: string;
  pull: number;
  until: GithubPullRequestUntil;
  /** The pinned commit for checks-settled; null follows the pull request's head. */
  sha: string | null;
  expect: string[];
  settleForSeconds: number;
  noChecksAfterSeconds: number;
  maxWaitSeconds: number;
}

/** Check conclusions that count as passing for the summary word. The raw conclusions always ride along. */
const PASSING = new Set(["success", "neutral", "skipped"]);

const DURATION = /^(\d+)\s*(s|m|h|d)?$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function durationSeconds(raw: unknown, field: string): number | { problem: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const m = DURATION.exec(raw.trim());
    if (m) return Number(m[1]) * UNIT_SECONDS[m[2] ?? "s"]!;
  }
  return { problem: `${field} must be a whole number of seconds or a duration like 90s, 2m, 2h or 7d` };
}

/** Read and validate a job's spec. Accepts the fields at the top level of `context:`. */
export function parseGithubPullRequestSpec(context: Record<string, unknown>): GithubPullRequestSpec | { problem: string } {
  const repo = context["repo"];
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { problem: "context.repo must be '<owner>/<repo>'" };
  }
  const pull = context["pull"];
  if (typeof pull !== "number" || !Number.isInteger(pull) || pull <= 0) {
    return { problem: "context.pull must be a positive pull request number" };
  }
  const until = context["until"];
  if (until === "base-runs-settled") {
    return { problem: "context.until 'base-runs-settled' is not supported yet; use checks-settled or closed" };
  }
  if (until !== "checks-settled" && until !== "closed") {
    return { problem: "context.until must be 'checks-settled' or 'closed'" };
  }
  const sha = context["sha"];
  if (sha !== undefined && sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha))) {
    return { problem: "context.sha must be a commit SHA" };
  }
  if (until === "closed" && sha) return { problem: "context.sha applies only to until: checks-settled" };
  const expect = context["expect"];
  if (expect !== undefined && expect !== null &&
    (!Array.isArray(expect) || expect.some((e) => typeof e !== "string" || e.length === 0))) {
    return { problem: "context.expect must be a list of check names" };
  }
  const settle = durationSeconds(context["settle_for"], "context.settle_for");
  const noChecks = durationSeconds(context["no_checks_after"], "context.no_checks_after");
  const maxWait = durationSeconds(context["max_wait"], "context.max_wait");
  for (const d of [settle, noChecks, maxWait]) if (d && typeof d === "object") return d;
  return {
    repo,
    pull,
    until,
    sha: typeof sha === "string" ? sha.toLowerCase() : null,
    expect: Array.isArray(expect) ? [...(expect as string[])] : [],
    settleForSeconds: (settle as number | null) ?? GITHUB_PULL_REQUEST_DEFAULTS.settleForSeconds,
    noChecksAfterSeconds: (noChecks as number | null) ?? GITHUB_PULL_REQUEST_DEFAULTS.noChecksAfterSeconds,
    maxWaitSeconds: (maxWait as number | null) ?? GITHUB_PULL_REQUEST_DEFAULTS.maxWaitSeconds[until],
  };
}

/** Registration-time check: a valid spec, a cadence no faster than the floor, and a token to read with. */
export function githubPullRequestRegistrationProblem(input: {
  context: Record<string, unknown>;
  intervalSeconds: number;
  scanIntervalSeconds?: number | null;
  hasToken: boolean;
}): string | null {
  const spec = parseGithubPullRequestSpec(input.context);
  if ("problem" in spec) return spec.problem;
  const cadence = input.scanIntervalSeconds ?? input.intervalSeconds;
  if (cadence < GITHUB_PULL_REQUEST_MIN_SCAN_SECONDS) {
    return `scan cadence must be at least ${GITHUB_PULL_REQUEST_MIN_SCAN_SECONDS}s (got ${cadence}s)`;
  }
  if (!input.hasToken) {
    return "no GitHub token for the daemon: set GITHUB_TOKEN (or OPENRIG_GITHUB_TOKEN) in the daemon's environment or its secrets env file; a fine-grained token with read-only pull requests, commit statuses and checks is enough";
  }
  return null;
}

export interface GithubPullRequestDeps {
  github: GithubPullRequestReader;
  now?: () => Date;
  /**
   * Whether queue rows were ever attached to this job with --wake-watchdog, and whether one still waits on it.
   * A job whose rows have all moved on ends quietly; a job registered without a row always reports.
   */
  attachment?: (jobId: string) => { ever: boolean; live: boolean };
}

/** What a job remembers between scans. In memory only: a daemon restart restarts the settle window, never shortens it. */
interface WatchMemory {
  sha: string | null;
  shaSeenAtMs: number;
  settledSinceMs: number | null;
  failing: boolean;
}

export function makeGithubPullRequestPolicy(deps: GithubPullRequestDeps): Policy {
  const now = deps.now ?? (() => new Date());
  // A reader that throws is a transient failure, never an exception out of the scheduler tick.
  const guarded = async <T>(read: () => Promise<GithubRead<T>>): Promise<GithubRead<T>> => {
    try {
      return await read();
    } catch (err) {
      return { ok: false, kind: "transient", status: null, detail: err instanceof Error ? err.message : String(err) };
    }
  };
  const github = {
    pull: (repo: string, pull: number) => guarded(() => deps.github.pull(repo, pull)),
    checks: (repo: string, sha: string) => guarded(() => deps.github.checks(repo, sha)),
  };
  const memory = new Map<string, WatchMemory>();

  function remember(jobId: string, registeredAtMs: number): WatchMemory {
    let m = memory.get(jobId);
    if (!m) {
      m = { sha: null, shaSeenAtMs: registeredAtMs, settledSinceMs: null, failing: false };
      memory.set(jobId, m);
    }
    return m;
  }

  function done(jobId: string, reason: string, notes?: Record<string, unknown>): PolicyEvaluation {
    memory.delete(jobId);
    return { action: "terminal", reason, ...(notes ? { notes } : {}) };
  }

  function failed(job: PolicyJob, spec: GithubPullRequestSpec, mem: WatchMemory, read: Extract<GithubRead<unknown>, { ok: false }>): PolicyEvaluation {
    if (read.kind === "fatal") {
      return wake(job, spec, "cannot-watch", `cannot-watch:${read.status ?? "none"}`, [`GitHub refused the read: ${read.detail}.`, "This watch has ended; register a new one once access is fixed."], { status: read.status });
    }
    const first = !mem.failing;
    mem.failing = true;
    return {
      action: "skip",
      reason: first ? "github_unavailable" : "github_unavailable_still",
      notes: { repo: spec.repo, pull: spec.pull, status: read.status, detail: read.detail },
    };
  }

  return {
    name: GITHUB_PULL_REQUEST_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const spec = parseGithubPullRequestSpec(job.context);
      if ("problem" in spec) return done(job.jobId, "spec_invalid", { problem: spec.problem });

      // The wake for this job already reached its seat: the job is finished.
      if (job.lastFiredCondition !== null) return done(job.jobId, "github_pr_reported", { condition: job.lastFiredCondition });

      // Every row that was waiting on this job has moved on: nobody is left to tell.
      const attached = deps.attachment?.(job.jobId);
      if (attached?.ever && !attached.live) return done(job.jobId, "github_pr_rows_moved_on");

      const nowMs = now().getTime();
      const registeredAtMs = Date.parse(job.registeredAt);
      const mem = remember(job.jobId, Number.isFinite(registeredAtMs) ? registeredAtMs : nowMs);
      if (Number.isFinite(registeredAtMs) && nowMs - registeredAtMs >= spec.maxWaitSeconds * 1000) {
        return wake(job, spec, "gave-up", "gave-up", [`Nothing to report after ${formatSeconds(spec.maxWaitSeconds)} (max_wait); this watch has ended.`]);
      }

      if (spec.until === "closed") {
        const pull = await github.pull(spec.repo, spec.pull);
        if (!pull.ok) return failed(job, spec, mem, pull);
        mem.failing = false;
        if (pull.value.state === "open") return { action: "skip", reason: "github_pr_open" };
        return pull.value.merged
          ? wake(job, spec, "merged", "merged", mergedLines(pull.value), { mergeCommitSha: pull.value.mergeCommitSha, mergedBy: pull.value.mergedBy, url: pull.value.url })
          : wake(job, spec, "closed-unmerged", "closed-unmerged", ["Closed without merging."], { url: pull.value.url });
      }

      // checks-settled: the pinned commit, or the pull request's current head.
      let sha = spec.sha;
      if (!sha) {
        const pull = await github.pull(spec.repo, spec.pull);
        if (!pull.ok) return failed(job, spec, mem, pull);
        sha = pull.value.headSha.toLowerCase();
      }
      if (mem.sha !== sha) {
        // A new head is a new wait: the old commit's checks say nothing about it.
        if (mem.sha !== null) mem.shaSeenAtMs = nowMs;
        mem.sha = sha;
        mem.settledSinceMs = null;
      }
      const read = await github.checks(spec.repo, sha);
      if (!read.ok) return failed(job, spec, mem, read);
      mem.failing = false;
      const { checks, truncated } = read.value;

      if (checks.length === 0) {
        if (nowMs - mem.shaSeenAtMs >= spec.noChecksAfterSeconds * 1000) {
          return wake(job, spec, "no-checks", `no-checks:${sha}`, [`No checks or statuses appeared on ${short(sha)} within ${formatSeconds(spec.noChecksAfterSeconds)} (no_checks_after).`], { sha });
        }
        return { action: "skip", reason: "github_checks_pending", notes: { sha, checks: 0 } };
      }
      const pending = checks.filter((c) => !c.completed).map((c) => c.name);
      const completedNames = new Set(checks.filter((c) => c.completed).map((c) => c.name));
      const missing = spec.expect.filter((name) => !completedNames.has(name));
      if (pending.length > 0 || missing.length > 0) {
        mem.settledSinceMs = null;
        return { action: "skip", reason: "github_checks_pending", notes: { sha, pending, missing } };
      }
      // Nothing pending is not yet "settled": a chained workflow may be about to add checks.
      mem.settledSinceMs ??= nowMs;
      if (nowMs - mem.settledSinceMs < spec.settleForSeconds * 1000) {
        return { action: "skip", reason: "github_checks_settling", notes: { sha } };
      }
      const failing = checks.filter((c) => !PASSING.has(c.conclusion ?? ""));
      const verdict: GithubPullRequestVerdict = failing.length === 0 ? "all-passed" : "some-failed";
      return wake(job, spec, verdict, `checks-settled:${sha}`, [
        `Checks settled on ${short(sha)}: ${checks.length - failing.length} passed, ${failing.length} did not.`,
        ...checks.map(checkLine),
        ...(truncated ? ["(GitHub returned only the first 100 check runs; the verdict covers those.)"] : []),
      ], { sha, checks: checks.map((c) => ({ name: c.name, kind: c.kind, conclusion: c.conclusion })) });
    },
  };
}

function wake(
  job: PolicyJob,
  spec: GithubPullRequestSpec,
  verdict: GithubPullRequestVerdict,
  receipt: string,
  lines: string[],
  notes: Record<string, unknown> = {},
): PolicyEvaluation {
  const message = [
    ...(job.message ? [job.message, ""] : []),
    `GitHub pull request ${spec.repo}#${spec.pull} (${spec.until}): ${verdict}.`,
    ...lines,
    `https://github.com/${spec.repo}/pull/${spec.pull}`,
    "This is a wake only: OpenRig merged, re-ran and changed nothing.",
  ].join("\n");
  return {
    action: "send",
    target: { session: job.target.session },
    message,
    conditionReceipt: receipt,
    notes: { repo: spec.repo, pull: spec.pull, until: spec.until, verdict, ...notes },
  };
}

function mergedLines(pull: GithubPullSnapshot): string[] {
  return [
    `Merged${pull.mergedBy ? ` by ${pull.mergedBy}` : ""}${pull.baseRef ? ` into ${pull.baseRef}` : ""}${pull.mergeCommitSha ? ` as ${short(pull.mergeCommitSha)}` : ""}.`,
  ];
}

function checkLine(c: GithubCheck): string {
  return `  ${c.name}: ${c.conclusion ?? "unknown"}`;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function formatSeconds(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}
