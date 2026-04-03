# CLAUDE.md

## 專案定位

Claude Code 個人化配置 repo。腳本透過 install.sh 安裝到 ~/.claude/，作用於所有 repo。

## Commit

- Conventional commits（feat/fix/docs/chore）
- 訊息用中文
- 相關改動合併為一個 commit，不要拆

## 文件

- README 只放概覽，細節放 docs/
- 文件必須與腳本實作一致，不要記錄未實作的功能

## 開發注意

- scripts/ 下的腳本每次被 Claude Code 呼叫都是獨立 process，不能用 $$ 做 cache key
- 改動後要實際驗證，不確定的問題先驗證再報告
