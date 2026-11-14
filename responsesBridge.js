'use strict'

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => part?.text || part?.value || '')
    .filter(Boolean)
    .join('')
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}

function inputContentToAnthropic(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  return content.map((part) => {
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return { type: 'text', text: part.text || part.value || '' }
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const url = part.image_url?.url || part.image_url || part.url || ''
      const match = String(url).match(/^data:([^;]+);base64,(.+)$/)
      if (!match) throw new Error('Responses image inputs must be base64 data URLs')
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] }
      }
    }
    return { type: 'text', text: JSON.stringify(part) }
  })
}

function appendResponseInput(messages, item) {
  if (typeof item === 'string') {
    messages.push({ role: 'user', content: item })
    return
  }

  if (item?.type === 'message') {
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    messages.push({ role, content: inputContentToAnthropic(item.content) })
    return
  }

  if (item?.type === 'function_call') {
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: parseArguments(item.arguments)
      }]
    })
    return
  }

  if (item?.type === 'function_call_output') {
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: item.call_id || item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      }]
    })
  }
}

function convertTool(tool) {
  if (tool?.type !== 'function') return null
  const result = {
    name: tool.name || tool.function?.name,
    input_schema: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} }
  }
  const description = tool.description || tool.function?.description
  if (description) result.description = description
  return result
}

function convertResponsesRequest(body) {
  const messages = []
  let system = body.instructions

  if (Array.isArray(system)) system = textFromContent(system)
  for (const item of Array.isArray(body.input) ? body.input : [body.input]) {
    if (item !== undefined && item !== null) appendResponseInput(messages, item)
  }

  const request = {
    model: body.model,
    messages,
    max_tokens: body.max_output_tokens || body.max_tokens || 4096,
    stream: body.stream === true
  }

  if (system) request.system = typeof system === 'string' ? system : textFromContent(system)
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.top_p = body.top_p

  const effort = body.reasoning?.effort
  if (effort && effort !== 'none') {
    request.thinking = { type: 'adaptive' }
    request.output_config = { effort }
  } else if (effort === 'none') {
    request.thinking = { type: 'disabled' }
  }

  const tools = (body.tools || []).map(convertTool).filter(Boolean)
  if (tools.length > 0) request.tools = tools

  if (body.tool_choice === 'none') request.tool_choice = { type: 'none' }
  else if (body.tool_choice === 'required') request.tool_choice = { type: 'any' }
  else if (body.tool_choice?.type === 'function') {
    request.tool_choice = { type: 'tool', name: body.tool_choice.name || body.tool_choice.function?.name }
  } else if (body.tool_choice === 'auto') request.tool_choice = { type: 'auto' }

  return request
}

function responseIdFor(message) {
  return `resp_${message?.id || Math.random().toString(36).slice(2)}`
}

