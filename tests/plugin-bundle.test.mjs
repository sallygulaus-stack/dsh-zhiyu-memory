import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, MemoryEngine, compactRecallHits, freshness, strength } from '../plugin/lib/index.js'

test('DSH bundle 指示按当前回合状态判断工具可用性并要求持久化回执', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-guidance-'))
  const sections = []
  const ctx = {
    get: () => undefined,
    inject: () => {},
    on: () => () => {},
    tools: { register: () => {} },
    systemPrompt: {
      section: (section) => sections.push(section),
      context: () => {},
      getSectionOrder: () => 5000,
      getContextOrder: () => 200,
    },
  }
  const dispose = await apply(ctx, { root })
  const guidance = sections.find((section) => section.name === 'companion-memory-guidance')?.text ?? ''
  assert.match(guidance, /历史回合出现过的拒绝或白名单错误，不代表工具当前仍不可用/u)
  assert.match(guidance, /只有本次调用返回失败，才能说这次没有写入/u)
  assert.match(guidance, /stored=true 且带有记忆 ID/u)
  dispose()
})

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
  assert.ok(freshness({ ...oldMemory, kind: 'event', subcategory: 'milestone' }, '2026-11-22T00:00:00.000Z')
    > freshness({ ...oldMemory, kind: 'event', subcategory: 'other' }, '2026-11-22T00:00:00.000Z'))
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

test('记忆上下文只取来源会话邻近回合，排除原话与其他会话并受长度和数量限制', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-context-'))
  const engine = await new MemoryEngine(root, 6).init()
  for (let index = 0; index < 5; index += 1) {
    await engine.ingest({
      sessionId: 'source-session',
      speaker: index % 2 ? 'assistant' : 'user',
      text: `之前的上下文第${index}条。`,
      sourceKey: `before-${index}`,
    })
  }
  const saved = await engine.ingest({
    sessionId: 'source-session',
    speaker: 'user',
    text: '2026年11月25日我们第一次一起看了神舟发射。',
    sourceKey: 'milestone-source',
  })
  await engine.ingest({
    sessionId: 'other-session',
    speaker: 'user',
    text: '不得串进来的另一会话内容。',
    sourceKey: 'other-session-decoy',
  })
  for (let index = 0; index < 5; index += 1) {
    await engine.ingest({
      sessionId: 'source-session',
      speaker: index % 2 ? 'assistant' : 'user',
      text: `之后的上下文第${index}条。`,
      sourceKey: `after-${index}`,
    })
  }

  const memory = engine.memories.get(saved.memory.id)
  const context = engine.contextForMemory(memory)
  assert.equal(context.length, 4)
  assert.deepEqual(context.map((turn) => turn.relation), ['before', 'before', 'after', 'after'])
  assert.ok(context.every((turn) => turn.text !== memory.evidence))
  assert.ok(context.every((turn) => turn.text.length <= 240))
  assert.ok(context.every((turn) => !turn.text.includes('另一会话')))
  assert.ok(context.some((turn) => turn.text.includes('之前的上下文第3条')))
  assert.ok(context.some((turn) => turn.text.includes('之后的上下文第0条')))
  const limited = engine.contextForMemory(memory, { radius: 4, maxTurns: 2, maxChars: 8 })
  assert.equal(limited.length, 2)
  assert.ok(limited.every((turn) => turn.text.length <= 8))
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

test('DSH bundle 会召回用户人工确认的旧木偶摘要并保留证据等级说明', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-human-reviewed-'))
  const memory = {
    id: 'human-reviewed-legacy',
    kind: 'event',
    subcategory: 'milestone',
    speaker: 'user',
    sourceKind: 'puppet-memory',
    sourceFile: 'behavior/notes.jsonl',
    sourceTurnIds: ['legacy-summary-turn'],
    sourceSessionId: 'legacy-session',
    summary: '爸爸曾经给小鱼做过一首专属单曲和 MV。',
    evidence: '爸爸曾经给小鱼做过一首专属单曲和 MV。',
    occurredAt: '2026-10-29T11:47:10.503Z',
    recordedAt: '2026-11-23T04:34:22.847Z',
    visibility: 'recallable',
    epistemicStatus: 'accepted',
    migrationStatus: 'human-reviewed',
    migrationReason: 'user-manual-review',
    humanReview: {
      reviewer: 'user',
      reviewedAt: '2026-11-23T13:50:00.000Z',
      machineEvidence: 'legacy-summary-without-verified-span',
    },
    status: 'active',
    importance: 0.8,
    strength: 0.8,
  }
  await writeFile(join(root, 'turns.jsonl'), '')
  await writeFile(join(root, 'memories.json'), JSON.stringify([memory]))
  const engine = await new MemoryEngine(root, 6).init()
  const hits = await engine.recall('你还记得爸爸做过单曲和 MV 吗？', 'fresh-session')
  assert.deepEqual(hits.map((hit) => hit.memory.id), [memory.id])
  assert.match(await engine.context('fresh-session', '你还记得爸爸做过单曲和 MV 吗？'), /爸爸人工确认的旧木偶记忆摘要/u)
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
  assert.doesNotMatch(context, /同会话上下文旁证/u)
  const recall = engine.events.findLast((event) => event.type === 'recall')
  assert.equal(recall.mode, 'auto')
  assert.equal(recall.query, '今天还是那个搭配。')
  assert.match(recall.retrievalQuery, /四格小菜搭配/u)
  assert.ok(engine.events.findLast((event) => event.type === 'auto-inject').memoryIds.includes(saved.memory.id))
})

