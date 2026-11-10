// Issue #2793 — github-pull-request watchdog policy. No test reaches the network:
// the policy gets a scripted reader, and the client gets a scripted fetch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { idleGateFiredConditionSchema } from "../src/db/migrations/078_idle_gate_fired_condition.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

import {
  makeGithubPullRequestPolicy,
  parseGithubPullRequestSpec,
} from "../src/domain/policies/github-pull-request.js";
import {
  makeFetchGithubReader,
  type GithubCheck,
  type GithubChecksSnapshot,
  type GithubPullRequestReader,
  type GithubPullSnapshot,
  type GithubRead,
} from "../src/domain/github-pull-request-client.js";

/** The full test schema plus the watchdog tables, as the other watchdog policy tests build it. */
function watchdogDb(): Database.Database {
  const db = createFullTestDb();
  migrate(db, [watchdogJobsSchema, watchdogHistorySchema, idleGateFiredConditionSchema]);
  return db;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function pullSnap(over: Partial<GithubPullSnapshot> = {}): GithubPullSnapshot {
  return { state: "open", merged: false, headSha: SHA_A, baseRef: "main", mergeCommitSha: null, mergedBy: null, url: null, ...over };
}
const done = (name: string, conclusion = "success"): GithubCheck => ({ name, kind: "check-run", completed: true, conclusion });
const running = (name: string): GithubCheck => ({ name, kind: "check-run", completed: false, conclusion: null });

/** A reader whose answers the test sets between scans, counting each call. */
class FakeGithub implements GithubPullRequestReader {
  pullRead: GithubRead<GithubPullSnapshot> = { ok: true, value: pullSnap() };
  checksBySha = new Map<string, GithubRead<GithubChecksSnapshot>>();
  calls = { pull: 0, checks: [] as string[] };
  throwOnce = false;
  async pull(): Promise<GithubRead<GithubPullSnapshot>> {
    this.calls.pull++;
    if (this.throwOnce) { this.throwOnce = false; throw new Error("socket hang up"); }
    return this.pullRead;
  }
  async checks(_repo: string, sha: string): Promise<GithubRead<GithubChecksSnapshot>> {
    this.calls.checks.push(sha);
    return this.checksBySha.get(sha) ?? { ok: true, value: { checks: [], truncated: false } };
  }
  setChecks(sha: string, checks: GithubCheck[]): void {
    this.checksBySha.set(sha, { ok: true, value: { checks, truncated: false } });
  }
}

const T0 = Date.parse("2026-11-10T12:00:00.000Z");

describe("github-pull-request policy through the watchdog engine", () => {
  let db: Database.Database;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let github: FakeGithub;
  let clock: number;
  let sent: Array<{ targetSession: string; message: string }>;
  let deliveryStatus: "ok" | "failed";
  let engine: WatchdogPolicyEngine;

  beforeEach(() => {
    db = watchdogDb();
    clock = T0;
    jobsRepo = new WatchdogJobsRepository(db, () => new Date(clock));
    log = new WatchdogHistoryLog(db);
    github = new FakeGithub();
    sent = [];
    deliveryStatus = "ok";
    const deliver: DeliveryFn = async (req) => {
      sent.push({ targetSession: req.targetSession, message: req.message });
      return { status: deliveryStatus };
    };
    engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: new EventBus(db),
      deliver,
      now: () => new Date(clock),
      additionalPolicies: [makeGithubPullRequestPolicy({ github, now: () => new Date(clock) })],
    });
  });

  afterEach(() => db.close());

  function register(context: Record<string, unknown>) {
    const lines = Object.entries(context).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
    return jobsRepo.register({
      policy: "github-pull-request",
      specYaml: ["target:", "  session: dev@rig", "context:", ...lines, ""].join("\n"),
      targetSession: "dev@rig",
      intervalSeconds: 60,
      registeredBySession: "dev@rig",
    });
  }
  const scan = async (jobId: string) => engine.evaluate(jobsRepo.getByIdOrThrow(jobId));
  const advance = (seconds: number) => { clock += seconds * 1000; };
  const loudRows = (jobId: string) => log.listForJob(jobId, 100);

  it("checks-settled: waits for settle_for, wakes once with the pass/fail summary, then ends", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "checks-settled", settle_for: "2m" });
    github.setChecks(SHA_A, [running("test"), done("lint")]);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_pending" });

    advance(60);
    github.setChecks(SHA_A, [done("test", "failure"), done("lint")]);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_settling" });
    advance(60);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_settling" });
    expect(sent).toHaveLength(0);

    advance(60);
    const fired = await scan(job.jobId);
    expect(fired.outcome).toMatchObject({ action: "send", conditionReceipt: `checks-settled:${SHA_A}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.targetSession).toBe("dev@rig");
    expect(sent[0]!.message).toContain("acme/app#7 (checks-settled): some-failed.");
    expect(sent[0]!.message).toContain("1 passed, 1 did not");
    expect(sent[0]!.message).toContain("test: failure");

    // One wake per condition: the next scan ends the job instead of sending again.
    advance(60);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "terminal", reason: "github_pr_reported" });
    expect(jobsRepo.getByIdOrThrow(job.jobId).state).toBe("terminal");
    expect(sent).toHaveLength(1);
  });

  it("a new head SHA resets the wait: the old head's settled checks never fire, the new head starts over", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "checks-settled", settle_for: "2m", no_checks_after: "10m" });
    github.setChecks(SHA_A, [done("test")]);
    await scan(job.jobId); // A settled, window opens
    advance(90);
    // Push: head moves to B before A's window closes.
    github.pullRead = { ok: true, value: pullSnap({ headSha: SHA_B }) };
    github.setChecks(SHA_B, []);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_pending" });
    advance(60);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_pending" });
    expect(sent).toHaveLength(0);
    expect(github.calls.checks.at(-1)).toBe(SHA_B);

    // B's checks finish; its own settle window starts from now, not from A's.
    github.setChecks(SHA_B, [done("test")]);
    advance(30);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_settling" });
    advance(119);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_settling" });
    advance(1);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "send", conditionReceipt: `checks-settled:${SHA_B}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain(`Checks settled on ${SHA_B.slice(0, 7)}`);
    expect(sent[0]!.message).toContain("all-passed");
  });

  it("a new head also restarts the no-checks clock", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "checks-settled", no_checks_after: "5m" });
    await scan(job.jobId);
    advance(240);
    github.pullRead = { ok: true, value: pullSnap({ headSha: SHA_B }) };
    await scan(job.jobId);
    advance(120); // 6m after registration, 2m after the push
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_pending" });
    advance(180);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "send", conditionReceipt: `no-checks:${SHA_B}` });
    expect(sent[0]!.message).toContain("no-checks");
  });

  it("a pinned sha ignores the head and waits for every expected check", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "checks-settled", sha: SHA_A, expect: ["test", "lint"], settle_for: 0 });
    github.setChecks(SHA_A, [done("test")]);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_checks_pending", notes: { missing: ["lint"] } });
    github.setChecks(SHA_A, [done("test"), done("lint", "neutral")]);
    advance(60);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "send", notes: { verdict: "all-passed" } });
    expect(github.calls.pull).toBe(0);
  });

  it("closed: merged and closed-unmerged are different wakes", async () => {
    const merged = register({ repo: "acme/app", pull: 7, until: "closed" });
    expect((await scan(merged.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_pr_open" });
    github.pullRead = { ok: true, value: pullSnap({ state: "closed", merged: true, mergeCommitSha: SHA_B, mergedBy: "octocat" }) };
    advance(300);
    expect((await scan(merged.jobId)).outcome).toMatchObject({ action: "send", conditionReceipt: "merged", notes: { verdict: "merged", mergeCommitSha: SHA_B } });
    expect(sent[0]!.message).toContain(`Merged by octocat into main as ${SHA_B.slice(0, 7)}.`);

    const closed = register({ repo: "acme/app", pull: 8, until: "closed" });
    github.pullRead = { ok: true, value: pullSnap({ state: "closed", merged: false }) };
    expect((await scan(closed.jobId)).outcome).toMatchObject({ action: "send", conditionReceipt: "closed-unmerged", notes: { verdict: "closed-unmerged" } });
    expect(sent[1]!.message).toContain("closed-unmerged");
    expect(sent[1]!.message).not.toContain("Merged");
  });

  it("a failed delivery banks no receipt, so the next scan sends again instead of going silent", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "closed" });
    github.pullRead = { ok: true, value: pullSnap({ state: "closed", merged: true }) };
    deliveryStatus = "failed";
    await scan(job.jobId);
    expect(jobsRepo.getByIdOrThrow(job.jobId).lastFiredCondition).toBeNull();
    deliveryStatus = "ok";
    advance(300);
    await scan(job.jobId);
    expect(sent).toHaveLength(2);
    advance(300);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "terminal" });
    expect(sent).toHaveLength(2);
  });

  it("transient GitHub failures neither crash nor spam: one loud row, then quiet, then recovery", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "closed" });
    github.pullRead = { ok: false, kind: "transient", status: 502, detail: "GitHub answered 502" };
    for (let i = 0; i < 5; i++) {
      advance(300);
      const r = await scan(job.jobId);
      expect(r.outcome.action).toBe("skip");
    }
    github.throwOnce = true; // a reader that throws is a transient failure too
    advance(300);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_unavailable_still" });
    const rows = loudRows(job.jobId);
    expect(rows.filter((r) => r.skipReason === "github_unavailable")).toHaveLength(1);
    expect(rows.filter((r) => r.skipReason === "github_unavailable_still")).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(jobsRepo.getByIdOrThrow(job.jobId).state).toBe("active");

    github.pullRead = { ok: true, value: pullSnap() };
    advance(300);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "skip", reason: "github_pr_open" });
    // A later outage is a new run: recorded once again.
    github.pullRead = { ok: false, kind: "transient", status: null, detail: "timeout" };
    advance(300);
    await scan(job.jobId);
    expect(loudRows(job.jobId).filter((r) => r.skipReason === "github_unavailable")).toHaveLength(2);
  });

  it("401/403/404 wakes once with cannot-watch and ends the job", async () => {
    const job = register({ repo: "acme/private", pull: 7, until: "closed" });
    github.pullRead = { ok: false, kind: "fatal", status: 404, detail: "GitHub answered 404" };
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "send", notes: { verdict: "cannot-watch", status: 404 } });
    advance(300);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "terminal" });
    advance(300);
    await scan(job.jobId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("cannot-watch");
  });

  it("max_wait ends a watch nobody resolves with one gave-up wake", async () => {
    const job = register({ repo: "acme/app", pull: 7, until: "closed", max_wait: "1h" });
    await scan(job.jobId);
    advance(3600);
    expect((await scan(job.jobId)).outcome).toMatchObject({ action: "send", conditionReceipt: "gave-up" });
    expect(github.calls.pull).toBe(1);
  });

  it("ends quietly once every row that waited on it has moved on; a job with no row still fires", async () => {
    let attachment = { ever: true, live: true };
    const policy = makeGithubPullRequestPolicy({ github, now: () => new Date(clock), attachment: () => attachment });
    const base = {
      jobId: "j1", policy: "github-pull-request", target: { session: "dev@rig" }, intervalSeconds: 60,
      activeWakeIntervalSeconds: null, scanIntervalSeconds: null, lastEvaluationAt: null, lastFireAt: null,
      registeredBySession: "dev@rig", registeredAt: new Date(T0).toISOString(), watchedFilePath: null,
      thresholdBytes: null, thresholdTokens: null, thresholdPercent: null, contextUsageSample: null,
      requiresJobId: null, lastFiredGeneration: null, lastFiredCondition: null, occupantGeneration: null,
      currentGenerationTranscriptPending: false, requiredReceiptSatisfied: true, requiredReceiptDeferred: false,
      context: { repo: "acme/app", pull: 7, until: "closed" },
    };
    github.pullRead = { ok: true, value: pullSnap({ state: "closed", merged: true }) };
    expect((await policy.evaluate(base)).action).toBe("send");
    attachment = { ever: true, live: false };
    expect(await policy.evaluate(base)).toMatchObject({ action: "terminal", reason: "github_pr_rows_moved_on" });
    attachment = { ever: false, live: false };
    expect((await policy.evaluate(base)).action).toBe("send");
  });
});

