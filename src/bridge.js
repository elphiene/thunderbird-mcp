import express from 'express'
import { randomUUID } from 'crypto'

const HEARTBEAT_STALE_MS = 60_000
const POLL_TIMEOUT_MS = 25_000
const COMMAND_TIMEOUT_MS = 30_000

/**
 * Local-only HTTP bridge between the MCP server and the Thunderbird
 * WebExtension. Binds to 127.0.0.1 only — never expose this port externally
 * (no Cloudflare tunnel, no 0.0.0.0).
 *
 * Write operations (e.g. sending email) are dispatched to the extension via
 * long-polling: the extension holds open a GET /extension/poll request, the
 * MCP server enqueues a command (resolving that request immediately), the
 * extension executes it via the browser.* APIs and POSTs the result back to
 * /extension/result.
 */
export function createBridge() {
  const app = express()
  app.use(express.json())

  const state = {
    lastHeartbeat: null,
    accounts: [],
    pendingCommands: [],
    pollWaiters: [],
    pendingResults: new Map(),
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

  app.get('/extension/poll', (req, res) => {
    if (state.pendingCommands.length > 0) {
      res.json({ command: state.pendingCommands.shift() })
      return
    }

    const timer = setTimeout(() => {
      removeWaiter(state, waiter)
      res.json({ command: null })
    }, POLL_TIMEOUT_MS)

    const waiter = (command) => {
      clearTimeout(timer)
      res.json({ command })
    }

    state.pollWaiters.push(waiter)
    req.on('close', () => {
      clearTimeout(timer)
      removeWaiter(state, waiter)
    })
  })

  app.post('/extension/result', (req, res) => {
    const { id, ok, result, error } = req.body ?? {}
    const pending = state.pendingResults.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      state.pendingResults.delete(id)
      if (ok) pending.resolve(result)
      else pending.reject(new Error(error || 'Command failed'))
    }
    res.json({ ok: true })
  })

  return { app, state }
}

function removeWaiter(state, waiter) {
  const idx = state.pollWaiters.indexOf(waiter)
  if (idx !== -1) state.pollWaiters.splice(idx, 1)
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

/**
 * Sends a command to the Thunderbird extension and waits for its result.
 * Rejects if the extension doesn't respond within COMMAND_TIMEOUT_MS.
 */
export function enqueueCommand(state, type, payload) {
  if (!isExtensionConnected(state)) {
    return Promise.reject(
      new Error('Thunderbird WebExtension is not connected to the bridge. Make sure Thunderbird is running with the extension loaded — see bridge_status.')
    )
  }

  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      state.pendingResults.delete(id)
      reject(new Error('Timed out waiting for the Thunderbird extension to respond.'))
    }, COMMAND_TIMEOUT_MS)

    state.pendingResults.set(id, { resolve, reject, timer })

    const command = { id, type, payload }
    const waiter = state.pollWaiters.shift()
    if (waiter) {
      waiter(command)
    } else {
      state.pendingCommands.push(command)
    }
  })
}

export function startBridge(port = 8084) {
  const { app, state } = createBridge()
  const server = app.listen(port, '127.0.0.1', () => {
    console.error(`thunderbird-mcp bridge listening on http://127.0.0.1:${port}`)
  })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `thunderbird-mcp bridge: port ${port} is already in use (likely another thunderbird-mcp instance) — bridge_status/send_email in this process will report disconnected.`
      )
    } else {
      console.error('thunderbird-mcp bridge: failed to start —', error.message)
    }
  })
  return { server, state }
}
