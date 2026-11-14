'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { upstreamPath } = require('../server')

test('removes the local /api compatibility prefix', () => {
  const config = { upstreamBaseUrl: new URL('https://api.anthropic.com') }
  assert.equal(upstreamPath(config, '/v1/messages?beta=true'), '/v1/messages?beta=true')
})

test('keeps the native /v1/messages path', () => {
  const config = { upstreamBaseUrl: new URL('https://api.anthropic.com') }
  assert.equal(upstreamPath(config, '/v1/messages'), '/v1/messages')
})

test('joins a configured upstream path once', () => {
  const config = { upstreamBaseUrl: new URL('https://example.test/anthropic') }
  assert.equal(upstreamPath(config, '/v1/messages'), '/anthropic/v1/messages')
})

test('forwards the Claude body and replaces the client key', async (t) => {
  let received = null
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        apiKey: req.headers['x-api-key'],
        body: Buffer.concat(chunks).toString('utf8')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] }))
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())

  const relay = require('../server').createServer({
    host: '127.0.0.1',
    port: 0,
    upstreamBaseUrl: new URL(`http://127.0.0.1:${upstream.address().port}`),
    upstreamApiKey: 'upstream-secret',
    relayApiKey: 'client-secret',
    authHeader: 'x-api-key'
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  t.after(() => relay.close())

  const unauthorized = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: relay.address().port,
        path: '/v1/messages',
        method: 'POST'
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    request.on('error', reject)
    request.end('{}')
  })
  assert.equal(unauthorized, 401)

  const payload = JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] })
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: relay.address().port,
        path: '/api/v1/messages?beta=true',
        method: 'POST',
        headers: {
          authorization: 'Bearer client-secret',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }))
      }
    )
    request.on('error', reject)
    request.end(payload)
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).content[0].text, 'ok')
  assert.deepEqual(received, {
    method: 'POST',
    url: '/v1/messages?beta=true',
    apiKey: 'upstream-secret',
    body: payload
  })
})

test('passes an Anthropic SSE stream through unchanged', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())

  const relay = require('../server').createServer({
    host: '127.0.0.1',
    port: 0,
    upstreamBaseUrl: new URL(`http://127.0.0.1:${upstream.address().port}`),
    upstreamApiKey: 'upstream-secret',
    relayApiKey: 'client-secret',
    authHeader: 'x-api-key'
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  t.after(() => relay.close())

  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: relay.address().port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          authorization: 'Bearer client-secret',
          'content-type': 'application/json'
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ type: res.headers['content-type'], body: Buffer.concat(chunks).toString() }))
      }
    )
    request.on('error', reject)
    request.end('{"stream":true}')
  })

  assert.equal(result.type, 'text/event-stream')
  assert.equal(result.body, 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
})

test('translates a Codex Responses request through the relay', async (t) => {
  let receivedBody = null
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString())
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_codex',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'translated' }],
        usage: { input_tokens: 4, output_tokens: 2 }
      }))
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())

  const relay = require('../server').createServer({
    host: '127.0.0.1',
    port: 0,
    upstreamBaseUrl: new URL(`http://127.0.0.1:${upstream.address().port}`),
    upstreamApiKey: 'upstream-secret',
    relayApiKey: 'client-secret',
    authHeader: 'x-api-key'
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  t.after(() => relay.close())

  const payload = JSON.stringify({
    model: 'claude-sonnet-5',
    instructions: 'Be concise',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
  })
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: relay.address().port,
        path: '/v1/responses',
        method: 'POST',
        headers: {
          authorization: 'Bearer client-secret',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }))
      }
    )
    request.on('error', reject)
    request.end(payload)
  })

  const translated = JSON.parse(response.body)
  assert.equal(response.statusCode, 200)
  assert.equal(translated.object, 'response')
  assert.equal(translated.output_text, 'translated')
  assert.equal(receivedBody.system, 'Be concise')
  assert.equal(receivedBody.messages[0].content[0].text, 'hello')
})

test('aggregates non-stream web_search SSE into one Anthropic Message', async (t) => {
  const send = (res, event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    send(res, { type: 'message_start', message: { id: 'msg_search', type: 'message', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 0 } } })
    send(res, { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } })
    send(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"arxiv"}' } })
    send(res, { type: 'content_block_stop', index: 0 })
    send(res, { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.test/paper' }] } })
    send(res, { type: 'content_block_stop', index: 1 })
    send(res, { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })
    send(res, { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.test/paper' } } })
    send(res, { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'found it' } })
    send(res, { type: 'content_block_stop', index: 2 })
    send(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 4, server_tool_use: { web_search_requests: 1 } } })
    send(res, { type: 'message_stop' })
    res.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())

  const relay = require('../server').createServer({
    host: '127.0.0.1',
    port: 0,
    upstreamBaseUrl: new URL(`http://127.0.0.1:${upstream.address().port}`),
    upstreamApiKey: 'upstream-secret',
    relayApiKey: 'client-secret',
    authHeader: 'x-api-key'
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  t.after(() => relay.close())

  const payload = JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'search arxiv' }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    thinking: { type: 'disabled' }
  })
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: relay.address().port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          authorization: 'Bearer client-secret',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'], body: Buffer.concat(chunks).toString() }))
      }
    )
    request.on('error', reject)
    request.end(payload)
  })

  const message = JSON.parse(response.body)
  assert.equal(response.statusCode, 200)
  assert.match(response.contentType, /^application\/json/)
  assert.deepEqual(message.content.map((item) => item.type), ['server_tool_use', 'web_search_tool_result', 'text'])
  assert.deepEqual(message.content[0].input, { query: 'arxiv' })
  assert.equal(message.content[1].content[0].url, 'https://example.test/paper')
  assert.equal(message.content[2].text, 'found it')
  assert.equal(message.usage.server_tool_use.web_search_requests, 1)
})
