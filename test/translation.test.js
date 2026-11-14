'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { translateDeepSeekHarnessRequest } = require('../deepseekHarnessCompat')
const {
  convertResponsesRequest,
  claudeToResponsesResponse,
  createSseTransformer
} = require('../responsesBridge')

test('translates DeepSeek Harness legacy thinking for adaptive Claude models', () => {
  const result = translateDeepSeekHarnessRequest({
    model: 'claude-fable-5',
    temperature: 0.2,
    thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' }
  })
  assert.deepEqual(result.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(result.output_config, { effort: 'medium' })
  assert.equal(result.temperature, undefined)
})

test('converts Codex Responses input to Claude Messages', () => {
  const result = convertResponsesRequest({
    model: 'claude-sonnet-5',
    instructions: 'Be concise',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    stream: true
  })
  assert.equal(result.system, 'Be concise')
  assert.deepEqual(result.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  assert.deepEqual(result.tools[0], { name: 'Read', input_schema: { type: 'object' } })
  assert.deepEqual(result.thinking, { type: 'adaptive' })
  assert.deepEqual(result.output_config, { effort: 'high' })
})

test('converts Claude response to Responses response', () => {
  const result = claudeToResponsesResponse({
    id: 'msg_1',
    model: 'claude-sonnet-5',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'a.txt' } }
    ],
    usage: { input_tokens: 2, output_tokens: 3 }
  }, 'claude-sonnet-5')
  assert.equal(result.object, 'response')
  assert.equal(result.output_text, 'hello')
  assert.equal(result.output.find((item) => item.type === 'function_call').type, 'function_call')
  assert.equal(result.usage.total_tokens, 5)
})

test('converts Anthropic stream events to Responses events', () => {
  const transformer = createSseTransformer('claude-sonnet-5')
  const source = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ]
  const output = source.map((event) => transformer.push(`data: ${JSON.stringify(event)}\n\n`)).join('')
  assert.match(output, /event: response.created/)
  assert.match(output, /event: response.output_text.delta/)
  assert.match(output, /event: response.completed/)
  assert.match(output, /data: \[DONE\]/)
})
