import { simpleParser } from 'mailparser'
import { iterateMboxMessages, readMessageAt } from './mbox.js'
import { getProfileDir, enumerateAllFolders, findFolderByAbsPath } from './profile.js'

const SNIPPET_LENGTH = 200

/**
 * Parses a raw RFC822 message buffer into a structured object.
 */
export async function parseMessage(rawBuffer) {
  const parsed = await simpleParser(rawBuffer)

  return {
    messageId: parsed.messageId || null,
    from: parsed.from?.text || null,
    to: parsed.to?.text || null,
    cc: parsed.cc?.text || null,
    subject: parsed.subject || null,
    date: parsed.date ? parsed.date.toISOString() : null,
    textBody: parsed.text || '',
    hasAttachments: parsed.attachments.length > 0,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename || null,
      size: a.size ?? null,
    })),
  }
}

// Cheap header extraction from the raw header block (before the first blank
// line), used to filter messages during search without running a full
// mailparser pass on every message.
function extractHeaders(raw) {
  const text = raw.toString('utf-8')
  const headerEnd = text.search(/\r?\n\r?\n/)
  const headerBlock = headerEnd === -1 ? text : text.slice(0, headerEnd)
  // Unfold continuation lines (RFC 822 header folding).
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ')

  const headers = {}
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    if (!(key in headers)) headers[key] = match[2].trim()
  }
  return headers
}

function encodeId(absPath, offset) {
  return Buffer.from(JSON.stringify({ absPath, offset }), 'utf-8').toString('base64url')
}

function decodeId(id) {
  try {
    const { absPath, offset } = JSON.parse(Buffer.from(id, 'base64url').toString('utf-8'))
    if (typeof absPath !== 'string' || typeof offset !== 'number') {
      throw new Error('malformed id')
    }
    return { absPath, offset }
  } catch {
    throw new Error(`Invalid email id: ${id}`)
  }
}

/**
 * Searches messages across one or more mbox folders, filtering on cheap
 * header/keyword matches. Returns lightweight result objects with an opaque
 * `id` usable with readEmail().
 */
export async function searchEmails({
  accountEmail,
  folderPath,
  sender,
  subject,
  keyword,
  since,
  until,
  limit,
} = {}) {
  if (!accountEmail && !folderPath && !sender && !subject && !keyword) {
    throw new Error(
      'search_emails requires at least one of: accountEmail, folderPath, sender, subject, keyword'
    )
  }

  const cappedLimit = Math.min(Math.max(limit ?? 20, 1), 100)
  const sinceDate = since ? new Date(since) : null
  const untilDate = until ? new Date(until) : null
  const senderLower = sender?.toLowerCase()
  const subjectLower = subject?.toLowerCase()
  const keywordLower = keyword?.toLowerCase()

  let folders = enumerateAllFolders(getProfileDir()).filter((f) => f.hasMessages)
  if (accountEmail) folders = folders.filter((f) => f.accountEmail === accountEmail)
  if (folderPath) {
    folders = folders.filter(
      (f) => f.folderPath === folderPath || f.folderPath.endsWith(`/${folderPath}`)
    )
  }

  const results = []

  for (const folder of folders) {
    for await (const msg of iterateMboxMessages(folder.absPath)) {
      const headers = extractHeaders(msg.raw)
      const msgSubject = headers.subject || ''
      const msgFrom = headers.from || ''
      const msgDate = headers.date ? new Date(headers.date) : null

      if (senderLower && !msgFrom.toLowerCase().includes(senderLower)) continue
      if (subjectLower && !msgSubject.toLowerCase().includes(subjectLower)) continue
      if (sinceDate && (!msgDate || msgDate < sinceDate)) continue
      if (untilDate && (!msgDate || msgDate > untilDate)) continue
      if (keywordLower) {
        const haystack = `${msgSubject}\n${msgFrom}\n${msg.raw.toString('utf-8')}`.toLowerCase()
        if (!haystack.includes(keywordLower)) continue
      }

      let snippet = ''
      try {
        const parsed = await simpleParser(msg.raw)
        snippet = (parsed.text || '').slice(0, SNIPPET_LENGTH)
      } catch {
        // Leave snippet empty if the message fails to parse.
      }

      results.push({
        id: encodeId(folder.absPath, msg.offset),
        accountEmail: folder.accountEmail,
        folderPath: folder.folderPath,
        subject: msgSubject || null,
        from: msgFrom || null,
        date: msgDate ? msgDate.toISOString() : null,
        messageId: headers['message-id'] || null,
        snippet,
      })

      if (results.length >= cappedLimit) return results
    }
  }

  return results
}

/**
 * Reads a single message by its opaque id, returning full headers, text body,
 * and attachment metadata (names/sizes only).
 */
export async function readEmail({ id }) {
  const { absPath, offset } = decodeId(id)
  const raw = await readMessageAt(absPath, offset)
  return parseMessage(raw)
}

/**
 * Resolves an opaque message id to the identifying information the
 * WebExtension needs to find the message via browser.messages.query():
 * the account/folder it currently lives in (per the local mbox copy) plus
 * its Message-ID header. Used by move/delete/tag management tools.
 *
 * Note: if the message has already been moved/deleted since the id was
 * issued, this still resolves based on the *original* mbox location —
 * the extension's query may then find nothing, which surfaces as a clear
 * "message not found" error from the bridge.
 */
export async function getMessageRef({ id }) {
  const { absPath, offset } = decodeId(id)
  const raw = await readMessageAt(absPath, offset)
  const headers = extractHeaders(raw)
  const headerMessageId = headers['message-id'] || null
  if (!headerMessageId) {
    throw new Error('This message has no Message-ID header — it cannot be targeted by management operations.')
  }

  const folder = findFolderByAbsPath(getProfileDir(), absPath)
  if (!folder) {
    throw new Error('Could not resolve the account/folder for this message.')
  }

  return {
    accountId: folder.accountId,
    accountEmail: folder.accountEmail,
    folderPath: folder.folderPath,
    headerMessageId,
    subject: headers.subject || null,
  }
}
