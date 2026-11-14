'use strict'

const http = require('node:http')
const https = require('node:https')
const pathModule = require('node:path')
const { URL } = require('node:url')
const { translateDeepSeekHarnessRequest } = require('./deepseekHarnessCompat')
const {
  convertResponsesRequest,
  claudeToResponsesResponse,
  createSseTransformer
} = require('./responsesBridge')
const { AnthropicSseAggregator } = require('./anthropicAggregator')
const { ClaudeOAuthManager } = require('./claudeOAuthManager')

const MAX_BODY_BYTES = 16 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function getConfig(env = process.env) {
  const upstreamBaseUrl = env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com'
  const upstreamApiKey = env.ANTHROPIC_API_KEY
  const relayApiKey = env.RELAY_API_KEY
  if (!relayApiKey) throw new Error('RELAY_API_KEY is required')

  const parsed = new URL(upstreamBaseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('ANTHROPIC_UPSTREAM_URL must use http or https')
  }

  const oauthManager = new ClaudeOAuthManager({
    storePath: env.CLAUDE_OAUTH_STORE || pathModule.join(process.cwd(), '.oauth-tokens.json'),
    accessToken: env.CLAUDE_OAUTH_ACCESS_TOKEN,
    refreshToken: env.CLAUDE_OAUTH_REFRESH_TOKEN,
    expiresAt: env.CLAUDE_OAUTH_EXPIRES_AT
  })
  const authMode = (env.CLAUDE_AUTH_MODE || (oauthManager.status().configured ? 'oauth' : 'api')).toLowerCase()
  if (authMode !== 'oauth' && !upstreamApiKey) throw new Error('ANTHROPIC_API_KEY is required in api auth mode')
  if (!['api', 'oauth'].includes(authMode)) throw new Error('CLAUDE_AUTH_MODE must be api or oauth')

  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    upstreamBaseUrl: parsed,
    upstreamApiKey,
    relayApiKey,
    authMode,
    oauthManager,
    authHeader: (env.ANTHROPIC_AUTH_HEADER || (authMode === 'oauth' ? 'authorization' : 'x-api-key')).toLowerCase(),
    deepSeekHarnessCompat: env.DEEPSEEK_HARNESS_COMPAT !== 'false'
  }
}

function getClientApiKey(req) {
  const authorization = req.headers.authorization || ''
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)
  return bearer ? bearer[1] : req.headers['x-api-key'] || ''
}

function normalizeIncomingPath(requestUrl) {
  const incoming = new URL(requestUrl, 'http://relay.local')
  let pathname = incoming.pathname
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    pathname = pathname.slice('/api'.length) || '/'
  }
  return `${pathname}${incoming.search}`
}

function copyResponseHeaders(upstreamResponse, response) {
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ])
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (!hopByHop.has(name) && value !== undefined) response.setHeader(name, value)
  }
}

function buildUpstreamHeaders(req, body, config, credential) {
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'content-length': String(body.length),
    accept: req.headers.accept || 'application/json',
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    'accept-encoding': 'identity'
  }
  for (const name of [
    'anthropic-beta',
    'user-agent',
    'accept-language',
    'x-app',
    'x-stainless-retry-count',
    'x-stainless-timeout',
    'x-stainless-lang',
    'x-stainless-package-version',
    'x-stainless-os',
    'x-stainless-arch',
    'x-stainless-runtime',
    'x-stainless-runtime-version'
  ]) {
    if (req.headers[name]) headers[name] = req.headers[name]
  }
  if (config.authHeader === 'authorization') headers.authorization = `Bearer ${credential}`
  else headers['x-api-key'] = credential
  return headers
}

function upstreamPath(config, path) {
  const basePath = config.upstreamBaseUrl.pathname.replace(/\/+$/, '')
  const targetPath = path.replace(/^\/+/, '')
  const joined = `${basePath}/${targetPath}`.replace(/\/{2,}/g, '/')
  return joined.startsWith('/') ? joined : `/${joined}`
}

async function relayRequest(req, res, config, body, path, handlers) {
  try {
    const credential = config.authMode === 'oauth'
      ? await config.oauthManager.getAccessToken()
      : config.upstreamApiKey
    const target = config.upstreamBaseUrl
    const transport = target.protocol === 'http:' ? http : https
    const upstreamRequest = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: 'POST',
        path: upstreamPath(config, path),
        headers: buildUpstreamHeaders(req, body, config, credential),
        timeout: Number(process.env.UPSTREAM_TIMEOUT_MS || 600000)
      },
      (upstreamResponse) => handlers.response(upstreamResponse)
    )

    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('Upstream request timed out')))
    upstreamRequest.on('error', (error) => handlers.error(error))
    req.on('aborted', () => {
      if (!upstreamRequest.destroyed) upstreamRequest.destroy()
    })
    res.on('close', () => {
      if (!res.writableFinished && !upstreamRequest.destroyed) upstreamRequest.destroy()
    })
    upstreamRequest.end(body)
  } catch (error) {
    handlers.error(error)
  }
}

function sendRelayError(res, error) {
  if (res.headersSent) {
    res.destroy(error)
    return
  }
  const statusCode = error.statusCode || (error.code === 'ETIMEDOUT' ? 504 : 502)
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'relay_error', message: error.message } }))
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function isAuthorized(req, config) {
  return getClientApiKey(req) === config.relayApiKey
}

