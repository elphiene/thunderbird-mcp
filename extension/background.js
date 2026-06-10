const BRIDGE_URL = 'http://127.0.0.1:8084'
const HEARTBEAT_INTERVAL_MS = 30_000

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

sendHeartbeat()
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