describe("github-pull-request with a parked queue row (rig queue block --wake-watchdog)", () => {
  let db: Database.Database;
  let jobs: WatchdogJobsRepository;
  let queue: QueueRepository;
  let github: FakeGithub;
  let sent: string[];
  let engine: WatchdogPolicyEngine;

  beforeEach(() => {
    db = watchdogDb();
    const bus = new EventBus(db);
    jobs = new WatchdogJobsRepository(db);
    queue = new QueueRepository(db, bus);
    github = new FakeGithub();
    sent = [];
    engine = new WatchdogPolicyEngine({
      jobsRepo: jobs,
      historyLog: new WatchdogHistoryLog(db),
      eventBus: bus,
      deliver: async (req) => { sent.push(req.targetSession); return { status: "ok" }; },
      resolveQueueWait: (input) => queue.evaluateWaitReminder(input),
      onWakeAttempt: ({ jobId, deliveryStatus }) => queue.recordWatchdogWakeAttempt(jobId, deliveryStatus),
      additionalPolicies: [makeGithubPullRequestPolicy({ github, attachment: (id) => queue.watchdogAttachment(id) })],
    });
  });

  afterEach(() => db.close());

  async function parkedOn() {
    const job = jobs.register({
      policy: "github-pull-request",
      specYaml: "target:\n  session: dev@rig\ncontext:\n  repo: acme/app\n  pull: 7\n  until: closed\n",
      targetSession: "dev@rig", intervalSeconds: 300, registeredBySession: "dev@rig",
    });
    const row = await queue.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "ship it", nudge: false });
    queue.update({
      qitemId: row.qitemId, actorSession: "dev@rig", state: "blocked", blockedOn: "external:merge",
      transitionNote: "continuation: close the slice once merged", wakeWatchdogId: job.jobId,
    } as never);
    return { job, row };
  }

  it("wakes the parked row's seat on merge", async () => {
    const { job } = await parkedOn();
    expect(queue.watchdogAttachment(job.jobId)).toEqual({ ever: true, live: true });
    expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome).toMatchObject({ action: "skip", reason: "github_pr_open" });
    github.pullRead = { ok: true, value: pullSnap({ state: "closed", merged: true }) };
    expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome).toMatchObject({ action: "send", notes: { verdict: "merged" } });
    expect(sent).toEqual(["dev@rig"]);
  });

  it("ends quietly when the row moved on before anything happened", async () => {
    const { job, row } = await parkedOn();
    queue.update({ qitemId: row.qitemId, actorSession: "dev@rig", state: "in-progress", transitionNote: "picked it back up" } as never);
    expect(queue.watchdogAttachment(job.jobId)).toEqual({ ever: true, live: false });
    github.pullRead = { ok: true, value: pullSnap({ state: "closed", merged: true }) };
    expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome).toMatchObject({ action: "terminal", reason: "github_pr_rows_moved_on" });
    expect(sent).toEqual([]);
  });
});

