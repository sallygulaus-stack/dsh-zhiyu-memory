import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
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

test('DSH bundle 为主分类补充稳定子类，并让子类参与主题检索', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-subcategory-'))
  const engine = await new MemoryEngine(root, 6).init()
  const taste = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我喜欢把黄瓜和豆角分成四格菜盘。',
    sourceKey: 'subcategory-taste',
  })
  const format = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我更喜欢先听结论，再听理由，最后看细节。',
    sourceKey: 'subcategory-format',
  })
  const emotion = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我最近因为搬迁测试有点焦虑。',
    sourceKey: 'subcategory-emotion',
  })
  const event = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '昨天完成了服务器搬迁演练。',
    sourceKey: 'subcategory-event',
  })
  assert.equal(taste.memory.subcategory, 'taste')
  assert.equal(format.memory.subcategory, 'response-format')
  assert.equal(emotion.memory.subcategory, 'stress')
  assert.equal(event.memory.kind, 'event')
  assert.equal(event.memory.subcategory, 'milestone')
  const hits = await engine.recall('你记得我喜欢怎么搭配菜吗？', 's2')
  assert.equal(hits[0].memory.id, taste.memory.id)
  assert.equal(hits.some((hit) => hit.memory.id === format.memory.id), false)
  const stats = await engine.stats()
  assert.equal(stats.categoryCounts.preference, 2)
  assert.equal(stats.categoryCounts.emotion, 1)
  assert.equal(stats.categoryCounts.event, 1)
  assert.equal(stats.subcategoryCounts['preference:taste'], 1)
  assert.equal(stats.subcategoryCounts['event:milestone'], 1)
})

test('DSH bundle 新会话会注入父会话最近窗口，但不写成长期记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-parent-window-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({
    sessionId: 'parent',
    speaker: 'user',
    text: '第三版先放着，我们接着看第四版。',
    sourceKey: 'parent-window-user',
  })
  await engine.ingest({
    sessionId: 'parent',
    speaker: 'assistant',
    text: '好，第四版的迁移清单还没有收尾。',
    sourceKey: 'parent-window-assistant',
  })
  await engine.session('child', 'parent')
  const context = await engine.context('child', '就按刚才说的继续吧')
  assert.match(context, /上一会话最近内容/u)
  assert.match(context, /第四版/u)
  assert.equal(engine.memories.size, 1)
})

test('DSH bundle 自动注入会带证据和发生时间，不依赖模型主动调用 recall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-auto-inject-'))
  const engine = await new MemoryEngine(root, 6).init()
  const saved = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我喜欢把黄瓜、豆角和萝卜条分成四格。',
    sourceKey: 'meal-preference',
    occurredAt: '2026-11-20T12:00:00.000Z',
  })
  const context = await engine.context('s1', '你还记得我喜欢怎么搭配吗？')
  assert.match(context, /伴生记忆回忆/u)
  assert.match(context, /黄瓜、豆角和萝卜条/u)
  assert.match(context, /发生于 2026-11-20/u)
  assert.match(context, new RegExp(saved.memory.sourceTurnIds[0]))
  const auto = engine.events.findLast((event) => event.type === 'auto-inject')
  assert.equal(auto.hitCount, 1)
  assert.deepEqual(auto.memoryIds, [saved.memory.id])
  assert.equal(auto.injected, true)
  assert.equal((await engine.stats()).autoInjectHitCount, 1)
})

test('DSH bundle 只在具体词组匹配时召回能核实聊天原话的木偶迁移条目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-puppet-recall-'))
  const sourceFile = 'behavior/diary/2026-11.jsonl'
  const text = '今天的晚餐我喜欢分成四格菜盘。'
  const at = new Date().toISOString()
  const turn = {
    id: 'original',
    sessionId: 'legacy-session',
    speaker: 'user',
    text,
    sourceFile,
    occurredAt: at,
    sourceKind: 'puppet-memory',
  }
  const base = {
    id: 'verified',
    kind: 'preference',
    subcategory: 'taste',
    speaker: 'user',
    sourceKind: 'puppet-memory',
    migrationStatus: 'quarantined',
    migrationReason: 'legacy-span-speaker-polarity-unverified',
    summary: text,
    evidence: text,
    sourceTurnIds: [turn.id],
    sourceSessionId: turn.sessionId,
    sourceFile,
    occurredAt: at,
    visibility: 'evidence-only',
    status: 'active',
    epistemicStatus: 'candidate',
    importance: 0.8,
    strength: 0.8,
  }
  const external = { ...turn, id: 'external', speaker: 'external', sourceKind: 'puppet-memory-record' }
  await writeFile(join(root, 'turns.jsonl'), [turn, external].map((row) => JSON.stringify(row)).join('\n'))
  await writeFile(join(root, 'memories.json'), JSON.stringify([
    base,
    { ...base, id: 'external-record', sourceTurnIds: [external.id] },
    { ...base, id: 'missing', sourceTurnIds: ['missing'] },
    { ...base, id: 'misquoted', summary: '晚餐有番茄', evidence: '晚餐有番茄' },
    { ...base, id: 'wrong-session', sourceSessionId: 'other-session' },
    { ...base, id: 'blocked', deletionState: 'recall-blocked' },
    { ...base, id: 'model', sourceKind: 'consolidation' },
  ]))
  const engine = await new MemoryEngine(root, 6).init()
  const hits = await engine.recall('你还记得我喜欢怎么搭配晚餐吗？', 'fresh-session')
  assert.deepEqual(hits.map((hit) => hit.memory.id), ['verified'])
  assert.match(await engine.context('fresh-session', '继续聊之前的四格菜盘'), /迁移对话用户原话/u)
  for (const query of ['今天东京天气怎么样？', '我们接着聊之前关于头像的事情吧']) {
    assert.equal(await engine.context('fresh-session', query), '')
  }
})

