# thunderbird-mcp — Decisions log

Append-only. When reversing a decision, add a new entry rather than editing the old one.

## D-001 · Mail format is mbox, not Maildir

**Decided:** 2026-06-10
**Context:** Brief listed "mbox vs Maildir" as an open question.
**Decision:** Confirmed mbox via `file` on `ImapMail/imap.gmail.com/INBOX` ("Mailbox
text, 1st line 'From - ...'"). All accounts on this profile use mbox.
**Why:** Determines the parser in `src/mbox.js` — no Maildir support needed.
**Trade-off:** None for this profile; if a future profile uses Maildir, `src/mbox.js`
would need a parallel implementation.

## D-002 · Bridge port reserved as 8084

**Decided:** 2026-06-10
**Context:** Brief asked to run `check-projects` and pick an available port for the
future WebExtension↔MCP bridge.
**Decision:** Port 8084 is free locally (8081-8083 and others are taken by other
services). Reserved for the future bridge — not used by milestones 1-3, and not added
to the shared `check-projects` port map since it's local-only.
**Why:** Avoids future port collisions when the WebExtension bridge is built.
**Trade-off:** None.

## D-003 · Active Thunderbird profile

**Decided:** 2026-06-10
**Context:** Two profiles exist (`profiles.ini`); one is empty/unused.
**Decision:** `~/.thunderbird/7cz0uali.default-default` is the active profile with mail,
contacts, and calendar data. Set as `THUNDERBIRD_PROFILE` in the local (gitignored)
`.env`.
**Why:** Required for all profile-parsing modules.
**Trade-off:** None — `THUNDERBIRD_PROFILE` remains user-configurable via env var, never
hardcoded in source.

## D-004 · Plain Node ESM, not TypeScript

**Decided:** 2026-06-10
**Context:** Brief references `colour-match` (plain Node v24 ESM + Express) as the
Node/Express pattern, and doesn't specify TypeScript.
**Decision:** `src/` is plain JavaScript (`"type": "module"`), matching the
`colour-match` style rather than the TypeScript `gtasks-mcp` reference.
**Why:** Consistency with the brief's stated reference project and simpler tooling (no
build step needed for an stdio MCP process).
**Trade-off:** No compile-time type checking.

## D-005 · Message addressing: offset-only, not offset+length

**Decided:** 2026-06-10
**Context:** Initial design for `read_email`'s opaque `id` considered storing
`(folderPath, byteOffset, byteLength)`. Implementing the mbox parser revealed
Thunderbird mbox files mix CRLF and LF line endings, and a message's "length" is just
"until the next `From ` separator or EOF" anyway.
**Decision:** `id` encodes `{ absPath, offset }` only (base64url JSON). `read_email`
scans forward from `offset` until the next separator line or EOF.
**Why:** Simpler, smaller id, and avoids any risk of a stored length disagreeing with
the actual message boundary.
**Trade-off:** `read_email` must scan forward token-by-token rather than doing a single
fixed-size read — negligible cost since messages are small relative to mbox files.

## D-006 · Calendar read path requires Thunderbird closed; no real cached events to test against

**Decided:** 2026-06-10
**Context:** While building `src/calendar.js`, found that `calendar-data/local.sqlite`
is held with an exclusive lock the entire time Thunderbird is running (unlike
`abook*.sqlite`, which can be read concurrently). Additionally, in this profile
`cal_events`/`cal_todos`/`cal_properties`/`cal_attendees`/`cal_recurrence` all have 0
rows even with Thunderbird closed — none of the configured CalDAV calendars have a
populated local cache yet.
**Decision:** `listCalendars()` reads only `prefs.js` (`calendar.registry.*`) and works
regardless of Thunderbird's state. `listEvents()` reads `calendar-data/local.sqlite`;
if the file is missing it returns `[]`, and if it's locked it throws a clear error
("Calendar database is locked — close Thunderbird and try again."). Date columns
(`event_start`/`event_end`) are treated as PRTime (microseconds since the Unix epoch),
matching Mozilla's `calStorageCalendar` convention; `cal_attendees`/`cal_recurrence`
rows store raw `icalString` (e.g. `ATTENDEE;CN=...;PARTSTAT=...:mailto:...`), parsed
with a small regex helper.
**Why:** Schema (table/column names) was confirmed directly against this profile's
`local.sqlite` (schema version 23), but row-level parsing (PRTime conversion, attendee
icalString format) was verified only against a synthetic temp database with the same
schema, since this profile has no real cached events.
**Trade-off:** `list_events` will return `[]` until Thunderbird has synced and cached
at least one calendar locally — re-verify against real data once that happens, and
revisit the PRTime/icalString assumptions if results look wrong.

