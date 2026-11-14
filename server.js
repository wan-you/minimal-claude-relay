'use strict'

const http = require('node:http')
const https = require('node:https')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const pathModule = require('node:path')
const { URL } = require('node:url')
const { translateDeepSeekHarnessRequest } = require('./deepseekHarnessCompat')
const {
  convertResponsesRequest,
  claudeToResponsesResponse,
  createSseTransformer
} = require('./responsesBridge')
const { AnthropicSseAggregator } = require('./anthropicAggregator')
const {
  ClaudeOAuthManager,
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  keychainAccounts,
  readClaudeCodeKeychain
} = require('./claudeOAuthManager')

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

  const configuredAuthMode = (env.CLAUDE_AUTH_MODE || '').toLowerCase()
  const importMode = (env.CLAUDE_CODE_OAUTH_IMPORT || 'auto').toLowerCase()
  const autoImportClaudeCodeOAuth = !['false', '0', 'off', 'never'].includes(importMode) && configuredAuthMode !== 'api'
  const oauthManager = new ClaudeOAuthManager({
    storePath: env.CLAUDE_OAUTH_STORE || pathModule.join(process.cwd(), '.oauth-tokens.json'),
    accessToken: env.CLAUDE_OAUTH_ACCESS_TOKEN,
    refreshToken: env.CLAUDE_OAUTH_REFRESH_TOKEN,
    expiresAt: env.CLAUDE_OAUTH_EXPIRES_AT,
    autoImport: autoImportClaudeCodeOAuth,
    keychainReader: () => readClaudeCodeKeychain({
      service: env.CLAUDE_CODE_KEYCHAIN_SERVICE || CLAUDE_CODE_KEYCHAIN_SERVICE,
      accounts: keychainAccounts({ env, homeDirectory: env.HOME })
    })
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
    logPath: env.RELAY_LOG_PATH || pathModule.join(process.cwd(), 'launchd.log'),
    launchdLabel: env.RELAY_LAUNCHD_LABEL || 'com.wanyou.minimal-claude-relay',
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

async function probeUpstream(config, onProgress = () => {}) {
  const startedAt = Date.now()
  onProgress({ phase: 'prepare', status: 'running', message: '准备上游认证凭证' })
  let credential
  try {
    credential = config.authMode === 'oauth'
      ? await config.oauthManager.getAccessToken()
      : config.upstreamApiKey
  } catch (error) {
    onProgress({ phase: 'prepare', status: 'error', message: error.message })
    return { ok: false, network_reachable: false, auth_ready: false, latency_ms: Date.now() - startedAt, error: error.message }
  }

  const requestPath = upstreamPath(config, '/v1/models?limit=1')
  onProgress({
    phase: 'request',
    status: 'running',
    message: '发送上游模型列表探测请求',
    request: {
      method: 'GET',
      url: `${config.upstreamBaseUrl.origin}${requestPath}`,
      headers: { authorization: config.authHeader === 'authorization' ? 'Bearer ***' : undefined, 'x-api-key': config.authHeader === 'authorization' ? undefined : '***', 'anthropic-version': '2023-06-01' }
    }
  })

  return new Promise((resolve) => {
    const target = config.upstreamBaseUrl
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: requestPath,
      headers: {
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        ...(config.authHeader === 'authorization'
          ? { authorization: `Bearer ${credential}` }
          : { 'x-api-key': credential })
      },
      timeout: 10000
    }, (response) => {
      const statusCode = response.statusCode || 0
      const chunks = []
      let bodyBytes = 0
      response.on('data', (chunk) => {
        if (bodyBytes < 64 * 1024) {
          chunks.push(chunk)
          bodyBytes += chunk.length
        }
      })
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8')
        let bodySummary = { bytes_sampled: bodyBytes }
        try {
          const parsed = JSON.parse(rawBody)
          bodySummary = { ...bodySummary, model_count: Array.isArray(parsed.data) ? parsed.data.length : undefined, error_type: parsed.error?.type || undefined }
        } catch {
          bodySummary.parseable_json = false
        }
        const result = {
          ok: statusCode >= 200 && statusCode < 300,
          network_reachable: true,
          auth_ready: statusCode !== 401 && statusCode !== 403,
          status_code: statusCode,
          latency_ms: Date.now() - startedAt,
          response: { content_type: response.headers['content-type'] || null, body_summary: bodySummary }
        }
        onProgress({ phase: 'response', status: result.ok ? 'success' : 'error', message: `收到上游 HTTP ${statusCode}`, response: result.response, status_code: statusCode })
        onProgress({ phase: 'complete', status: result.ok ? 'success' : 'error', message: result.ok ? '上游检测通过' : '上游返回非成功状态', result })
        resolve(result)
      })
    })
    request.on('timeout', () => request.destroy(new Error('upstream probe timed out')))
    request.on('error', (error) => {
      const result = { ok: false, network_reachable: false, auth_ready: Boolean(credential), latency_ms: Date.now() - startedAt, error: error.message, code: error.code || null }
      onProgress({ phase: 'response', status: 'error', message: error.message, result })
      onProgress({ phase: 'complete', status: 'error', message: '上游检测失败', result })
      resolve(result)
    })
    request.end()
  })
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
    .status-panel { min-height: 20px; }
    .info-grid { display:grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap:10px; }
    .metric { background:#f2f2ef; border-radius:9px; padding:12px; }
    .metric-label { color:#777; font-size:12px; margin-bottom:4px; }
    .metric-value { font-weight:600; overflow-wrap:anywhere; }
    .probe { border-radius:10px; padding:14px; margin-bottom:12px; border:1px solid #ddd; }
    .probe.good { background:#edf8f0; border-color:#b7dfc2; color:#14532d; }
    .probe.bad { background:#fff1f0; border-color:#f3b4ae; color:#8a1c13; }
    .probe-title { font-size:18px; font-weight:700; margin-bottom:5px; }
    .timeline { display:grid; gap:8px; }
    .timeline-step { border-left:3px solid #bbb; padding:10px 12px; background:#f2f2ef; border-radius:0 8px 8px 0; }
    .timeline-step.success { border-left-color:#299447; }
    .timeline-step.error { border-left-color:#c3342d; }
    .timeline-step.running { border-left-color:#c99318; }
    .timeline-title { font-weight:700; margin-bottom:4px; }
    .timeline-detail { font-size:13px; color:#666; white-space:pre-wrap; word-break:break-word; }
    @media (max-width:560px) { .info-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<main>
  <div class="card">
    <h1>Minimal Claude Relay</h1>
    <p>这是单账号 Claude 中转。本机管理面板无需输入 Key；远程访问管理接口仍需 <code>RELAY_API_KEY</code>。</p>
    <p class="muted">服务地址：<span id="origin"></span></p>
  </div>
  <div class="card">
    <h2>1. 管理面板访问</h2>
    <label for="key">RELAY_API_KEY</label>
    <input id="key" type="password" autocomplete="off" placeholder="远程访问时填写 RELAY_API_KEY；本机访问可留空">
    <div class="row"><button class="secondary" onclick="saveKey()">保存到本页</button><button class="secondary" onclick="loadStatus()">查看 OAuth 状态</button></div>
    <div id="status" class="status-panel">尚未查询状态</div>
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
  <div class="card">
    <h2>4. 服务日志</h2>
    <p>日志接口需要入站 Key，只显示最近记录。</p>
    <div class="row"><button class="secondary" onclick="loadLogs()">刷新日志</button></div>
    <pre id="logs">尚未加载日志</pre>
  </div>
  <div class="card">
    <h2>5. 上游检测与服务管理</h2>
    <p>检测会真实请求 Claude 上游的轻量模型列表接口，不调用模型生成，不消耗文本 Token。</p>
    <div class="row"><button class="secondary" onclick="loadDiagnostics()">检测上游连通性</button><button onclick="restartRelay()">重启服务</button></div>
    <div id="diagnostics" class="status-panel">尚未检测</div>
  </div>
</main>
<script>
const keyInput = document.getElementById('key')
const statusBox = document.getElementById('status')
const resultBox = document.getElementById('result')
document.getElementById('origin').textContent = location.origin
keyInput.value = sessionStorage.getItem('minimalRelayKey') || ''
function saveKey() { sessionStorage.setItem('minimalRelayKey', keyInput.value.trim()); resultBox.textContent = '已保存到当前浏览器标签页' }
function esc(value) { return String(value ?? '-').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function metric(label, value) { return '<div class="metric"><div class="metric-label">' + esc(label) + '</div><div class="metric-value">' + esc(value) + '</div></div>' }
function renderOAuth(data) { const state = data.configured ? (data.expired ? '已过期' : '已连接') : '未连接'; return '<div class="probe ' + (data.configured && !data.expired ? 'good' : 'bad') + '"><div class="probe-title">OAuth：' + state + '</div><div class="info-grid">' + metric('Token 来源', data.source || '-') + metric('Access Token', data.hasAccessToken ? '已配置' : '未配置') + metric('Refresh Token', data.hasRefreshToken ? '已配置' : '未配置') + metric('过期时间', data.expiresAt || '-') + '</div></div>' }
function renderDiagnostics(data) { const p = data.upstream_probe || {}; const probeOk = p.ok === true; const probeTitle = probeOk ? '上游 Claude 可用' : (p.network_reachable ? '上游可达，但 API 检测失败' : '上游不可达'); return '<div class="probe ' + (probeOk ? 'good' : 'bad') + '"><div class="probe-title">' + probeTitle + '</div><div class="info-grid">' + metric('HTTP 状态', p.status_code || '-') + metric('延迟', p.latency_ms != null ? p.latency_ms + ' ms' : '-') + metric('网络连通', p.network_reachable ? '是' : '否') + metric('鉴权状态', p.auth_ready ? '可用' : '未就绪') + '</div>' + (p.error ? '<p>' + esc(p.error) + '</p>' : '') + '</div><div class="info-grid">' + metric('上游地址', data.upstream) + metric('认证模式', data.auth_mode) + metric('进程 PID', data.pid) + metric('运行时间', data.uptime_seconds + ' 秒') + metric('LaunchAgent', data.launchd?.state || '未知') + metric('日志路径', data.log_path) + '</div>' + renderOAuth(data.oauth || {}) }
function renderProbeEvent(event) { const status = event.status || 'running'; let detail = event.message || ''; if (event.request) detail += '\\n' + event.request.method + ' ' + event.request.url + '\\n请求头：' + JSON.stringify(event.request.headers); if (event.response) detail += '\\n响应：' + JSON.stringify(event.response); if (event.result) detail += '\\n结果：' + JSON.stringify(event.result); return '<div class="timeline-step ' + esc(status) + '"><div class="timeline-title">' + esc(event.phase || 'step') + '</div><div class="timeline-detail">' + esc(detail) + '</div></div>' }
function authHeaders(json) { const key = keyInput.value.trim(); const h = {}; if (key) h.Authorization = 'Bearer ' + key; if (json) h['Content-Type'] = 'application/json'; return h }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...authHeaders(Boolean(options.body)), ...(options.headers || {}) } }); const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = { raw: text } } if (!response.ok) throw new Error(data.error?.message || data.error || text || ('HTTP ' + response.status)); return data }
async function loadStatus() { try { saveKey(); const data = await api('/oauth/status'); statusBox.className = ''; statusBox.innerHTML = renderOAuth(data) } catch (e) { statusBox.className = 'error'; statusBox.textContent = e.message } }
async function startOAuth() { try { saveKey(); const data = await api('/oauth/authorize'); const link = document.getElementById('authLink'); link.href = data.authUrl; link.style.display = 'inline-block'; resultBox.className = 'ok'; resultBox.textContent = '授权链接已生成。点击“打开 Claude 授权页”，完成后粘贴回调地址。' } catch (e) { resultBox.className = 'error'; resultBox.textContent = e.message } }
async function exchangeOAuth() { try { saveKey(); const callbackUrl = document.getElementById('callback').value.trim(); if (!callbackUrl) throw new Error('请粘贴回调地址'); const data = await api('/oauth/exchange', { method: 'POST', body: JSON.stringify({ callbackUrl }) }); resultBox.className = 'ok'; resultBox.textContent = 'OAuth 完成：\\n' + JSON.stringify(data, null, 2); loadStatus() } catch (e) { resultBox.className = 'error'; resultBox.textContent = e.message } }
async function loadLogs() { try { saveKey(); const data = await api('/logs?lines=200'); document.getElementById('logs').textContent = data.logs || '(暂无日志)' } catch (e) { document.getElementById('logs').textContent = e.message } }
async function loadDiagnostics() { const box = document.getElementById('diagnostics'); try { saveKey(); const response = await fetch('/diagnostics/stream', { method: 'POST', headers: authHeaders(true), body: '{}' }); if (!response.ok) throw new Error(await response.text()); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = []; const render = () => { box.className = ''; box.innerHTML = '<div class="timeline">' + events.map(renderProbeEvent).join('') + '</div>' }; while (true) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const chunks = buffer.split('\n\n'); buffer = chunks.pop() || ''; for (const chunk of chunks) { const line = chunk.split('\n').find(x => x.startsWith('data: ')); if (!line) continue; try { const event = JSON.parse(line.slice(6)); events.push(event); render(); } catch {} } } render() } catch (e) { box.className = 'error'; box.textContent = e.message } }
async function restartRelay() { if (!confirm('确定重启本地中转服务吗？')) return; try { saveKey(); const data = await api('/admin/restart', { method: 'POST', body: '{}' }); document.getElementById('diagnostics').textContent = JSON.stringify(data, null, 2) + '\\n服务正在重启，请稍后刷新页面。' } catch (e) { document.getElementById('diagnostics').textContent = e.message } }
</script>
</body>
</html>`
}

function isAuthorized(req, config) {
  return getClientApiKey(req) === config.relayApiKey
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isManagementAuthorized(req, config) {
  return isLoopbackRequest(req) || isAuthorized(req, config)
}

function readRecentLogs(logPath, lineCount = 200) {
  try {
    const content = fs.readFileSync(logPath, 'utf8')
    const count = Math.max(1, Math.min(Number(lineCount) || 200, 1000))
    return content.split(/\r?\n/).slice(-count).join('\n')
  } catch (error) {
    return `日志暂不可用：${error.message}`
  }
}

function getLaunchdStatus(label) {
  if (process.platform !== 'darwin') return { available: false, reason: 'launchd is macOS-only' }
  return new Promise((resolve) => {
    const domain = `gui/${typeof process.getuid === 'function' ? process.getuid() : ''}/${label}`
    execFile('/bin/launchctl', ['print', domain], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve({ available: false, label, error: error.message })
        return
      }
      const state = stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() || null
      const pid = stdout.match(/\bpid = (\d+)/)?.[1] || null
      resolve({ available: true, label, state, pid })
    })
  })
}

async function buildDiagnostics(config, onProgress = () => {}) {
  return {
    service: 'minimal-claude-relay',
    ok: true,
    pid: process.pid,
    uptime_seconds: Math.floor(process.uptime()),
    node: process.version,
    platform: process.platform,
    port: config.port,
    auth_mode: config.authMode,
    upstream: config.upstreamBaseUrl.origin,
    upstream_probe: await probeUpstream(config, onProgress),
    oauth: config.oauthManager.status(),
    launchd: await getLaunchdStatus(config.launchdLabel),
    log_path: config.logPath
  }
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
      if (!isManagementAuthorized(req, config)) {
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

    if (path === '/logs') {
      if (req.method !== 'GET' || !isManagementAuthorized(req, config)) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid relay API key' } })
        return
      }
      const query = new URL(req.url, 'http://relay.local').searchParams
      sendJson(res, 200, { logs: readRecentLogs(config.logPath, query.get('lines') || 200), path: config.logPath })
      return
    }

    if (path === '/diagnostics') {
      if (req.method !== 'GET' || !isManagementAuthorized(req, config)) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid relay API key' } })
        return
      }
      sendJson(res, 200, await buildDiagnostics(config))
      return
    }

    if (path === '/diagnostics/stream') {
      if (req.method !== 'POST' || !isManagementAuthorized(req, config)) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid relay API key' } })
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const sendEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
      try {
        sendEvent({ phase: 'start', status: 'running', message: '开始检测服务与上游' })
        const result = await buildDiagnostics(config, sendEvent)
        sendEvent({ phase: 'diagnostics', status: 'success', message: '本地服务检测完成', diagnostics: result })
        sendEvent({ phase: 'done', status: 'success', message: '检测结束' })
      } catch (error) {
        sendEvent({ phase: 'done', status: 'error', message: error.message })
      }
      res.end()
      return
    }

    if (path === '/admin/restart') {
      if (req.method !== 'POST' || !isManagementAuthorized(req, config)) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid relay API key' } })
        return
      }
      if (process.platform !== 'darwin') {
        sendJson(res, 501, { success: false, error: 'LaunchAgent restart is only supported on macOS' })
        return
      }
      sendJson(res, 202, { success: true, message: 'Restart scheduled', launchd_label: config.launchdLabel })
      setTimeout(() => {
        const domain = `gui/${typeof process.getuid === 'function' ? process.getuid() : ''}/${config.launchdLabel}`
        execFile('/bin/launchctl', ['kickstart', '-k', domain], { timeout: 5000 }, () => {})
      }, 100)
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

    console.log(`[request] ${req.method} ${req.url}`)

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

module.exports = { createServer, getConfig, normalizeIncomingPath, upstreamPath, probeUpstream }
