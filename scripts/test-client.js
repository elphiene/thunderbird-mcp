#!/usr/bin/env node
// Exercises all thunderbird-mcp tools over a real stdio MCP connection.
// Prints only counts/shapes — never message content — so this is safe to run
// and commit.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = join(__dirname, '../src/index.js')

function parseJsonResult(result) {
  if (result.isError) {
    throw new Error(`Tool error: ${result.content[0]?.text}`)
  }
  return JSON.parse(result.content[0].text)
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
  })

  const client = new Client({ name: 'thunderbird-mcp-test-client', version: '0.0.1' })
  await client.connect(transport)

  const tools = await client.listTools()
  console.log(`tools available: ${tools.tools.map((t) => t.name).join(', ')}`)

  // 1. list_accounts
  const accounts = parseJsonResult(await client.callTool({ name: 'list_accounts', arguments: {} }))
  console.log(`list_accounts: ${accounts.length} accounts`)
  if (!accounts.length) throw new Error('Expected at least one account')
  const testAccount = accounts.find((a) => a.email) ?? accounts[0]

  // 2. list_folders
  const folderResult = parseJsonResult(
    await client.callTool({ name: 'list_folders', arguments: { accountEmail: testAccount.email ?? undefined } })
  )
  const folderCount = folderResult.reduce((sum, acct) => sum + countFolders(acct.folders), 0)
  console.log(`list_folders: ${folderResult.length} account(s), ${folderCount} folders total`)
  if (!folderCount) throw new Error('Expected at least one folder')

  // 3. search_emails — generic keyword across the test account's INBOX
  const searchResults = parseJsonResult(
    await client.callTool({
      name: 'search_emails',
      arguments: { accountEmail: testAccount.email, folderPath: 'INBOX', keyword: 'e', limit: 5 },
    })
  )
  console.log(`search_emails: ${searchResults.length} results`)
  if (!Array.isArray(searchResults)) throw new Error('Expected search_emails to return an array')

  // 4. read_email — only if search returned something
  if (searchResults.length) {
    const message = parseJsonResult(
      await client.callTool({ name: 'read_email', arguments: { id: searchResults[0].id } })
    )
    console.log(
      `read_email: subject present=${!!message.subject}, textBody length=${message.textBody.length}, attachments=${message.attachments.length}`
    )
    if (typeof message.textBody !== 'string') throw new Error('Expected textBody to be a string')
  } else {
    console.log('read_email: skipped (no search results)')
  }

  // search_emails without any filters should be rejected
  const noFilterResult = await client.callTool({ name: 'search_emails', arguments: {} })
  if (!noFilterResult.isError) throw new Error('Expected search_emails with no filters to error')
  console.log('search_emails with no filters: correctly rejected')

  // 5. list_address_books
  const addressBooks = parseJsonResult(await client.callTool({ name: 'list_address_books', arguments: {} }))
  console.log(`list_address_books: ${addressBooks.length} address book(s)`)
  if (!addressBooks.length) throw new Error('Expected at least one address book')

  // 6. list_contacts
  const contacts = parseJsonResult(await client.callTool({ name: 'list_contacts', arguments: { limit: 200 } }))
  console.log(`list_contacts: ${contacts.length} contact(s), ${contacts.filter((c) => c.emails.length).length} with email`)
  if (!Array.isArray(contacts)) throw new Error('Expected list_contacts to return an array')

  // list_contacts scoped to a single address book
  const scopedContacts = parseJsonResult(
    await client.callTool({ name: 'list_contacts', arguments: { addressBook: addressBooks[0].id, limit: 200 } })
  )
  console.log(`list_contacts (scoped to ${addressBooks[0].id}): ${scopedContacts.length} contact(s)`)
  if (!scopedContacts.every((c) => c.addressBook === addressBooks[0].id)) {
    throw new Error('Expected scoped contacts to all belong to the requested address book')
  }

  // 7. list_calendars
  const calendars = parseJsonResult(await client.callTool({ name: 'list_calendars', arguments: {} }))
  console.log(`list_calendars: ${calendars.length} calendar(s)`)
  if (!calendars.length) throw new Error('Expected at least one calendar')

  // 8. list_events
  const eventsResult = await client.callTool({ name: 'list_events', arguments: { limit: 10 } })
  if (eventsResult.isError) {
    console.log(`list_events: error (expected if Thunderbird is running) — ${eventsResult.content[0]?.text}`)
  } else {
    const events = JSON.parse(eventsResult.content[0].text)
    console.log(`list_events: ${events.length} event(s)`)
    if (!Array.isArray(events)) throw new Error('Expected list_events to return an array')
  }

  // 9. bridge_status
  const bridgeStatus = parseJsonResult(await client.callTool({ name: 'bridge_status', arguments: {} }))
  console.log(`bridge_status: extensionConnected=${bridgeStatus.extensionConnected}, lastHeartbeat=${bridgeStatus.lastHeartbeat}`)
  if (typeof bridgeStatus.extensionConnected !== 'boolean') throw new Error('Expected extensionConnected to be a boolean')

  // 10. bridge /health endpoint (localhost-only HTTP bridge)
  const bridgePort = process.env.BRIDGE_PORT || 8084
  const health = await fetch(`http://127.0.0.1:${bridgePort}/health`).then((r) => r.json())
  console.log(`bridge /health: status=${health.status}, extensionConnected=${health.extensionConnected}`)
  if (health.status !== 'ok') throw new Error('Expected bridge /health to report status "ok"')

  await client.close()
  console.log('\nAll checks passed.')
}

function countFolders(folders) {
  let count = 0
  for (const folder of folders) {
    count += 1 + countFolders(folder.children)
  }
  return count
}

main().catch((error) => {
  console.error('Test client failed:', error)
  process.exit(1)
})