async function handleNativeMessages(req, res, config, bodyBuffer) {
  let body
  try {
    body = JSON.parse(bodyBuffer.toString('utf8') || '{}')
  } catch {
    return sendRelayError(res, Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }))
  }
  if (config.deepSeekHarnessCompat) body = translateDeepSeekHarnessRequest(body)
  const translatedBody = Buffer.from(JSON.stringify(body))

  relayRequest(req, res, config, translatedBody, normalizeIncomingPath(req.url), {
    response(upstreamResponse) {
      const contentType = String(upstreamResponse.headers['content-type'] || '').toLowerCase()
      if (body.stream !== true && contentType.includes('text/event-stream')) {
        if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
          const chunks = []
          upstreamResponse.on('data', (chunk) => chunks.push(chunk))
          upstreamResponse.on('end', () => {
            res.writeHead(upstreamResponse.statusCode || 502, { 'content-type': 'application/json' })
            res.end(Buffer.concat(chunks))
          })
          return
        }

        const aggregator = new AnthropicSseAggregator()
        upstreamResponse.on('data', (chunk) => aggregator.push(chunk))
        upstreamResponse.on('end', () => {
          try {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(aggregator.finish()))
          } catch (error) {
            if (error.anthropicError) {
              res.writeHead(error.statusCode || 502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ type: 'error', error: error.anthropicError }))
            } else {
              sendRelayError(res, error)
            }
          }
        })
        return
      }
      copyResponseHeaders(upstreamResponse, res)
      res.writeHead(upstreamResponse.statusCode || 502)
      upstreamResponse.pipe(res)
    },
    error: (error) => sendRelayError(res, error)
  })
}

async function handleResponses(req, res, config, bodyBuffer) {
  let body
  try {
    body = JSON.parse(bodyBuffer.toString('utf8') || '{}')
  } catch {
    return sendRelayError(res, Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }))
  }

  let claudeRequest
  try {
    claudeRequest = convertResponsesRequest(body)
  } catch (error) {
    return sendRelayError(res, Object.assign(error, { statusCode: 400 }))
  }
  const translatedBody = Buffer.from(JSON.stringify(claudeRequest))

  if (claudeRequest.stream) {
    const transformer = createSseTransformer(body.model)
    relayRequest(req, res, config, translatedBody, '/v1/messages', {
      response(upstreamResponse) {
        if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
          const chunks = []
          upstreamResponse.on('data', (chunk) => chunks.push(chunk))
          upstreamResponse.on('end', () => {
            res.writeHead(upstreamResponse.statusCode || 502, { 'content-type': 'application/json' })
            res.end(Buffer.concat(chunks))
          })
          return
        }
        res.writeHead(upstreamResponse.statusCode || 200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        upstreamResponse.on('data', (chunk) => {
          const output = transformer.push(chunk)
          if (output) res.write(output)
        })
        upstreamResponse.on('end', () => {
          const output = transformer.finish()
          if (output) res.write(output)
          res.end()
        })
      },
      error: (error) => sendRelayError(res, error)
    })
    return
  }

  relayRequest(req, res, config, translatedBody, '/v1/messages', {
    response(upstreamResponse) {
      const chunks = []
      upstreamResponse.on('data', (chunk) => chunks.push(chunk))
      upstreamResponse.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
          res.writeHead(upstreamResponse.statusCode || 502, { 'content-type': 'application/json' })
          res.end(raw)
          return
        }
        try {
          const translated = claudeToResponsesResponse(JSON.parse(raw), body.model)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(translated))
        } catch (error) {
          sendRelayError(res, Object.assign(error, { statusCode: 502 }))
        }
      })
    },
    error: (error) => sendRelayError(res, error)
  })
}

function createServer(config) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    const path = new URL(req.url, 'http://relay.local').pathname.replace(/^\/api/, '')

    if (path === '/oauth/authorize' || path === '/oauth/status' || path === '/oauth/exchange') {
      if (!isAuthorized(req, config)) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid relay API key' } })
        return
      }

      try {
        if (req.method === 'GET' && path === '/oauth/authorize') {
          sendJson(res, 200, config.oauthManager.createAuthorization())
          return
        }
        if (req.method === 'GET' && path === '/oauth/status') {
          sendJson(res, 200, config.oauthManager.status())
          return
        }
        if (req.method === 'POST' && path === '/oauth/exchange') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
          const result = await config.oauthManager.exchange(body)
          sendJson(res, 200, { success: true, data: result })
          return
        }
      } catch (error) {
        sendJson(res, error.statusCode || 400, { success: false, error: error.message })
        return
      }

      sendJson(res, 404, { error: 'Not found' })
      return
    }

    const isMessages = path.startsWith('/v1/messages')
    const isResponses = path === '/v1/responses' || path === '/v1/responses/compact'
    if (req.method !== 'POST' || (!isMessages && !isResponses)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    if (!isAuthorized(req, config)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid relay API key' }
      }))
      return
    }

    try {
      const body = await readBody(req)
      if (isResponses) await handleResponses(req, res, config, body)
      else await handleNativeMessages(req, res, config, body)
    } catch (error) {
      sendRelayError(res, error)
    }
  })
}

if (require.main === module) {
  try {
    const config = getConfig()
    const server = createServer(config)
    server.listen(config.port, config.host, () => {
      console.log(`minimal Claude relay listening on http://${config.host}:${config.port}`)
      console.log(`upstream: ${config.upstreamBaseUrl.origin}`)
    })
  } catch (error) {
    console.error(`minimal Claude relay failed to start: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { createServer, getConfig, normalizeIncomingPath, upstreamPath }
