#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const DEFAULT_REMOTE_URL = 'https://mcp.guffeyholdings.com/TokenOracle'
const BRIDGE_VERSION = '1.0.1'
const FALLBACK_SERVER_NAME = 'com.guffeyholdings/token-oracle'

function parseArgs(argv) {
  const parsed = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--url') {
      parsed.url = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--api-key') {
      parsed.apiKey = argv[index + 1]
      index += 1
      continue
    }
    if (argument === '--subject') {
      parsed.subject = argv[index + 1]
      index += 1
    }
  }

  return parsed
}

function getConfig() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = args.apiKey ?? process.env['TOKEN_ORACLE_API_KEY']
  if (!apiKey) {
    throw new Error('TOKEN_ORACLE_API_KEY or --api-key is required')
  }

  return {
    apiKey,
    remoteUrl: args.url ?? process.env['TOKEN_ORACLE_BASE_URL'] ?? DEFAULT_REMOTE_URL,
    subject: args.subject ?? process.env['TOKEN_ORACLE_SUBJECT'],
  }
}

async function sendSafely(callback) {
  try {
    await callback()
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ level: 'warn', msg: 'bridge notification dropped', error: String(error) }) + '\n'
    )
  }
}

async function main() {
  const config = getConfig()
  const requestHeaders = {
    'X-API-Key': config.apiKey,
    ...(config.subject ? { 'X-Token-Oracle-Subject': config.subject } : {}),
  }

  const client = new Client(
    { name: '@guffeyholdings/token-oracle-remote', version: BRIDGE_VERSION },
    { capabilities: {} }
  )
  const remoteTransport = new StreamableHTTPClientTransport(new URL(config.remoteUrl), {
    requestInit: {
      headers: requestHeaders,
    },
  })

  await client.connect(remoteTransport)

  const remoteCapabilities = client.getServerCapabilities() ?? {}
  const remoteInfo = client.getServerVersion() ?? {
    name: FALLBACK_SERVER_NAME,
    version: BRIDGE_VERSION,
  }
  const server = new Server(remoteInfo, {
    capabilities: remoteCapabilities,
    instructions: client.getInstructions(),
  })

  if (remoteCapabilities.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      return await client.setLoggingLevel(request.params.level)
    })
  }

  if (remoteCapabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      return await client.listTools(request.params)
    })
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await client.callTool(request.params)
    })
  }

  if (remoteCapabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return await client.listResources(request.params)
    })
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await client.readResource(request.params)
    })

    if (remoteCapabilities.resources.subscribe) {
      server.setRequestHandler(SubscribeRequestSchema, async (request) => {
        return await client.subscribeResource(request.params)
      })
      server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
        return await client.unsubscribeResource(request.params)
      })
    }
  }

  if (remoteCapabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return await client.listPrompts(request.params)
    })
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await client.getPrompt(request.params)
    })
  }

  if (remoteCapabilities.tools?.listChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await sendSafely(() => server.sendToolListChanged())
    })
  }

  if (remoteCapabilities.prompts?.listChanged) {
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      await sendSafely(() => server.sendPromptListChanged())
    })
  }

  if (remoteCapabilities.resources?.listChanged) {
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      await sendSafely(() => server.sendResourceListChanged())
    })
  }

  if (remoteCapabilities.resources) {
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
      await sendSafely(() => server.sendResourceUpdated(notification.params))
    })
  }

  const stdioTransport = new StdioServerTransport()
  await server.connect(stdioTransport)

  const shutdown = async () => {
    await Promise.allSettled([server.close(), remoteTransport.close()])
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ level: 'error', msg: 'bridge startup failed', error: String(error) }) + '\n')
  process.exit(1)
})
