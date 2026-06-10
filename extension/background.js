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
      default:
        return { ok: false, error: `Unknown command type: ${command.type}` }
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
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
