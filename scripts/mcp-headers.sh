#!/bin/sh
# Prints the headers Claude Code adds for the Orrery MCP server. The plugin's
# personal_key setting is sent as a static Authorization header, and what this
# prints wins over it. Claude Code gives this script no setting values, so it
# asks Claude Code whether personal_key is set, and when it is prints nothing.
# Otherwise the key is looked up by hub in a file of lines
# "<hub ingest URL> <command that prints a token>" (~/.config/orrery/tokens,
# or ORRERY_TOKENS_FILE), the sign-in the Orrery command line keeps.
set -e
hub="${CLAUDE_CODE_MCP_SERVER_URL%/mcp}"

# Whether personal_key is set, asked of Claude Code about the installed plugin
# that runs from this script's root.
claude="${CLAUDE_CODE_EXECPATH:-claude}"
id="$("$claude" plugin list --json 2>/dev/null | awk -v root="${CLAUDE_PLUGIN_ROOT%/}" '
  /"id":/ { split($0, part, "\""); id = part[4] }
  /"(installPath|readFromFolder)":/ { split($0, part, "\""); if (part[4] == root) { print id; exit } }' || true)"
if [ -n "$id" ]; then
  configured="$("$claude" plugin configure "$id" --json 2>/dev/null | tr -d ' \n' | sed -n 's/.*"configured":\[\([^]]*\)\].*/\1/p' || true)"
  case "$configured" in *'"personal_key"'*) echo '{}'; exit 0 ;; esac
fi

file="${ORRERY_TOKENS_FILE:-$HOME/.config/orrery/tokens}"
command=""
if [ -f "$file" ]; then
  while read -r url rest; do
    case "$url" in ''|'#'*) continue ;; esac
    if [ "${url%/}" = "${hub%/}" ]; then command="$rest"; break; fi
  done < "$file"
fi
if [ -z "$command" ]; then
  echo "orrery: no personal key; set it with /plugin configure" >&2
  echo '{}'
  exit 0
fi
token="$(sh -c "$command" | tr -d '\r\n')"
[ -n "$token" ] || { echo "orrery: the token command for $hub printed nothing" >&2; echo '{}'; exit 0; }
printf '{"Authorization":"Bearer %s"}\n' "$token"
