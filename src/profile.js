import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const PREFS_PREFIXES = [
  'mail.account.',
  'mail.server.',
  'mail.identity.',
  'mail.accountmanager.accounts',
  'ldap_2.servers.',
  'calendar.registry.',
]

/**
 * Returns the configured Thunderbird profile directory.
 * Throws if THUNDERBIRD_PROFILE is not set — never hardcode a fallback path.
 */
export function getProfileDir() {
  const dir = process.env.THUNDERBIRD_PROFILE
  if (!dir) {
    throw new Error(
      'THUNDERBIRD_PROFILE environment variable is not set. ' +
      'Copy .env.example to .env and point it at your Thunderbird profile directory ' +
      '(see ~/.thunderbird/profiles.ini).'
    )
  }
  if (!existsSync(dir)) {
    throw new Error(`THUNDERBIRD_PROFILE directory does not exist: ${dir}`)
  }
  return dir
}

/**
 * Parses prefs.js into a flat Map<string, string|number|boolean>, keeping only
 * the mail.account/server/identity keys needed for account discovery.
 */
export function parsePrefsJs(profileDir) {
  const prefsPath = join(profileDir, 'prefs.js')
  const text = readFileSync(prefsPath, 'utf-8')
  const map = new Map()

  const lineRe = /^user_pref\("([^"]+)",\s*(.*)\);$/

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const match = lineRe.exec(trimmed)
    if (!match) continue

    const key = match[1]
    if (!PREFS_PREFIXES.some((prefix) => key.startsWith(prefix))) continue

    const rawValue = match[2]
    map.set(key, parsePrefValue(rawValue))
  }

  return map
}

function parsePrefValue(rawValue) {
  if (rawValue === 'true') return true
  if (rawValue === 'false') return false
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    try {
      return JSON.parse(rawValue)
    } catch {
      return rawValue.slice(1, -1)
    }
  }
  const num = Number(rawValue)
  return Number.isNaN(num) ? rawValue : num
}

/**
 * Lists all configured Thunderbird mail accounts, including the "Local Folders"
 * pseudo-account (server type "none", no identity).
 */
export function listAccounts(profileDir) {
  const prefs = parsePrefsJs(profileDir)
  const accountIds = String(prefs.get('mail.accountmanager.accounts') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return accountIds.map((accountId) => {
    const serverId = prefs.get(`mail.account.${accountId}.server`)
    const hostname = prefs.get(`mail.server.${serverId}.hostname`)
    const type = prefs.get(`mail.server.${serverId}.type`)
    const serverName = prefs.get(`mail.server.${serverId}.name`)
    const serverDirectory = prefs.get(`mail.server.${serverId}.directory`)

    const identitiesRaw = prefs.get(`mail.account.${accountId}.identities`)
    let email = null
    let fullName = serverName ?? null

    if (identitiesRaw) {
      const identityId = String(identitiesRaw).split(',')[0].trim()
      email = prefs.get(`mail.identity.${identityId}.useremail`) ?? null
      fullName = prefs.get(`mail.identity.${identityId}.fullName`) ?? fullName
    }

    return {
      accountId,
      email,
      fullName,
      hostname: hostname ?? null,
      type: type ?? null,
      serverDirectory: serverDirectory ?? null,
    }
  })
}

const SKIP_EXTENSIONS = new Set(['.msf', '.dat', '.json', '.sqlite', '.html'])

/**
 * Builds the folder tree for a single account's server directory.
 * Folders are discovered via their .msf index files (every folder has one, even
 * empty folders that have no mbox data file yet).
 */
export function listFolders(serverDirectory) {
  if (!serverDirectory || !existsSync(serverDirectory)) return []
  return listFoldersInDir(serverDirectory, '')
}

function listFoldersInDir(dirPath, relPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true })
  const folders = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.msf')) continue

    const name = entry.name.slice(0, -'.msf'.length)
    const absPath = join(dirPath, name)
    const sbdPath = join(dirPath, `${name}.sbd`)
    const path = relPath ? `${relPath}/${name}` : name

    let children = []
    if (existsSync(sbdPath)) {
      children = listFoldersInDir(sbdPath, path)
    }

    folders.push({
      name,
      path,
      absPath,
      hasMessages: existsSync(absPath),
      children,
    })
  }

  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Flattens listAccounts() + listFolders() into a single list of folders across
 * all accounts, for use by the email search/read modules.
 */
export function enumerateAllFolders(profileDir) {
  const accounts = listAccounts(profileDir)
  const flat = []

  for (const account of accounts) {
    const tree = listFolders(account.serverDirectory)
    flatten(tree, account, flat)
  }

  return flat
}

function flatten(folders, account, out) {
  for (const folder of folders) {
    out.push({
      accountId: account.accountId,
      accountEmail: account.email,
      accountLabel: account.fullName,
      folderPath: folder.path,
      absPath: folder.absPath,
      hasMessages: folder.hasMessages,
    })
    if (folder.children.length) flatten(folder.children, account, out)
  }
}
