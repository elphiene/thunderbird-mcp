# thunderbird-mcp — Architecture

> Decisions log: see `docs/DECISIONS.md`. Full project brief: `docs/BRIEF.md`.

## Three layers (per the brief)

1. **MCP server (Node v24 ESM)** — stdio MCP process exposing tools to Claude.
   - **Read path** (current focus, works with Thunderbird closed): parses the
     Thunderbird profile directly — mbox for email, `abook.sqlite` for contacts,
     `calendar-data/*.sqlite` for calendar.
   - **Write/send/manage path** (future): talks to the Thunderbird WebExtension over a
     local-only HTTP bridge.
2. **Thunderbird WebExtension** (`extension/`, scaffolded) — thin shim. Currently just
   sends a periodic heartbeat with the account list; write operations
   (`browser.compose.*`, `browser.messages.*`, `browser.calendar.*`) land in
   milestones 8-11.
3. **Local HTTP bridge** (`src/bridge.js`) — Express server, part of the MCP server
   process, bound to `127.0.0.1:8084` only (override with `BRIDGE_PORT`). Currently
   exposes `/health` and `/extension/heartbeat`.

## Current implementation status

- Milestones 1-3 (scaffold, profile discovery, email read path) — done.
- Milestone 4 (contacts read path) — done.
- Milestone 5 (calendar read path) — done.
- Milestone 7 (WebExtension scaffold + bridge) — done.
- Milestones 8-11 (send, message management, calendar/contact write) — not started.

## Modules

- `src/profile.js` — locates the Thunderbird profile (`THUNDERBIRD_PROFILE` env var),
  parses `prefs.js` for account/server/identity/calendar info, enumerates accounts and
  their mbox folder trees.
- `src/mbox.js` — low-level mbox file splitter. Streams a mailbox file and yields raw
  RFC822 message bytes plus byte offsets, with `>From` unescaping.
- `src/email.js` — structured email parsing (via `mailparser`) and search, built on
  `profile.js` + `mbox.js`.
- `src/contacts.js` — address book discovery and contact listing/search, reading
  `abook*.sqlite`/`history.sqlite` via `sqlite3`.
- `src/calendar.js` — calendar discovery (from `prefs.js`) and event listing, reading
  `calendar-data/local.sqlite` via `sqlite3`.
- `src/bridge.js` — local-only Express HTTP bridge (`127.0.0.1:8084`) for the
  WebExtension to talk to.
- `src/index.js` — MCP server entrypoint, registers tools, connects over stdio, and
  starts the bridge.
- `extension/` — Thunderbird WebExtension (Manifest V2): `manifest.json` +
  `background.js`, currently just a heartbeat shim.

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

## WebExtension + bridge (scaffold)

`src/bridge.js` starts an Express server bound to `127.0.0.1:8084` (override via
`BRIDGE_PORT`) alongside the MCP stdio server. It currently exposes:

- `GET /health` — `{ status, extensionConnected, lastHeartbeat }`.
- `POST /extension/heartbeat` — called by the extension's background script every 30s
  with `{ accounts: [{ id, name, type }] }`. The bridge considers the extension
  "connected" if a heartbeat was received in the last 60 seconds.

`extension/` is a Manifest V2 WebExtension (`strict_min_version: "115.0"`,
matches the installed Thunderbird 140 ESR — MV2 remains supported). Its
`background.js` does nothing but heartbeat for now; all real logic
(`browser.compose.*`, `browser.messages.*`, etc.) will be added in milestones 8-11,
keeping the extension itself a thin shim per the brief's constraints.

To load it in Thunderbird: Settings → General → (scroll to) "Add-ons and Themes" →
gear icon → "Debug Add-ons" → "Load Temporary Add-on" → select
`extension/manifest.json`. Check the Browser Console for errors.

**Security**: the bridge binds to `127.0.0.1` explicitly (not `0.0.0.0`) — never expose
this port via a tunnel or reverse proxy.

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
