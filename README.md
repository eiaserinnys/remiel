# Remiel

A lightweight Slack bot powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk).

Remiel watches Slack channels and responds in character — a gambling-addicted angel from thunder and lightning, based on a character from *Ember & Blade*.

## Features

- **Character-driven responses** via Claude Agent SDK with a custom `CLAUDE.md` persona
- **Selective engagement** — skips messages not directed at the bot
- **Delegation** — forwards complex tasks to an external agent (Soulstream) via `<request>` blocks
- **Timing logs** — records per-stage latency for every interaction

## Requirements

- Node.js 20+
- pnpm
- A Slack app with Socket Mode enabled (Bot Token + App Token)

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in the values in .env
pnpm build
pnpm start
```

### Environment Variables

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) |
| `SLACK_CHANNEL_IDS` | Comma-separated list of channel IDs to monitor |
| `WORKSPACE_DIR` | Working directory for logs and artifacts |
| `CLAUDE_MODEL` | Claude model to use (default: `claude-sonnet-4-6`) |
| `BOT_NAME` | Display name for the bot (default: `레미엘`) |
| `SOULSTREAM_URL` | *(Optional)* Soulstream server URL for delegation |
| `SOULSTREAM_TOKEN` | *(Optional)* Soulstream auth token |
| `SOULSTREAM_AGENT_ID` | *(Optional)* Agent session ID for delegation |

## Development

```bash
pnpm dev       # Run with tsx (no build step)
pnpm test      # Run tests with Vitest
```

## License

MIT
