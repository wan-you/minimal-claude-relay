'use strict'

function parseJson(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}

class AnthropicSseAggregator {
  constructor() {
    this.buffer = ''
    this.message = null
    this.blocks = []
    this.usage = {}
    this.stopReason = null
    this.stopSequence = null
    this.error = null
  }

  consumeEvent(event) {
    if (!event || !event.type) return

    if (event.type === 'message_start') {
      this.message = { ...(event.message || {}), content: [] }
      this.usage = { ...(event.message?.usage || {}) }
      return
    }

    if (event.type === 'content_block_start') {
      const index = Number.isInteger(event.index) ? event.index : this.blocks.length
      this.blocks[index] = { ...(event.content_block || {}) }
      const block = this.blocks[index]
      if (block.type === 'text' || block.type === 'thinking') {
        block.text = block.text || block.thinking || ''
      }
      if (block.type === 'server_tool_use' || block.type === 'tool_use') {
        block.input = block.input || {}
        block._partialJson = ''
      }
      if (block.type === 'text') block.citations = block.citations || []
      return
    }

    if (event.type === 'content_block_delta') {
      const index = Number.isInteger(event.index) ? event.index : 0
      const block = this.blocks[index] || (this.blocks[index] = {})
      const delta = event.delta || {}
      if (delta.type === 'text_delta') block.text = `${block.text || ''}${delta.text || ''}`
      else if (delta.type === 'thinking_delta') block.thinking = `${block.thinking || ''}${delta.thinking || ''}`
      else if (delta.type === 'input_json_delta') block._partialJson = `${block._partialJson || ''}${delta.partial_json || ''}`
      else if (delta.type === 'citations_delta' && delta.citation) {
        block.citations = block.citations || []
        block.citations.push(delta.citation)
      }
      return
    }

    if (event.type === 'content_block_stop') {
      const index = Number.isInteger(event.index) ? event.index : 0
      const block = this.blocks[index]
      if (block?._partialJson) block.input = parseJson(block._partialJson)
      return
    }

    if (event.type === 'message_delta') {
      this.stopReason = event.delta?.stop_reason ?? this.stopReason
      this.stopSequence = event.delta?.stop_sequence ?? this.stopSequence
      this.usage = { ...this.usage, ...(event.usage || {}) }
      return
    }

    if (event.type === 'error') {
      this.error = event.error || { type: 'api_error', message: 'Upstream stream error' }
    }
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8').replace(/\r\n/g, '\n')
    while (true) {
      const separator = this.buffer.indexOf('\n\n')
      if (separator < 0) break
      const raw = this.buffer.slice(0, separator)
      this.buffer = this.buffer.slice(separator + 2)
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        this.consumeEvent(JSON.parse(data))
      } catch {
        // Ignore comments and malformed intermediary events.
      }
    }
  }

  finish() {
    if (this.error) {
      const error = new Error(this.error.message || 'Upstream stream error')
      error.statusCode = 502
      error.anthropicError = this.error
      throw error
    }
    if (!this.message) throw Object.assign(new Error('Upstream SSE did not contain message_start'), { statusCode: 502 })

    const content = this.blocks.filter(Boolean).map((block) => {
      const result = { ...block }
      if (result._partialJson) result.input = parseJson(result._partialJson)
      delete result._partialJson
      if (result.type === 'thinking' && result.thinking === undefined) result.thinking = result.text || ''
      if (result.type === 'text' && result.text === undefined) result.text = ''
      return result
    })

    return {
      ...this.message,
      content,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      usage: { ...(this.message.usage || {}), ...this.usage }
    }
  }
}

module.exports = { AnthropicSseAggregator }
