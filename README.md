# claude-rig

My Claude Code rig — scripts, skills, hooks, and commands.

## What's Inside

| Component                                      | Description                                            | 
|------------------------------------------------|--------------------------------------------------------|
| [Statusline](docs/statusline/statusline.md)    | 三行即時儀表板 — model, context, cost, rate limits, cache hit |
| [Buddy Patch](docs/buddy-patch/buddy-patch.md) | Buddy 外觀與屬性自訂 — salt 搜尋、species/rarity/stats patch     |

## Project Structure

```
claude-rig/
├── scripts/     # Shell scripts (statusline, etc.)
├── docs/        # Documentation
├── skills/      # Custom skills
├── hooks/       # Lifecycle hooks
├── commands/    # Slash commands
└── install.sh   # Installer
```

## License

Apache 2.0
