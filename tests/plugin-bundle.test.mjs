import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEngine, compactRecallHits, freshness, strength } from '../plugin/lib/index.js'

test('DSH bundle 使用分类鲜活度并保留时间字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我们第一次一起完成了研究。',
    sourceKey: 'turn-1',
    occurredAt: '2026-10-22T00:00:00.000Z',
  })
  const memory = engine.list()[0]
  assert.equal(memory.recordedAt !== undefined, true)
  assert.equal(memory.lastRecalledAt, null)
  const oldMemory = { ...memory, lastSupportedAt: '2026-10-22T00:00:00.000Z' }
  assert.ok(freshness({ ...oldMemory, kind: 'relationship' }, '2026-11-22T00:00:00.000Z')
    > freshness({ ...oldMemory, kind: 'emotion' }, '2026-11-22T00:00:00.000Z'))
  assert.ok(strength(memory, '2026-11-22T00:00:00.000Z') > 0)
})

test('DSH bundle 的软每日配额只限制普通写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-budget-'))
  const engine = await new MemoryEngine(root, 6, { dailyWriteBudget: 1 }).init()
  const first = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我今天在研究轻量记忆。',
    sourceKey: 'turn-1',
  })
  const second = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我最近正在测试低成本部署。',
    sourceKey: 'turn-2',
  })
  const priority = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '请记得我们的关系变化和承诺。',
    sourceKey: 'turn-3',
    writePriority: 'priority',
  })
  assert.ok(first.memory)
  assert.equal(second.memory, null)
  assert.ok(priority.memory)
  assert.ok(engine.events.some((event) => event.type === 'write-suppressed'))
})

test('DSH bundle 的明确 remember 请求强制写入事实', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-explicit-remember-'))
  const engine = await new MemoryEngine(root, 6, { dailyWriteBudget: 0 }).init()
  const result = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '蓝色鲸鱼钥匙放在书房抽屉里。',
    sourceKey: 'tool-remember-1',
    writePriority: 'priority',
    forcedKind: 'fact',
  })
  assert.ok(result.memory)
  assert.equal(result.memory.kind, 'fact')
  assert.equal(result.memory.writePriority, 'priority')
  assert.equal(engine.list().length, 1)
})

test('DSH bundle 的优先记忆在大量旧记忆中仍能进入召回窗口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-priority-recall-'))
  const engine = await new MemoryEngine(root, 2).init()
  for (let index = 0; index < 12; index += 1) {
    await engine.ingest({
      sessionId: 'legacy',
      speaker: 'user',
      text: `我以前记录过绿色相关的普通事项 ${index}。`,
      sourceKey: `legacy-${index}`,
      occurredAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    })
  }
  await engine.ingest({
    sessionId: 'current',
    speaker: 'user',
    text: '绿色鲸鱼挂件放在书房第二层抽屉。',
    sourceKey: 'current-priority',
    writePriority: 'priority',
    forcedKind: 'fact',
  })
  const hits = await engine.retrieve('之前说的那件绿色挂件放在哪？', 'new-session')
  assert.ok(hits.some((hit) => hit.memory.summary.includes('绿色鲸鱼挂件')))
})

test('DSH bundle 的 recall 工具只回传必要来源字段', () => {
  const hits = compactRecallHits([{
    score: 0.9,
    lexical: 0.8,
    semantic: false,
    memory: {
      id: 'm1',
      kind: 'fact',
      recordType: 'entity',
      subjectType: 'person',
      summary: '绿色鲸鱼挂件放在书房第二层抽屉。',
      evidence: '绿色鲸鱼挂件放在书房第二层抽屉。',
      sourceTurnIds: ['t1'],
      sourceSessionId: 's1',
      sourceFile: 'behavior/notes.jsonl',
      sourceRowHash: 'secret-row-hash',
      occurredAt: '2026-11-22T00:00:00.000Z',
      recordedAt: '2026-11-22T00:00:01.000Z',
      lastRecalledAt: null,
      status: 'active',
      writePriority: 'priority',
    },
  }])
  assert.equal(hits[0].memory.sourceTurnIds[0], 't1')
  assert.equal(hits[0].memory.sourceFile, undefined)
  assert.equal(hits[0].memory.sourceRowHash, undefined)
})

test('DSH bundle 低频整理拒绝无证据候选并记录成本指标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-llm-'))
  const engine = await new MemoryEngine(root, 6, {
    llm: {
      async chatJson() {
        return {
          value: {
            memories: [{
              kind: 'fact',
              speaker: 'user',
              summary: '猜测',
              evidence: '不存在',
              sourceTurnIds: ['missing'],
              importance: 0.8,
            }],
          },
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          model: 'fake',
          retried: true,
        }
      },
    },
    modelCost: { inputPerMillion: 0.1, outputPerMillion: 0.2 },
  }).init()
  await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我正在测试低频模型整理。',
    sourceKey: 'turn-1',
  })
  const result = await engine.consolidateSession('s1')
  assert.equal(result.rejected, 1)
  const stats = await engine.stats()
  assert.equal(stats.llm.evidenceRejected, 1)
  assert.equal(stats.llm.jsonErrors, 1)
  assert.ok(stats.llm.estimatedCostUsd > 0)
})

