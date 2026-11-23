import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDeepSeekCost, normalizeDeepSeekModel } from '../src/pricing.mjs'

test('DeepSeek 价格表识别接口模型名和实际版本别名', () => {
  assert.equal(normalizeDeepSeekModel('deepseek-flash(1)'), 'deepseek-flash')
  assert.equal(normalizeDeepSeekModel('DeepSeek-V4.1-Flash-1017'), 'deepseek-flash')
  assert.equal(normalizeDeepSeekModel('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
})

test('DeepSeek Flash 按缓存命中、未命中和输出分别计算空闲时段费用', () => {
  const result = calculateDeepSeekCost({
    model: 'deepseek-flash(1)',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 400_000,
  })
  assert.equal(result.supported, true)
  assert.equal(result.cachedInputTokens, 400_000)
  assert.equal(result.uncachedInputTokens, 600_000)
  assert.equal(result.inputCny, 0.608)
  assert.equal(result.outputCny, 4)
  assert.equal(result.totalCny, 4.608)
})

test('DeepSeek V4 Pro 高峰时段使用高峰价格', () => {
  const result = calculateDeepSeekCost({
    model: 'deepseek-v4-pro',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    peak: true,
  })
  assert.equal(result.rates.cachedInputPerMillion, 0.3)
  assert.equal(result.rates.uncachedInputPerMillion, 9)
  assert.equal(result.rates.outputPerMillion, 27)
  assert.equal(result.totalCny, 27.3)
})

test('未知模型不伪造费用', () => {
  const result = calculateDeepSeekCost({
    model: 'unknown-model',
    inputTokens: 1000,
    outputTokens: 1000,
  })
  assert.equal(result.supported, false)
  assert.equal(result.totalCny, 0)
  assert.equal(result.reason, 'unknown-model')
})
