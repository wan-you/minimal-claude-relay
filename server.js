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

function renderHomePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Minimal Claude Relay</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    body { margin: 0; background: #f5f5f2; color: #222; }
    main { max-width: 720px; margin: 48px auto; padding: 0 20px; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 14px; padding: 24px; margin: 16px 0; box-shadow: 0 8px 30px #0000000b; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    h2 { margin: 0 0 14px; font-size: 17px; }
    p { color: #666; line-height: 1.6; }
    label { display:block; margin: 12px 0 6px; font-size: 14px; font-weight: 600; }
    input, textarea { box-sizing: border-box; width: 100%; border: 1px solid #ccc; border-radius: 8px; padding: 10px; font: inherit; }
    textarea { min-height: 100px; resize: vertical; }
    button, a.button { display:inline-block; border:0; border-radius: 8px; background:#222; color:#fff; padding:10px 14px; cursor:pointer; text-decoration:none; font: inherit; }
    button.secondary { background:#e9e9e5; color:#222; }
    .row { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
    pre { white-space: pre-wrap; word-break: break-word; background:#f2f2ef; border-radius:8px; padding:12px; min-height: 20px; }
    .muted { font-size: 13px; color:#777; }
    .ok { color:#157347; } .error { color:#b42318; }
  </style>
</head>
<body>
<main>
  <div class="card">
    <h1>Minimal Claude Relay</h1>
    <p>这是单账号 Claude 中转。这里的 Key 是进入中转的 <code>RELAY_API_KEY</code>，OAuth Token 会保存在服务端本地。</p>
    <p class="muted">服务地址：<span id="origin"></span></p>
  </div>
  <div class="card">
    <h2>1. 连接入站 Key</h2>
    <label for="key">RELAY_API_KEY</label>
    <input id="key" type="password" autocomplete="off" placeholder="粘贴本地 .env 里的 RELAY_API_KEY">
    <div class="row"><button class="secondary" onclick="saveKey()">保存到本页</button><button class="secondary" onclick="loadStatus()">查看 OAuth 状态</button></div>
    <pre id="status">尚未查询状态</pre>
  </div>
  <div class="card">
    <h2>2. Claude OAuth 授权</h2>
    <p>点击后打开 Claude 登录授权页面。授权完成后，把浏览器地址栏里的完整回调地址粘贴回来。</p>
    <div class="row"><button onclick="startOAuth()">获取授权链接</button><a id="authLink" class="button" target="_blank" rel="noreferrer" style="display:none">打开 Claude 授权页</a></div>
    <label for="callback">回调地址</label>
    <textarea id="callback" placeholder="https://platform.claude.com/oauth/code/callback?..."></textarea>
    <div class="row"><button onclick="exchangeOAuth()">完成 OAuth 授权</button></div>
    <pre id="result">等待操作</pre>
  </div>
  <div class="card">
    <h2>3. 客户端地址</h2>
    <p>Claude Code 使用：</p>
    <pre>ANTHROPIC_BASE_URL=${'http://127.0.0.1:3001/api/'}
ANTHROPIC_AUTH_TOKEN=你的 RELAY_API_KEY</pre>
    <p>健康检查：<a href="/health">/health</a>　API：<code>/api/v1/messages</code></p>
  </div>
</main>
<script>
const keyInput = document.getElementById('key')
const statusBox = document.getElementById('status')
const resultBox = document.getElementById('result')
document.getElementById('origin').textContent = location.origin
keyInput.value = sessionStorage.getItem('minimalRelayKey') || ''
function saveKey() { sessionStorage.setItem('minimalRelayKey', keyInput.value.trim()); resultBox.textContent = '已保存到当前浏览器标签页' }
function authHeaders(json) { const key = keyInput.value.trim(); if (!key) throw new Error('请先填写 RELAY_API_KEY'); const h = { Authorization: 'Bearer ' + key }; if (json) h['Content-Type'] = 'application/json'; return h }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...authHeaders(Boolean(options.body)), ...(options.headers || {}) } }); const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = { raw: text } } if (!response.ok) throw new Error(data.error?.message || data.error || text || ('HTTP ' + response.status)); return data }
async function loadStatus() { try { saveKey(); const data = await api('/oauth/status'); statusBox.className = 'ok'; statusBox.textContent = JSON.stringify(data, null, 2) } catch (e) { statusBox.className = 'error'; statusBox.textContent = e.message } }
async function startOAuth() { try { saveKey(); const data = await api('/oauth/authorize'); const link = document.getElementById('authLink'); link.href = data.authUrl; link.style.display = 'inline-block'; resultBox.className = 'ok'; resultBox.textContent = '授权链接已生成。点击“打开 Claude 授权页”，完成后粘贴回调地址。' } catch (e) { resultBox.className = 'error'; resultBox.textContent = e.message } }
async function exchangeOAuth() { try { saveKey(); const callbackUrl = document.getElementById('callback').value.trim(); if (!callbackUrl) throw new Error('请粘贴回调地址'); const data = await api('/oauth/exchange', { method: 'POST', body: JSON.stringify({ callbackUrl }) }); resultBox.className = 'ok'; resultBox.textContent = 'OAuth 完成：\\n' + JSON.stringify(data, null, 2); loadStatus() } catch (e) { resultBox.className = 'error'; resultBox.textContent = e.message } }
</script>
</body>
</html>`
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
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderHomePage())
      return
    }

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
