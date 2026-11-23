import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { planPuppetRecovery } from '../src/puppet-recovery.mjs'

const sourceFile = 'behavior/diary/2026-11.jsonl'
const occurredAt = '2026-11-01T12:00:00.000Z'
const makeTurn = (hash, text, overrides = {}) => ({
  id: `turn_puppet_${hash}_user`,
  sourceRowHash: hash,
  sessionId: 'puppet-session-cafe',
  sourceKind: 'puppet-memory',
  speaker: 'user',
  sourceFile,
  occurredAt,
  text,
  ...overrides,
})
const makeMemory = (id, summary, overrides = {}) => ({
  id,
  summary,
  evidence: summary,
  sourceKind: 'puppet-memory',
  sourceFile: 'behavior/user.jsonl',
  sourceTurnIds: ['imported-summary-turn'],
  kind: 'preference',
  visibility: 'evidence-only',
  epistemicStatus: 'candidate',
  migrationStatus: 'quarantined',
  migrationReason: 'legacy-span-speaker-polarity-unverified',
  deletionState: 'live',
  status: 'active',
  ...overrides,
})

test('木偶摘要只读报告可定位真实用户原话，不在报告吐出摘要或原话', () => {
  const quote = '我喜欢黄瓜和豆角分开装。'
  const turn = makeTurn('01', `  ${quote}  `)
  const archive = { memories: [makeMemory('m1', '用户喜欢黄瓜和豆角分开装')], turns: [turn] }
  const original = structuredClone(archive)
  const report = planPuppetRecovery(archive)
  assert.equal(report.scannedSummaries, 1)
  assert.deepEqual(report.priorityOutcomes, { 'verified-historical-quote': 1 })
  assert.deepEqual(report.items[0].evidenceRef, {
    turnId: turn.id, start: 2, end: 2 + quote.length,
    quoteHash: createHash('sha256').update(quote).digest('hex'),
    speaker: 'user',
  })
  assert.equal(report.items[0].recordedAt, occurredAt)
  assert.deepEqual(archive, original)
  assert.doesNotMatch(JSON.stringify(report), /黄瓜|豆角/u)
})

test('词语相近、条件、否定、引用或提问不能替代原话证据', () => {
  const summary = '我喜欢黄瓜和豆角分开装。'
  const archive = {
    memories: [makeMemory('m1', summary)],
    turns: [
      makeTurn('01', '如果我喜欢黄瓜和豆角分开装，就会点那份。'),
      makeTurn('02', '我并不喜欢黄瓜和豆角分开装。'),
      makeTurn('03', `同事说：“${summary}”`),
      makeTurn('04', '我喜欢黄瓜和豆角分开装吗？'),
      makeTurn('05', '我喜欢黄瓜和豆角分开装，但现在不这么吃了。'),
    ],
  }
  assert.deepEqual(planPuppetRecovery(archive).outcomes, { 'related-only': 1 })
})

test('回填不认助手、伪装成用户的迁移摘要和被删除证据；多处相同原话也不擅自选日期', () => {
  const summary = '我喜欢黄瓜和豆角分开装。'
  const archive = {
    memories: [makeMemory('m1', summary)],
    turns: [
      makeTurn('01', summary, { speaker: 'assistant' }),
      makeTurn('02', summary, { id: 'turn_puppet_02', sessionId: 'puppet-import-cafe' }),
      makeTurn('03', summary),
      makeTurn('04', summary),
    ],
    blockedTurnIds: ['turn_puppet_03_user'],
  }
  assert.equal(planPuppetRecovery(archive).items[0].evidenceRef.turnId, 'turn_puppet_04_user')
  archive.blockedTurnIds = []
  assert.deepEqual(planPuppetRecovery(archive).outcomes, { 'ambiguous-quote': 1 })
  archive.memories[0].deletionState = 'recall-blocked'
  assert.equal(planPuppetRecovery(archive).scannedSummaries, 0)
})

test('有原话的历史承诺只返回证据记录，不推断为仍有效的待办', () => {
  const quote = '我答应周日收拾阳台。'
  const archive = {
    memories: [makeMemory('m1', quote, { kind: 'commitment', status: 'open', writePriority: 'priority' })],
    turns: [makeTurn('ab', quote)],
  }
  const result = planPuppetRecovery(archive).items[0]
  assert.equal(result.outcome, 'verified-historical-quote')
  assert.equal(result.status, undefined)
  assert.equal(result.occurredAt, undefined)
})
