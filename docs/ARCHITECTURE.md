# thunderbird-mcp — Architecture

> Decisions log: see `docs/DECISIONS.md`. Full project brief: `docs/BRIEF.md`.

## Three layers (per the brief)

1. **MCP server (Node v24 ESM)** — stdio MCP process exposing tools to Claude.
   - **Read path** (current focus, works with Thunderbird closed): parses the
     Thunderbird profile directly — mbox for email, `abook.sqlite` for contacts,
     `calendar-data/*.sqlite` for calendar.
   - **Write/send/manage path** (future): talks to the Thunderbird WebExtension over a
     local-only HTTP bridge.
2. **Thunderbird WebExtension** (`extension/`) — thin shim. Sends a periodic heartbeat
   with the account list, and polls the bridge for commands to execute via
   `browser.*` APIs (currently `send_email` via `browser.compose.*`). Remaining write
   operations (`browser.messages.*`, `browser.calendar.*`) land in milestones 9-11.
3. **Local HTTP bridge** (`src/bridge.js`) — Express server, part of the MCP server
   process, bound to `127.0.0.1:8084` only (override with `BRIDGE_PORT`). Exposes
   `/health`, `/extension/heartbeat`, and the long-polling RPC endpoints
   `/extension/poll` + `/extension/result`.

## Current implementation status

- Milestones 1-3 (scaffold, profile discovery, email read path) — done.
- Milestone 4 (contacts read path) — done.
- Milestone 5 (calendar read path) — done.
- Milestone 7 (WebExtension scaffold + bridge) — done.
- Milestone 8 (send path) — done.
- Milestone 9 (message management) — done.
- Milestones 10-11 (calendar/contact write) — not started.

## Modules

- `src/profile.js` — locates the Thunderbird profile (`THUNDERBIRD_PROFILE` env var),
  parses `prefs.js` for account/server/identity/calendar/tag info, enumerates accounts
  and their mbox folder trees, and resolves a folder for a given mbox file path
  (`findFolderByAbsPath`, used by message management).
- `src/mbox.js` — low-level mbox file splitter. Streams a mailbox file and yields raw
  RFC822 message bytes plus byte offsets, with `>From` unescaping.
- `src/email.js` — structured email parsing (via `mailparser`) and search, built on
  `profile.js` + `mbox.js`. Also resolves an opaque message `id` to the
  `{accountId, folderPath, headerMessageId}` reference used by message management
  (`getMessageRef`).
- `src/contacts.js` — address book discovery and contact listing/search, reading
  `abook*.sqlite`/`history.sqlite` via `sqlite3`.
- `src/calendar.js` — calendar discovery (from `prefs.js`) and event listing, reading
  `calendar-data/local.sqlite` via `sqlite3`.
- `src/bridge.js` — local-only Express HTTP bridge (`127.0.0.1:8084`) for the
  WebExtension to talk to.
- `src/index.js` — MCP server entrypoint, registers tools, connects over stdio, and
  starts the bridge.
- `extension/` — Thunderbird WebExtension (Manifest V2): `manifest.json` +
  `background.js` — heartbeat plus a poll/execute/result loop for RPC commands
  (currently `send_email`).

## Email read path

### Folder layout (mbox)

Each Thunderbird IMAP/local account has a server directory containing one mbox file per
folder (e.g. `INBOX`, `Archive`, `Trash`). A folder with subfolders has a sibling
`<name>.sbd/` directory containing more mbox files. `.msf` files are Mork index files
and are not parsed.

### Message addressing

`search_emails` returns an opaque `id` per message: a base64url-encoded JSON object
`{ "absPath": "<absolute mbox file path>", "offset": <byte offset of the "From "
separator line> }`. `read_email` decodes this, then reads forward from `offset` until
the next `From ` separator line (or EOF) to recover the full message — so only the
offset needs to be stored, not a length.

**Caveat**: byte offsets are stable only until Thunderbird compacts the mbox file
(e.g. after emptying Trash). This is fine for a single search → read flow within a
session, but an `id` from an old session may become stale. `Message-ID` is also
returned by `search_emails` as a more durable (but not currently indexed) reference for
a possible future lookup mode.

### mbox parsing details

Thunderbird mbox files mix CRLF and LF line endings (CRLF for IMAP-fetched headers/body,
LF for Thunderbird-added headers like `X-Mozilla-Status`). `src/mbox.js` scans the file
byte-by-byte for `\n` to compute exact offsets regardless of line-ending style, and
unescapes mbox `>From`/`>>From`/... quoting at the byte level.

## Contacts read path

### Address book discovery

Thunderbird stores contacts in one or more `abook*.sqlite` / `history.sqlite` files in
the profile directory, each with a `properties` table of `(card, name, value)` rows.
`discoverAddressBooks()` finds these files and, where an address book is CardDAV-synced,
maps it to the owning account's email via the `ldap_2.servers.<id>.filename` /
`.description` / `.carddav.username` keys in `prefs.js`.

### Contact shape