function claudeToResponsesResponse(message, requestedModel) {
  const responseId = responseIdFor(message)
  const output = []
  const text = []
  const content = Array.isArray(message?.content) ? message.content : []

  for (const block of content) {
    if (block.type === 'thinking') {
      output.push({
        type: 'reasoning',
        id: block.id || `reasoning_${output.length}`,
        summary: [{ type: 'summary_text', text: block.thinking || '' }]
      })
    } else if (block.type === 'text') {
      text.push(block.text || '')
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: block.id,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
        status: 'completed'
      })
    }
  }

  if (text.length > 0) {
    output.push({
      type: 'message',
      id: `msg_${message?.id || Date.now()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: text.join(''), annotations: [] }]
    })
  }

  const usage = message?.usage
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: message?.model || requestedModel,
    output,
    output_text: text.join(''),
    usage: usage
      ? {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
        }
      : undefined
  }
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

class AnthropicToResponsesStream {
  constructor(model) {
    this.model = model
    this.messageId = ''
    this.responseId = ''
    this.blocks = []
    this.usage = null
    this.stopReason = null
    this.createdAt = Math.floor(Date.now() / 1000)
  }

  responseShell(status = 'in_progress') {
    return {
      id: this.responseId || `resp_${this.messageId || Math.random().toString(36).slice(2)}`,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: []
    }
  }

  responseCompleted() {
    const message = {
      id: this.messageId,
      model: this.model,
      content: this.blocks.map((block) => {
        if (block.type === 'text') return { type: 'text', text: block.text }
        if (block.type === 'thinking') return { type: 'thinking', thinking: block.text }
        return { type: 'tool_use', id: block.id, name: block.name, input: parseArguments(block.arguments) }
      }),
      usage: this.usage
    }
    const result = claudeToResponsesResponse(message, this.model)
    result.id = this.responseId || result.id
    result.created_at = this.createdAt
    result.status = 'completed'
    result.output = result.output || []
    return result
  }

  convert(event) {
    const type = event?.type
    if (type === 'message_start') {
      this.messageId = event.message?.id || ''
      this.model = event.message?.model || this.model
      this.responseId = `resp_${this.messageId || Math.random().toString(36).slice(2)}`
      return [sseEvent('response.created', { type: 'response.created', response: this.responseShell() })]
    }

    if (type === 'content_block_start') {
      const source = event.content_block || {}
      const block = { type: source.type, id: source.id, name: source.name, text: source.text || '', arguments: '' }
      this.blocks[event.index ?? this.blocks.length] = block
      const index = event.index ?? this.blocks.length - 1
      if (source.type === 'text') {
        return [
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added', output_index: index,
            item: { type: 'message', id: `msg_${this.messageId}`, role: 'assistant', status: 'in_progress', content: [] }
          }),
          sseEvent('response.content_part.added', {
            type: 'response.content_part.added', item_id: `msg_${this.messageId}`,
            output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }
          })
        ]
      }
      if (source.type === 'tool_use') {
        return [sseEvent('response.output_item.added', {
          type: 'response.output_item.added', output_index: index,
          item: { type: 'function_call', id: source.id, call_id: source.id, name: source.name, arguments: '', status: 'in_progress' }
        })]
      }
      return []
    }

    if (type === 'content_block_delta') {
      const index = event.index ?? 0
      const block = this.blocks[index] || { type: event.delta?.type === 'text_delta' ? 'text' : 'tool_use', text: '', arguments: '' }
      this.blocks[index] = block
      if (event.delta?.type === 'text_delta') {
        block.text += event.delta.text || ''
        return [sseEvent('response.output_text.delta', {
          type: 'response.output_text.delta', item_id: `msg_${this.messageId}`,
          output_index: index, content_index: 0, delta: event.delta.text || ''
        })]
      }
      if (event.delta?.type === 'thinking_delta') {
        block.text += event.delta.thinking || ''
        return [sseEvent('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', item_id: block.id,
          output_index: index, summary_index: 0, delta: event.delta.thinking || ''
        })]
      }
      if (event.delta?.type === 'input_json_delta') {
        block.arguments += event.delta.partial_json || ''
        return [sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: block.id,
          output_index: index, delta: event.delta.partial_json || ''
        })]
      }
      return []
    }

    if (type === 'content_block_stop') {
      const index = event.index ?? 0
      const block = this.blocks[index]
      if (!block) return []
      if (block.type === 'text') {
        return [
          sseEvent('response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${this.messageId}`, output_index: index, content_index: 0, text: block.text }),
          sseEvent('response.content_part.done', { type: 'response.content_part.done', item_id: `msg_${this.messageId}`, output_index: index, content_index: 0, part: { type: 'output_text', text: block.text, annotations: [] } }),
          sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'message', id: `msg_${this.messageId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: block.text, annotations: [] }] } })
        ]
      }
      if (block.type === 'tool_use') {
        return [
          sseEvent('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: block.id, output_index: index, arguments: block.arguments || '{}' }),
          sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: block.id, call_id: block.id, name: block.name, arguments: block.arguments || '{}', status: 'completed' } })
        ]
      }
      return []
    }

    if (type === 'message_delta') {
      this.stopReason = event.delta?.stop_reason || null
      this.usage = event.usage || null
      return []
    }

    if (type === 'message_stop') {
      return [
        sseEvent('response.completed', { type: 'response.completed', response: this.responseCompleted() }),
        'data: [DONE]\n\n'
      ]
    }

    return []
  }
}

function createSseTransformer(model) {
  const state = new AnthropicToResponsesStream(model)
  let buffer = ''

  return {
    push(chunk) {
      buffer += chunk.toString('utf8')
      const outputs = []
      let separator
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!data || data === '[DONE]') continue
        try {
          outputs.push(...state.convert(JSON.parse(data)))
        } catch {
          // Ignore incomplete or non-JSON upstream SSE events.
        }
      }
      return outputs.join('')
    },
    finish() {
      return ''
    }
  }
}

module.exports = { convertResponsesRequest, claudeToResponsesResponse, createSseTransformer }