describe("github-pull-request spec", () => {
  it("applies the issue's defaults and reads durations", () => {
    expect(parseGithubPullRequestSpec({ repo: "a/b", pull: 1, until: "checks-settled" })).toMatchObject({
      sha: null, expect: [], settleForSeconds: 120, noChecksAfterSeconds: 600, maxWaitSeconds: 7200,
    });
    expect(parseGithubPullRequestSpec({ repo: "a/b", pull: 1, until: "closed", max_wait: "3d" })).toMatchObject({ maxWaitSeconds: 259200 });
  });

  it.each([
    [{ pull: 1, until: "closed" }, "repo"],
    [{ repo: "a/b", pull: 0, until: "closed" }, "pull"],
    [{ repo: "a/b", pull: 1, until: "merged" }, "until"],
    [{ repo: "a/b", pull: 1, until: "base-runs-settled" }, "not supported yet"],
    [{ repo: "a/b", pull: 1, until: "closed", sha: SHA_A }, "only to until: checks-settled"],
    [{ repo: "a/b", pull: 1, until: "checks-settled", settle_for: "soon" }, "settle_for"],
  ])("refuses %j", (context, fragment) => {
    const parsed = parseGithubPullRequestSpec(context);
    expect("problem" in parsed && parsed.problem).toContain(fragment);
  });
});

