const BRIDGE_URL = 'http://127.0.0.1:8084'
const HEARTBEAT_INTERVAL_MS = 30_000
const POLL_FETCH_TIMEOUT_MS = 30_000
const POLL_RETRY_DELAY_MS = 5_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendHeartbeat() {
  try {
    const accounts = await browser.accounts.list()
    await fetch(`${BRIDGE_URL}/extension/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          type: account.type,
        })),
      }),
    })
  } catch (error) {
    // The MCP server isn't always running — that's expected, not an error to surface.
    console.debug('thunderbird-mcp bridge: heartbeat failed (is the MCP server running?)', error)
  }
}

async function pollLoop() {
  while (true) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), POLL_FETCH_TIMEOUT_MS)
      let response
      try {
        response = await fetch(`${BRIDGE_URL}/extension/poll`, { signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }

      const { command } = await response.json()
      if (command) {
        const outcome = await executeCommand(command)
        await fetch(`${BRIDGE_URL}/extension/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: command.id, ...outcome }),
        })
      }
    } catch (error) {
      console.debug('thunderbird-mcp bridge: poll failed, retrying', error)
      await sleep(POLL_RETRY_DELAY_MS)
    }
  }
}

async function executeCommand(command) {
  try {
    switch (command.type) {
      case 'send_email':
        return { ok: true, result: await sendEmail(command.payload) }
      case 'move_message':
        return { ok: true, result: await moveMessage(command.payload) }
      case 'delete_message':
        return { ok: true, result: await deleteMessage(command.payload) }
      case 'set_message_read':
        return { ok: true, result: await setMessageRead(command.payload) }
      case 'update_message_tags':
        return { ok: true, result: await updateMessageTags(command.payload) }
      default:
        return { ok: false, error: `Unknown command type: ${command.type}` }
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

// Resolves a message identified by (accountId, folderPath, headerMessageId) —
// the addressing scheme used by the MCP server's mbox-based message ids — to
// the WebExtension's internal MessageHeader.
async function findMessage({ accountId, folderPath, headerMessageId }) {
  const { messages } = await browser.messages.query({
    folder: { accountId, path: `/${folderPath}` },
    headerMessageId,
  })
  if (!messages.length) {
    throw new Error(`Message not found in /${folderPath} (it may have been moved or deleted)`)
  }
  return messages[0]
}

async function moveMessage({ accountId, folderPath, headerMessageId, destAccountId, destFolderPath }) {
  const message = await findMessage({ accountId, folderPath, headerMessageId })
  await browser.messages.move([message.id], { accountId: destAccountId, path: `/${destFolderPath}` })
  return { moved: true }
}

async function deleteMessage({ accountId, folderPath, headerMessageId, permanent = false }) {
  const message = await findMessage({ accountId, folderPath, headerMessageId })
  await browser.messages.delete([message.id], permanent)
  return { deleted: true, permanent }
}

async function setMessageRead({ accountId, folderPath, headerMessageId, read }) {
  const message = await findMessage({ accountId, folderPath, headerMessageId })
  await browser.messages.update(message.id, { read })
  return { read }
}

async function updateMessageTags({ accountId, folderPath, headerMessageId, addTags = [], removeTags = [] }) {
  const message = await findMessage({ accountId, folderPath, headerMessageId })
  const tags = new Set(message.tags || [])
  for (const tag of addTags) tags.add(tag)
  for (const tag of removeTags) tags.delete(tag)
  const result = [...tags]
  await browser.messages.update(message.id, { tags: result })
  return { tags: result }
}

async function sendEmail({ fromEmail, to, cc, bcc, subject, body, isPlainText = true }) {
  const accounts = await browser.accounts.list()
  let identityId
  for (const account of accounts) {
    const identity = account.identities.find((i) => i.email === fromEmail)
    if (identity) {
      identityId = identity.id
      break
    }
  }
  if (!identityId) {
    throw new Error(`No identity found for ${fromEmail}`)
  }

  const details = { identityId, to, subject, isPlainText }
  if (cc?.length) details.cc = cc
  if (bcc?.length) details.bcc = bcc
  if (isPlainText) {
    details.plainTextBody = body
  } else {
    details.body = body
  }

  const tab = await browser.compose.beginNew(details)
  await browser.compose.sendMessage(tab.id, { mode: 'sendNow' })
  return { sent: true }
}

sendHeartbeat()
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
pollLoop()
