#!/bin/bash
# =============================================================================
# claude-rig installer
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[91m'
DIM=$'\033[2m'
RESET=$'\033[0m'

info()  { echo "${GREEN}[✓]${RESET} $1"; }
warn()  { echo "${YELLOW}[!]${RESET} $1"; }
error() { echo "${RED}[✗]${RESET} $1"; exit 1; }

# ---------------------------------------------------------------------------
# 前置檢查
# ---------------------------------------------------------------------------
command -v jq >/dev/null 2>&1 || error "需要 jq，請先安裝：brew install jq / apt install jq"

# ---------------------------------------------------------------------------
# 安裝函式
# ---------------------------------------------------------------------------
install_statusline() {
  mkdir -p "$CLAUDE_DIR"

  cp "$SCRIPT_DIR/scripts/statusline.sh" "$CLAUDE_DIR/statusline.sh"
  chmod +x "$CLAUDE_DIR/statusline.sh"
  info "statusline.sh → $CLAUDE_DIR/statusline.sh"

  # 更新 settings.json
  local sl_config='{"type":"command","command":"~/.claude/statusline.sh","padding":0}'

  if [ -f "$SETTINGS_FILE" ]; then
    local updated
    updated=$(jq --argjson sl "$sl_config" '.statusLine = $sl' "$SETTINGS_FILE")
    echo "$updated" > "$SETTINGS_FILE"
    info "已更新 $SETTINGS_FILE"
  else
    echo "{\"statusLine\": $sl_config}" | jq '.' > "$SETTINGS_FILE"
    info "已建立 $SETTINGS_FILE"
  fi

  echo ""
  info "Statusline 安裝完成！請重啟 Claude Code。"
}

# ---------------------------------------------------------------------------
# 選單
# ---------------------------------------------------------------------------
echo ""
echo "  claude-rig installer"
echo "  ${DIM}────────────────────${RESET}"
echo "  1) Statusline — 三行即時儀表板"
echo "  q) 離開"
echo ""
read -rp "  選擇要安裝的項目 [1]: " choice
echo ""

case "${choice:-1}" in
  1) install_statusline ;;
  q|Q) info "離開"; exit 0 ;;
  *) warn "無效選項"; exit 1 ;;
esac
