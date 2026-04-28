#!/bin/bash
#
# NanoClaw Persona Backup
# Backs up irreplaceable group state to external disk image.
# Safe two-phase: SQLite snapshot + staged rsync + atomic commit.
#

set -euo pipefail

### Config
SRC_ROOT="/Users/dev/Dropbox (Personal)/Developer/nanoclaw/repo"
DEST_VOL="/Volumes/nanoclaw-personas-bak"
RETAIN=4
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
    exit 1
}

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

### Phase A — Consistent SQLite snapshot
log "Phase A: Creating consistent SQLite snapshot..."
mkdir -p "${SRC_ROOT}/.tmp-backup"
sqlite3 "${SRC_ROOT}/store/messages.db" ".backup '${SRC_ROOT}/.tmp-backup/messages.db.snapshot'"
log "SQLite snapshot complete"

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
    "${SRC_ROOT}/data/" "${DEST_VOL}/${STAGING}/data/"

rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
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

log "Rsync complete"

### Phase C — Atomic commit
log "Phase C: Atomic commit to ${BACKUP_NAME}..."
mv "${DEST_VOL}/${STAGING}" "${DEST_VOL}/${BACKUP_NAME}"
log "Backup committed: ${DEST_VOL}/${BACKUP_NAME}"

### Phase D — Rotation (keep last N)
log "Phase D: Rotating backups (retain ${RETAIN})..."
BACKUPS=$(ls -1dt "${DEST_VOL}"/nanoclaw-* 2>/dev/null || true)
if [[ -n "$BACKUPS" ]]; then
    echo "$BACKUPS" | tail -n +$((RETAIN + 1)) | while IFS= read -r OLD; do
        if [[ -n "$OLD" && -d "$OLD" ]]; then
            log "Removing old backup: $OLD"
            rm -rf "$OLD"
        fi
    done
fi
REMAINING=$(ls -1d "${DEST_VOL}"/nanoclaw-* 2>/dev/null | wc -l | tr -d ' ')
log "Rotation complete. Total backups: $REMAINING"

### Cleanup
rm -rf "${SRC_ROOT}/.tmp-backup"
log "Backup finished successfully"