Each contact card is assembled from its `properties` rows into:

```js
{ addressBook, addressBookLabel, cardId, displayName, firstName, lastName, emails: [] }
```

`emails` is a deduplicated union of the `PrimaryEmail`/`SecondEmail` properties (used by
the iCloud/CardDAV address book) and any `EMAIL`/`ITEM\d+.EMAIL` fields found in the
card's `_vCard` (vCard 3.0, regex-parsed — no vCard library dependency). Cards with no
email at all (common in the synced Google address books in this profile) still appear,
with `emails: []`.

### Mailing lists

`lists`/`list_cards` tables exist but are empty in this profile — not surfaced for v0.

### Locking

Unlike the calendar database, `abook*.sqlite`/`history.sqlite` can usually be read while
Thunderbird is running. However, while Thunderbird is actively CardDAV-syncing an
address book it switches that file into WAL mode and can hold it locked continuously
(not just transiently) — `db.configure('busyTimeout', ...)` doesn't help with a
continuous lock. `listContacts()` catches `SQLITE_BUSY`/"database is locked" per address
book and returns a friendly error for that book (other address books are unaffected);
`list_contacts` surfaces this as a tool error. See D-008.

## Calendar read path

### Calendar discovery

`listCalendars()` reads `calendar.registry.<uuid>.*` keys from `prefs.js` — this works
regardless of whether Thunderbird is running, since it's pure prefs parsing. Each
calendar has an `id` (the registry UUID), `name`, `type` (`storage` for the local
"Home" calendar, `caldav` for synced calendars), `color`, `readOnly`, and `accountEmail`
(from `.username`, for CalDAV calendars).

### Event listing

`listEvents()` reads `calendar-data/local.sqlite` (`cal_events`, joined with
`cal_properties` for `LOCATION`/`DESCRIPTION`, `cal_attendees` for attendee lists, and
`cal_recurrence` to flag recurring events). Supports filtering by `calendarId`,
`since`/`until` (event end/start vs. an ISO date), and `limit` (default 50, max 200).

**Caveats**:
- `event_start`/`event_end` are stored as PRTime (microseconds since the Unix epoch),
  per Mozilla's `calStorageCalendar` convention — converted to ISO 8601 strings.
- `cal_attendees`/`cal_recurrence` store raw `icalString` values (e.g.
  `ATTENDEE;CN=...;PARTSTAT=...:mailto:...`), parsed with a small regex helper.
- **`calendar-data/local.sqlite` is held with an exclusive lock the entire time
  Thunderbird is running** (unlike the mbox/abook files). `listEvents()` returns a
  clear error in that case — `list_events` requires Thunderbird to be closed.