test('DSH bundle 能接上短句，只用最近一件事作线索，不重新翻出同会话更早的话题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-elided-followup-'))
  const engine = await new MemoryEngine(root, 6).init()
  const add = (sessionId, text) => engine.ingest({ sessionId, speaker: 'user', text })
  const older = await add('parent', '我喜欢吃蓝莓松饼。')
  const meal = await add('parent', '我喜欢把黄瓜和豆角分成四格菜盘。')
  await engine.session('child', 'parent')
  await add('child', '那就原样。')
  const context = await engine.context('child', '那就原样。')
  assert.match(context, /四格菜盘/u)
  assert.doesNotMatch(context, /松饼/u)
  assert.deepEqual(engine.events.findLast((event) => event.type === 'auto-inject').memoryIds, [meal.memory.id])
  assert.notEqual(meal.memory.id, older.memory.id)
})

test('DSH bundle 不用上一会话的话题覆盖本轮明确换过的话题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-reference-topic-change-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({ sessionId: 'parent', speaker: 'user', text: '我喜欢把黄瓜和豆角分成四格菜盘。' })
  await engine.session('child', 'parent')
  const current = await engine.ingest({ sessionId: 'child', speaker: 'user', text: '我喜欢先讲结论、再给背景。' })
  const context = await engine.context('child', '还是那样？')
  assert.match(context, /结论/u)
  assert.doesNotMatch(context, /黄瓜|上一会话最近内容/u)
  assert.deepEqual(engine.events.findLast((event) => event.type === 'auto-inject').memoryIds, [current.memory.id])
})

test('DSH bundle 独立会话的无锚指代和普通点餐不注入旧菜盘，也不调用语义模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-reference-abstain-'))
  let calls = 0
  const engine = await new MemoryEngine(root, 6, { llm: { chatJson: async () => {
    calls++
    return { value: { memoryIds: [] } }
  } } }).init()
  await engine.ingest({ sessionId: 'old', speaker: 'user', text: '我喜欢把黄瓜和豆角分成四格菜盘。' })
  await engine.session('independent')
  assert.match(await engine.context('independent', '还是那样？'), /直接、简短地问用户指哪一件/u)
  assert.equal(engine.events.findLast((event) => event.type === 'auto-inject').injected, false)
  for (const query of ['今晚吃什么？', '还是算一下 8 乘 7 吧。']) {
    assert.equal(await engine.context('independent', query), '')
  }
  await engine.session('child', 'old')
  assert.equal(await engine.context('child', '今晚吃什么？'), '')
  assert.equal(await engine.context('child', '好。'), '')
  assert.equal(calls, 0)
  assert.match(await engine.context('child', '继续说刚才那份四格菜盘'), /黄瓜/u)
})

