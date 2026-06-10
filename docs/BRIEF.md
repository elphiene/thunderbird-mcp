# New project brief — thunderbird-mcp

> Filled in: Jun 10 2026. Copy to new repo as `docs/BRIEF.md`.

---

## 1. Identity

- **Name:** `thunderbird-mcp`
- **One-liner:** An MCP server that gives Claude full control of Thunderbird — read, search, manage, and send emails across all connected accounts, look up contacts, and access the unified calendar including iCloud.
- **Why now:** Claude's Gmail MCP only covers one Google account. iCloud mail and calendar have no MCP at all. Thunderbird already aggregates everything — Gmail, iCloud, and any other accounts — in one place with full local access. This bridges the gap and gives Claude a truly unified inbox, contact book, send capability, and calendar without relying on per-service cloud APIs.

---

## 2. Account & repo

- **GitHub account:** `elphiene`
- **Repo name:** `thunderbird-mcp`
- **Visibility:** Public — strip `CLAUDE.md`, `.claude/`, `PLAN.md`, `Co-Authored-By: Claude` before commits
- **License:** MIT

---

## 3. Audience & purpose

- **Primary user:** El (personal use; reusable by anyone with Thunderbird + Claude)
- **Problem it solves:** Claude can only see one Gmail inbox and one Google Calendar. iCloud mail and calendar are completely invisible. Contacts are siloed. Thunderbird already aggregates all of this — this exposes it to Claude via MCP so it can read, search, manage, send, and schedule across every connected account from one interface.
- **"Done for now" means:** Claude can read/search any inbox, move/delete/label messages, look up and manage contacts, send from any connected account, and read/create/modify calendar events — all routed through Thunderbird, covering accounts that have no other MCP.
- **Success signal:** "Search my iCloud inbox for anything from Amelia" works. "Send Cherry a message from my iCloud address" works. "Move all newsletters to the Archive folder" works. "What's on my calendar next week?" returns events from all calendars including iCloud CalDAV.

---

## 4. Tech stack

### Architecture

Three layers working together:

**A. MCP server (Node)** — stdio MCP process, exposes all tools to Claude.
- **Read path** (no extension needed): parses Thunderbird profile files directly — mbox/Maildir for emails, `abook.sqlite` for contacts, `calendar-data/` SQLite for calendar events. Works even with Thunderbird closed.
- **Write/send/manage path**: communicates with the Thunderbird WebExtension over a local-only HTTP bridge.

**B. Thunderbird WebExtension** — installs into Thunderbird, exposes a localhost HTTP API using the MailExtension and Calendar APIs for all write operations:
- Send/compose email (`browser.compose.*`)
- Move, delete, label/tag messages (`browser.messages.*`)
- Create, modify, delete calendar events (`browser.calendar.*`)
- Live folder and account enumeration

**C. Local HTTP bridge** — Express server (part of the MCP server process) that the WebExtension POSTs to / GETs from. localhost only, never exposed externally.

### Stack
- **MCP server:** Node v24 ESM + `@modelcontextprotocol/sdk` + Express (bridge)
- **Profile parsing:** Node `fs` + `sqlite3` (async) — mbox/Maildir + `abook.sqlite` + `calendar-data/*.sqlite`
- **WebExtension:** Thunderbird MailExtension API (JS, Manifest V2 for Thunderbird 115 compatibility)
- **IPC:** localhost HTTP only

### Hard constraints
- Must not expose any port via Cloudflare tunnel — local only
- Must work read-only when Thunderbird is closed (no WebExtension running)
- `sqlite3` not `better-sqlite3` (Node v24)
- `THUNDERBIRD_PROFILE` env var for profile path — never hardcoded
- Public repo — no credentials, profile paths, or personal data in source

### Reference projects
- MCP pattern: `@modelcontextprotocol/server-filesystem`
- Node/Express pattern: `colour-match` (Node v24 ESM + Express)

---

## 5. Deployment

- **Where it runs:** Local only — stdio MCP process, no systemd service, no domain
- **Port:** One localhost port for the WebExtension ↔ MCP bridge (pick from available, document in README — not added to the public port map)
- **Cloudflare:** N/A — never

### Wiring into Claude (Cowork)
Add to `~/.config/Claude/claude_desktop_config.json`:
```json
"thunderbird": {
  "command": "node",
  "args": ["/home/el/Documents/El-Projects/thunderbird-mcp/src/index.js"],
  "env": {
    "THUNDERBIRD_PROFILE": "/home/el/.thunderbird/<profile-dir>"
  }
}
```

---

## 6. Scope

### In scope for v0.1.0