- If the local cache has no events for a calendar yet (e.g. a CalDAV calendar that
  hasn't synced/cached locally), `listEvents()` simply returns fewer/no results for
  that calendar — this is not an error.

See `docs/DECISIONS.md` (D-006) for how this was verified.

## WebExtension + bridge

`src/bridge.js` starts an Express server bound to `127.0.0.1:8084` (override via
`BRIDGE_PORT`) alongside the MCP stdio server. It exposes:

- `GET /health` — `{ status, extensionConnected, lastHeartbeat }`.
- `POST /extension/heartbeat` — called by the extension's background script every 30s
  with `{ accounts: [{ id, name, type }] }`. The bridge considers the extension
  "connected" if a heartbeat was received in the last 60 seconds.
- `GET /extension/poll` — long-polled by the extension (up to 25s). Resolves
  immediately with `{ command: {...} }` if a command is queued, otherwise resolves
  with `{ command: null }` on timeout (the extension immediately re-polls).
- `POST /extension/result` — the extension posts `{ id, ok, result, error }` back after
  executing a command.

`extension/` is a Manifest V2 WebExtension (`strict_min_version: "115.0"`,
matches the installed Thunderbird 140 ESR — MV2 remains supported). Its
`background.js` heartbeats every 30s and runs a poll loop: each command from
`/extension/poll` is dispatched (by `type`) to a handler that calls the relevant
`browser.*` API and posts the outcome to `/extension/result`. All logic stays in the
MCP server — the extension only translates `{type, payload}` commands into
`browser.*` calls and relays results, per the brief's "thin shim" constraint.

To load it in Thunderbird: Settings → General → (scroll to) "Add-ons and Themes" →
gear icon → "Debug Add-ons" → "Load Temporary Add-on" → select
`extension/manifest.json`. Check the Browser Console for errors.

**Security**: the bridge binds to `127.0.0.1` explicitly (not `0.0.0.0`) — never expose
this port via a tunnel or reverse proxy.

### Send path (milestone 8)

`send_email` calls `enqueueCommand(state, 'send_email', {...})`, which rejects
immediately if the extension isn't connected (per `bridge_status`). Otherwise it queues
a `send_email` command for the extension's poll loop and waits up to 30s for a result.

In `background.js`, `sendEmail()` resolves `fromEmail` to an `identityId` via
`browser.accounts.list()` (matching `identity.email === fromEmail`), then calls
`browser.compose.beginNew({ identityId, to, cc, bcc, subject, plainTextBody|body,
isPlainText })` followed by `browser.compose.sendMessage(tab.id, { mode: 'sendNow' })`.
If no identity matches `fromEmail`, it throws before composing anything.

**Scope**: compose-and-send only — reply/reply-all are deferred (see D-008). See
`scripts/test-client.js` for the safe error-path test (an invalid `fromEmail` that the
extension rejects before composing).

### Message management (milestone 9)

`move_message`, `delete_message`, `set_message_read`, and `update_message_tags` all
take the same opaque `id` as `read_email`/`search_emails` (an mbox `{absPath, offset}`
reference, D-005). Since `browser.messages.*` addresses messages by Thunderbird's
internal numeric message id, not mbox offsets, each tool first calls
`getMessageRef({id})` (`src/email.js`) — a cheap header-only read that returns
`{accountId, folderPath, headerMessageId}` (the account/folder come from
`findFolderByAbsPath()` matching the mbox file's path; `headerMessageId` is the
`Message-ID` header). This happens entirely in the MCP server and works even if the
extension is offline (errors fast via `enqueueCommand`'s connectivity check).

The resulting `{accountId, folderPath, headerMessageId, ...}` payload is sent to the
extension, where `findMessage()` calls
`browser.messages.query({ folder: { accountId, path: '/'+folderPath }, headerMessageId
})` to recover the live `MessageHeader`, then:

- `move_message` → `browser.messages.move([msg.id], { accountId: destAccountId, path:
  '/'+destFolderPath })`. `destAccountId` defaults to the source account, resolved from
  `destAccountEmail` via `listAccounts()` if given.
- `delete_message` → `browser.messages.delete([msg.id], permanent)` (default
  `permanent: false`, i.e. moves to Trash).
- `set_message_read` → `browser.messages.update(msg.id, { read })`.
- `update_message_tags` → reads `msg.tags`, applies `addTags`/`removeTags` (tag keys —
  see `list_tags`), then `browser.messages.update(msg.id, { tags })`.

`list_tags` is a pure read-path tool (`src/profile.js`'s `listTags()`) parsing
`mailnews.tags.<key>.tag`/`.color` from `prefs.js` — works without the extension and
without Thunderbird running.

**Caveats**:
- If a message has no `Message-ID` header, `getMessageRef()` throws before any RPC —
  these tools can't target it.
- If the message has moved/been deleted since the `id` was issued (e.g. by a previous
  `move_message`/`delete_message` call, or by Thunderbird itself), `findMessage()`
  finds nothing and the extension returns a "Message not found" error — re-run
  `search_emails` to get a fresh `id`.
- A folder path used as `destFolderPath`/`folderPath` is prefixed with `/` to match
  Thunderbird's internal `MailFolder.path` convention (`list_folders` returns paths
  without a leading `/`, e.g. `"Archive"` or `"[Gmail]/All Mail"`).

### Testing the bridge/extension

`npm run test:tools` spawns its own `node src/index.js` with `BRIDGE_PORT=18084` (not
the default `8084`), so it doesn't collide with a persistent thunderbird-mcp instance
that may already be running (e.g. the one wired into Claude Desktop/Cowork, which holds
the real extension connection on `8084`). As a result, `bridge_status`/`send_email` in
the test process will normally report "not connected" and `send_email` is skipped —
this is expected. To exercise `send_email` end-to-end, use the persistent
Cowork-wired instance directly (it already has the extension connected on `8084`).

## Tools

- `list_accounts` — lists configured Thunderbird accounts (email, display name,
  hostname, type).
- `list_folders` — lists the folder tree for an account (or all accounts).
- `search_emails` — search by account/folder/sender/subject/keyword/date range.
- `read_email` — full headers + text body + attachment metadata for one message `id`.
- `list_address_books` — lists configured address books and the account (if any) each
  syncs from.
- `list_contacts` — lists/searches contacts across one or all address books, matching
  against name and email.
- `list_calendars` — lists configured calendars (name, type, color, account).
- `list_events` — lists events from the local calendar cache, filtered by calendar
  and/or date range. Requires Thunderbird to be closed.
- `bridge_status` — reports whether the Thunderbird WebExtension is currently
  connected to the local HTTP bridge.
- `send_email` — composes and sends a new email from a connected account via the
  WebExtension (`browser.compose.*`). Requires the extension to be connected — check
  `bridge_status` first.
- `list_tags` — lists configured message tags/labels (key, name, color) from
  `prefs.js`. Read-only, no extension needed.
- `move_message` — moves a message (by `id`) to another folder/account. Requires the
  extension.
- `delete_message` — deletes a message (by `id`), to Trash by default. Requires the
  extension.
- `set_message_read` — marks a message (by `id`) read or unread. Requires the
  extension.
- `update_message_tags` — adds/removes tags on a message (by `id`). Requires the
  extension.
