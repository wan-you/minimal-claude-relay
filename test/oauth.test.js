'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  ClaudeOAuthManager,
  CLIENT_ID,
  REDIRECT_URI,
  readClaudeCodeKeychain
} = require('../claudeOAuthManager')

test('creates CRS-compatible PKCE authorization parameters', () => {
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-oauth-')), 'tokens.json')
  const manager = new ClaudeOAuthManager({ storePath })
  const result = manager.createAuthorization()
  const url = new URL(result.authUrl)

  assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'))
  assert.ok(url.searchParams.get('state'))
})

test('persists OAuth tokens without exposing them in status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-oauth-'))
  const storePath = path.join(directory, 'tokens.json')
  const manager = new ClaudeOAuthManager({ storePath })
  manager.applyTokenResponse({ access_token: 'access-test', refresh_token: 'refresh-test', expires_in: 3600 })
  manager.save()

  const loaded = new ClaudeOAuthManager({ storePath })
  const status = loaded.status()
  assert.equal(status.configured, true)
  assert.equal(status.hasAccessToken, true)
  assert.equal(status.hasRefreshToken, true)
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).accessToken, 'access-test')
})

test('reads Claude Code OAuth from the macOS Keychain without logging token values', () => {
  const calls = []
  const imported = readClaudeCodeKeychain({
    platform: 'darwin',
    accounts: ['missing', 'wanyou'],
    execFileSyncImpl(_file, args) {
      const account = args[args.indexOf('-a') + 1]
      calls.push(account)
      if (account === 'missing') throw new Error('item not found')
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: 'access-from-claude-code',
          refreshToken: 'refresh-from-claude-code',
          expiresAt: 1234567890
        }
      })
    }
  })

  assert.deepEqual(calls, ['missing', 'wanyou'])
  assert.deepEqual(imported, {
    accessToken: 'access-from-claude-code',
    refreshToken: 'refresh-from-claude-code',
    expiresAt: 1234567890,
    account: 'wanyou'
  })
})

test('auto-imports only when the relay OAuth store is empty', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-oauth-'))
  const storePath = path.join(directory, 'tokens.json')
  const imported = new ClaudeOAuthManager({
    storePath,
    autoImport: true,
    keychainReader: () => ({
      accessToken: 'access-from-claude-code',
      refreshToken: 'refresh-from-claude-code',
      expiresAt: 1234567890,
      account: 'wanyou'
    })
  })

  assert.equal(imported.status().source, 'claude-code-keychain')
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).refreshToken, 'refresh-from-claude-code')

  const existing = new ClaudeOAuthManager({
    storePath,
    autoImport: true,
    keychainReader: () => { throw new Error('Keychain should not be read when the store is configured') }
  })
  assert.equal(existing.status().source, 'store')
  assert.equal(existing.accessToken, 'access-from-claude-code')
})
