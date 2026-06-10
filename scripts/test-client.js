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

// Use a dedicated bridge port for the test run so this process's own bridge can
// bind successfully even if a persistent thunderbird-mcp instance (e.g. wired into
// Claude Desktop/Cowork) is already holding the default port. The real extension only
// connects to the default port, so bridge_status/send_email here will correctly
// report "not connected" — that's expected, not a bug. To exercise send_email
// end-to-end, use the persistent instance (e.g. ask Claude in Cowork to send a test
// email) which has the real extension connection.
const TEST_BRIDGE_PORT = process.env.BRIDGE_PORT || '18084'

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, BRIDGE_PORT: TEST_BRIDGE_PORT },
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

  // 4b. list_tags
  const tags = parseJsonResult(await client.callTool({ name: 'list_tags', arguments: {} }))
  console.log(`list_tags: ${tags.length} tag(s)`)
  if (!Array.isArray(tags)) throw new Error('Expected list_tags to return an array')

  // 5. list_address_books
  const addressBooks = parseJsonResult(await client.callTool({ name: 'list_address_books', arguments: {} }))
  console.log(`list_address_books: ${addressBooks.length} address book(s)`)
  if (!addressBooks.length) throw new Error('Expected at least one address book')

  // 6. list_contacts
  const contactsResult = await client.callTool({ name: 'list_contacts', arguments: { limit: 200 } })
  if (contactsResult.isError) {
    console.log(`list_contacts: error (expected if Thunderbird is mid-sync) — ${contactsResult.content[0]?.text}`)
  } else {
    const contacts = JSON.parse(contactsResult.content[0].text)
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
  const health = await fetch(`http://127.0.0.1:${TEST_BRIDGE_PORT}/health`).then((r) => r.json())
  console.log(`bridge /health: status=${health.status}, extensionConnected=${health.extensionConnected}`)
  if (health.status !== 'ok') throw new Error('Expected bridge /health to report status "ok"')

  // 11. send_email — only if extension connected; use a fromEmail that matches no
  // identity so the extension rejects it before composing/sending anything real.
  if (bridgeStatus.extensionConnected) {
    const sendResult = await client.callTool({
      name: 'send_email',
      arguments: {
        fromEmail: 'not-a-real-account@example.invalid',
        to: ['test@example.invalid'],
        subject: 'thunderbird-mcp test (should not send)',
        body: 'test',
      },
    })
    if (!sendResult.isError) throw new Error('Expected send_email with an unknown fromEmail to error')
    console.log(`send_email (unknown fromEmail): correctly rejected — ${sendResult.content[0]?.text}`)
  } else {
    console.log('send_email: skipped (extension not connected)')
  }

  // 12. message management tools — only check the "extension not connected" error
  // path. This still exercises getMessageRef() (decoding the id, finding the
  // Message-ID header and owning account/folder) without ever reaching the
  // extension, so it's safe to run against a real message id.
  if (searchResults.length && !bridgeStatus.extensionConnected) {
    const targetId = searchResults[0].id

    const moveResult = await client.callTool({
      name: 'move_message',
      arguments: { id: targetId, destFolderPath: 'Archive' },
    })
    if (!moveResult.isError) throw new Error('Expected move_message to error when extension is not connected')
    console.log(`move_message (not connected): correctly rejected — ${moveResult.content[0]?.text}`)

    const deleteResult = await client.callTool({
      name: 'delete_message',
      arguments: { id: targetId },
    })
    if (!deleteResult.isError) throw new Error('Expected delete_message to error when extension is not connected')
    console.log(`delete_message (not connected): correctly rejected — ${deleteResult.content[0]?.text}`)

    const readResult = await client.callTool({
      name: 'set_message_read',
      arguments: { id: targetId, read: true },
    })
    if (!readResult.isError) throw new Error('Expected set_message_read to error when extension is not connected')
    console.log(`set_message_read (not connected): correctly rejected — ${readResult.content[0]?.text}`)

    const tagsResult = await client.callTool({
      name: 'update_message_tags',
      arguments: { id: targetId, addTags: ['$label1'] },
    })
    if (!tagsResult.isError) throw new Error('Expected update_message_tags to error when extension is not connected')
    console.log(`update_message_tags (not connected): correctly rejected — ${tagsResult.content[0]?.text}`)

    // update_message_tags with neither addTags nor removeTags should be rejected
    // before even attempting to resolve the message.
    const noTagsResult = await client.callTool({
      name: 'update_message_tags',
      arguments: { id: targetId },
    })
    if (!noTagsResult.isError) throw new Error('Expected update_message_tags with no tags to error')
    console.log('update_message_tags with no addTags/removeTags: correctly rejected')
  } else {
    console.log('message management tools: skipped (no search results, or extension connected)')
  }

  // 13. contact write tools — only check error paths that don't require the
  // extension (unknown address book / no fields to update), plus the
  // "extension not connected" path.
  const createNoFieldsResult = await client.callTool({
    name: 'create_contact',
    arguments: { addressBook: addressBooks[0].id },
  })
  if (!createNoFieldsResult.isError) throw new Error('Expected create_contact with no name/email fields to error')
  console.log('create_contact with no fields: correctly rejected')

  const updateNoFieldsResult = await client.callTool({
    name: 'update_contact',
    arguments: { cardId: 'not-a-real-card-id' },
  })
  if (!updateNoFieldsResult.isError) throw new Error('Expected update_contact with no fields to error')
  console.log('update_contact with no fields: correctly rejected')

  if (!bridgeStatus.extensionConnected) {
    const createUnknownAbResult = await client.callTool({
      name: 'create_contact',
      arguments: { addressBook: 'not-a-real-address-book.sqlite', displayName: 'Test Contact' },
    })
    if (!createUnknownAbResult.isError) throw new Error('Expected create_contact with an unknown address book to error')
    console.log(`create_contact (unknown address book): correctly rejected — ${createUnknownAbResult.content[0]?.text}`)

    const updateNotConnectedResult = await client.callTool({
      name: 'update_contact',
      arguments: { cardId: 'not-a-real-card-id', displayName: 'Test Contact' },
    })
    if (!updateNotConnectedResult.isError) throw new Error('Expected update_contact to error when extension is not connected')
    console.log(`update_contact (not connected): correctly rejected — ${updateNotConnectedResult.content[0]?.text}`)
  } else {
    console.log('contact write tools: skipped further checks (extension connected)')
  }

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
