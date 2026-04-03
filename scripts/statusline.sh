#!/usr/bin/env bash
# =============================================================================
# Claude Code Statusline
# =============================================================================
#
# Line 1: Model CTX_SIZE vVer │ Repo (branch) │ +n -n lines │ xM xA xD │ ⚙ agent
# Line 2: ●●●●●○○○○○ PCT% │ $Cost │ Duration │ 5h x% (countdown) │ 7d x%
# Line 3: in: xK  out: xK │ api wait xm (x%) │ cache x%
#
# 安裝：cd claude-rig && ./install.sh
# 依賴：jq
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# 功能開關
# ---------------------------------------------------------------------------
SHOW_MODEL=1
SHOW_CTX_SIZE=1         # model name 沒帶 context 時自動補上
SHOW_VERSION=0          # Claude Code 版本號
SHOW_DIR=1
SHOW_GIT_BRANCH=1
SHOW_GIT_FILES=1        # git file stats (M/A/D)
SHOW_LINES=1            # +n -n lines
SHOW_AGENT=1
SHOW_CONTEXT_BAR=1
SHOW_COST=1             # $0.00 時 dim 顯示
SHOW_DURATION=1
SHOW_RATE_LIMITS=1      # 5h / 7d rate limits
SHOW_TOKENS=1           # in: xK  out: xK
SHOW_API_WAIT=1         # api wait time + 佔比
SHOW_CACHE_HIT=1        # cache hit rate

# ---------------------------------------------------------------------------
# 視覺設定
# ---------------------------------------------------------------------------
BAR_WIDTH=15
GIT_CACHE_TTL=5

# ---------------------------------------------------------------------------
# 色彩
# ---------------------------------------------------------------------------
RST='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
BLUE='\033[34m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
MAGENTA='\033[35m'
WHITE='\033[37m'
GRAY='\033[90m'

SEP="${DIM} | ${RST}"

# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------
fallback() {
  printf '%b' "${GRAY}${1:-─}${RST}"
  exit 0
}
command -v jq &>/dev/null || fallback "jq not found"

# ---------------------------------------------------------------------------
# 單次 jq
# ---------------------------------------------------------------------------
input=$(cat)