test('DSH bundle 在问上次吃过什么时区分实际一餐和相近的个人偏好', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-meal-event-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({ sessionId: 'other', speaker: 'user', text: '我喜欢把黄瓜和豆角分成四格菜盘。' })
  const { memory } = await engine.ingest({
    sessionId: 'parent',
    speaker: 'user',
    text: '昨晚吃了黄瓜、豆角和腌萝卜。',
  })
  await engine.session('child', 'parent')
  const context = await engine.context('child', '今晚还是吃上次那套？')
  assert.match(context, /腌萝卜/u)
  assert.doesNotMatch(context, /四格菜盘/u)
  assert.deepEqual(engine.events.findLast((event) => event.type === 'auto-inject').memoryIds, [memory.id])
  assert.match(await engine.context('unlinked', '今晚还是吃上次那套？'), /直接、简短地问用户指哪一件/u)
  assert.deepEqual(await engine.recall('上次吃的那套 晚饭 点餐 常点', 'unlinked'), [])
  assert.match(await engine.context('unlinked', '上回有腌萝卜的那顿饭吃了哪些？'), /腌萝卜/u)
})

test('DSH bundle 已阻断的条目原话不会由父会话临时窗口重新注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-reference-blocked-'))
  const engine = await new MemoryEngine(root, 6).init()
  const { memory } = await engine.ingest({ sessionId: 'parent', speaker: 'user', text: '我喜欢把黄瓜和豆角分成四格菜盘。' })
  await engine.session('child', 'parent')
  await engine.forget(memory.id, false, 'recall-block')
  assert.doesNotMatch(await engine.context('child', '那就原样。'), /黄瓜|上一会话最近内容/u)
  const restarted = await new MemoryEngine(root, 6).init()
  assert.doesNotMatch(await restarted.context('child', '还是那样？'), /黄瓜|上一会话最近内容/u)
})

test('DSH bundle 不把多天前的父会话当成刚聊过的话题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-stale-parent-window-'))
  const engine = await new MemoryEngine(root, 6).init()
  const { turn } = await engine.ingest({ sessionId: 'parent', speaker: 'user', text: '我喜欢把黄瓜和豆角分成四格菜盘。' })
  turn.recordedAt = new Date(Date.now() - 4 * 86400000).toISOString()
  await engine.session('child', 'parent')
  assert.match(await engine.context('child', '那就原样。'), /直接、简短地问用户指哪一件/u)
  assert.match(await engine.context('child', '你还记得我喜欢怎么搭配四格菜盘吗？'), /黄瓜/u)
})

test('DSH bundle 不把久远情绪作为顺带话题注入，但明确回顾时仍可查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-faded-emotion-'))
  const engine = await new MemoryEngine(root, 6).init()
  const { memory } = await engine.ingest({
    sessionId: 'old',
    speaker: 'user',
    text: '我当时因为蓝湾面试非常紧张。',
    occurredAt: new Date(Date.now() - 180 * 86400000).toISOString(),
    forcedKind: 'emotion',
  })
  memory.lastSupportedAt = memory.occurredAt
  assert.equal(await engine.context('fresh', '现在蓝湾面试怎么准备才不紧张？'), '')
  assert.match(await engine.context('fresh', '记得当时蓝湾面试我紧张吗？'), /蓝湾面试/u)
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

test('DSH bundle 日常共同事件会跨会话自动晋升', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-daily-promotion-'))
  const engine = await new MemoryEngine(root, 6).init()
  const first = await engine.ingest({
    sessionId: 'daily-first',
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    sourceKey: 'daily-first-1',
    occurredAt: '2026-11-22T10:00:00.000Z',
  })
  assert.equal(first.candidate.kind, 'event')
  assert.equal(first.candidate.retentionClass, 'daily')
  const second = await engine.ingest({
    sessionId: 'daily-second',
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    sourceKey: 'daily-second-1',
    occurredAt: '2026-11-23T10:00:00.000Z',
  })
  assert.equal(second.memory.retentionClass, 'durable')
  assert.equal(second.memory.promotionState, 'promoted')
  assert.ok(engine.events.some((event) => event.type === 'promote'))
})

