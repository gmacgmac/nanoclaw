#!/bin/bash
# container.sh — Versioning and channel management for nanoclaw-agent images.
# Source of truth: ../VERSIONS.json
# Docs: ../VERSIONING.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="$SCRIPT_DIR/VERSIONS.json"
IMAGE_NAME="nanoclaw-agent"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# --- Helpers ---

die_user()  { echo "ERROR: $*" >&2; exit 1; }
die_env()   { echo "ENV ERROR: $*" >&2; exit 2; }

check_deps() {
  command -v jq >/dev/null 2>&1 || die_env "jq is required but not installed. Install with: brew install jq"
  command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1 || die_env "$CONTAINER_RUNTIME is not available."
  [[ -f "$VERSIONS_FILE" ]] || die_env "VERSIONS.json not found at $VERSIONS_FILE"
}

# Atomic write: write to tmp then mv
write_versions() {
  local tmp="$VERSIONS_FILE.tmp"
  jq '.' <<< "$1" > "$tmp" || die_env "Failed to write VERSIONS.json"
  mv "$tmp" "$VERSIONS_FILE"
}

validate_semver() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die_user "Version must match vX.Y.Z (got: $1)"
}

version_exists() {
  jq -e --arg v "$1" '.versions[$v] != null' "$VERSIONS_FILE" >/dev/null 2>&1
}

docker_tag_exists() {
  $CONTAINER_RUNTIME inspect "$IMAGE_NAME:$1" >/dev/null 2>&1
}

get_image_id() {
  $CONTAINER_RUNTIME inspect --format '{{.Id}}' "$IMAGE_NAME:$1" 2>/dev/null
}

# --- Subcommands ---

cmd_build() {
  local version="${1:-}"
  [[ -z "$version" ]] && die_user "Usage: container.sh build <vX.Y.Z>"
  validate_semver "$version"

  docker_tag_exists "$version" && die_user "Docker tag $IMAGE_NAME:$version already exists. Versions are immutable."
  version_exists "$version" && die_user "Version $version already recorded in VERSIONS.json."

  echo "Building $IMAGE_NAME:$version ..."
  "$SCRIPT_DIR/build.sh" "$version"

  # Capture metadata from the built image
  local image_id
  image_id=$(get_image_id "$version")
  local built_at
  built_at=$($CONTAINER_RUNTIME inspect --format '{{.Created}}' "$IMAGE_NAME:$version" | cut -d. -f1)

  # Extract SDK and CLI versions from inside the image
  local sdk_version
  sdk_version=$($CONTAINER_RUNTIME run --rm --entrypoint sh "$IMAGE_NAME:$version" -c \
    "node -e \"console.log(require('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)\"" 2>/dev/null || echo "unknown")
  local cli_version
  cli_version=$($CONTAINER_RUNTIME run --rm --entrypoint sh "$IMAGE_NAME:$version" -c \
    "claude --version 2>/dev/null | head -1 || echo unknown" 2>/dev/null || echo "unknown")

  # Write to VERSIONS.json
  local updated
  updated=$(jq --arg v "$version" --arg id "$image_id" --arg at "$built_at" \
    --arg sdk "$sdk_version" --arg cli "$cli_version" \
    '.versions[$v] = {"imageId": $id, "builtAt": $at, "sdkVersion": $sdk, "cliVersion": $cli, "notes": ""}' \
    "$VERSIONS_FILE")
  write_versions "$updated"

  echo ""
  echo "✓ Built and recorded $IMAGE_NAME:$version"
  echo "  Image ID: $image_id"
  echo "  SDK: $sdk_version | CLI: $cli_version"
  echo ""
  echo "Next: stage this version with 'container.sh stage $version'"
}

cmd_stage() {
  local version="${1:-}"
  [[ -z "$version" ]] && die_user "Usage: container.sh stage <vX.Y.Z>"
  validate_semver "$version"
  version_exists "$version" || die_user "Version $version not found in VERSIONS.json. Build it first."
  docker_tag_exists "$version" || die_user "Docker tag $IMAGE_NAME:$version not found locally."

  $CONTAINER_RUNTIME tag "$IMAGE_NAME:$version" "$IMAGE_NAME:next"

  # Verify
  local expected actual
  expected=$(get_image_id "$version")
  actual=$(get_image_id "next")
  [[ "$expected" == "$actual" ]] || die_env "Tag verification failed! :next does not match :$version"

  # Update VERSIONS.json
  local updated
  updated=$(jq --arg v "$version" '.channels.next = $v' "$VERSIONS_FILE")
  write_versions "$updated"

  echo "✓ Staged: $IMAGE_NAME:next → $version"
}

cmd_promote() {
  local version="${1:-}"
  [[ -z "$version" ]] && die_user "Usage: container.sh promote <vX.Y.Z>"
  validate_semver "$version"
  version_exists "$version" || die_user "Version $version not found in VERSIONS.json. Build it first."
  docker_tag_exists "$version" || die_user "Docker tag $IMAGE_NAME:$version not found locally."

  local current_stable
  current_stable=$(jq -r '.channels.stable' "$VERSIONS_FILE")

  echo ""
  echo "⚠️  WARNING: This will change :stable for ALL groups using the stable channel."
  echo "   Current :stable → $current_stable"
  echo "   New :stable     → $version"
  echo ""
  read -rp "Type 'promote' to confirm: " confirm
  [[ "$confirm" == "promote" ]] || { echo "Aborted."; exit 0; }

  $CONTAINER_RUNTIME tag "$IMAGE_NAME:$version" "$IMAGE_NAME:stable"

  # Verify
  local expected actual
  expected=$(get_image_id "$version")
  actual=$(get_image_id "stable")
  [[ "$expected" == "$actual" ]] || die_env "Tag verification failed! :stable does not match :$version"

  # Update VERSIONS.json with history
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local updated
  updated=$(jq --arg v "$version" --arg from "$current_stable" --arg at "$now" \
    '.channels.stable = $v | .history += [{"channel": "stable", "from": $from, "to": $v, "at": $at}]' \
    "$VERSIONS_FILE")
  write_versions "$updated"

  echo "✓ Promoted: $IMAGE_NAME:stable → $version"
}

