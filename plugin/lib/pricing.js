const PRICING_VERSION = 'deepseek-2026-11-23-user-provided'

const DEEPSEEK_PRICING = Object.freeze({
  'deepseek-flash': Object.freeze({
    label: 'DeepSeek V4.1 Flash',
    cachedInput: Object.freeze({ offPeak: 0.02, peak: 0.04 }),
    uncachedInput: Object.freeze({ offPeak: 1, peak: 2 }),
    output: Object.freeze({ offPeak: 4, peak: 8 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    label: 'DeepSeek V4 Pro',
    cachedInput: Object.freeze({ offPeak: 0.15, peak: 0.30 }),
    uncachedInput: Object.freeze({ offPeak: 4.5, peak: 9 }),
    output: Object.freeze({ offPeak: 13.5, peak: 27 }),
  }),
})

const MODEL_ALIASES = Object.freeze({
  'deepseek-flash': 'deepseek-flash',
  'deepseek-flash-1': 'deepseek-flash',
  'deepseek-flash1': 'deepseek-flash',
  'deepseek-v4-1-flash-1017': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
})

function nonNegative(value) {
  return Math.max(0, Number(value) || 0)
}

function normalizeModelName(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/[()[\]\s]/gu, '')
    .replaceAll('.', '-')
}

export function normalizeDeepSeekModel(model) {
  const normalized = normalizeModelName(model)
  return MODEL_ALIASES[normalized] || null
}

export function calculateDeepSeekCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheHitTokens = 0,
  peak = false,
} = {}) {
  const canonicalModel = normalizeDeepSeekModel(model)
  const pricing = canonicalModel ? DEEPSEEK_PRICING[canonicalModel] : null
  const input = nonNegative(inputTokens)
  const output = nonNegative(outputTokens)
  const cached = Math.min(input, nonNegative(cacheReadTokens || cacheHitTokens))
  const uncached = Math.max(0, input - cached)
  if (!pricing) {
    return {
      supported: false,
      model: canonicalModel,
      requestedModel: model ?? null,
      currency: 'CNY',
      pricingVersion: PRICING_VERSION,
      totalCny: 0,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      uncachedInputTokens: uncached,
      reason: model ? 'unknown-model' : 'missing-model',
    }
  }
  const period = peak ? 'peak' : 'offPeak'
  const rates = {
    cachedInputPerMillion: pricing.cachedInput[period],
    uncachedInputPerMillion: pricing.uncachedInput[period],
    outputPerMillion: pricing.output[period],
  }
  const inputCny = (cached * rates.cachedInputPerMillion + uncached * rates.uncachedInputPerMillion) / 1_000_000
  const outputCny = output * rates.outputPerMillion / 1_000_000
  return {
    supported: true,
    model: canonicalModel,
    label: pricing.label,
    currency: 'CNY',
    pricingVersion: PRICING_VERSION,
    period,
    rates,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    uncachedInputTokens: uncached,
    inputCny: Number(inputCny.toFixed(8)),
    outputCny: Number(outputCny.toFixed(8)),
    totalCny: Number((inputCny + outputCny).toFixed(8)),
  }
}

export { DEEPSEEK_PRICING, PRICING_VERSION }
