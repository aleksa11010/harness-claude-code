#!/usr/bin/env bash
# Installs the harness-platform Claude Code mod from this folder.
#   ./install.sh                      asks for org, project and API key (key input is hidden)
#   HARNESS_API_KEY=… HARNESS_DEFAULT_ORG_ID=… HARNESS_DEFAULT_PROJECT_ID=… ./install.sh --yes
# Re-running it updates the plugin and lets you change the settings.
set -euo pipefail

YES=0; [ "${1:-}" = "--yes" ] && YES=1
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HARNESS_TOOLS_DIR:-$HOME/.claude-plugins/harness-tools}"
MIN="2.1.287"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Claude Code present and new enough
command -v claude >/dev/null || fail "Claude Code isn't installed (https://code.claude.com/docs/en/setup)."
VER="$(claude --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ -n "$VER" ] || fail "Couldn't read the Claude Code version."
ver_ge() { local IFS=.; local -a a=($1) b=($2); for i in 0 1 2; do (( ${a[i]:-0} > ${b[i]:-0} )) && return 0; (( ${a[i]:-0} < ${b[i]:-0} )) && return 1; done; return 0; }
ver_ge "$VER" "$MIN" || fail "Claude Code $VER is too old; mods need $MIN or later. Update Claude Code and re-run."
say "Claude Code $VER"

