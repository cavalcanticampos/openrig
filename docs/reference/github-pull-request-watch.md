# Waking a Seat on a Pull Request

The `github-pull-request` watchdog policy watches one GitHub pull request and wakes its target seat once, when the
thing the seat is waiting for happens. It replaces guessing a `--wake-after` timer for two waits:

- **`until: checks-settled`**: the checks on a commit have finished. The seat then reports the work ready, or fixes
  what failed.
- **`until: closed`**: the pull request was merged, or closed without merging. The seat then closes its row.

The policy only reads and wakes. It never merges, re-runs or comments.

## Setting one

The daemon reads GitHub with its own token, never the host's `gh` login. Set `GITHUB_TOKEN` (or
`OPENRIG_GITHUB_TOKEN`) in the daemon's environment, or in the secrets env file the Slack gateway uses. A fine-grained
token with read-only access to pull requests, commit statuses and checks on the repositories the rig works on is
enough. Without a token, registration fails.

```yaml
# pr-checks.yaml
target:
  session: dev@my-rig
context:
  repo: acme/app
  pull: 123
  until: checks-settled
  expect: [test, lint]   # optional
```

```sh
rig watchdog register --policy github-pull-request --spec pr-checks.yaml \
  --target-session dev@my-rig --registered-by dev@my-rig --interval-seconds 60
rig queue block <row> --on external:ci --continuation "report ready or fix" --wake-watchdog <job id>
```

For the merge, use `until: closed` and a slower cadence, such as `--interval-seconds 300`.

| Field | Default | Meaning |
|---|---|---|
| `repo` | required | `<owner>/<repo>` |
| `pull` | required | Pull request number |
| `until` | required | `checks-settled` or `closed` |
| `sha` | the pull request's head | `checks-settled` only. Pin one commit. Without it the job follows the head, and a new push restarts the wait for the new head. |
| `expect` | none | Check names that must each appear and finish before the checks count as settled |
| `settle_for` | `2m` | How long the commit must have at least one check and none running before the wake |
| `no_checks_after` | `10m` | Wake with `no-checks` if no check or status appears on the commit in this time |
| `max_wait` | `2h` for checks, `7d` for closed | Wake with `gave-up` and end |

Durations are seconds, or a number with `s`, `m`, `h` or `d`. The scan cadence can't be faster than 30 seconds.

## What the wake says

One summary word, then the detail:

- `all-passed` or `some-failed`, with each check's raw conclusion. `success`, `neutral` and `skipped` count as passed;
  the seat decides what a `cancelled` or `neutral` check means for its work.
- `no-checks`: nothing appeared on the commit within `no_checks_after`.
- `merged`, with who merged it, into which branch and the merge commit; or `closed-unmerged`.
- `gave-up`: `max_wait` passed.
- `cannot-watch`: GitHub answered 401, 403 or 404. Fix the token or the repository name and register a new job.

## Lifecycle

- The job wakes once. After the wake is delivered, the next scan ends it. A delivery that fails is retried on the
  next scan.
- If rows were parked on the job with `--wake-watchdog` and all of them have moved on, the job ends without a wake.
  A job registered without a row still wakes.
- A timeout, a 5xx or a rate limit is retried on the next scan. The first failure in a run is recorded in the job's
  history; repeats are not.
- Every request is conditional, so an unchanged pull request costs a `304`, which GitHub doesn't count against the
  token's rate limit. The settle window is kept in memory: a daemon restart restarts it, which can delay a wake but
  never brings it forward.

## Not yet

- Watching the base branch's runs on the merge commit after a merge (`until: base-runs-settled`).
- Reading a branch's required checks from branch protection in place of `expect`.
- More than 100 check runs on one commit: the verdict covers the first 100 and says so.
