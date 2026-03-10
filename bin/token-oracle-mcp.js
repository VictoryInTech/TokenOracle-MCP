#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
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
const BRIDGE_VERSION = '1.0.4'
const FALLBACK_SERVER_NAME = 'com.guffeyholdings/token-oracle'
const BRIDGE_PACKAGE_NAME = 'token-oracle-mcp'
const CREDENTIALS_FILE_NAME = 'credentials.json'

function parseArgs(argv) {
  const parsed = { command: 'bridge' }
  let startIndex = 0

  if (argv[0] && !argv[0].startsWith('--')) {
    parsed.command = argv[0]
    startIndex = 1
  }

  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      parsed.command = 'help'
      continue
    }
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

function printHelp() {
  process.stdout.write(
    [
      `Usage: ${BRIDGE_PACKAGE_NAME} [login|logout] [--api-key <key>] [--url <url>] [--subject <subject>]`,
      '',
      'Commands:',
      '  login   Store a paid API key or fetch a hosted trial credential for future bridge launches',
      '  logout  Remove stored local credentials',
      '',
      'Default behavior:',
      '  Starts the stdio bridge and forwards MCP traffic to the hosted TokenOracle endpoint.',
      '  Credential lookup order: --api-key, TOKEN_ORACLE_API_KEY, stored credentials, hosted trial issuance.',
    ].join('\n') + '\n'
  )
}

function getCredentialsFilePath() {
  const configRoot =
    process.env['TOKEN_ORACLE_CONFIG_DIR'] ??
    (process.env['XDG_CONFIG_HOME'] ? path.join(process.env['XDG_CONFIG_HOME'], 'token-oracle') : undefined) ??
    path.join(homedir(), '.config', 'token-oracle')

  return path.join(configRoot, CREDENTIALS_FILE_NAME)
}

async function readStoredCredentials() {
  const credentialsPath = getCredentialsFilePath()
  const raw = await readFile(credentialsPath, 'utf8').catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!raw) return null

  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) {
    throw new Error(`Stored credentials at ${credentialsPath} are invalid`)
  }

  return {
    apiKey: parsed.apiKey,
    remoteUrl: typeof parsed.remoteUrl === 'string' && parsed.remoteUrl.length > 0 ? parsed.remoteUrl : undefined,
    subject: typeof parsed.subject === 'string' && parsed.subject.length > 0 ? parsed.subject : undefined,
  }
}