describe("github-pull-request registration", () => {
  const saved = { ...process.env };
  let home: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gh-pr-watch-"));
    process.env.OPENRIG_HOME = home; // no secrets file of the host's is read
    delete process.env.GITHUB_TOKEN;
    delete process.env.OPENRIG_GITHUB_TOKEN;
    db = watchdogDb();
    const bus = new EventBus(db);
    const jobsRepo = new WatchdogJobsRepository(db);
    const historyLog = new WatchdogHistoryLog(db);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("watchdogJobsRepo" as never, jobsRepo);
      c.set("watchdogHistoryLog" as never, historyLog);
      await next();
    });
    app.route("/api/watchdog", watchdogRoutes());
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    process.env = { ...saved };
  });

  const register = (over: Record<string, unknown> = {}) => app.request("/api/watchdog/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      policy: "github-pull-request",
      specYaml: "context:\n  repo: acme/app\n  pull: 7\n  until: closed\n",
      targetSession: "dev@rig",
      intervalSeconds: 300,
      registeredBySession: "dev@rig",
      ...over,
    }),
  });

  it("fails with a clear error when the daemon has no GitHub token", async () => {
    const res = await register();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("GITHUB_TOKEN");
  });

  it("refuses a scan cadence under 30s and an invalid spec", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    expect((await register({ scanIntervalSeconds: 10 })).status).toBe(400);
    expect((await register({ specYaml: "context:\n  repo: acme/app\n  until: closed\n" })).status).toBe(400);
  });

  it("registers with a token", async () => {
    process.env.OPENRIG_GITHUB_TOKEN = "test-token";
    const res = await register({ scanIntervalSeconds: 60 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { policy: string }).policy).toBe("github-pull-request");
  });
});

