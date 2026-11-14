'use strict'

const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function createCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function parseCallbackInput(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('callbackUrl or authorization code is required')
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw)
    return { code: url.searchParams.get('code'), state: url.searchParams.get('state') }
  }
  return { code: raw.split('#')[0].split('&')[0], state: null }
}

async function exchangeToken(payload) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'user-agent': 'claude-cli/1.0.56 (external, cli)',
      'accept-language': 'en-US,en;q=0.9',
      origin: 'https://claude.ai',
      referer: 'https://claude.ai/'
    },
    body: JSON.stringify(payload)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error_description || data.message || `OAuth token request failed (${response.status})`)
    error.statusCode = response.status
    throw error
  }
  return data
}

function keychainAccounts({ env = process.env, homeDirectory = os.homedir() } = {}) {
  return [...new Set([
    env.CLAUDE_CODE_KEYCHAIN_ACCOUNT,
    env.USER,
    env.LOGNAME,
    path.basename(homeDirectory)
  ].filter(Boolean))]
}

function normalizeKeychainOAuth(value) {
  if (!value || typeof value !== 'object') return null
  const accessToken = typeof value.accessToken === 'string' ? value.accessToken.trim() : ''
  const refreshToken = typeof value.refreshToken === 'string' ? value.refreshToken.trim() : ''
  if (!accessToken && !refreshToken) return null

  const expiresAt = Number(value.expiresAt) || 0
  return { accessToken, refreshToken, expiresAt }
}

/**
 * Read Claude Code's first-party OAuth record from the macOS Keychain.
 * The token values are never printed or logged; callers receive the parsed
 * credential object so it can be written to the relay's private token store.
 */
function readClaudeCodeKeychain({
  platform = process.platform,
  service = CLAUDE_CODE_KEYCHAIN_SERVICE,
  accounts = keychainAccounts(),
  execFileSyncImpl = execFileSync
} = {}) {
  if (platform !== 'darwin') return null

  for (const account of accounts) {
    try {
      const raw = execFileSyncImpl('/usr/bin/security', [
        'find-generic-password',
        '-s', service,
        '-a', account,
        '-w'
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000
      })
      const record = JSON.parse(String(raw))
      const oauth = normalizeKeychainOAuth(record.claudeAiOauth)
      if (oauth) return { ...oauth, account }
    } catch {
      // Keychain access is optional. Fall through to the next account or the
      // normal relay token store when this machine has no usable Claude login.
    }
  }

  return null
}

class ClaudeOAuthManager {
  constructor({
    storePath,
    accessToken = '',
    refreshToken = '',
    expiresAt = '',
    autoImport = false,
    keychainReader = readClaudeCodeKeychain
  } = {}) {
    this.storePath = storePath
    this.pending = new Map()
    this.accessToken = accessToken || ''
    this.refreshToken = refreshToken || ''
    this.expiresAt = Number(expiresAt) || 0
    this.credentialSource = this.accessToken || this.refreshToken ? 'environment' : null
    this.keychainAccount = null
    this.load()
    if (autoImport && !this.accessToken && !this.refreshToken) {
      let imported = null
      try {
        imported = keychainReader()
      } catch {
        imported = null
      }
      if (imported) {
        this.accessToken = imported.accessToken
        this.refreshToken = imported.refreshToken
        this.expiresAt = imported.expiresAt
        this.credentialSource = 'claude-code-keychain'
        this.keychainAccount = imported.account || null
        this.save()
      }
    }
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'))
      this.accessToken = data.accessToken || this.accessToken
      this.refreshToken = data.refreshToken || this.refreshToken
      this.expiresAt = Number(data.expiresAt) || this.expiresAt
      if (this.accessToken || this.refreshToken) this.credentialSource = 'store'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  save() {
    const directory = path.dirname(this.storePath)
    fs.mkdirSync(directory, { recursive: true })
    const temporaryPath = `${this.storePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      updatedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 })
    fs.renameSync(temporaryPath, this.storePath)
  }

  createAuthorization() {
    const state = randomBase64Url()
    const codeVerifier = randomBase64Url()
    const codeChallenge = createCodeChallenge(codeVerifier)
    this.pending.set(state, { codeVerifier, expiresAt: Date.now() + 10 * 60 * 1000 })

    const params = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state
    })
    return { authUrl: `${AUTHORIZE_URL}?${params.toString()}`, state, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  }

  async exchange({ callbackUrl, code, state }) {
    const parsed = callbackUrl ? parseCallbackInput(callbackUrl) : { code, state }
    if (!parsed.code) throw new Error('OAuth callback did not contain a code')
    const pending = parsed.state ? this.pending.get(parsed.state) : null
    if (!pending || pending.expiresAt < Date.now()) throw new Error('Invalid or expired OAuth state')

    const data = await exchangeToken({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: parsed.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.codeVerifier,
      state: parsed.state
    })
    this.pending.delete(parsed.state)
    this.applyTokenResponse(data)
    this.save()
    return this.status()
  }

  applyTokenResponse(data) {
    if (!data.access_token) throw new Error('OAuth response did not contain access_token')
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token || this.refreshToken
    this.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000
    this.credentialSource = 'oauth'
  }

  async refresh() {
    if (!this.refreshToken) throw new Error('No Claude OAuth refresh token configured')
    const data = await exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: CLIENT_ID
    })
    this.applyTokenResponse(data)
    this.save()
    return this.accessToken
  }

  async getAccessToken() {
    if (!this.accessToken || this.expiresAt <= Date.now() + 60 * 1000) return this.refresh()
    return this.accessToken
  }

  status() {
    return {
      configured: Boolean(this.accessToken || this.refreshToken),
      hasAccessToken: Boolean(this.accessToken),
      hasRefreshToken: Boolean(this.refreshToken),
      expiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      expired: this.expiresAt > 0 && this.expiresAt <= Date.now(),
      source: this.credentialSource
    }
  }
}

module.exports = {
  ClaudeOAuthManager,
  AUTHORIZE_URL,
  TOKEN_URL,
  CLIENT_ID,
  REDIRECT_URI,
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  keychainAccounts,
  normalizeKeychainOAuth,
  readClaudeCodeKeychain
}
