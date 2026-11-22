import { redactApiError, parseJsonLoose } from './util.mjs'

export class DeepSeekClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
    this.timeoutMs = options.timeoutMs ?? 60_000
    if (!this.apiKey) throw new Error('未设置 DEEPSEEK_API_KEY')
  }

  async request(path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        payload = { raw: text.slice(0, 500) }
      }
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || payload?.raw || `HTTP ${response.status}`
        throw new Error(`DeepSeek ${response.status}: ${detail}`)
      }
      return payload
    } catch (error) {
      throw new Error(redactApiError(error))
    } finally {
      clearTimeout(timer)
    }
  }

  async models() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        payload = { raw: text.slice(0, 500) }
      }
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || payload?.raw || `HTTP ${response.status}`
        throw new Error(`DeepSeek ${response.status}: ${detail}`)
      }
      return payload
    } catch (error) {
      throw new Error(redactApiError(error))
    } finally {
      clearTimeout(timer)
    }
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model ?? this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 700,
      stream: false,
    }
    if (options.responseFormat) body.response_format = options.responseFormat
    const payload = await this.request('/chat/completions', body)
    const choice = payload?.choices?.[0]
    return {
      text: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: payload?.usage ?? null,
      model: payload?.model ?? options.model ?? this.model,
      raw: payload,
    }
  }

  async chatJson(messages, options = {}) {
    const requestOptions = {
      ...options,
      responseFormat: { type: 'json_object' },
    }
    const response = await this.chat(messages, requestOptions)
    try {
      return { ...response, value: parseJsonLoose(response.text) }
    } catch (firstError) {
      const retry = await this.chat([
        ...messages,
        {
          role: 'user',
          content: '上一个输出无法解析。请不要解释，重新只输出一个完整、合法、可解析的 JSON 对象。',
        },
      ], {
        ...requestOptions,
        maxTokens: Math.max(Number(requestOptions.maxTokens) || 0, 700),
      })
      try {
        return {
          ...retry,
          usage: mergeUsage(response.usage, retry.usage),
          value: parseJsonLoose(retry.text),
          retried: true,
        }
      } catch {
        throw firstError
      }
    }
  }
}

function mergeUsage(first, second) {
  if (!first && !second) return null
  const keys = [
    ['prompt_tokens', 'promptTokens'],
    ['completion_tokens', 'completionTokens'],
    ['total_tokens', 'totalTokens'],
  ]
  const merged = { ...(second || {}) }
  for (const [snake, camel] of keys) {
    const value = Number(first?.[snake] ?? first?.[camel] ?? 0) + Number(second?.[snake] ?? second?.[camel] ?? 0)
    if (first?.[snake] !== undefined || second?.[snake] !== undefined) merged[snake] = value
    if (first?.[camel] !== undefined || second?.[camel] !== undefined) merged[camel] = value
  }
  return merged
}