async function writeStoredCredentials(config) {
  const credentialsPath = getCredentialsFilePath()
  await mkdir(path.dirname(credentialsPath), { recursive: true })
  await writeFile(
    credentialsPath,
    JSON.stringify(
      {
        apiKey: config.apiKey,
        remoteUrl: config.remoteUrl,
        subject: config.subject,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  await chmod(credentialsPath, 0o600)
  return credentialsPath
}

async function deleteStoredCredentials() {
  const credentialsPath = getCredentialsFilePath()
  await rm(credentialsPath, { force: true })
  return credentialsPath
}

function buildTrialIssueUrl(remoteUrl) {
  const normalized = remoteUrl.endsWith('/') ? remoteUrl.slice(0, -1) : remoteUrl
  return new URL(`${normalized}/trial/issue`)
}

function buildConfig(args, storedCredentials) {
  const apiKey = args.apiKey ?? process.env['TOKEN_ORACLE_API_KEY'] ?? storedCredentials?.apiKey
  if (!apiKey) {
    throw new Error('NO_API_KEY_CONFIGURED')
  }

  return {
    apiKey,
    remoteUrl: args.url ?? process.env['TOKEN_ORACLE_BASE_URL'] ?? storedCredentials?.remoteUrl ?? DEFAULT_REMOTE_URL,
    subject: args.subject ?? process.env['TOKEN_ORACLE_SUBJECT'] ?? storedCredentials?.subject,
  }
}

async function issueTrialCredentials({ remoteUrl, subject }) {
  const response = await fetch(buildTrialIssueUrl(remoteUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(subject ? { 'X-Token-Oracle-Subject': subject } : {}),
    },
    body: JSON.stringify({}),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok || typeof payload.api_key !== 'string') {
    throw new Error(payload.error ?? `Trial issuance failed with ${response.status}`)
  }

  return {
    apiKey: payload.api_key,
    remoteUrl,
    subject,
    plan: payload.plan,
    requestLimit: payload.request_limit,
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

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function promptSecret(promptText) {
  if (!isInteractiveTerminal()) {
    throw new Error('Interactive login requires a TTY')
  }

  process.stdout.write(promptText)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()

  return await new Promise((resolve, reject) => {
    let value = ''

    const cleanup = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
    }

    const onData = (chunk) => {
      const text = String(chunk)
      for (const character of text) {
        if (character === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('Prompt cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (character === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        value += character
      }
    }

    process.stdin.on('data', onData)
  })
}

async function validateCredentials(config) {
  const client = new Client(
    { name: BRIDGE_PACKAGE_NAME, version: BRIDGE_VERSION },
    { capabilities: {} }
  )
  const transport = new StreamableHTTPClientTransport(new URL(config.remoteUrl), {
    requestInit: {
      headers: {
        'X-API-Key': config.apiKey,
        ...(config.subject ? { 'X-Token-Oracle-Subject': config.subject } : {}),
      },
    },
  })

  try {
    await client.connect(transport)
    await client.listTools()
  } finally {
    await Promise.allSettled([client.close(), transport.close()])
  }
}

async function login(args) {
  const storedCredentials = await readStoredCredentials()
  let config

  if (args.apiKey || process.env['TOKEN_ORACLE_API_KEY']) {
    config = buildConfig(args, storedCredentials)
  } else {
    config = await issueTrialCredentials({
      remoteUrl: args.url ?? process.env['TOKEN_ORACLE_BASE_URL'] ?? storedCredentials?.remoteUrl ?? DEFAULT_REMOTE_URL,
      subject: args.subject ?? process.env['TOKEN_ORACLE_SUBJECT'] ?? storedCredentials?.subject,
    })
  }

  await validateCredentials(config)
  const credentialsPath = await writeStoredCredentials(config)
  process.stdout.write(
    `Stored TokenOracle ${config.plan === 'trial' ? 'trial' : 'hosted'} credentials in ${credentialsPath}\n`
  )
}

async function logout() {
  const credentialsPath = await deleteStoredCredentials()
  process.stdout.write(`Removed stored TokenOracle credentials from ${credentialsPath}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'login') {
    await login(args)
    return
  }
  if (args.command === 'logout') {
    await logout()
    return
  }
  if (args.command === 'help') {
    printHelp()
    return
  }
  if (args.command !== 'bridge') {
    throw new Error(`Unknown command: ${args.command}`)
  }

  const storedCredentials = await readStoredCredentials()
  let config

  try {
    config = buildConfig(args, storedCredentials)
  } catch (error) {
    if (String(error) === 'Error: NO_API_KEY_CONFIGURED') {
      config = await issueTrialCredentials({
        remoteUrl: args.url ?? process.env['TOKEN_ORACLE_BASE_URL'] ?? storedCredentials?.remoteUrl ?? DEFAULT_REMOTE_URL,
        subject: args.subject ?? process.env['TOKEN_ORACLE_SUBJECT'] ?? storedCredentials?.subject,
      })
      await validateCredentials(config)
      await writeStoredCredentials(config)
      process.stderr.write(
        JSON.stringify({ level: 'info', msg: 'stored TokenOracle trial credentials after automatic first-run issuance' }) + '\n'
      )
    } else if (!storedCredentials && isInteractiveTerminal()) {
      const promptedApiKey = await promptSecret('TokenOracle API key: ')
      config = buildConfig({ ...args, apiKey: promptedApiKey }, storedCredentials)
      await validateCredentials(config)
      await writeStoredCredentials(config)
      process.stderr.write(
        JSON.stringify({ level: 'info', msg: 'stored TokenOracle hosted credentials after interactive login' }) + '\n'
      )
    } else {
      throw error
    }
  }

  const requestHeaders = {
    'X-API-Key': config.apiKey,
    ...(config.subject ? { 'X-Token-Oracle-Subject': config.subject } : {}),
  }

  const client = new Client(
    { name: BRIDGE_PACKAGE_NAME, version: BRIDGE_VERSION },
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
