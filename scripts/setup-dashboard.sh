#!/bin/bash
# Setup script for NanoClaw Dashboard integration
# Registers the dashboard as a main group and creates IPC directories
# Idempotent: safe to run multiple times

set -e

# Determine script location relative to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default paths (can be overridden by environment)
DATA_DIR="${NANOCLAW_DATA_DIR:-$PROJECT_ROOT/data}"
DB_PATH="${DB_PATH:-$PROJECT_ROOT/store/messages.db}"

# IPC directories
IPC_DASHBOARD="$DATA_DIR/ipc/dashboard"
IPC_TASKS="$IPC_DASHBOARD/tasks"
IPC_MESSAGES="$IPC_DASHBOARD/messages"

echo "NanoClaw Dashboard Setup"
echo "========================"
echo "Data directory: $DATA_DIR"
echo "Database: $DB_PATH"
echo ""

# Create IPC directories
echo "Creating IPC directories..."
mkdir -p "$IPC_TASKS"
mkdir -p "$IPC_MESSAGES"
echo "  ✓ $IPC_TASKS"
echo "  ✓ $IPC_MESSAGES"

# Check if dashboard group already exists
echo ""
echo "Checking dashboard registration..."

DASHBOARD_EXISTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM registered_groups WHERE jid = 'dashboard@internal';" 2>/dev/null || echo "0")

if [ "$DASHBOARD_EXISTS" = "1" ]; then
  echo "  ✓ Dashboard group already registered"
else
  echo "  Registering dashboard group..."
  sqlite3 "$DB_PATH" <<EOF
INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
VALUES ('dashboard@internal', 'Dashboard', 'dashboard', '', datetime('now'), 1);
EOF
  echo "  ✓ Dashboard group registered (is_main=1)"
fi

echo ""
echo "Setup complete!"
echo ""
echo "The dashboard can now:"
echo "  - Read from: $DB_PATH"
echo "  - Write IPC to: $IPC_TASKS and $IPC_MESSAGES"
echo ""