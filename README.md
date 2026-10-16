# Subly MCP

Remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects [Subly](https://subly.app) to AI tools such as ChatGPT custom connectors and Claude custom connectors.

Use it when you want an assistant to read and manage your Subly workspace: projects, subscriptions and other expenses, revenue items, and transactions.

## Why this exists

Subscription spend is easy to lose track of. New tools appear, renewals land on different dates, and the same question keeps coming back: what are we paying for, and can we change it safely?

Subly already tracks that financial picture. The missing piece was a clean way for AI tools to use the same workspace through a standard connector, instead of copying numbers by hand or building one-off scripts for every chat product.

Subly MCP fills that gap. It exposes Subly as an MCP server over HTTPS, so an assistant can list subscriptions, inspect costs, and create or update records when you ask—using the same API your workspace already trusts.

## What it provides

| Capability | Tools |
|------------|--------|
| Read | list/get projects, expenses, revenue, transactions |
| Write | create/update projects, expenses, revenue, transactions |
| Delete | delete projects, expenses, revenue, transactions (marked destructive) |

Authentication for the MCP endpoint is a high-entropy path (capability URL). The Subly API key stays on the server and is never sent to ChatGPT or Claude.

## Requirements

- Node.js 22+
- A Subly workspace API key from the Subly dashboard

## Quick start

```bash
cp .env.example .env
# Set SUBLY_API_KEY and MCP_PATH (must start with / and end with /mcp)
npm ci
npm run build
npm start
```

Example:

```bash
MCP_PATH=/$(openssl rand -hex 32)/mcp
```

Connect ChatGPT or Claude with:

- Server URL: `https://your-host.example.com${MCP_PATH}`
- Authentication: none (the path is the credential)

Treat that URL like a password. Anyone who has it can use the MCP tools.

## Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
```

Health check (internal): `GET /health`  
MCP endpoint: `POST/GET ${MCP_PATH}`

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SUBLY_API_KEY` | yes | Subly workspace API key |
| `MCP_PATH` | yes | Capability path, e.g. `/<64-hex>/mcp` |
| `PORT` | no | Listen port (default `3000`) |

## License

MIT
