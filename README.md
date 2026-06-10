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

## Known limitations

- **Calendar is read-only.** `create_event`/`update_event`/`delete_event` are not
  implemented — Thunderbird has no standard `browser.calendar` WebExtension API (see
  `docs/DECISIONS.md` D-010). **Workaround for Google-backed calendars**: if your
  Thunderbird calendar is CalDAV-synced from a Google account, use Claude's separate
  Google Calendar connector to create/update/delete events on that account directly —
  the change syncs back into Thunderbird and shows up via `list_events`. This doesn't
  help with iCloud-backed calendars.
- **`list_events` requires Thunderbird to be closed** — the calendar cache database
  (`calendar-data/local.sqlite`) is held with an exclusive lock while Thunderbird runs
  (D-006).
- **Reply/reply-all are not implemented** — only compose-and-send (D-008).
- Message ids from `search_emails`/`read_email` are based on mbox byte offsets and can
  go stale after Thunderbird compacts a folder (e.g. emptying Trash) — re-run
  `search_emails` if a tool reports "message not found".

## Troubleshooting

- **`bridge_status` reports `extensionConnected: false`**: make sure Thunderbird is
  running and the extension is loaded (see "WebExtension" above), and that no other
  thunderbird-mcp process is bound to the same `BRIDGE_PORT` (only one process can hold
  the port; `npm run test:tools` uses a separate port for this reason).
- **`list_events`/`list_contacts` report a "locked" error**: `list_events` requires
  Thunderbird to be closed (D-006). `list_contacts` can hit this transiently while
  Thunderbird is actively CardDAV-syncing an address book — wait a moment and retry
  (D-008).
- **A management tool (`move_message`, etc.) reports "message not found"**: the `id`
  is stale — re-run `search_emails` to get a fresh one.
- **Send/management/contact-write tools time out**: the extension didn't respond
  within 30s. Check the Browser Console (Settings → General → "Add-ons and Themes" →
  gear icon → "Debug Add-ons" → "Inspect") for errors in `background.js`.