test('DSH bundle 不让普通 LLM 候选覆盖明确记住的优先记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-priority-'))
  const engine = await new MemoryEngine(root, 6, {
    llm: {
      async chatJson() {
        const turn = engine.turns[0]
        return {
          value: {
            memories: [{
              kind: 'preference',
              speaker: 'user',
              summary: '用户现在先看结论再看证据',
              evidence: '请记得我改成先看结论，再看证据。',
              sourceTurnIds: [turn.id],
              factKey: 'preference:response-format',
              importance: 0.7,
            }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          model: 'fake',
        }
      },
    },
  }).init()
  const explicit = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '请记得我改成先看结论，再看证据。',
    sourceKey: 'turn-1',
    writePriority: 'priority',
  })
  await engine.consolidateSession('s1')
  const saved = engine.memories.get(explicit.memory.id)
  assert.equal(saved.status, 'open')
  assert.equal(saved.writePriority, 'priority')
  assert.equal(engine.list().filter((item) => item.status === 'superseded').length, 0)
  assert.ok(engine.list().some((item) => item.status === 'review'))
})

test('DSH bundle 从来源推导 assistant 主体并隔离否定内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-evidence-'))
  const engine = await new MemoryEngine(root, 6).init()
  const assistant = await engine.ingest({
    sessionId: 's1',
    speaker: 'assistant',
    text: '我会在明天上线。',
    sourceKey: 'assistant-turn-1',
  })
  const negated = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我不住在上海。',
    sourceKey: 'user-turn-1',
  })
  const requirement = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '请记得把自研方案做成真正的插件，不能只做交接纸。',
    sourceKey: 'user-turn-2',
  })
  assert.equal(assistant.memory.authority, 'assistant')
  assert.equal(assistant.memory.polarity, 'affirmed')
  assert.equal(assistant.memory.modality, 'plan')
  assert.equal(negated.memory.polarity, 'negated')
  assert.equal(negated.memory.visibility, 'evidence-only')
  assert.equal(requirement.memory.claimType, 'commitment')
  assert.equal(requirement.memory.polarity, 'affirmed')
  assert.equal(requirement.memory.visibility, 'recallable')
  assert.match(requirement.memory.evidence, /不能只做交接纸/)
  assert.equal((await engine.recall('我住在上海', 's1')).some((hit) => hit.memory.id === negated.memory.id), false)
  assert.equal((await engine.recall('上次我要求记住什么', 's1')).some((hit) => hit.memory.id === requirement.memory.id), true)
})

test('DSH bundle 的模型整理拒绝说话人伪造、单字证据和空 key，并使用增量游标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-hardening-'))
  let calls = 0
  const engine = await new MemoryEngine(root, 6, {
    llm: {
      async chatJson() {
        calls++
        const turn = engine.turns[0]
        return {
          value: {
            memories: [
              {
                kind: 'fact',
                speaker: 'user',
                summary: '用户承诺明天上线',
                evidence: '我会在明天上线。',
                sourceTurnIds: [turn.id],
                factKey: 'user.commitment.launch',
              },
              {
                kind: 'fact',
                speaker: 'assistant',
                summary: '单字证据',
                evidence: '我',
                sourceTurnIds: [turn.id],
                factKey: 'assistant.single',
              },
              {
                kind: 'fact',
                speaker: 'assistant',
                summary: '空 key',
                evidence: '我会在明天上线。',
                sourceTurnIds: [turn.id],
                factKey: '',
              },
            ],
          },
          usage: { totalTokens: 1 },
        }
      },
    },
  }).init()
  await engine.ingest({
    sessionId: 's1',
    speaker: 'assistant',
    text: '我会在明天上线。',
    sourceKey: 'assistant-turn-1',
  })
  const first = await engine.consolidateSession('s1')
  const second = await engine.consolidateSession('s1')
  assert.equal(first.rejected, 3)
  assert.equal(first.extracted, 0)
  assert.equal(second.reason, 'no-turns')
  assert.equal(calls, 1)
})

test('DSH bundle 确认回忆必须指向用户原话并刷新强化锚点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-confirm-'))
  const engine = await new MemoryEngine(root, 6).init()
  const first = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我喜欢先看结论。',
    sourceKey: 'user-turn-1',
  })
  await assert.rejects(engine.confirmRecall(first.memory.id), /confirmationTurnId/)
  const confirmation = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我喜欢先看结论。',
    sourceKey: 'user-turn-2',
  })
  await engine.confirmRecall(first.memory.id, { confirmationTurnId: confirmation.turn.id })
  assert.equal(engine.memories.get(first.memory.id).lastReinforcedAt !== null, true)
})