## D-007 · WebExtension manifest version: MV2

**Decided:** 2026-06-10
**Context:** Brief specified "Manifest V2 (Thunderbird 115 compatibility) — verify
against installed version". Installed version is Thunderbird 140.11.0esr.
**Decision:** `extension/manifest.json` uses `manifest_version: 2` with
`strict_min_version: "115.0"`. Thunderbird 140 still supports MV2 (unlike Chrome/Firefox,
Thunderbird has not removed MV2 support), and MV2's `background.scripts` + persistent
background page model is simpler and better-documented for the `browser.messages.*` /
`browser.compose.*` / `browser.addressBooks.*` APIs this project needs.
**Why:** Avoids MV3's service-worker lifecycle complexity (no persistent background
page, harder to maintain a heartbeat) for no compatibility benefit on this Thunderbird
version.
**Trade-off:** If a future Thunderbird release drops MV2 support, the extension will
need a migration to MV3 (service worker + `browser.scripting`/`alarms` for the
heartbeat instead of `setInterval`).

## D-008 · Send path: long-polling RPC bridge, address book WAL locking, and send-only scope

**Decided:** 2026-06-10
**Context:** Building milestone 8 (`send_email`) required (a) a way for the MCP server
to invoke `browser.*` APIs running in the WebExtension's background page, (b) a new
`SQLITE_BUSY` failure mode discovered in `list_contacts` testing, and (c) a scoping
call on how much of the brief's "Email — send" surface to cover now.

**Decisions:**
- **RPC mechanism**: `GET /extension/poll` (long-polled, 25s timeout) +
  `POST /extension/result`. The MCP server's `enqueueCommand()` hands a `{id, type,
  payload}` to a waiting poll request (or queues it if none is waiting) and returns a
  promise that resolves/rejects when `/extension/result` posts back, or after a 30s
  command timeout. Chosen over WebSockets/SSE because MV2's persistent background page
  can hold a long-lived `fetch` trivially, and this needed no new dependencies.
- **Address book locking**: Thunderbird can switch `abook*.sqlite`/`history.sqlite`
  into WAL mode and hold them locked *continuously* during active CardDAV sync (not
  just transiently, unlike typical SQLite contention). `db.configure('busyTimeout',
  ...)` doesn't help with a continuous lock. `getContactsFromAddressBook()` now catches
  `SQLITE_BUSY`/"database is locked" per address book and throws a friendly,
  per-book error (mirrors D-006's pattern for `calendar.js`); other address books are
  unaffected. `scripts/test-client.js` treats this as an expected/non-fatal result for
  `list_contacts`, same as it already did for `list_events`.
- **Scope**: `send_email` covers compose-and-send only (`browser.compose.beginNew` +
  `sendMessage(mode: 'sendNow')`). Reply/reply-all are deferred — `read_email`'s `id`
  is an mbox `{absPath, offset}` (D-005), which doesn't map to Thunderbird's internal
  WebExtension message IDs needed for `browser.compose.beginReply()`. A future
  milestone would need to resolve that mapping (e.g. via `browser.messages.query()`
  matched on the `Message-ID` header) before reply support can be added.

**Why:** Long-polling fits MV2 with zero new dependencies; the address book fix keeps
`list_contacts` consistent with `list_events`'s existing "locked DB" UX; scoping send
to compose-only avoids blocking milestone 8 on an unverified message-id-mapping design.

**Trade-off:** Long-polling holds one open connection per idle extension instance and
adds up to ~25s of poll-cycle latency in the worst case (negligible for interactive
use). Reply/reply-all remain unimplemented until the message-id mapping is designed.
