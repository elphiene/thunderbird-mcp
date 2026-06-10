# thunderbird-mcp — Architecture

> Decisions log: see `docs/DECISIONS.md`. Full project brief: `docs/BRIEF.md`.

## Three layers (per the brief)

1. **MCP server (Node v24 ESM)** — stdio MCP process exposing tools to Claude.
   - **Read path** (current focus, works with Thunderbird closed): parses the
     Thunderbird profile directly — mbox for email, `abook.sqlite` for contacts,
     `calendar-data/*.sqlite` for calendar.
   - **Write/send/manage path** (future): talks to the Thunderbird WebExtension over a
     local-only HTTP bridge.
2. **Thunderbird WebExtension** (future) — thin localhost HTTP API shim for write
   operations (`browser.compose.*`, `browser.messages.*`, `browser.calendar.*`).
3. **Local HTTP bridge** (future) — Express server, part of the MCP server process,
   localhost-only, port 8084.

## Current implementation status

- Milestones 1-3 (scaffold, profile discovery, email read path) — done.
- Milestone 4 (contacts read path) — done.
- Milestones 5+ (calendar, WebExtension, write paths) — not started.

## Modules

- `src/profile.js` — locates the Thunderbird profile (`THUNDERBIRD_PROFILE` env var),
  parses `prefs.js` for account/server/identity info, enumerates accounts and their
  mbox folder trees.
- `src/mbox.js` — low-level mbox file splitter. Streams a mailbox file and yields raw
  RFC822 message bytes plus byte offsets, with `>From` unescaping.
- `src/email.js` — structured email parsing (via `mailparser`) and search, built on
  `profile.js` + `mbox.js`.
- `src/contacts.js` — address book discovery and contact listing/search, reading
  `abook*.sqlite`/`history.sqlite` via `sqlite3`.
- `src/index.js` — MCP server entrypoint, registers tools and connects over stdio.

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
