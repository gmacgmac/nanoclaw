# Reviewing NanoClaw Logs

A quick reference for finding what's happening inside NanoClaw without spinning up tooling.

---

## Where the Logs Live

```
repo/logs/nanoclaw.log         ← all levels (info, warn, error, debug)
repo/logs/nanoclaw.error.log   ← errors and warns only (StandardErrorPath from launchd)
```

These are written by the launchd plist (`repo/launchd/com.nanoclaw.plist`). Format is pino's default: a single line per entry, prefixed with `[HH:MM:SS.mmm] LEVEL (PID): message`, followed by indented key/value pairs for structured fields.

> Heads up: these files grow large. As of this writing, `nanoclaw.log` is ~600 MB and `nanoclaw.error.log` is ~200 MB. There is no log rotation yet. Use byte-bounded `tail -c` for ad-hoc reads to avoid loading the whole file into memory.

---

## Common Lookups

### Live tail of errors only

```bash
tail -f repo/logs/nanoclaw.error.log
```

Use this while reproducing an issue. Watch for `ERROR` lines and the `WARN` lines immediately following, which usually carry the root cause.

### Errors from the current NanoClaw process only

NanoClaw appends to the log across restarts, so old PIDs clutter the tail. Filter to just the running PID:

```bash
grep "($(pgrep -f 'dist/index.js'))" repo/logs/nanoclaw.error.log | tail -50
```

### Last N MB of a log (without loading it all)

```bash
tail -c 5M repo/logs/nanoclaw.error.log
```

### Errors in a specific time window

The format is `[HH:MM:SS.mmm]`, no date by default — date is captured by file mtime / log rotation when it's added later. For quick range filtering within a single day:

```bash
awk '/\[23:1[5-9]/,/\[23:30/' repo/logs/nanoclaw.error.log | tail -100
```

### Errors for a specific group

The structured field is `group: "..."` (group display name, not folder).

```bash
grep -A 3 'group: "GM"' repo/logs/nanoclaw.error.log | tail -40
```

For folder-based filtering use `groupJid:` or `folder:` depending on which logger emitted the line.

---

## Signals Worth Watching

These are the lines that indicate something real is wrong, in rough priority order.

### `Max retries exceeded, dropping messages`

A group hit 5 consecutive failures and is now parked until the next inbound message wakes it. After [BUG_01](../cortex-tasks/nanoclaw-container/docker_2026-05-21_canary-channels-and-sdk-upgrade/BUG_01_image-not-found-false-negative.md) was fixed, this is now a **real** signal — phantom failures should no longer trigger it.

```bash
grep "Max retries exceeded" repo/logs/nanoclaw.error.log
```

If this fires more than a couple of times a day, something upstream is unhealthy — usually Docker, sometimes disk space, occasionally a bad container build.

### `Container image not found locally`

Should be **zero** since BUG_01 was resolved. If this reappears, the pre-spawn `imageExists()` check has been re-introduced, or a real image is genuinely missing. Either way, investigate.

```bash
grep "Container image not found locally" repo/logs/nanoclaw.error.log
```

### `Container exited with error`

The container started but crashed during agent execution. The log line includes `code` (exit code), `duration` (ms), and a truncated `stderr`. Common patterns:

- `code: 137` — SIGKILL, usually because `closeStdin` was invoked (`/stop`, `/shutdown`, `/model`, `/version`, idle timeout). Often benign.
- `code: 1` with a docker socket message — Docker daemon is unreachable. Check Docker Desktop is running.
- `code: 1` with an SDK or Node trace — the agent itself errored. Open the per-container log file referenced in the `logFile` field for the full output.

### `Container agent error` immediately followed by `Agent error after output was sent, skipping cursor rollback`

This means the agent did reply to the user but the container then errored on cleanup. Not user-visible — the user got their answer. Worth knowing about but not action-required unless it's persistent.

### `Spawning container agent`

Useful as a positive heartbeat. If you're not seeing these, no container is actually starting.

```bash
grep "Spawning container agent" repo/logs/nanoclaw.log | tail -20
```

### `State loaded` with `channelCounts`

Emitted on every NanoClaw startup. Tells you how many groups are on `:stable` vs `:next`.

```bash
grep "State loaded" repo/logs/nanoclaw.log | tail -5
```

---

## Per-Container Logs

Each container spawn also writes to a dedicated file under the group's folder:

```
repo/groups/<group_folder>/logs/container-<ISO-timestamp>.log
```

These contain the full agent-runner stderr/stdout for one specific container run. The `logFile` field in error log entries points to the relevant one. Use these when the host log says "Container exited with error" and you need to see what the agent itself was doing.

---

## What's Coming

Tail-and-grep gets you most of what you need but is awkward for "is anything bad happening right now" at a glance. A planned dashboard task in `nanoclaw-dashboard/` would surface the three signals above (Max retries exceeded, image-not-found resurgence, error clusters per group) in a single page with auto-refresh. Until then, the `tail -f` + `grep` recipes above are the recommended workflow.

Two preliminaries worth landing before that dashboard:

1. **Log rotation.** Wire pino into a rolling file appender or set up `logrotate` on `repo/logs/`. Files growing unboundedly will eventually become unreadable on their own, dashboard or not.
2. **Per-PID separation.** Adding the PID to the launchd output filename (or rotating on each restart) makes it easier to scope investigations to a single NanoClaw lifetime without filtering by `(PID)`.

Both small, both worth doing first.
