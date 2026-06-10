# thunderbird-mcp

An MCP server that gives Claude access to Thunderbird — read and search emails across
all connected accounts (including iCloud), look up contacts, and access the unified
calendar.

The read path works directly with your Thunderbird profile files and does **not**
require Thunderbird to be running. Sending email requires Thunderbird to be running
with the bundled WebExtension loaded (see below).

## Status

- ✅ Email read path: list accounts/folders, search emails, read full messages
- ✅ Contacts read path: list address books, list/search contacts
- ✅ Calendar read path: list calendars, list events (requires Thunderbird closed)
- ✅ Local HTTP bridge + WebExtension: heartbeat + send email
- ✅ Message management: move, delete, mark read/unread, add/remove tags
- ✅ Contact writes: create/update contacts
- ❌ Calendar writes — blocked, no standard `browser.calendar` WebExtension API exists
  (see `docs/DECISIONS.md` D-010); calendar remains read-only

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
- `bridge_status` — reports whether the Thunderbird WebExtension is connected
- `send_email` — composes and sends a new email from a connected account (requires
  Thunderbird running with the extension loaded; check `bridge_status` first)
- `list_tags` — lists configured message tags/labels (key, name, color)
- `move_message` — moves a message to another folder/account (requires the extension)
- `delete_message` — deletes a message, to Trash by default (requires the extension)
- `set_message_read` — marks a message read or unread (requires the extension)
- `update_message_tags` — adds/removes tags on a message (requires the extension)
- `create_contact` — creates a contact in an address book (requires the extension)
- `update_contact` — updates fields on an existing contact (requires the extension)

See `docs/ARCHITECTURE.md` for how email parsing, message addressing, and the
WebExtension bridge work, and `docs/BRIEF.md` for the full project scope and roadmap.

## WebExtension

`extension/` is a Manifest V2 Thunderbird WebExtension that connects to the local
bridge. To load it:

1. In Thunderbird: Settings → General → "Add-ons and Themes" → gear icon →
   "Debug Add-ons" → "Load Temporary Add-on" → select `extension/manifest.json`.
2. With `npm start` running, call the `bridge_status` tool (or
   `curl http://127.0.0.1:8084/health`) — `extensionConnected` should become `true`
   within ~30 seconds.

Once connected, `send_email`, the message management tools (`move_message`,
`delete_message`, `set_message_read`, `update_message_tags`), and the contact write
tools (`create_contact`, `update_contact`) are available. Calendar write operations
are not implemented — see `docs/DECISIONS.md` D-010.

## Constraints

- Local only — no network exposure, no Cloudflare tunnel. The bridge binds to
  `127.0.0.1:8084` (override with `BRIDGE_PORT`) and must never be tunneled.
- `sqlite3`, not `better-sqlite3` (required for Node v24 compatibility)
- `THUNDERBIRD_PROFILE` must be set via environment variable — never hardcoded