test('DSH bundle 日常事件过期后不再自动注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-daily-expiry-'))
  const engine = await new MemoryEngine(root, 6).init()
  const result = await engine.ingest({
    sessionId: 'daily-expiry',
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    sourceKey: 'daily-expiry-1',
    occurredAt: '2026-11-22T10:00:00.000Z',
  })
  const hits = await engine.retrieve('神舟发射', 'daily-expiry', { mode: 'auto' })
  assert.equal(hits.length, 1)
  result.memory.dailyExpiresAt = '2026-11-20T10:00:00.000Z'
  await engine.saveMemory(result.memory, 'test-expiry')
  const expired = await engine.retrieve('神舟发射', 'daily-expiry', { mode: 'auto' })
  assert.equal(expired.length, 0)
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

test('DSH bundle 自动录入只进入日常层，事实层必须显式 remember', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-auto-daily-only-'))
  const engine = await new MemoryEngine(root, 6).init()
  const automatic = await engine.ingest({
    sessionId: 'auto-1',
    speaker: 'user',
    text: '现在服务器上正在施工，姐姐在看日志。',
    sourceKey: 'snapshot:auto-1',
    writeMode: 'auto',
  })
  assert.equal(automatic.memory.kind, 'fact')
  assert.equal(automatic.memory.retentionClass, 'daily')
  assert.equal(automatic.memory.writeMode, 'auto')
  const repeated = await engine.ingest({
    sessionId: 'auto-2',
    speaker: 'user',
    text: '现在服务器上正在施工，姐姐在看日志。',
    sourceKey: 'snapshot:auto-2',
    writeMode: 'auto',
  })
  assert.equal(repeated.memory.retentionClass, 'daily')
  assert.notEqual(repeated.memory.promotionState, 'promoted')
  const manual = await engine.ingest({
    sessionId: 'manual-1',
    speaker: 'user',
    text: '服务器长期部署在上海云端。',
    sourceKey: 'tool:manual-1',
    forcedKind: 'fact',
    writePriority: 'priority',
    writeMode: 'manual',
  })
  assert.equal(manual.memory.retentionClass, 'durable')
  assert.equal(manual.memory.writeMode, 'manual')
})

test('DSH bundle 自动候选不会刷新或替换长期条目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-protect-durable-'))
  const engine = await new MemoryEngine(root, 6).init()
  const original = await engine.ingest({
    sessionId: 'manual', speaker: 'user', text: '我住在上海市。',
    sourceKey: 'manual:1', forcedKind: 'fact', writeMode: 'manual',
  })
  const before = structuredClone(original.memory)
  const auto = (text, sourceKey) => engine.ingest({
    sessionId: 'auto', speaker: 'user', text, sourceKey, writeMode: 'auto',
  })
  const repeat = await auto(before.summary, 'auto:1')
  const changed = await auto('我住在杭州市。', 'auto:2')
  assert.equal(repeat.candidate.retentionClass, 'daily')
  assert.notEqual(repeat.memory.id, before.id)
  assert.equal(changed.memory.retentionClass, 'daily')
  assert.deepEqual(engine.memories.get(before.id), before)
  const rows = JSON.parse(await readFile(join(root, 'memories.json'), 'utf8'))
  assert.deepEqual(rows.filter((row) => row.retentionClass === 'durable'), [before])
})

test('DSH bundle 过滤角色卡运行时注入，不写入回合或长期记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-runtime-filter-'))
  const engine = await new MemoryEngine(root, 6).init()
  const runtimePrompt = [
    '【当前时间】2026/11/24 00:02:11（Asia/Shanghai）',
    '【当前角色】女儿（完整角色卡请调用 qq_get_prompt 查看）',
    '【你的身份】你在 QQ 上的昵称是「沈知鱼」',
    '【会话令牌】token-for-this-turn',
    '【当前唤醒】private:909227066',
    '【行动前】先判断当前消息是否需要回复。',
  ].join('\n')
  const result = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: runtimePrompt,
    sourceKey: 'runtime-prompt-1',
  })
  assert.equal(result.stored, false)
  assert.equal(result.reason, 'internal-runtime-injection')
  assert.equal(engine.turns.length, 0)
  assert.equal(engine.list().length, 0)
  assert.equal((await engine.stats()).filteredRuntimeInjections, 1)
})

