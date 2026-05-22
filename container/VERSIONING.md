# Container Versioning & Channels

> Source of truth: `VERSIONS.json` (this directory)
> Tooling: `scripts/container.sh`

---

## Concepts

| Term | Meaning |
|------|---------|
| **Versioned tag** | Immutable. `nanoclaw-agent:v1.0.0` is never overwritten. A build produces exactly one versioned tag. |
| **Channel alias** | Mutable pointer. `:stable` and `:next` are `docker tag` aliases that point at a versioned tag. |
| `:stable` | Default channel. All groups use this unless explicitly switched to `:next`. |
| `:next` | Canary channel. Used for testing new SDK/CLI versions on a single group before promotion. |
| `VERSIONS.json` | Git-tracked state file recording which version each channel points at, plus metadata for every built version. |

---

## Why No `:latest`

The `:latest` tag is **not used** in this system. Problems it caused:

1. Silent drift — two builds a week apart ship different CLI versions with no source change.
2. No rollback target — once overwritten, the previous image is unrecoverable without layer SHAs.
3. Ambiguity — `docker pull` defaults to `:latest`, masking which version is actually running.

`build.sh` now errors if called without an explicit version tag.

---

## Daily Commands

```bash
# See what's running
./scripts/container.sh current

# List all known versions
./scripts/container.sh list

# Build a new version (does NOT change any channel)
./scripts/container.sh build v1.2.0

# Point :next at the new build (canary)
./scripts/container.sh stage v1.2.0

# After testing, promote to :stable (affects all groups)
./scripts/container.sh promote v1.2.0

# Something went wrong — roll :stable back
./scripts/container.sh rollback
```

---

## The `VERSIONS.json` File

Located at `repo/container/VERSIONS.json`. Structure:

```json
{
  "channels": { "stable": "v1.0.0", "next": "v1.0.0" },
  "versions": {
    "v1.0.0": {
      "imageId": "sha256:...",
      "builtAt": "ISO-8601",
      "sdkVersion": "0.2.76",
      "cliVersion": "2.1.147",
      "notes": "..."
    }
  },
  "history": []
}
```

- **`channels`**: current pointer for each alias.
- **`versions`**: metadata per immutable build.
- **`history`**: append-only log of promote/rollback operations.

This file is git-tracked. After any `promote`, `stage`, or `rollback`, the file is updated atomically. Commit it to preserve the audit trail.

---

## Promotion Checklist

Before running `container.sh promote <version>`:

1. [ ] The version has been staged as `:next` and tested on at least one group.
2. [ ] Session resume works both directions (`:stable` → `:next` → `:stable`), or the `/newsession` workaround is documented.
3. [ ] All host-side tests pass against the new image.
4. [ ] The rollback target is known (`container.sh current` shows the current `:stable`).
5. [ ] You have explicit user approval (MANUAL_01 decision point).

---

## Rollback Procedure

```bash
# Automatic (uses history from VERSIONS.json)
./scripts/container.sh rollback

# Manual (if history is corrupted or missing)
docker tag nanoclaw-agent:v1.0.0 nanoclaw-agent:stable
# Then fix VERSIONS.json channels.stable manually
```

After rollback, groups on `:stable` will pick up the reverted image on their next container spawn. Running containers are not affected until recycled.

---

## Cross-References

- `repo/CLAUDE.md` — references this file for in-container agents
- `.agent/rules/nanoclaw-versioning.md` — agent steering for version conventions
- `repo/docs/docker-sandboxes.md` — user-facing container documentation
