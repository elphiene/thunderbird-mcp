#!/usr/bin/env node
import 'dotenv/config'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getProfileDir, listAccounts, listFolders } from './profile.js'
import { searchEmails, readEmail } from './email.js'

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

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('thunderbird-mcp running on stdio')
}

main().catch((error) => {
  console.error('Fatal error running thunderbird-mcp:', error)
  process.exit(1)
})