describe("fetch GitHub reader", () => {
  type Call = { url: string; headers: Record<string, string> };
  function scripted(responses: Array<Response | Error>) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      const next = responses.shift();
      if (!next) throw new Error("unscripted request");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const pullBody = { state: "open", merged: false, head: { sha: SHA_A }, base: { ref: "main" }, html_url: "u" };

  it("sends the token, then revalidates with If-None-Match and serves a 304 from cache", async () => {
    const { calls, fetchImpl } = scripted([json(pullBody, 200, { etag: '"v1"' }), new Response(null, { status: 304 })]);
    const reader = makeFetchGithubReader({ token: () => "t", fetchImpl });
    expect(await reader.pull("acme/app", 7)).toMatchObject({ ok: true, value: { headSha: SHA_A, state: "open" } });
    expect(await reader.pull("acme/app", 7)).toMatchObject({ ok: true, value: { headSha: SHA_A } });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/app/pulls/7");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer t");
    expect(calls[0]!.headers["If-None-Match"]).toBeUndefined();
    expect(calls[1]!.headers["If-None-Match"]).toBe('"v1"');
  });

  it("classifies failures: network/5xx/rate limit are transient, 401/403/404 and no token are fatal", async () => {
    const { fetchImpl } = scripted([
      new Error("The operation was aborted due to timeout"),
      json({}, 503),
      json({}, 403, { "x-ratelimit-remaining": "0" }),
      json({}, 429),
      json({}, 404),
      json({}, 401),
      json({}, 403, { "x-ratelimit-remaining": "4000" }),
    ]);
    const reader = makeFetchGithubReader({ token: () => "t", fetchImpl });
    const kinds = [];
    for (let i = 0; i < 7; i++) {
      const r = await reader.pull("acme/app", 7);
      kinds.push(r.ok ? "ok" : r.kind);
    }
    expect(kinds).toEqual(["transient", "transient", "transient", "transient", "fatal", "fatal", "fatal"]);
    const noToken = makeFetchGithubReader({ token: () => null, fetchImpl });
    expect(await noToken.pull("acme/app", 7)).toMatchObject({ ok: false, kind: "fatal" });
  });

  it("joins check runs and commit statuses on one commit", async () => {
    const { calls, fetchImpl } = scripted([
      json({ total_count: 2, check_runs: [
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "lint", status: "in_progress", conclusion: null },
      ] }),
      json({ state: "pending", statuses: [{ context: "deploy/preview", state: "success" }] }),
    ]);
    const reader = makeFetchGithubReader({ token: () => "t", fetchImpl });
    const read = await reader.checks("acme/app", SHA_A);
    expect(read).toEqual({ ok: true, value: { truncated: false, checks: [
      { name: "test", kind: "check-run", completed: true, conclusion: "failure" },
      { name: "lint", kind: "check-run", completed: false, conclusion: null },
      { name: "deploy/preview", kind: "status", completed: true, conclusion: "success" },
    ] } });
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.github.com/repos/acme/app/commits/${SHA_A}/check-runs?per_page=100`,
      `https://api.github.com/repos/acme/app/commits/${SHA_A}/status?per_page=100`,
    ]);
  });
});
