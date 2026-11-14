'use strict'

function effortForBudget(budget) {
  if (budget <= 1024) return 'low'
  if (budget <= 8192) return 'medium'
  return 'high'
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
}

/**
 * DeepSeek Harness sends Anthropic Messages, but some Claude model families
 * reject its legacy thinking form. Keep native requests untouched unless the
 * model has one of the known compatibility rules.
 */
function translateDeepSeekHarnessRequest(body) {
  const next = clone(body)
  const model = String(next?.model || '').toLowerCase()
  const thinking = next?.thinking

  if (!thinking || !model) return next

  const adaptiveModel = model.includes('fable-5') || model.includes('opus-5-5')
  const betweenToolsModel = model.includes('sonnet-5-5')

  if (thinking.type === 'enabled' && Number.isFinite(Number(thinking.budget_tokens)) && adaptiveModel) {
    next.thinking = { type: 'adaptive' }
    if (thinking.display !== undefined) next.thinking.display = thinking.display
    next.output_config = {
      ...(next.output_config || {}),
      effort: effortForBudget(Number(thinking.budget_tokens))
    }
    delete next.temperature
    delete next.top_p
    delete next.top_k
    return next
  }

  if (thinking.type === 'disabled' && adaptiveModel) {
    next.thinking = { type: 'adaptive' }
    next.output_config = { ...(next.output_config || {}), effort: 'low' }
    delete next.temperature
    delete next.top_p
    delete next.top_k
    return next
  }

  if (thinking.type === 'disabled' && betweenToolsModel) {
    next.thinking = { type: 'between_tools' }
    delete next.temperature
    delete next.top_p
    delete next.top_k
  }

  return next
}

module.exports = { translateDeepSeekHarnessRequest }