# 2. Settings
ask() { # ask VAR "Prompt" default
  local cur="${!1:-$3}"
  if [ $YES -eq 0 ]; then read -r -p "$2${cur:+ [$cur]}: " ans || true; printf -v "$1" '%s' "${ans:-$cur}"; else printf -v "$1" '%s' "$cur"; fi
}
ORG="${HARNESS_DEFAULT_ORG_ID:-}"; PROJECT="${HARNESS_DEFAULT_PROJECT_ID:-}"; BASE="${HARNESS_BASE_URL:-https://app.harness.io}"
ask ORG "Harness org ID" "default"
ask PROJECT "Harness project ID" ""
ask BASE "Harness URL" "https://app.harness.io"
[ -n "$PROJECT" ] || fail "A project ID is required."
for v in "$ORG" "$PROJECT"; do [[ "$v" =~ ^[A-Za-z0-9_-]+$ ]] || fail "IDs may contain only letters, digits, _ and -: '$v'"; done
[[ "$BASE" =~ ^https?://[^[:space:]\"\\]+$ ]] || fail "Not a URL: $BASE"

# Pane layout and write actions (both changeable later: press v in the pane, or /plugin configure)
LAYOUT="${HARNESS_CICD_LAYOUT:-}"
ask LAYOUT "Pane layout: stacked, focus, dock or strip" "stacked"
[[ "$LAYOUT" =~ ^(stacked|focus|dock|strip)$ ]] || fail "Layout must be stacked, focus, dock or strip: '$LAYOUT'"
START="${HARNESS_PLATFORM_START:-}"
ask START "Start on: home, runs, inventory, approvals, service or platform" "home"
[[ "$START" =~ ^(home|runs|inventory|approvals|service|platform)$ ]] || fail "Starting screen must be home, runs, inventory, approvals, service or platform: '$START'"
ACTIONS="${HARNESS_CICD_ALLOW_ACTIONS:-}"
if [ $YES -eq 0 ]; then
  read -r -p "Allow retry/rerun/abort/approve from the pane? Each asks before acting [y/N]: " a || true
  [[ "${a:-}" =~ ^[Yy] ]] && ACTIONS=1
fi
[ "$ACTIONS" = "1" ] && ACTIONS_JSON=true || ACTIONS_JSON=false

KEY="${HARNESS_API_KEY:-}"
if [ $YES -eq 0 ]; then
  read -r -s -p "Harness API key (input hidden; Enter to ${KEY:+use \$HARNESS_API_KEY}${KEY:-sign in with Harness instead}): " k || true; echo
  KEY="${k:-$KEY}"
fi
if [ -n "$KEY" ]; then
  [[ "$KEY" =~ ^[A-Za-z0-9._-]+$ ]] || fail "That doesn't look like a Harness API key."
  [[ "$KEY" =~ ^(pat|sat)\. ]] || say "Note: key doesn't start with pat. or sat.; set account_id with /plugin configure if needed."
else
  say "No API key: keeping a saved key if there is one; otherwise you'll sign in with Harness (/mcp in Claude Code)"
fi

# 3. Copy the marketplace somewhere permanent (Claude Code reads the plugin from here)
if [ "$SRC" != "$DEST" ]; then
  say "Copying to $DEST"
  mkdir -p "$(dirname "$DEST")"; rm -rf "$DEST"; cp -R "$SRC" "$DEST"
fi
claude plugin validate "$DEST" >/dev/null || fail "Validation failed: run 'claude plugin validate $DEST' for details."

# 4. Register the marketplace and install (or update) the plugin
if claude plugin marketplace list 2>/dev/null | grep -q 'harness-tools'; then
  say "Updating marketplace harness-tools"
  claude plugin marketplace update harness-tools >/dev/null
else
  say "Adding marketplace harness-tools"
  claude plugin marketplace add "$DEST" >/dev/null
fi
# Upgrading from the plugin's old name: remove harness-cicd so only one /harness answers
if claude plugin list 2>/dev/null | grep -q 'harness-cicd@harness-tools'; then
  say "Removing the old harness-cicd plugin (renamed to harness-platform)"
  claude plugin uninstall harness-cicd@harness-tools >/dev/null 2>&1 || true
fi
if claude plugin list 2>/dev/null | grep -q 'harness-platform@harness-tools'; then
  claude plugin update harness-platform@harness-tools >/dev/null 2>&1 || true
else
  say "Installing harness-platform"
  claude plugin install harness-platform@harness-tools >/dev/null
fi

# 5. Save settings; the key goes to your OS credential store, not settings.json (and never on a command line)
JSON="{\"org_id\":\"$ORG\",\"project_id\":\"$PROJECT\",\"base_url\":\"$BASE\",\"layout\":\"$LAYOUT\",\"start_view\":\"$START\",\"allow_actions\":\"$ACTIONS_JSON\"${KEY:+,\"api_key\":\"$KEY\"}}"
printf '%s' "$JSON" | claude plugin configure harness-platform@harness-tools --values-stdin >/dev/null
unset KEY JSON k
say "Saved settings for $ORG/$PROJECT (start: $START, layout: $LAYOUT, actions: $([ "$ACTIONS_JSON" = true ] && echo on || echo off))"

# 5b. Platform modules use Harness's MCP server; with an API key it runs locally through npx.
#     Download it once now, so its first start in Claude Code doesn't hit the 30-second limit.
if [ -n "${KEY:-}" ] || claude plugin configure harness-platform@harness-tools --json 2>/dev/null | grep -q '"api_key"'; then
  if command -v npx >/dev/null; then
    say "Preparing the local Harness MCP server (one-time download)…"
    printf '' | timeout 180 npx -y harness-mcp-v2@3.2.32 >/dev/null 2>&1 || true
  else
    say "Note: platform modules with an API key need Node.js (npx). Install Node.js, or sign in with Harness instead."
  fi
fi

# 6. Check it
claude plugin list 2>/dev/null | grep -A4 'harness-platform@harness-tools' | grep -q 'enabled' || fail "Installed but not enabled: run 'claude plugin enable harness-platform@harness-tools'."
say "Testing the connection to Harness…"
OUT="$(env -u HARNESS_API_KEY claude -p "/harness doctor" < /dev/null 2>&1 | tail -30 || true)"
printf '%s\n' "$OUT" | sed 's/^/    /'
case "$OUT" in
  *"refused the API key"*) fail "Installed, but Harness rejected the key. Check it has view access to $ORG/$PROJECT, then re-run to update it." ;;
  *"not configured"*)      say "Installed. Add your API key with: /plugin configure harness-platform@harness-tools" ;;
  *"sign-in needed"*)      say "Installed. Sign in once: open Claude Code, run /mcp, choose plugin:harness-platform:harness, then Authenticate. Check with /harness doctor." ;;
  *"HTTP "*)               fail "Harness returned an error (above). Check the org/project IDs and URL, then re-run." ;;
  *)                       say "Done. Start Claude Code in a repo Harness builds and type /harness" ;;
esac