cmd_rollback() {
  local history_len
  history_len=$(jq '.history | length' "$VERSIONS_FILE")
  [[ "$history_len" -gt 0 ]] || die_user "No promotion history. Nothing to roll back to."

  local prev_version
  prev_version=$(jq -r '.history[-1].from' "$VERSIONS_FILE")
  local current_stable
  current_stable=$(jq -r '.channels.stable' "$VERSIONS_FILE")

  echo ""
  echo "⚠️  WARNING: Rolling back :stable."
  echo "   Current :stable → $current_stable"
  echo "   Rollback to     → $prev_version"
  echo ""
  read -rp "Type 'rollback' to confirm: " confirm
  [[ "$confirm" == "rollback" ]] || { echo "Aborted."; exit 0; }

  docker_tag_exists "$prev_version" || die_user "Docker tag $IMAGE_NAME:$prev_version not found locally. Manual recovery needed."

  $CONTAINER_RUNTIME tag "$IMAGE_NAME:$prev_version" "$IMAGE_NAME:stable"

  # Verify
  local expected actual
  expected=$(get_image_id "$prev_version")
  actual=$(get_image_id "stable")
  [[ "$expected" == "$actual" ]] || die_env "Tag verification failed! :stable does not match :$prev_version"

  # Update VERSIONS.json
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local updated
  updated=$(jq --arg v "$prev_version" --arg from "$current_stable" --arg at "$now" \
    '.channels.stable = $v | .history += [{"channel": "stable", "from": $from, "to": $v, "at": $at, "type": "rollback"}]' \
    "$VERSIONS_FILE")
  write_versions "$updated"

  echo "✓ Rolled back: $IMAGE_NAME:stable → $prev_version"
}

cmd_list() {
  echo "=== nanoclaw-agent versions ==="
  echo ""
  jq -r '.versions | to_entries | sort_by(.key) | .[] |
    "  \(.key)  sdk=\(.value.sdkVersion)  cli=\(.value.cliVersion)  built=\(.value.builtAt)\n           \(.value.notes)"' \
    "$VERSIONS_FILE"
  echo ""
}

cmd_current() {
  local stable_ver next_ver
  stable_ver=$(jq -r '.channels.stable' "$VERSIONS_FILE")
  next_ver=$(jq -r '.channels.next' "$VERSIONS_FILE")

  echo "=== Channel Status ==="
  echo "  :stable → $stable_ver"
  echo "  :next   → $next_ver"
  echo ""

  # Verify docker tags match VERSIONS.json
  local drift=0
  if docker_tag_exists "stable"; then
    local expected actual
    expected=$(jq -r --arg v "$stable_ver" '.versions[$v].imageId' "$VERSIONS_FILE")
    actual=$(get_image_id "stable")
    if [[ "$expected" != "$actual" ]]; then
      echo "⚠️  DRIFT: :stable docker tag does not match VERSIONS.json!"
      echo "   Expected (from file): $expected"
      echo "   Actual (docker):      $actual"
      drift=1
    fi
  else
    echo "⚠️  :stable tag does not exist in docker."
    drift=1
  fi

  if docker_tag_exists "next"; then
    local expected actual
    expected=$(jq -r --arg v "$next_ver" '.versions[$v].imageId' "$VERSIONS_FILE")
    actual=$(get_image_id "next")
    if [[ "$expected" != "$actual" ]]; then
      echo "⚠️  DRIFT: :next docker tag does not match VERSIONS.json!"
      echo "   Expected (from file): $expected"
      echo "   Actual (docker):      $actual"
      drift=1
    fi
  else
    echo "⚠️  :next tag does not exist in docker."
    drift=1
  fi

  [[ $drift -eq 0 ]] && echo "✓ Docker tags match VERSIONS.json — no drift detected."
}

cmd_help() {
  cat <<'EOF'
Usage: container.sh <command> [args]

Commands:
  build <vX.Y.Z>     Build a new versioned image (does NOT change channels)
  stage <vX.Y.Z>     Point :next at a built version
  promote <vX.Y.Z>   Point :stable at a built version (affects all stable groups)
  rollback            Revert :stable to its previous version
  list                Show all recorded versions
  current             Show channel→version mapping and check for drift
  --help, help        Show this message

State file: repo/container/VERSIONS.json
Docs:       repo/container/VERSIONING.md
EOF
}

# --- Main ---

check_deps

case "${1:-}" in
  build)   shift; cmd_build "$@" ;;
  stage)   shift; cmd_stage "$@" ;;
  promote) shift; cmd_promote "$@" ;;
  rollback) cmd_rollback ;;
  list)    cmd_list ;;
  current) cmd_current ;;
  help|--help|-h) cmd_help ;;
  "") cmd_help ;;
  *) die_user "Unknown command: $1. Run 'container.sh --help' for usage." ;;
esac