**Email — read**
- Search emails by sender, subject, date, keyword, account, folder
- Read full email content (body + headers)
- List accounts and folder/label structure

**Email — manage**
- Move messages between folders
- Delete messages (to trash or permanent)
- Mark as read/unread
- Add/remove tags/labels

**Email — send**
- Compose and send from any connected Thunderbird account
- Reply and reply-all to existing threads

**Contacts**
- Look up contacts by name or email
- List all contacts in address book
- Create new contacts
- Update existing contact details

**Calendar**
- List all calendars (including iCloud CalDAV, Google)
- Read events by date range, title, or keyword
- Create new events on any calendar
- Modify existing events (time, title, description, location)
- Delete events
- Graceful degradation: read calendar SQLite directly if Thunderbird is closed; write requires WebExtension

### Out of scope (YAGNI)
- Attachment upload/download beyond noting they exist
- Multi-profile support (single active profile only)
- Any UI
- Recurring event recurrence rule editing (can read, not modify RRULE)
- Calendar invites / RSVP handling

### Open questions — resolved (see `docs/DECISIONS.md`)
- ~~What port for the WebExtension bridge?~~ → 8084 (D-002)
- ~~mbox or Maildir?~~ → mbox (D-001)
- ~~Which Thunderbird version?~~ → see D-003/profile notes; determines MV2 vs MV3 for
  the extension manifest, to be confirmed when milestone 7 starts
- ~~Is Thunderbird Calendar installed and used?~~ → yes, 9 calendars configured
  (Google + iCloud CalDAV + local "Home" storage calendar)

---

## 7. Things NOT to do

- Don't expose the bridge port externally — ever
- Don't store credentials or decoded email content in source
- Don't use `better-sqlite3` (fails on Node v24)
- Don't hardcode the profile path
- Don't make the WebExtension do more than it needs to — MCP server handles all the logic, extension is just a thin API shim
- Don't track `CLAUDE.md`, `.claude/`, `PLAN.md`, or `Co-Authored-By:` in commits (public repo)

---

## 8. Visual / design notes

CLI/MCP tool — no UI. README should be clear enough for another Thunderbird user to set it up in under 10 minutes.

---

## 9. Notes for Claude

- Public repo on `elphiene` — strip Claude artifacts before every commit
- `gh auth switch --user elphiene` before any GitHub ops
- Folder structure: `src/` (MCP server), `extension/` (WebExtension), `docs/`
- The WebExtension manifest must declare permissions for: `messagesRead`, `messagesMove`, `messagesDelete`, `messagesTags`, `compose`, `accountsRead`, `addressBooks`, `contacts`, `calendar` (if available in this Thunderbird version)
- Test read-only path first (no extension needed) — that's the fastest way to confirm profile parsing works before touching the extension

---

## 10. First milestones

1. ✅ **Scaffold** — repo + CLAUDE.md + docs/ + .gitignore (public repo rules) + pick bridge port
2. ✅ **Profile discovery** — detect Thunderbird profile dir, list accounts and folders, confirm mbox vs Maildir
3. ✅ **Email read path** — parse mbox/Maildir, search and read messages, MCP tools wired up and testable in Cowork
4. ✅ **Contact read path** — parse `abook*.sqlite`, look up and list contacts
5. ✅ **Calendar read path** — parse `calendar-data/local.sqlite`, list events by date range across all calendars
   (note: requires Thunderbird closed — see `docs/DECISIONS.md` D-006)
6. **Read-only v0.0.5 tag** — everything above working end-to-end, install docs written
7. **WebExtension scaffold** — manifest + background script + localhost HTTP listener, loads in Thunderbird without errors
8. **Send path** — compose and send from any account via extension bridge
9. **Message management** — move, delete, tag/label via extension bridge
10. **Calendar write path** — create, modify, delete events via extension bridge
11. **Contact write path** — create and update contacts via extension bridge
12. **Polish** — error handling, graceful degradation when extension is offline, README install guide
13. **v0.1.0 tag** — full feature set working, public release

---

## Initial setup checklist

- [ ] `gh auth switch --user elphiene`
- [ ] Check Thunderbird version: `thunderbird --version`
- [ ] Check profile storage: `ls ~/.thunderbird/*/Mail/`
- [ ] Check if Thunderbird Calendar is installed and active
- [ ] Run `check-projects`, pick available bridge port
- [ ] `new-project thunderbird-mcp --stack app --account elphiene --public` (or manual scaffold)
- [ ] Add `THUNDERBIRD_PROFILE` to `.env` (gitignored)
- [ ] Add to `claude_desktop_config.json` once MCP server is working (step 3)