parsed=$(echo "$input" | jq -r '
  (.model.display_name // ""),
  (.model.id // ""),
  (.version // ""),
  (.session_id // ""),
  (.workspace.current_dir // "."),
  (.workspace.current_dir // "." | split("/") | last),
  ((.cost.total_cost_usd // 0) | tostring),
  ((.cost.total_duration_ms // 0) | tostring),
  ((.cost.total_api_duration_ms // 0) | tostring),
  ((.cost.total_lines_added // 0) | tostring),
  ((.cost.total_lines_removed // 0) | tostring),
  ((.context_window.used_percentage // 0) | tostring),
  ((.context_window.context_window_size // 0) | tostring),
  ((.context_window.total_input_tokens // 0) | tostring),
  ((.context_window.total_output_tokens // 0) | tostring),
  ((.context_window.current_usage.input_tokens // 0) | tostring),
  ((.context_window.current_usage.cache_read_input_tokens // 0) | tostring),
  ((.context_window.current_usage.cache_creation_input_tokens // 0) | tostring),
  (.worktree.branch // ""),
  (.worktree.name // ""),
  (.agent.name // ""),
  (.vim.mode // ""),
  ((.rate_limits.five_hour.used_percentage // -1) | tostring),
  (.rate_limits.five_hour.resets_at // ""),
  ((.rate_limits.seven_day.used_percentage // -1) | tostring),
  (.rate_limits.seven_day.resets_at // ""),
  "END"
' 2>/dev/null) || fallback "parse error"

{
  IFS= read -r MODEL_NAME
  IFS= read -r MODEL_ID
  IFS= read -r VERSION
  IFS= read -r SESSION_ID
  IFS= read -r CWD_FULL
  IFS= read -r DIR_NAME
  IFS= read -r COST_USD
  IFS= read -r DURATION_MS
  IFS= read -r API_DURATION_MS
  IFS= read -r LINES_ADDED
  IFS= read -r LINES_REMOVED
  IFS= read -r CTX_PCT
  IFS= read -r CTX_SIZE
  IFS= read -r TOTAL_IN
  IFS= read -r TOTAL_OUT
  IFS= read -r CUR_INPUT
  IFS= read -r CACHE_READ
  IFS= read -r CACHE_CREATE
  IFS= read -r WT_BRANCH
  IFS= read -r WT_NAME
  IFS= read -r AGENT_NAME
  IFS= read -r VIM_MODE
  IFS= read -r RATE_5H
  IFS= read -r RESET_5H
  IFS= read -r RATE_7D
  IFS= read -r RESET_7D
  IFS= read -r _SENTINEL
} <<< "$parsed"

# Cache 路徑（SESSION_ID + CWD hash 避免跨 repo 衝突）
_cache_key="${SESSION_ID:-default}-$(echo "$CWD_FULL" | cksum | cut -d' ' -f1)"
GIT_CACHE_FILE="/tmp/claude-statusline-branch-${_cache_key}"
GIT_FILES_CACHE="/tmp/claude-statusline-files-${_cache_key}"

# 約 1/20 機率清理超過 60 分鐘的舊 cache
(( RANDOM % 20 == 0 )) && find /tmp -maxdepth 1 -name 'claude-statusline-*' -mmin +60 -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# 輔助函式
# ---------------------------------------------------------------------------

color_pct() {
  local v=${1:-0}
  if (( v >= 80 )); then echo "$RED"
  elif (( v >= 50 )); then echo "$YELLOW"
  else echo "$GREEN"; fi
}

fmt_tokens() {
  local t="${1:-0}"; t="${t%.*}"
  if (( t >= 1000000 )) 2>/dev/null; then
    local m=$((t / 1000)); printf "%d.%dM" "$((m / 1000))" "$(( (m % 1000) / 100 ))"
  elif (( t >= 1000 )) 2>/dev/null; then
    local k=$((t * 10 / 1000)); printf "%d.%dK" "$((k / 10))" "$((k % 10))"
  else
    printf "%d" "$t"
  fi
}

fmt_dur() {
  local ms="${1:-0}"; ms="${ms%.*}"
  local s=$((ms / 1000)) h m
  h=$((s / 3600)); m=$(( (s % 3600) / 60 )); s=$((s % 60))
  if (( h > 0 )); then printf "%dh %02dm" "$h" "$m"
  elif (( m > 0 )); then printf "%dm %02ds" "$m" "$s"
  else printf "%ds" "$s"; fi
}

fmt_countdown() {
  local reset_at="$1"
  [[ -z "$reset_at" || "$reset_at" == "null" ]] && return
  # 嘗試用 date 解析 ISO 8601
  local reset_epoch
  reset_epoch=$(date -d "$reset_at" +%s 2>/dev/null \
    || date -j -f "%Y-%m-%dT%H:%M:%S%z" "$(echo "$reset_at" | sed 's/://g; s/Z/+0000/')" +%s 2>/dev/null \
    || date -j -f "%Y-%m-%dT%H:%M:%S" "${reset_at%%[.+Z]*}" +%s 2>/dev/null \
    || echo "")
  [[ -z "$reset_epoch" ]] && return
  local now diff h m
  now=$(date +%s)
  diff=$((reset_epoch - now))
  (( diff <= 0 )) && { echo "now"; return; }
  h=$((diff / 3600)); m=$(( (diff % 3600) / 60 ))
  printf "%dh %dm" "$h" "$m"
}

# ---------------------------------------------------------------------------
# Git（帶快取）
# ---------------------------------------------------------------------------

git_branch="${WT_BRANCH:-}"
dirty=""
git_files=""

git_cache_stale() {
  local f="$1"
  [[ ! -f "$f" ]] && return 0
  local age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0) ))
  (( age > GIT_CACHE_TTL ))
}

if [[ -n "${CWD_FULL:-}" && -d "${CWD_FULL:-}" ]] && git -C "$CWD_FULL" rev-parse --git-dir &>/dev/null; then

  # Branch + dirty
  if git_cache_stale "$GIT_CACHE_FILE"; then
    cb="${git_branch}"
    [[ -z "$cb" ]] && { cb=$(git -C "$CWD_FULL" branch --show-current 2>/dev/null) || true; }
    [[ -z "$cb" ]] && { cb=$(git -C "$CWD_FULL" rev-parse --short HEAD 2>/dev/null) || true; }
    cd_flag=""
    if ! git -C "$CWD_FULL" diff --quiet 2>/dev/null || \
       ! git -C "$CWD_FULL" diff --cached --quiet 2>/dev/null; then
      cd_flag="*"
    fi
    echo "${cb}|${cd_flag}" > "$GIT_CACHE_FILE"
  fi
  if [[ -f "$GIT_CACHE_FILE" ]]; then
    IFS='|' read -r cached_br cached_dt < "$GIT_CACHE_FILE"
    [[ -z "$git_branch" ]] && git_branch="${cached_br}"
    dirty="${cached_dt}"
  fi

  # File stats (M/A/D) — 帶快取
  if [[ "$SHOW_GIT_FILES" == "1" ]]; then
    if git_cache_stale "$GIT_FILES_CACHE"; then
      gm=$(git -C "$CWD_FULL" diff --diff-filter=M --name-only 2>/dev/null | wc -l | tr -d ' ') || true
      ga=$(git -C "$CWD_FULL" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ') || true
      gd=$(git -C "$CWD_FULL" diff --diff-filter=D --name-only 2>/dev/null | wc -l | tr -d ' ') || true
      echo "${gm}|${ga}|${gd}" > "$GIT_FILES_CACHE"
    fi
    if [[ -f "$GIT_FILES_CACHE" ]]; then
      IFS='|' read -r gm ga gd < "$GIT_FILES_CACHE"
    fi
    parts=""
    (( ${gm:-0} > 0 )) && parts="${YELLOW}${gm}M${RST}"
    (( ${ga:-0} > 0 )) && { [[ -n "$parts" ]] && parts+=" "; parts+="${GREEN}${ga}A${RST}"; }
    (( ${gd:-0} > 0 )) && { [[ -n "$parts" ]] && parts+=" "; parts+="${RED}${gd}D${RST}"; }
    git_files="$parts"
  fi

  REPO_DISPLAY="${DIR_NAME}"
else
  REPO_DISPLAY="${DIR_NAME}"
fi

# ═══════════════════════════════════════════════════════════════
# LINE 1: Header
# ═══════════════════════════════════════════════════════════════

L1=""

# Model
if [[ "$SHOW_MODEL" == "1" && -n "$MODEL_NAME" ]]; then
  L1="${CYAN}${BOLD}${MODEL_NAME}${RST}"
fi

# Context size 智慧顯示
if [[ "$SHOW_CTX_SIZE" == "1" ]]; then
  ctx_s=${CTX_SIZE:-0}
  if [[ "$MODEL_NAME" != *context* && "$MODEL_NAME" != *Context* ]]; then
    if (( ctx_s >= 1000000 )); then L1+=" ${DIM}1M${RST}"
    elif (( ctx_s >= 200000 )); then L1+=" ${DIM}200K${RST}"; fi
  fi
fi

# Version
if [[ "$SHOW_VERSION" == "1" && -n "$VERSION" ]]; then
  L1+=" ${DIM}v${VERSION}${RST}"
fi

# Dir (repo link)
if [[ "$SHOW_DIR" == "1" ]]; then
  L1+="${SEP}${WHITE}${REPO_DISPLAY}${RST}"
fi

# Branch
if [[ "$SHOW_GIT_BRANCH" == "1" && -n "$git_branch" ]]; then
  L1+=" ${DIM}(${git_branch}${dirty})${RST}"
fi

# Lines +n -n（smart hiding）
if [[ "$SHOW_LINES" == "1" ]]; then
  la=${LINES_ADDED%.*}; la=${la:-0}
  lr=${LINES_REMOVED%.*}; lr=${lr:-0}
  if (( la > 0 || lr > 0 )); then
    lp="${GREEN}+${la}${RST}"
    (( lr > 0 )) && lp+=" ${RED}-${lr}${RST}"
    L1+="${SEP}${lp} ${DIM}lines${RST}"
  fi
fi

# Git file stats
if [[ -n "$git_files" ]]; then
  L1+="${SEP}${git_files}"
fi

# Agent / Worktree
if [[ "$SHOW_AGENT" == "1" ]]; then
  if [[ -n "${WT_NAME:-}" ]]; then
    L1+="${SEP}${MAGENTA}⚙ wt:${WT_NAME}${RST}"
  elif [[ -n "${AGENT_NAME:-}" ]]; then
    L1+="${SEP}${MAGENTA}⚙ ${AGENT_NAME}${RST}"
  fi
fi

# Vim mode
if [[ -n "${VIM_MODE:-}" ]]; then
  if [[ "$VIM_MODE" == "NORMAL" ]]; then
    L1+="${SEP}${BLUE}${BOLD}NOR${RST}"
  elif [[ "$VIM_MODE" == "INSERT" ]]; then
    L1+="${SEP}${GREEN}${BOLD}INS${RST}"
  fi
fi

# ═══════════════════════════════════════════════════════════════
# LINE 2: Context bar + Cost + Duration + Rate limits
# ═══════════════════════════════════════════════════════════════

L2=""

# Context bar（●）
if [[ "$SHOW_CONTEXT_BAR" == "1" ]]; then
  pct=${CTX_PCT%.*}; pct=${pct:-0}
  (( pct < 0 )) && pct=0; (( pct > 100 )) && pct=100
  filled=$((pct * BAR_WIDTH / 100))
  (( filled > BAR_WIDTH )) && filled=$BAR_WIDTH
  empty=$((BAR_WIDTH - filled))

  bc=$(color_pct "$pct")
  bar=""
  for (( i=0; i<filled; i++ )); do bar+="${bc}●${RST}"; done
  for (( i=0; i<empty; i++ )); do bar+="${DIM}●${RST}"; done

  # 警告
  warn=""
  (( pct >= 90 )) && warn=" ${RED}⚠${RST}"

  L2="${bar} ${bc}${pct}%${RST}${warn}"
fi

# Cost
if [[ "$SHOW_COST" == "1" ]]; then
  cost_fmt=$(printf '%.2f' "$COST_USD" 2>/dev/null || echo "0.00")
  cost_int=${COST_USD%.*}; cost_int=${cost_int:-0}
  if (( cost_int >= 10 )); then cc="$RED"
  elif [[ "$cost_fmt" == "0.00" ]]; then cc="$DIM"
  else cc="$YELLOW"; fi
  L2+="${SEP}${cc}\$${cost_fmt}${RST}"
fi

# Duration（smart hiding）
if [[ "$SHOW_DURATION" == "1" ]]; then
  dur_ms=${DURATION_MS%.*}; dur_ms=${dur_ms:-0}
  if (( dur_ms > 1000 )); then
    L2+="${SEP}${DIM}$(fmt_dur "$dur_ms")${RST}"
  fi
fi

# Rate limits: 5h + countdown
if [[ "$SHOW_RATE_LIMITS" == "1" ]]; then
  r5=${RATE_5H%.*}; r5=${r5:-0}
  r7=${RATE_7D%.*}; r7=${r7:-0}

  if (( r5 >= 0 )); then
    rc5=$(color_pct "$r5")
    L2+="${SEP}${DIM}5h${RST} ${rc5}${r5}%${RST}"
    cd5=$(fmt_countdown "$RESET_5H")
    [[ -n "$cd5" ]] && L2+=" ${DIM}(${cd5})${RST}"
  fi

  if (( r7 >= 0 )); then
    rc7=$(color_pct "$r7")
    L2+="${SEP}${DIM}7d${RST} ${rc7}${r7}%${RST}"
    cd7=$(fmt_countdown "$RESET_7D")
    [[ -n "$cd7" ]] && L2+=" ${DIM}(${cd7})${RST}"
  fi
fi

# ═══════════════════════════════════════════════════════════════
# LINE 3: Tokens + API wait + Cache hit
# ═══════════════════════════════════════════════════════════════

L3=""

# Tokens
if [[ "$SHOW_TOKENS" == "1" ]]; then
  ti=${TOTAL_IN%.*}; ti=${ti:-0}
  to=${TOTAL_OUT%.*}; to=${to:-0}
  if (( ti > 0 || to > 0 )); then
    L3="${DIM}in:${RST} ${CYAN}$(fmt_tokens "$ti")${RST} ${DIM}out:${RST} ${MAGENTA}$(fmt_tokens "$to")${RST}"
  fi
fi

# API wait + 佔比
if [[ "$SHOW_API_WAIT" == "1" ]]; then
  api_ms=${API_DURATION_MS%.*}; api_ms=${api_ms:-0}
  dur_ms_v=${DURATION_MS%.*}; dur_ms_v=${dur_ms_v:-0}
  if (( api_ms > 0 )); then
    api_str="${DIM}api wait${RST} ${CYAN}$(fmt_dur "$api_ms")${RST}"
    if (( dur_ms_v > 0 )); then
      api_pct=$((api_ms * 100 / dur_ms_v))
      api_str+=" ${DIM}(${api_pct}%)${RST}"
    fi
    [[ -n "$L3" ]] && L3+="${SEP}"
    L3+="$api_str"
  fi
fi

# Cache hit rate
if [[ "$SHOW_CACHE_HIT" == "1" ]]; then
  cr=${CACHE_READ%.*}; cr=${cr:-0}
  ci=${CUR_INPUT%.*}; ci=${ci:-0}
  cc_v=${CACHE_CREATE%.*}; cc_v=${cc_v:-0}
  cache_total=$((cr + ci + cc_v))
  if (( cache_total > 0 )); then
    cache_pct=$((cr * 100 / cache_total))
    # 反向著色：命中率高=好=綠，低=差=紅
    cache_color=$(color_pct "$((100 - cache_pct))")
    [[ -n "$L3" ]] && L3+="${SEP}"
    L3+="${DIM}cache${RST} ${cache_color}${cache_pct}%${RST}"
  fi
fi

# ═══════════════════════════════════════════════════════════════
# 輸出
# ═══════════════════════════════════════════════════════════════

output="$L1"
[[ -n "$L2" ]] && output+="\n${L2}"
[[ -n "$L3" ]] && output+="\n${L3}"

printf '%b' "$output"
