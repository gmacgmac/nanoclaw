#!/bin/bash
#
# NanoClaw Persona Backup
# Backs up irreplaceable group state to external disk image.
# Safe two-phase: SQLite snapshot + staged rsync + atomic commit + atomic compression.
#

set -euo pipefail

### Config
SRC_ROOT="/Users/dev/Dropbox (Personal)/Developer/nanoclaw/repo"
DEST_VOL="/Volumes/nanoclaw-personas-bak"
RETAIN=5
STAGING=".staging"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_NAME="nanoclaw-${TIMESTAMP}"
LOG_FILE="${SRC_ROOT}/logs/backup-personas.log"

### Pre-flight
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

fail() {
    log "ERROR: $*"
    osascript -e "display notification \"$*\" with title \"NanoClaw Backup Failed\" sound name \"Basso\"" 2>/dev/null || true
    exit 1
}

# Catch any unexpected failures (e.g. rsync disk full) and notify
trap 'osascript -e "display notification \"Backup failed unexpectedly — check logs/backup-personas.error.log\" with title \"NanoClaw Backup Failed\" sound name \"Basso\"" 2>/dev/null || true' ERR

# Check source exists
if [[ ! -d "$SRC_ROOT" ]]; then
    fail "Source directory not found: $SRC_ROOT"
fi

# Check destination volume is mounted
if [[ ! -d "$DEST_VOL" ]]; then
    fail "Backup volume not mounted: $DEST_VOL"
fi

# Check destination is writable
if ! touch "${DEST_VOL}/.write-test" 2>/dev/null; then
    fail "Backup volume is not writable: $DEST_VOL"
fi
rm -f "${DEST_VOL}/.write-test"

# Check available space (need at least 100 MB)
AVAILABLE_KB=$(df -k "$DEST_VOL" | awk 'NR==2 {print $4}')
if [[ "$AVAILABLE_KB" -lt 102400 ]]; then
    fail "Insufficient space on backup volume: ${AVAILABLE_KB}KB available, 100MB required"
fi

# Validate zip command exists
if ! command -v zip >/dev/null 2>&1; then
    fail "zip command not found. Install with: brew install zip"
fi

# Check Docker is available
if ! command -v docker >/dev/null 2>&1; then
    fail "docker command not found. Docker Desktop must be installed and running."
fi

# Check PostgreSQL container is running
if ! docker inspect --format='{{.State.Running}}' nanoclaw-postgres-1 2>/dev/null | grep -q true; then
    fail "PostgreSQL container (nanoclaw-postgres-1) is not running"
fi

# Clean stale artifacts from previous interrupted runs
rm -rf "${DEST_VOL}/${STAGING}"
rm -f "${DEST_VOL}"/nanoclaw-*.zip.tmp

# Compress any orphaned uncompressed backups from previous interrupted runs.
# This ensures every backup is represented as a .zip before rotation runs.
for orphan_dir in "${DEST_VOL}"/nanoclaw-*/; do
    if [[ -d "$orphan_dir" ]]; then
        dir_name=$(basename "$orphan_dir")
        # Skip if this looks like a staging directory (shouldn't happen, but safety)
        [[ "$dir_name" == "$STAGING" ]] && continue
        if [[ ! -f "${DEST_VOL}/${dir_name}.zip" ]]; then
            log "Compressing orphaned backup: ${dir_name}"
            (cd "$DEST_VOL" && zip -rqX "${dir_name}.zip.tmp" "$dir_name" && mv "${dir_name}.zip.tmp" "${dir_name}.zip" && rm -rf "$dir_name") || log "WARNING: Failed to compress orphaned backup ${dir_name}"
        fi
    fi
done

### Phase A1 — SQLite snapshot (legacy safety net — PG is primary)
log "Phase A1: Creating SQLite snapshot (legacy)..."
mkdir -p "${SRC_ROOT}/.tmp-backup"
sqlite3 "${SRC_ROOT}/store/messages.db" ".backup '${SRC_ROOT}/.tmp-backup/messages.db.snapshot'"
log "SQLite snapshot complete"

### Phase A2 — PostgreSQL dump
log "Phase A2: Creating PostgreSQL dump..."
docker compose -f "${SRC_ROOT}/docker-compose.yml" exec -T postgres \
    pg_dump -U nanoclaw nanoclaw | gzip > "${SRC_ROOT}/.tmp-backup/nanoclaw.sql.gz"

if [[ ! -s "${SRC_ROOT}/.tmp-backup/nanoclaw.sql.gz" ]]; then
    fail "pg_dump produced empty output"
fi
log "PostgreSQL dump complete ($(du -h "${SRC_ROOT}/.tmp-backup/nanoclaw.sql.gz" | cut -f1))"

### Phase B — Staged rsync
log "Phase B: Staging rsync to ${DEST_VOL}/${STAGING}/..."

# Clean any stale staging directory
rm -rf "${DEST_VOL}/${STAGING}"
mkdir -p "${DEST_VOL}/${STAGING}"