test('DSH bundle 从运行时消息快照只写入用户本人消息并按消息 ID 去重', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-runtime-snapshot-'))
  const handlers = new Map()
  const ctx = {
    get: () => undefined,
    inject: () => {},
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    tools: { register: () => {} },
    systemPrompt: {
      section: () => {},
      context: () => {},
      getSectionOrder: () => 5000,
      getContextOrder: () => 200,
    },
  }
  const dispose = await apply(ctx, { root })
  const session = {
    id: 'snapshot-session',
    header: {},
    snapshotEvents: () => [],
    seq: 0,
  }
  const prompt = [
    '【当前时间】2026/11/25 00:02:11（Asia/Shanghai）',
    '【当前角色】女儿（完整角色卡请调用 qq_get_prompt 查看）',
    '【会话令牌】token-for-this-turn',
    '【当前唤醒】private:909227066',
    '【行动前】先判断当前消息是否需要回复。',
    `【本次消息快照】${JSON.stringify({ messages: [
      { messageId: '41', sender: '私聊', isOwner: false, text: '旁人发言不应写入。' },
      { messageId: '42', sender: '私聊', isOwner: true, text: '今晚一起看神舟发射吧。' },
    ] })}`,
    '【快照之后的运行时附注】不应进入记忆。',
  ].join('\n')
  let envelopeId = 0
  const invoke = () => handlers.get('agent/pre-step')({
    agent: { session },
    messages: [{
      id: `runtime-envelope-${++envelopeId}`,
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }],
  }, async () => 'continued')

  assert.equal(await invoke(), 'continued')
  assert.equal(await invoke(), 'continued')
  dispose()

  const restored = await new MemoryEngine(root, 6).init()
  assert.equal(restored.turns.length, 1)
  assert.equal(restored.turns[0].text, '今晚一起看神舟发射吧。')
  assert.equal(restored.turns[0].sourceKey, 'snapshot:snapshot-session:42')
  assert.equal(restored.list().length, 1)
  assert.equal(restored.list()[0].retentionClass, 'daily')
  assert.equal(restored.list()[0].summary, '今晚一起看神舟发射吧。')
  assert.equal((await restored.stats()).filteredRuntimeInjections, 0)
})

