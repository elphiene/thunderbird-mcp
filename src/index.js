#!/usr/bin/env node
import 'dotenv/config'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getProfileDir, listAccounts, listFolders, listTags } from './profile.js'
import { searchEmails, readEmail, getMessageRef } from './email.js'
import { listAddressBooks, listContacts } from './contacts.js'
import { listCalendars, listEvents } from './calendar.js'
import { startBridge, getBridgeStatus, enqueueCommand } from './bridge.js'

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 8084

const server = new McpServer({
  name: 'thunderbird-mcp',
  version: '0.0.1',
})

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  }
}

server.registerTool(
  'list_accounts',
  {
    title: 'List Thunderbird accounts',
    description: 'Lists all configured Thunderbird mail accounts (email, display name, hostname, type), including Local Folders.',
    inputSchema: {},
  },
  async () => {
    try {
      const accounts = listAccounts(getProfileDir()).map(({ accountId, email, fullName, hostname, type }) => ({
        accountId,
        email,
        fullName,
        hostname,
        type,
      }))
      return jsonResult(accounts)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'list_folders',
  {
    title: 'List Thunderbird folders',
    description: 'Lists the folder tree for a Thunderbird account, identified by email address. If omitted, lists folders for all accounts.',
    inputSchema: {
      accountEmail: z.string().email().optional().describe('Email address of the account to list folders for. Omit to list folders for every account.'),
    },
  },
  async ({ accountEmail }) => {
    try {
      const accounts = listAccounts(getProfileDir()).filter(
        (a) => !accountEmail || a.email === accountEmail
      )
      const result = accounts.map((account) => ({
        accountId: account.accountId,
        email: account.email,
        fullName: account.fullName,
        folders: listFolders(account.serverDirectory),
      }))
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'search_emails',
  {
    title: 'Search emails',
    description: 'Searches Thunderbird emails by account, folder, sender, subject, keyword, and/or date range. At least one of accountEmail, folderPath, sender, subject, or keyword is required.',
    inputSchema: {
      accountEmail: z.string().email().optional().describe('Restrict search to this account.'),
      folderPath: z.string().optional().describe('Restrict search to this folder path (e.g. "INBOX" or "[Gmail]/All Mail").'),
      sender: z.string().optional().describe('Match against the From header (case-insensitive substring).'),
      subject: z.string().optional().describe('Match against the Subject header (case-insensitive substring).'),
      keyword: z.string().optional().describe('Match against subject, sender, or message body (case-insensitive substring).'),
      since: z.string().optional().describe('Only messages dated on or after this date (ISO 8601 string).'),
      until: z.string().optional().describe('Only messages dated on or before this date (ISO 8601 string).'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results (default 20, max 100).'),
    },
  },
  async (args) => {
    try {
      const results = await searchEmails(args)
      return jsonResult(results)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'read_email',
  {
    title: 'Read email',
    description: 'Reads the full headers, text body, and attachment metadata for a single email, identified by the id returned from search_emails.',
    inputSchema: {
      id: z.string().describe('The opaque message id returned by search_emails.'),
    },
  },
  async ({ id }) => {
    try {
      const message = await readEmail({ id })
      return jsonResult(message)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'list_tags',
  {
    title: 'List message tags',
    description: 'Lists configured Thunderbird message tags/labels (e.g. Important, Work) with their keys and colors. Tag keys are used by update_message_tags.',
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(listTags(getProfileDir()))
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'list_address_books',
  {
    title: 'List address books',
    description: 'Lists all configured Thunderbird address books, including which account (if any) each one syncs from.',
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(listAddressBooks())
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'list_contacts',
  {
    title: 'List/search contacts',
    description: 'Lists or searches Thunderbird contacts across one or all address books. Matches against display name, first/last name, and email addresses.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive substring to match against name or email. Omit to list all contacts.'),
      addressBook: z.string().optional().describe('Restrict to a single address book id, as returned by list_address_books.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of results (default 50, max 200).'),
    },
  },
  async (args) => {
    try {
      const contacts = await listContacts(args)
      return jsonResult(contacts)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'list_calendars',
  {
    title: 'List calendars',
    description: 'Lists all configured Thunderbird calendars (name, type, color, read-only flag, and the account they sync from, if any).',
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(listCalendars())
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'list_events',
  {
    title: 'List calendar events',
    description: 'Lists events from the local calendar cache, optionally filtered by calendar and date range. Requires Thunderbird to be closed (the cache database is locked while it runs).',
    inputSchema: {
      calendarId: z.string().optional().describe('Restrict to a single calendar id, as returned by list_calendars.'),
      since: z.string().optional().describe('Only events ending on or after this date/time (ISO 8601 string).'),
      until: z.string().optional().describe('Only events starting on or before this date/time (ISO 8601 string).'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of results (default 50, max 200).'),
    },
  },
  async (args) => {
    try {
      const events = await listEvents(args)
      return jsonResult(events)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'bridge_status',
  {
    title: 'Bridge status',
    description: 'Reports whether the Thunderbird WebExtension is connected to the local HTTP bridge (required for send/manage/write operations).',
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(getBridgeStatus(bridgeState))
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'send_email',
  {
    title: 'Send email',
    description: 'Composes and sends a new email from a connected account, via the Thunderbird WebExtension. Requires Thunderbird to be running with the bridge extension loaded — check bridge_status first.',
    inputSchema: {
      fromEmail: z.string().email().describe('The sending account\'s email address, as returned by list_accounts.'),
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses.'),
      cc: z.array(z.string().email()).optional().describe('CC email addresses.'),
      bcc: z.array(z.string().email()).optional().describe('BCC email addresses.'),
      subject: z.string().describe('Email subject.'),
      body: z.string().describe('Email body.'),
      isPlainText: z.boolean().optional().describe('Whether body is plain text (default true). Set to false to send body as HTML.'),
    },
  },
  async (args) => {
    try {
      const result = await enqueueCommand(bridgeState, 'send_email', args)
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'move_message',
  {
    title: 'Move email to another folder',
    description: 'Moves an email (identified by the id from search_emails/read_email) to another folder, optionally in a different account. Requires the Thunderbird WebExtension to be connected — check bridge_status first.',
    inputSchema: {
      id: z.string().describe('The opaque message id returned by search_emails.'),
      destFolderPath: z.string().describe('Destination folder path, as returned by list_folders (e.g. "Archive" or "[Gmail]/All Mail").'),
      destAccountEmail: z.string().email().optional().describe('Destination account email, as returned by list_accounts. Defaults to the message\'s current account.'),
    },
  },
  async ({ id, destFolderPath, destAccountEmail }) => {
    try {
      const ref = await getMessageRef({ id })
      const accounts = listAccounts(getProfileDir())
      const destAccount = destAccountEmail
        ? accounts.find((a) => a.email === destAccountEmail)
        : accounts.find((a) => a.accountId === ref.accountId)
      if (!destAccount) {
        throw new Error(`Unknown destination account: ${destAccountEmail ?? ref.accountId}`)
      }
      const result = await enqueueCommand(bridgeState, 'move_message', {
        accountId: ref.accountId,
        folderPath: ref.folderPath,
        headerMessageId: ref.headerMessageId,
        destAccountId: destAccount.accountId,
        destFolderPath,
      })
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'delete_message',
  {
    title: 'Delete email',
    description: 'Deletes an email (identified by the id from search_emails/read_email). By default moves it to Trash; set permanent to bypass Trash. Requires the Thunderbird WebExtension to be connected — check bridge_status first.',
    inputSchema: {
      id: z.string().describe('The opaque message id returned by search_emails.'),
      permanent: z.boolean().optional().describe('If true, permanently deletes instead of moving to Trash. Default false.'),
    },
  },
  async ({ id, permanent }) => {
    try {
      const ref = await getMessageRef({ id })
      const result = await enqueueCommand(bridgeState, 'delete_message', {
        accountId: ref.accountId,
        folderPath: ref.folderPath,
        headerMessageId: ref.headerMessageId,
        permanent: !!permanent,
      })
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'set_message_read',
  {
    title: 'Mark email read/unread',
    description: 'Marks an email (identified by the id from search_emails/read_email) as read or unread. Requires the Thunderbird WebExtension to be connected — check bridge_status first.',
    inputSchema: {
      id: z.string().describe('The opaque message id returned by search_emails.'),
      read: z.boolean().describe('true to mark as read, false to mark as unread.'),
    },
  },
  async ({ id, read }) => {
    try {
      const ref = await getMessageRef({ id })
      const result = await enqueueCommand(bridgeState, 'set_message_read', {
        accountId: ref.accountId,
        folderPath: ref.folderPath,
        headerMessageId: ref.headerMessageId,
        read,
      })
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'update_message_tags',
  {
    title: 'Add/remove email tags',
    description: 'Adds and/or removes tags/labels on an email (identified by the id from search_emails/read_email). Use list_tags for available tag keys. Requires the Thunderbird WebExtension to be connected — check bridge_status first.',
    inputSchema: {
      id: z.string().describe('The opaque message id returned by search_emails.'),
      addTags: z.array(z.string()).optional().describe('Tag keys to add, as returned by list_tags.'),
      removeTags: z.array(z.string()).optional().describe('Tag keys to remove, as returned by list_tags.'),
    },
  },
  async ({ id, addTags, removeTags }) => {
    if (!addTags?.length && !removeTags?.length) {
      return errorResult(new Error('update_message_tags requires at least one of addTags or removeTags'))
    }
    try {
      const ref = await getMessageRef({ id })
      const result = await enqueueCommand(bridgeState, 'update_message_tags', {
        accountId: ref.accountId,
        folderPath: ref.folderPath,
        headerMessageId: ref.headerMessageId,
        addTags: addTags ?? [],
        removeTags: removeTags ?? [],
      })
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'create_contact',
  {
    title: 'Create contact',
    description: 'Creates a new contact in a Thunderbird address book. Requires the Thunderbird WebExtension to be connected — check bridge_status first.',
    inputSchema: {
      addressBook: z.string().describe('Address book id, as returned by list_address_books.'),
      displayName: z.string().optional().describe('Display name.'),
      firstName: z.string().optional().describe('First name.'),
      lastName: z.string().optional().describe('Last name.'),
      primaryEmail: z.string().email().optional().describe('Primary email address.'),
      secondEmail: z.string().email().optional().describe('Secondary email address.'),
    },
  },
  async ({ addressBook, displayName, firstName, lastName, primaryEmail, secondEmail }) => {
    if (!displayName && !firstName && !lastName && !primaryEmail) {
      return errorResult(new Error('create_contact requires at least one of displayName, firstName, lastName, or primaryEmail'))
    }
    try {
      const ab = listAddressBooks().find((a) => a.id === addressBook)
      if (!ab) throw new Error(`Unknown address book: ${addressBook}`)

      const properties = {}
      if (displayName) properties.DisplayName = displayName
      if (firstName) properties.FirstName = firstName
      if (lastName) properties.LastName = lastName
      if (primaryEmail) properties.PrimaryEmail = primaryEmail
      if (secondEmail) properties.SecondEmail = secondEmail

      const result = await enqueueCommand(bridgeState, 'create_contact', { addressBookLabel: ab.label, properties })
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

server.registerTool(
  'update_contact',
  {
    title: 'Update contact',
    description: 'Updates fields on an existing contact, identified by the cardId from list_contacts. Only the provided fields are changed. Requires the Thunderbird WebExtension to be connected — check bridge_status first.',
    inputSchema: {
      cardId: z.string().describe('The contact card id, as returned by list_contacts.'),
      displayName: z.string().optional().describe('Display name.'),
      firstName: z.string().optional().describe('First name.'),
      lastName: z.string().optional().describe('Last name.'),
      primaryEmail: z.string().email().optional().describe('Primary email address.'),
      secondEmail: z.string().email().optional().describe('Secondary email address.'),
    },
  },
  async ({ cardId, displayName, firstName, lastName, primaryEmail, secondEmail }) => {
    const properties = {}
    if (displayName !== undefined) properties.DisplayName = displayName
    if (firstName !== undefined) properties.FirstName = firstName
    if (lastName !== undefined) properties.LastName = lastName
    if (primaryEmail !== undefined) properties.PrimaryEmail = primaryEmail
    if (secondEmail !== undefined) properties.SecondEmail = secondEmail

    if (Object.keys(properties).length === 0) {
      return errorResult(new Error('update_contact requires at least one field to update'))
    }

    try {
      const result = await enqueueCommand(bridgeState, 'update_contact', { cardId, properties })
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
)

let bridgeState

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('thunderbird-mcp running on stdio')

  const bridge = startBridge(BRIDGE_PORT)
  bridgeState = bridge.state
}

main().catch((error) => {
  console.error('Fatal error running thunderbird-mcp:', error)
  process.exit(1)
})
