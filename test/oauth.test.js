'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ClaudeOAuthManager, CLIENT_ID, REDIRECT_URI } = require('../claudeOAuthManager')

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
