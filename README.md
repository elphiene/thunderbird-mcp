# thunderbird-mcp

An MCP server that gives Claude access to Thunderbird — read and search emails across
all connected accounts (including iCloud), look up contacts, and access the unified
calendar.

This is an early, read-only build. It works directly with your Thunderbird profile
files and does **not** require Thunderbird to be running.

## Status

- ✅ Email read path: list accounts/folders, search emails, read full messages
- ✅ Contacts read path: list address books, list/search contacts
- ✅ Calendar read path: list calendars, list events (requires Thunderbird closed)
- ⏳ Send/manage email, contact and calendar writes (via a Thunderbird WebExtension) —
  not yet implemented

## Setup

1. Find your Thunderbird profile directory:
   ```bash
   cat ~/.thunderbird/profiles.ini
   ls ~/.thunderbird/
   ```
   Pick the profile directory containing `Mail/`, `ImapMail/`, `abook.sqlite`, etc.

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set `THUNDERBIRD_PROFILE` to your profile
   directory:
   ```bash
   cp .env.example .env
   # edit .env
   ```

4. Verify it works:
   ```bash
   npm run test:tools
   ```

## Wiring into Claude Desktop / Cowork

Add an entry to `~/.config/Claude/claude_desktop_config.json` under `mcpServers`:

```json
"thunderbird": {
  "command": "node",
  "args": ["/absolute/path/to/thunderbird-mcp/src/index.js"],
  "env": {
    "THUNDERBIRD_PROFILE": "/home/<you>/.thunderbird/<profile-dir>"
  }
}
```

Restart Claude Desktop. You should then be able to ask things like "list my Thunderbird
accounts" or "search my inbox for invoices".

## Tools

- `list_accounts` — lists configured Thunderbird accounts
- `list_folders` — lists the folder tree for an account
- `search_emails` — search by account, folder, sender, subject, keyword, date range
- `read_email` — full headers, text body, and attachment metadata for one message
- `list_address_books` — lists configured address books and their synced account
- `list_contacts` — lists/searches contacts by name or email
- `list_calendars` — lists configured calendars
- `list_events` — lists calendar events by calendar/date range (requires Thunderbird
  to be closed)

See `docs/ARCHITECTURE.md` for how email parsing and message addressing work, and
`docs/BRIEF.md` for the full project scope and roadmap.

## Constraints

- Local only — no network exposure, no Cloudflare tunnel
- `sqlite3`, not `better-sqlite3` (required for Node v24 compatibility)
- `THUNDERBIRD_PROFILE` must be set via environment variable — never hardcoded