test('DSH bundle 会用近期对话展开“那个/这种”指代后再自动注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-auto-reference-'))
  const engine = await new MemoryEngine(root, 6).init()
  const saved = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我喜欢把黄瓜、豆角和萝卜条分成四格。',
    sourceKey: 'meal-preference',
    occurredAt: '2026-11-20T12:00:00.000Z',
  })
  await engine.ingest({
    sessionId: 's1',
    speaker: 'assistant',
    text: '好，我记住你说的这份四格小菜搭配了。',
    sourceKey: 'meal-followup',
  })
  const context = await engine.context('s1', '今天还是那个搭配。')
  assert.match(context, /黄瓜、豆角和萝卜条/u)
  const recall = engine.events.findLast((event) => event.type === 'recall')
  assert.equal(recall.mode, 'auto')
  assert.equal(recall.query, '今天还是那个搭配。')
  assert.match(recall.retrievalQuery, /四格小菜搭配/u)
  assert.ok(engine.events.findLast((event) => event.type === 'auto-inject').memoryIds.includes(saved.memory.id))
})

test('DSH bundle 的明确 remember 可以保存可召回的否定事实，但问题仍隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-explicit-negative-'))
  const engine = await new MemoryEngine(root, 6).init()
  const negative = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '项目还没有收尾。',
    sourceKey: 'explicit-negative',
    forcedKind: 'fact',
    writePriority: 'priority',
  })
  assert.equal(negative.memory.visibility, 'recallable')
  assert.equal(negative.memory.epistemicStatus, 'accepted')
  const question = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '项目是不是已经收尾？',
    sourceKey: 'explicit-question',
    forcedKind: 'fact',
    writePriority: 'priority',
  })
  assert.equal(question.memory.visibility, 'evidence-only')
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

test('DSH bundle 使用 DeepSeek 价格表记录人民币估算费用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-pricing-'))
  const engine = await new MemoryEngine(root, 6, {
    pricingModel: 'deepseek-flash(1)',
    pricingPeriod: 'peak',
  }).init()
  await engine.recordModelMetric({
    model: 'DeepSeek-V4.1-Flash-1017',
    purpose: 'pricing-test',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 500_000,
  })
  const stats = await engine.stats()
  assert.equal(stats.usage.estimatedCostCny, 1.82)
  assert.equal(stats.llm.estimatedCostCny, 1.82)
})

test('DSH bundle 进程重启后不会重复统计同一条模型回复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-usage-'))
  let engine = await new MemoryEngine(root, 6).init()
  const usage = { prompt_tokens: 120, prompt_cache_hit_tokens: 100, completion_tokens: 10, total_tokens: 130 }
  const key = 'assistant:fixture:1'
  await engine.recordUsage(usage, key)
  await engine.recordUsage(usage, key)
  engine = await new MemoryEngine(root, 6).init()
  await engine.recordUsage(usage, key)
  const { usage: totals, llm } = await engine.stats()
  assert.equal(totals.modelCalls, 1)
  assert.equal(totals.totalTokens, 130)
  assert.equal(totals.cacheReadTokens, 100)
  assert.equal(totals.estimatedCostCny, 0.000062)
  assert.equal(llm.calls, 0)
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

test('DSH bundle 不把助手的记住确认话术写成新的长期记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-ack-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({
    sessionId: 's1',
    speaker: 'assistant',
    text: '好的，我记住了。以后我会按结论、原因、细节的顺序回答。',
    sourceKey: 'assistant-ack-1',
  })
  assert.equal(engine.list().length, 0)
  await engine.ingest({
    sessionId: 's1',
    speaker: 'assistant',
    text: '结论：已经记下了。根据系统上下文里自动检索到的记录，你住在苏州市；我会继续按这个前提回答。',
    sourceKey: 'assistant-ack-2',
  })
  assert.equal(engine.list().length, 0)
  await engine.ingest({
    sessionId: 's1',
    speaker: 'assistant',
    text: '根据本会话自动注入的记忆，你周五答应的是把蓝图发给我。',
    sourceKey: 'assistant-ack-3',
  })
  assert.equal(engine.list().length, 0)
})

test('DSH bundle 明确主题时优先召回同主题记忆，避免跨类别污染', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-topic-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我喜欢吃黄瓜、豆角和萝卜条，最好放在四格菜盘里。',
    sourceKey: 'taste-1',
  })
  await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我更喜欢先听结论，再听理由，最后看细节。',
    sourceKey: 'format-1',
  })
  const hits = await engine.recall('我喜欢你用什么顺序回答？', 's2')
  assert.ok(hits.length > 0)
  assert.equal(hits[0].memory.factKey, 'preference:response-format')
  assert.equal(hits[0].memory.subcategory, 'response-format')
  assert.equal(hits.some((hit) => hit.memory.factKey === 'preference:taste'), false)
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
