import test from 'node:test'
import assert from 'node:assert/strict'
import { backfillLegacyEvidence, classifyQuote, locateQuote } from '../src/backfill-legacy-evidence.mjs'
import { isRecallable } from '../src/evidence.mjs'

const turns = [
  { id: 'turn_1', speaker: 'user', text: '朋友给我买了一本笔记本，封面是绿色的。' },
  { id: 'turn_2', speaker: 'assistant', text: '我记得你昨天问过我这件事。' },
  { id: 'turn_3', speaker: 'user', text: '如果明天有空，我们一起去海边吗？' },
]

test('能定位的原文补出证据 span 与指纹', () => {
  const memory = {
    id: 'memory_1',
    speaker: 'user',
    evidence: '朋友给我买了一本笔记本',
    summary: '买了笔记本',
    sourceTurnIds: ['turn_1'],
    epistemicStatus: 'candidate',
    visibility: 'evidence-only',
    migrationStatus: 'quarantined',
  }
  const result = backfillLegacyEvidence({ memories: [memory], turns })
  assert.equal(result.counts.filled, 1)
  const ref = result.filled[0].evidenceRefs[0]
  assert.equal(ref.turnId, 'turn_1')
  assert.equal(ref.quote, '朋友给我买了一本笔记本')
  assert.equal(ref.start, 0)
  assert.equal(ref.end, ref.quote.length)
  assert.equal(ref.speaker, 'user')
  assert.equal(result.filled[0].polarity, 'affirmed')
  assert.equal(result.filled[0].epistemicStatus, 'supported')
  assert.equal(result.filled[0].visibility, 'recallable')
  assert.equal(isRecallable(result.filled[0]), true)
})

test('原文找不到时保持隔离', () => {
  const memory = {
    id: 'memory_2',
    speaker: 'user',
    evidence: '这句话根本不在来源里',
    sourceTurnIds: ['turn_1'],
    epistemicStatus: 'candidate',
    visibility: 'evidence-only',
  }
  const result = backfillLegacyEvidence({ memories: [memory], turns })
  assert.equal(result.counts.filled, 0)
  assert.equal(result.skipped[0].reason, 'quote-not-found-in-source-turns')
})

test('说话人对不上时保持隔离', () => {
  const memory = {
    id: 'memory_3',
    speaker: 'user',
    evidence: '我记得你昨天问过我这件事',
    sourceTurnIds: ['turn_2'],
  }
  const result = backfillLegacyEvidence({ memories: [memory], turns })
  assert.equal(result.counts.filled, 0)
  assert.match(result.skipped[0].reason, /^speaker-mismatch/)
})

test('假设句和问句不当作断言证据', () => {
  assert.equal(classifyQuote('如果明天有空，我们一起去海边吗？', { speaker: 'user' }).ok, false)
  assert.equal(classifyQuote('你吃饭了吗？', { speaker: 'user' }).ok, false)
  assert.equal(classifyQuote('朋友给我买了一本笔记本。', { speaker: 'user' }).ok, true)
  const memory = {
    id: 'memory_4',
    speaker: 'user',
    evidence: '如果明天有空，我们一起去海边吗？',
    sourceTurnIds: ['turn_3'],
  }
  const result = backfillLegacyEvidence({ memories: [memory], turns })
  assert.equal(result.counts.filled, 0)
  assert.equal(result.skipped[0].reason, 'hypothetical-or-question')
})

test('已经有证据的记忆不会被改写', () => {
  const memory = {
    id: 'memory_5',
    speaker: 'user',
    evidence: '朋友给我买了一本笔记本',
    sourceTurnIds: ['turn_1'],
    evidenceRefs: [{ turnId: 'turn_1', start: 0, end: 5, quote: '朋友给我买', quoteHash: 'x', speaker: 'user' }],
  }
  const result = backfillLegacyEvidence({ memories: [memory], turns })
  assert.equal(result.counts.untouched, 1)
  assert.equal(result.counts.filled, 0)
})

test('定位函数同时尝试 evidence 与 summary', () => {
  const turn = { id: 'turn_9', speaker: 'user', text: '今天下雨了，我们没出门。' }
  const hit = locateQuote({ evidence: '不存在的片段', summary: '今天下雨了', sourceTurnIds: ['turn_9'] }, [turn])
  assert.equal(hit.quote, '今天下雨了')
  assert.equal(hit.start, 0)
})
