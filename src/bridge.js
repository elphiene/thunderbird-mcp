import express from 'express'

const HEARTBEAT_STALE_MS = 60_000

/**
 * Local-only HTTP bridge between the MCP server and the Thunderbird
 * WebExtension. Binds to 127.0.0.1 only — never expose this port externally
 * (no Cloudflare tunnel, no 0.0.0.0).
 */
export function createBridge() {
  const app = express()
  app.use(express.json())

  const state = {
    lastHeartbeat: null,
    accounts: [],
  }

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      extensionConnected: isExtensionConnected(state),
      lastHeartbeat: state.lastHeartbeat,
    })
  })

  app.post('/extension/heartbeat', (req, res) => {
    state.lastHeartbeat = new Date().toISOString()
    state.accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : []
    res.json({ ok: true })
  })

  return { app, state }
}

function isExtensionConnected(state) {
  if (!state.lastHeartbeat) return false
  return Date.now() - Date.parse(state.lastHeartbeat) < HEARTBEAT_STALE_MS
}

export function getBridgeStatus(state) {
  return {
    extensionConnected: isExtensionConnected(state),
    lastHeartbeat: state.lastHeartbeat,
    accounts: state.accounts,
  }
}

export function startBridge(port = 8084) {
  const { app, state } = createBridge()
  const server = app.listen(port, '127.0.0.1', () => {
    console.error(`thunderbird-mcp bridge listening on http://127.0.0.1:${port}`)
  })
  return { server, state }
}
