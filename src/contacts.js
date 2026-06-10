import sqlite3 from 'sqlite3'
import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { getProfileDir, parsePrefsJs } from './profile.js'

const DEFAULT_LABELS = {
  'abook.sqlite': 'Personal Address Book',
  'history.sqlite': 'Collected Addresses',
}

const ADDRESS_BOOK_FILE_RE = /^(abook(-\d+)?|history)\.sqlite$/

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Discovers Thunderbird address book SQLite files in the profile directory,
 * matching them up with the account email they sync from (via CardDAV prefs)
 * where possible.
 */
export function discoverAddressBooks(profileDir) {
  const prefs = parsePrefsJs(profileDir)
  const serverInfo = new Map()

  for (const [key, value] of prefs) {
    const match = /^ldap_2\.servers\.([^.]+)\.filename$/.exec(key)
    if (!match) continue
    const serverId = match[1]
    serverInfo.set(value, {
      description: prefs.get(`ldap_2.servers.${serverId}.description`) ?? null,
      accountEmail: prefs.get(`ldap_2.servers.${serverId}.carddav.username`) ?? null,
    })
  }

  return readdirSync(profileDir)
    .filter((f) => ADDRESS_BOOK_FILE_RE.test(f) && existsSync(join(profileDir, f)))
    .map((filename) => {
      const info = serverInfo.get(filename)
      return {
        id: filename,
        label: info?.description ?? DEFAULT_LABELS[filename] ?? filename,
        accountEmail: info?.accountEmail ?? null,
        path: join(profileDir, filename),
      }
    })
}

// vCard EMAIL lines look like "EMAIL;TYPE=INTERNET,pref:foo@example.com" or
// "ITEM1.EMAIL;TYPE=...:foo@example.com". Lines may be folded (continued on the
// next line with a leading space/tab), so unfold first.
function parseVCardEmails(vcard) {
  if (!vcard) return []
  const unfolded = vcard.replace(/\r?\n[ \t]/g, '')
  const emails = []
  const re = /^(?:item\d+\.)?EMAIL[^:\r\n]*:(.+)$/gim
  let match
  while ((match = re.exec(unfolded))) {
    emails.push(match[1].trim())
  }
  return emails
}

function buildContact(addressBook, cardId, props) {
  const vcardEmails = parseVCardEmails(props._vCard)
  const emails = [...new Set([props.PrimaryEmail, props.SecondEmail, ...vcardEmails].filter(Boolean))]

  return {
    addressBook: addressBook.id,
    addressBookLabel: addressBook.label,
    cardId,
    displayName: props.DisplayName || null,
    firstName: props.FirstName || null,
    lastName: props.LastName || null,
    emails,
  }
}

async function getContactsFromAddressBook(addressBook) {
  const db = new sqlite3.Database(addressBook.path, sqlite3.OPEN_READONLY)
  db.configure('busyTimeout', 3000)
  try {
    const rows = await all(db, 'SELECT card, name, value FROM properties')
    const cards = new Map()
    for (const row of rows) {
      if (!cards.has(row.card)) cards.set(row.card, {})
      cards.get(row.card)[row.name] = row.value
    }
    return [...cards.entries()].map(([cardId, props]) => buildContact(addressBook, cardId, props))
  } catch (error) {
    if (error.code === 'SQLITE_BUSY' || /database is locked/i.test(error.message)) {
      throw new Error(`Address book "${addressBook.label}" is locked — Thunderbird may be syncing contacts; try again shortly.`)
    }
    throw error
  } finally {
    await closeDb(db)
  }
}

/**
 * Lists all configured address books.
 */
export function listAddressBooks() {
  return discoverAddressBooks(getProfileDir()).map(({ id, label, accountEmail }) => ({
    id,
    label,
    accountEmail,
  }))
}

/**
 * Lists/searches contacts across one or all address books. `query` matches
 * (case-insensitively) against display name, first/last name, or any email.
 */
export async function listContacts({ query, addressBook, limit } = {}) {
  const cappedLimit = Math.min(Math.max(limit ?? 50, 1), 200)
  const queryLower = query?.toLowerCase()

  let addressBooks = discoverAddressBooks(getProfileDir())
  if (addressBook) addressBooks = addressBooks.filter((ab) => ab.id === addressBook)

  const results = []

  for (const ab of addressBooks) {
    const contacts = await getContactsFromAddressBook(ab)
    for (const contact of contacts) {
      if (queryLower) {
        const haystack = [contact.displayName, contact.firstName, contact.lastName, ...contact.emails]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(queryLower)) continue
      }

      results.push(contact)
      if (results.length >= cappedLimit) return results
    }
  }

  return results
}
