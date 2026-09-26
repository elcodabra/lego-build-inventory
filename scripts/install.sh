#!/usr/bin/env bash
# Install / package lego-inventory-build for different agents.
#   scripts/install.sh claude-code   plugin (skill + MCP) via the local marketplace
#   scripts/install.sh codex         skill into ~/.codex/skills + MCP server into Codex config
#   scripts/install.sh desktop       MCP server into Claude Desktop config (prints the JSON to merge)
#   scripts/install.sh zip           dist/lego-inventory-build.zip for claude.ai (Settings > Capabilities > Skills)
#   scripts/install.sh deps          npm install + Chromium inside the skill folder
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$REPO/plugins/lego-inventory-build/skills/lego-inventory-build"

deps() { (cd "$1" && npm install --no-audit --no-fund && npx playwright install chromium); }

case "${1:-}" in
  claude-code)
    claude plugin marketplace add "$REPO"
    claude plugin install lego-inventory-build@lego-tools
    echo "Done. Restart Claude Code; dependencies install on the first MCP start (see /mcp)."
    ;;
  codex)
    DEST="${CODEX_HOME:-$HOME/.codex}/skills/lego-inventory-build"
    mkdir -p "$(dirname "$DEST")"
    rsync -a --delete --exclude node_modules --exclude exports "$SKILL/" "$DEST/"
    deps "$DEST"
    codex mcp remove lego >/dev/null 2>&1 || true
    codex mcp add lego -- node "$DEST/mcp/server.mjs"
    echo "Skill: $DEST, MCP server 'lego' registered in Codex."
    ;;
  desktop)
    deps "$SKILL"
    cat <<EOF
Add to ~/Library/Application Support/Claude/claude_desktop_config.json (Windows: %APPDATA%\\Claude\\...):
{
  "mcpServers": {
    "lego": { "command": "node", "args": ["$SKILL/mcp/server.mjs"] }
  }
}
Then restart Claude Desktop.
EOF
    ;;
  zip)
    mkdir -p "$REPO/dist"
    OUT="$REPO/dist/lego-inventory-build.zip"
    rm -f "$OUT"
    (cd "$(dirname "$SKILL")" && zip -qr "$OUT" lego-inventory-build -x '*/node_modules/*' '*/exports/*' '*/test/*' '*.DS_Store' '*/package-lock.json')
    echo "$OUT ($(du -h "$OUT" | cut -f1)). Upload in claude.ai: Settings > Capabilities > Skills."
    ;;
  deps)
    deps "$SKILL"
    ;;
  *)
    sed -n '2,7p' "$0"; exit 1 ;;
esac