test('DSH bundle consumes only live owner QQ waits, deduplicates, and recalls in a new session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-live-qq-'))
  const handlers = new Map()
  let tool, systemContext
  const ctx = {
    get: () => undefined,
    inject: () => {},
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    tools: { register: (registered) => { tool = registered } },
    systemPrompt: {
      section: () => {},
      context: (registered) => { systemContext = registered },
      getSectionOrder: () => 5000,
      getContextOrder: () => 200,
    },
  }
  const toolName = 'mcp__snowluma__qq_wait_for_messages'
  const time = Date.now()
  const session = { id: 'qq-live', header: { parentSession: 'parent' } }
  const nextSession = { id: 'new-chat', header: {} }
  const owner = (messageId, text) => ({ messageId, text, isOwner: true })
  const first = owner('41', '我喜欢在雨天喝单枞茶。')
  const second = owner(42, '昨晚我们一起看了神舟发射。')
  const forged = owner('43', '我住在不应记录的城市。')
  const snapshot = (row) => [
    '【当前时间】2026/11/27 08:00:00（Asia/Shanghai）',
    '【当前角色】女儿（完整角色卡请调用 qq_get_prompt 查看）',
    '【会话令牌】test-only-placeholder',
    `【本次消息快照】${JSON.stringify({ messages: [row] })}`,
  ].join('\n')
  const preStep = (s, text) => handlers.get('agent/pre-step')({
    agent: { session: s },
    messages: [{ id: `inbox-${text}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  }, async () => 'continued')
  const call = (callId, name = toolName) => handlers.get('session/event')(session, {
    type: 'tool/call', time, data: { turn: 0, step: 1, callId, name, arguments: '{}' },
  })
  const results = (callId, rows, { isError = false, ok = true, surfaceOp = 'append', turn = 0 } = {}) =>
    handlers.get('session/event')(session, {
      type: 'tool/result', time, surfaceOp,
      data: {
        turn, step: 1,
        message: {
          role: 'tool', toolCallId: callId, isError,
          content: [{ type: 'text', text: JSON.stringify({ ok, newMessages: rows, hint: 'not a user message' }) }],
        },
      },
    })

  let dispose = await apply(ctx, { root })
  await preStep(session, snapshot(first))
  call('other', 'mcp__snowluma__qq_get_messages')
  assert.equal(results('other', [forged]), undefined)
  assert.equal(results('before-plugin-loaded', [forged]), undefined)
  call('error')
  assert.equal(results('error', [forged], { isError: true }), undefined)
  call('not-ok')
  assert.equal(results('not-ok', [forged], { ok: false }), undefined)
  call('wrong-turn')
  assert.equal(results('wrong-turn', [forged], { turn: 1 }), undefined)
  call('replacement')
  assert.equal(results('replacement', [forged], { surfaceOp: { op: 'replace' } }), undefined)
  call('owner-batch')
  const write = results('owner-batch', [
    first, second, second,
    { ...forged, isOwner: false }, { ...forged, isSelf: true },
    owner('  ', forged.text), owner('44', '   '), { ...owner('45'), plain: forged.text },
  ])
  assert.ok(write instanceof Promise)
  await handlers.get('session/flush')(session)
  await write
  await preStep(session, snapshot(second))
  dispose()
  assert.equal(handlers.size, 0)

  dispose = await apply(ctx, { root })
  call('repeated-after-restart')
  await results('repeated-after-restart', [first, second])
  await preStep(nextSession, '昨晚我们一起看了神舟发射吗？')
  assert.match(systemContext.text({ scope: { session: nextSession } }), /昨晚我们一起看了神舟发射/u)
  const { hits } = await tool.execute({ action: 'recall', query: '昨晚我们一起看了神舟发射' }, { agent: { session: nextSession } })
  const shenzhou = hits.find((hit) => hit.memory.evidence === second.text)
  assert.ok(shenzhou)
  assert.ok(shenzhou.memory.context.some((turn) => turn.text === first.text))
  assert.notEqual(shenzhou.memory.context[0].text, shenzhou.memory.evidence)
  assert.deepEqual(JSON.parse(JSON.stringify(hits)), hits)
  dispose()

  const restored = await new MemoryEngine(root, 6).init()
  const qqTurns = restored.turns.filter((turn) => turn.sessionId === session.id)
  assert.deepEqual(qqTurns.map((turn) => turn.text), [first.text, second.text])
  assert.deepEqual(qqTurns.map((turn) => turn.sourceKey), ['snapshot:qq-live:41', 'snapshot:qq-live:42'])
  assert.equal(qqTurns[1].occurredAt, new Date(time).toISOString())
  assert.equal(qqTurns[1].historicalTimeBasis, 'snapshot-captured-at')
  assert.equal(restored.list().length, 2)
  assert.ok(restored.list().every((row) => row.retentionClass === 'daily'))
})

test('DSH bundle persists a consolidation batch once and keeps the latest concurrent changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-consolidate-batch-'))
  const engine = await new MemoryEngine(root, 6).init()
  const old = '2020-01-01T00:00:00.000Z'
  const daily = await engine.ingest({
    sessionId: 's1', speaker: 'user', text: '我住在上海市。', occurredAt: old, writeMode: 'auto',
  })
  const promise = await engine.ingest({
    sessionId: 's1', speaker: 'user', text: '我明天要出门拍照。', occurredAt: old, writeMode: 'auto',
  })
  const live = await engine.ingest({ sessionId: 's2', speaker: 'user', text: '我喜欢先看结论。' })
  const writes = []
  const writeJson = engine.writeJson.bind(engine)
  engine.writeJson = (file, value) => {
    writes.push(file)
    return writeJson(file, value)
  }
  assert.deepEqual(await engine.consolidate(), { count: 3 })
  assert.deepEqual(writes, ['memories.json'])
  const maintenance = engine.events.filter((row) => row.type === 'consolidate')
  assert.equal(maintenance.length, 1)
  assert.deepEqual([maintenance[0].faded, maintenance[0].expired], [1, 1])

  await Promise.all([engine.consolidate(), engine.correct(live.memory.id, { importance: 0.93 })])
  const restored = await new MemoryEngine(root, 6).init()
  assert.equal(restored.memories.get(daily.memory.id).status, 'faded')
  assert.equal(restored.memories.get(promise.memory.id).status, 'expired')
  assert.equal(restored.memories.get(live.memory.id).importance, 0.93)
  assert.equal(typeof restored.memories.get(live.memory.id).effectiveStrength, 'number')
})

test('DSH bundle 不会因用户正常提到当前时间而误过滤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-runtime-text-'))
  const engine = await new MemoryEngine(root, 6).init()
  const result = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '我正在记录当前时间字段，周五继续测试迁移。',
    sourceKey: 'normal-runtime-wording-1',
  })
  assert.equal(result.stored, true)
  assert.ok(result.memory)
  assert.equal((await engine.stats()).filteredRuntimeInjections, 0)
})

test('明确 remember 可以有意保存包含运行时标记的内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-plugin-runtime-explicit-'))
  const engine = await new MemoryEngine(root, 6, { dailyWriteBudget: 0 }).init()
  const result = await engine.ingest({
    sessionId: 's1',
    speaker: 'user',
    text: '【当前时间】这个字段是测试数据格式的一部分。',
    sourceKey: 'explicit-runtime-wording-1',
    forcedKind: 'fact',
    writePriority: 'priority',
  })
  assert.equal(result.stored, true)
  assert.ok(result.memory)
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
  assert.equal(hits[0].memory.factKey, null)
  assert.equal(hits[0].memory.epistemicStatus, null)
  assert.equal(hits[0].memory.lastRecalledAt, null)
  assert.equal(hits[0].memory.sourceFile, undefined)
  assert.equal(hits[0].memory.sourceRowHash, undefined)
})

test('DSH bundle 的 recall 工具可无损返回混合新旧记忆，不改写记忆文件', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-tool-recall-json-'))
  const at = new Date().toISOString()
  const memoryFile = join(root, 'memories.json')
  const summary = '蓝色工具箱原来放在仓库门口。'
  await writeFile(memoryFile, JSON.stringify([{
    id: 'legacy',
    kind: 'event',
    speaker: 'user',
    sourceKind: 'puppet-memory',
    migrationStatus: 'human-reviewed',
    summary,
    evidence: summary,
    sourceTurnIds: ['legacy-turn'],
    sourceSessionId: 'legacy-session',
    occurredAt: at,
    recordedAt: at,
    visibility: 'recallable',
    epistemicStatus: 'accepted',
    status: 'active',
    importance: 0.8,
    strength: 0.8,
  }]))
  let tool
  const dispose = await apply({
    get: () => undefined,
    inject: () => {},
    on: () => () => {},
    tools: { register: (definition) => { tool = definition } },
    systemPrompt: {
      section: () => {},
      context: () => {},
      getSectionOrder: () => 5000,
      getContextOrder: () => 200,
    },
  }, { root })
  t.after(dispose)

  const remembered = await tool.execute({
    action: 'remember',
    text: '蓝色工具箱现在放在仓库货架。',
    kind: 'fact',
    sessionId: 'current-session',
  })
  assert.equal(remembered.stored, true)
  assert.equal(typeof remembered.memory.claimType, 'string')
  const before = await readFile(memoryFile, 'utf8')
  assert.equal(Object.hasOwn(JSON.parse(before).find((row) => row.id === 'legacy'), 'claimType'), false)

  const result = await tool.execute({ action: 'recall', query: '蓝色工具箱', sessionId: 'new-session' })
  assert.equal(result.hits.length, 2)
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)))
  const legacy = result.hits.find((hit) => hit.memory.id === 'legacy').memory
  const current = result.hits.find((hit) => hit.memory.id === remembered.memory.id).memory
  assert.equal(legacy.claimType, null)
  assert.equal(legacy.evidence, summary)
  assert.equal(legacy.occurredAt, at)
  assert.deepEqual(legacy.sourceTurnIds, ['legacy-turn'])
  assert.equal(current.claimType, remembered.memory.claimType)
  assert.equal(await readFile(memoryFile, 'utf8'), before)
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