rsync -a --delete \
    --exclude='node_modules' \
    --exclude='agent-runner-src' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
    --exclude='logs/' \
    --exclude='tmp/' \
    --exclude='dist/' \
    --exclude='.tmp-*' \
    --exclude='.git/' \
    --exclude='.nanoclaw/' \
    --exclude='store/messages.db' \
    "${SRC_ROOT}/store/" "${DEST_VOL}/${STAGING}/store/"

rsync -a --delete \
    --exclude='node_modules' \
    --exclude='agent-runner-src' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
    --exclude='models/' \
    "${SRC_ROOT}/data/" "${DEST_VOL}/${STAGING}/data/"

rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
    --exclude='media/' \
    --exclude='*.mp4' \
    --exclude='*.mov' \
    --exclude='*.avi' \
    --exclude='*.mkv' \
    --exclude='*.webm' \
    "${SRC_ROOT}/groups/" "${DEST_VOL}/${STAGING}/groups/"

# Copy SQLite snapshot instead of live DB
cp "${SRC_ROOT}/.tmp-backup/messages.db.snapshot" "${DEST_VOL}/${STAGING}/store/messages.db"

# Copy .env if it exists
if [[ -f "${SRC_ROOT}/.env" ]]; then
    cp "${SRC_ROOT}/.env" "${DEST_VOL}/${STAGING}/.env"
fi

# Copy .gitignore so restore knows what was tracked
if [[ -f "${SRC_ROOT}/.gitignore" ]]; then
    cp "${SRC_ROOT}/.gitignore" "${DEST_VOL}/${STAGING}/.gitignore"
fi

# Copy PostgreSQL dump
mkdir -p "${DEST_VOL}/${STAGING}/postgres"
cp "${SRC_ROOT}/.tmp-backup/nanoclaw.sql.gz" "${DEST_VOL}/${STAGING}/postgres/nanoclaw.sql.gz"

# Copy docker-compose.yml (infrastructure-as-code)
cp "${SRC_ROOT}/docker-compose.yml" "${DEST_VOL}/${STAGING}/docker-compose.yml"

log "Rsync complete"

### Phase C — Atomic commit (uncompressed)
log "Phase C: Atomic commit to ${BACKUP_NAME}..."
mv "${DEST_VOL}/${STAGING}" "${DEST_VOL}/${BACKUP_NAME}"
log "Backup committed: ${DEST_VOL}/${BACKUP_NAME}"

### Phase C2 — Atomic compression
log "Phase C2: Compressing backup..."
ZIP_TEMP="${DEST_VOL}/${BACKUP_NAME}.zip.tmp"
ZIP_FINAL="${DEST_VOL}/${BACKUP_NAME}.zip"

# Create zip from the committed backup directory.
# We cd into DEST_VOL so paths inside the zip are relative.
(cd "$DEST_VOL" && zip -rqX "$ZIP_TEMP" "$BACKUP_NAME")

# Validate the zip was created and is non-empty
if [[ ! -s "$ZIP_TEMP" ]]; then
    fail "Zip creation failed: $ZIP_TEMP is missing or empty. Uncompressed backup preserved at ${DEST_VOL}/${BACKUP_NAME}"
fi

# Atomic rename: the zip is complete and valid only after this mv
mv "$ZIP_TEMP" "$ZIP_FINAL"
log "Backup compressed: $ZIP_FINAL"

# Only remove uncompressed source after zip is confirmed complete.
# macOS may create .DS_Store files during rm -rf, causing "Directory not empty".
# Use find -delete to catch stragglers, then retry rm -rf.
rm -rf "${DEST_VOL}/${BACKUP_NAME}" 2>/dev/null || true
find "${DEST_VOL}/${BACKUP_NAME}" -delete 2>/dev/null || true
rm -rf "${DEST_VOL}/${BACKUP_NAME}" 2>/dev/null || true

### Phase D — Rotation (keep last N zip files)
log "Phase D: Rotating backups (retain ${RETAIN})..."

# Build list of zip files sorted by modification time (newest first)
BACKUPS=$(ls -1dt "${DEST_VOL}"/nanoclaw-*.zip 2>/dev/null || true)
if [[ -n "$BACKUPS" ]]; then
    echo "$BACKUPS" | tail -n +$((RETAIN + 1)) | while IFS= read -r OLD_ZIP; do
        if [[ -n "$OLD_ZIP" && -f "$OLD_ZIP" ]]; then
            OLD_NAME=$(basename "$OLD_ZIP" .zip)
            OLD_DIR="${DEST_VOL}/${OLD_NAME}"
            log "Removing old backup: $OLD_ZIP"
            rm -f "$OLD_ZIP"
            # Safety: also remove matching uncompressed dir if it exists
            if [[ -d "$OLD_DIR" ]]; then
                rm -rf "$OLD_DIR"
            fi
        fi
    done
fi

# Count remaining backups (zip files only)
REMAINING=$(ls -1 "${DEST_VOL}"/nanoclaw-*.zip 2>/dev/null | wc -l | tr -d ' ')
log "Rotation complete. Total backups: $REMAINING"

### Cleanup
rm -rf "${SRC_ROOT}/.tmp-backup"
log "Backup finished successfully"

# Final notification on success
osascript -e "display notification \"Backup complete (${REMAINING} retained)\" with title \"NanoClaw Backup\" sound name \"Glass\"" 2>/dev/null || true
