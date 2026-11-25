import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchStore } from '../src/store.mjs'
import { CompanionMemory, decayHalfLifeHours, freshnessScore, memoryStrength } from '../src/companion-memory.mjs'
import { SimulatedClock } from '../src/clock.mjs'
import { exportArchive, importArchive, migrateArchive } from '../src/archive.mjs'
import { runComparison } from '../src/comparison.mjs'
import { runUnifiedComparison, runLongTermAcceptance } from '../src/unified-comparison.mjs'

test('自研原型能跨会话召回近期内容和承诺', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const first = await memory.createSession({ title: 'first' })
  await memory.ingestTurn({
    sessionId: first.id,
    speaker: 'user',
    text: '请记得我明天要继续测试换对话连续性。',
    turnIndex: 0,
    occurredAt: '2026-11-22T00:00:00.000Z',
  })
  const second = await memory.createSession({ title: 'second', parentSessionId: first.id })
  const context = await memory.continuityContext({
    sessionId: second.id,
    query: '我们继续测试换对话连续性',
    now: '2026-11-22T01:00:00.000Z',
  })
  assert.match(context, /连续性/)
  assert.match(context, /明天要继续测试/)
  assert.equal(store.listMemories().length, 1)
})

test('新会话连续性窗口包含父会话最近内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const first = await memory.createSession({ title: 'parent' })
  await memory.ingestTurn({
    sessionId: first.id,
    speaker: 'user',
    text: '我们正在研究记忆插件的换对话连续性。',
    turnIndex: 0,
  })
  const second = await memory.createSession({ title: 'child', parentSessionId: first.id })
  const context = await memory.continuityContext({
    sessionId: second.id,
    query: '今天继续昨天的研究',
  })
  assert.match(context, /上一会话及当前会话最近对话/)
  assert.match(context, /换对话连续性/)
})

test('同一事实键的新陈述会产生取代关系', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'correction' })
  await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '我喜欢先看长报告。', turnIndex: 0 })
  await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '我不喜欢先看长报告，我改成先看结论。', turnIndex: 1 })
  const all = store.listMemories()
  assert.ok(all.some((item) => item.status === 'superseded'))
  assert.ok(all.some((item) => item.status !== 'superseded'))
})

test('长期整理只接受能回指原话的模型候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const llm = {
    async chatJson() {
      return {
        value: {
          memories: [
            {
              kind: 'preference',
              speaker: 'user',
              summary: '用户喜欢先看结论',
              evidence: '我喜欢先看结论。',
              sourceTurnIds: ['turn_good'],
              factKey: 'user.preference.report-order',
              importance: 0.9,
            },
            {
              kind: 'fact',
              speaker: 'user',
              summary: '模型猜测的事实',
              evidence: '这句并不存在',
              sourceTurnIds: ['turn_good'],
              factKey: 'user.unknown',
              importance: 1,
            },
          ],
        },
        usage: { total_tokens: 1 },
        model: 'test',
      }
    },
  }
  const memory = new CompanionMemory({ store, llm })
  const session = await memory.createSession({ title: 'grounding' })
  const ingested = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我喜欢先看结论。',
    turnIndex: 0,
  })
  await store.saveTurn({ ...ingested.turn, id: 'turn_good' })
  const result = await memory.consolidateSession(session.id)
  assert.equal(result.extracted, 1)
  assert.equal(result.rejected, 1)
  assert.ok(store.listMemories().some((item) => item.factKey === 'user.preference.report-order'))
})

test('承诺意图优先召回用户要求记住的事项', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'intent' })
  const requirement = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '请记得把自研方案做成真正的插件，不能只做交接纸。',
    turnIndex: 0,
  })
  assert.equal(requirement.candidate.kind, 'commitment')
  assert.equal(requirement.candidate.polarity, 'affirmed')
  assert.equal(requirement.candidate.visibility, 'recallable')
  assert.match(requirement.candidate.evidence, /不能只做交接纸/)
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'assistant',
    text: '研究结论以后先给结论，再给证据。',
    turnIndex: 1,
  })
  const hits = await memory.recall('上次我要求你记住的研究原则是什么？', {
    sessionId: session.id,
    topK: 1,
  })
  assert.equal(hits[0]?.memory.speaker, 'user')
  assert.match(hits[0]?.memory.summary || '', /真正的插件/)
  const context = await memory.continuityContext({
    sessionId: session.id,
    query: '上次我要求你记住的研究原则是什么？',
  })
  assert.match(context, /用户明确提出的要求\/承诺（优先）/)
  assert.match(context, /真正的插件/)
})

test('记忆库重启后能恢复数组格式的 memories.jsonl', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const firstStore = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store: firstStore })
  const session = await memory.createSession({ title: 'persist' })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '请记住我重启后仍然要继续研究记忆插件。',
    turnIndex: 0,
  })
  const secondStore = await new ResearchStore(root).init({ test: true })
  assert.equal(secondStore.listMemories().length, 1)
  assert.match(secondStore.listMemories()[0].summary, /重启后/)
})

test('模拟时钟能让远期记忆衰减，并让到期承诺进入 expired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const clock = new SimulatedClock('2026-11-22T00:00:00.000Z')
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store, clock: () => clock.now() })
  const session = await memory.createSession({ title: 'time' })
  const first = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '请记得明天完成一次换对话连续性测试。',
    turnIndex: 0,
    occurredAt: clock.iso(),
  })
  assert.equal(first.candidate.dueAt, '2026-11-23T23:59:59.999Z')
  clock.advanceDays(2)
  await memory.consolidate()
  assert.equal(store.listMemories()[0].status, 'expired')
  assert.ok(freshnessScore(store.listMemories()[0], clock.iso()) < 1)
})

test('独立归档可以导出、导入并保留自研格式', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'companion-memory-source-'))
  const targetRoot = await mkdtemp(join(tmpdir(), 'companion-memory-target-'))
  const sourceStore = await new ResearchStore(sourceRoot).init({ test: true })
  const sourceMemory = new CompanionMemory({ store: sourceStore })
  const session = await sourceMemory.createSession({ title: 'archive' })
  await sourceMemory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我要求独立格式必须支持迁移。',
    turnIndex: 0,
  })
  const archivePath = join(sourceRoot, 'archive.json')
  const archive = await exportArchive(sourceStore, archivePath, { metadata: { purpose: 'test' } })
  const targetStore = await new ResearchStore(targetRoot).init({ test: true })
  await importArchive(targetStore, archivePath)
  const duplicate = await importArchive(targetStore, archivePath)
  assert.equal(archive.schema, 'dsh-companion-memory/archive@3')
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(targetStore.listSessions().length, 1)
  assert.equal(targetStore.listMemories().length, 1)
  assert.match(targetStore.listMemories()[0].summary, /迁移/)
})

test('无效归档会在写入前失败，不覆盖现有记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-invalid-archive-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'rollback' })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我会保留原有数据。',
    turnIndex: 0,
  })
  await assert.rejects(
    importArchive(store, {
      schema: 'dsh-companion-memory/archive@1',
      version: 1,
      sessions: [{ id: 's1' }],
      turns: [{ id: 't1', sessionId: 'missing' }],
      memories: [],
    }),
    /不存在的 session/,
  )
  assert.equal(store.listMemories().length, 1)
  assert.match(store.listMemories()[0].summary, /保留原有数据/)
})

test('归档校验拒绝篡改，并能迁移无版本旧快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-archive-check-'))
  const store = await new ResearchStore(root).init({ test: true })
  const archive = await exportArchive(store, join(root, 'archive.json'))
  await assert.rejects(
    importArchive(store, { ...archive, archiveId: 'tampered' }),
    /archiveId 不匹配/,
  )
  const migrated = migrateArchive({ sessions: [], turns: [], memories: [] })
  assert.equal(migrated.schema, 'dsh-companion-memory/archive@2')
  assert.equal(migrated.version, 2)
})

test('archive@1 旧归档迁移时补齐三种时间字段并保留校验', async () => {
  const legacy = migrateArchive({
    schema: 'dsh-companion-memory/archive@1',
    version: 1,
    exportedAt: '2026-11-01T00:00:00.000Z',
    metadata: { source: 'legacy' },
    sessions: [{ id: 's1' }],
    turns: [{ id: 't1', sessionId: 's1', speaker: 'user', text: '旧回合', createdAt: '2026-11-01T01:00:00.000Z' }],
    memories: [{
      id: 'm1',
      kind: 'fact',
      summary: '旧记忆',
      evidence: '旧回合',
      sourceTurnIds: ['t1'],
      createdAt: '2026-11-01T01:00:00.000Z',
      lastSeenAt: '2026-11-01T01:00:00.000Z',
    }],
  })
  assert.equal(legacy.schema, 'dsh-companion-memory/archive@3')
  assert.equal(legacy.metadata.migratedFrom, 'dsh-companion-memory/archive@1')
  assert.equal(legacy.turns[0].occurredAt, '2026-11-01T01:00:00.000Z')
  assert.equal(legacy.turns[0].recordedAt, '2026-11-01T01:00:00.000Z')
  assert.equal(legacy.memories[0].lastRecalledAt, null)
  assert.equal(legacy.memories[0].visibility, 'evidence-only')
  assert.equal(legacy.memories[0].epistemicStatus, 'candidate')
})

test('统一比较入口能比较融合方案与朴素词法基线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-compare-'))
  const report = await runComparison(root)
  assert.ok(report.cases.length >= 3)
  assert.ok(report.summary.fusion >= report.summary.baseline)
  assert.ok(report.cases.some((item) => item.delta > 0))
})

test('统一 A/B 会在同一场景下报告四种方案的支持状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-unified-'))
  const report = await runUnifiedComparison(root)
  assert.deepEqual(report.adapters, ['fusion', 'memu', 'fish', 'baseline'])
  assert.ok(report.cases.length >= 6)
  assert.equal(report.summary.fusion.status, 'scored-not-independent')
  assert.equal(report.summary.fusion.independentEvidence, false)
  assert.ok(['scored-not-independent', 'unsupported'].includes(report.summary.memu.status))
  assert.ok(['scored-not-independent', 'unsupported'].includes(report.summary.fish.status))
})

test('长期验收覆盖分类衰减、远期召回、确认强化和时间字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-long-term-'))
  const report = await runLongTermAcceptance(root)
  assert.equal(report.status, 'passed')
  assert.equal(report.checks.categoryDecay, true)
  assert.equal(report.checks.explicitRecallReinforcement, true)
})

test('不相关问题不会主动注入所有未完成承诺', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'restraint' })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '请记得明天完成记忆插件回放测试。',
    turnIndex: 0,
    occurredAt: '2026-11-22T00:00:00.000Z',
  })
  const unrelatedSession = await memory.createSession({ title: 'unrelated' })
  const context = await memory.continuityContext({
    sessionId: unrelatedSession.id,
    query: '你觉得今天的天气怎么样？',
    now: '2026-11-22T01:00:00.000Z',
  })
  assert.doesNotMatch(context, /回放测试/)
  const hits = await memory.recall('你觉得今天的天气怎么样？', { sessionId: session.id })
  assert.equal(hits.length, 0)
})

test('记忆强度按类别衰减，检索不强化而明确确认可重新激活', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const clock = new SimulatedClock('2026-11-22T00:00:00.000Z')
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store, clock: () => clock.now() })
  const session = await memory.createSession({ title: 'decay' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我最近正在学习记忆系统。',
    turnIndex: 0,
    occurredAt: clock.iso(),
  })
  const initial = memoryStrength(result.candidate, clock.iso())
  clock.advanceDays(90)
  await memory.consolidate()
  const faded = store.listMemories()[0]
  assert.equal(decayHalfLifeHours('relationship') > decayHalfLifeHours('emotion'), true)
  assert.ok(faded.effectiveStrength < initial)
  faded.status = 'faded'
  const before = faded.recallCount || 0
  const beforeStrength = faded.strength || 0
  const retrieved = await memory.recall('学习记忆系统', { sessionId: session.id, now: clock.iso() })
  assert.equal(retrieved.length, 1)
  const afterRetrieve = store.listMemories()[0]
  assert.equal(afterRetrieve.recallCount || 0, before)
  assert.equal(afterRetrieve.strength || 0, beforeStrength)
  assert.equal(afterRetrieve.status, 'faded')
  const confirmation = {
    id: 'turn_confirmation_decay',
    sessionId: session.id,
    speaker: 'user',
    text: '我仍在学习记忆系统。',
    turnIndex: 1,
    occurredAt: clock.iso(),
    recordedAt: clock.iso(),
  }
  await store.saveTurn(confirmation)
  await memory.confirmRecall(retrieved.map((item) => item.memory.id), {
    sessionId: session.id,
    query: '学习记忆系统',
    now: clock.iso(),
    confirmationTurnId: confirmation.id,
  })
  const revived = store.listMemories()[0]
  assert.equal(revived.status, 'active')
  assert.equal(revived.recallCount, before + 1)
  assert.equal(revived.confirmedRecallCount, 1)
  assert.ok(revived.strength > beforeStrength)
})

test('连续性上下文注入不会因为误命中而强化记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'no-implicit-reinforcement' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我正在研究陪伴型记忆的来源追溯。',
    turnIndex: 0,
  })
  const before = { ...result.candidate }
  await memory.continuityContext({
    sessionId: session.id,
    query: '来源追溯',
  })
  const after = store.memoryMap.get(result.candidate.id)
  assert.equal(after.recallCount || 0, before.recallCount || 0)
  assert.equal(after.confirmedRecallCount || 0, before.confirmedRecallCount || 0)
  assert.equal(after.strength, before.strength)
})

test('同一事实被用户再次明确陈述时以新证据强化，而不是伪造回忆确认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'evidence-reinforcement' })
  const first = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我喜欢先看结论。',
    turnIndex: 0,
  })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我喜欢先看结论。',
    turnIndex: 1,
  })
  const saved = store.memoryMap.get(first.candidate.id)
  assert.equal(saved.reinforcementCount, 1)
  assert.equal(saved.recallCount, 0)
  assert.equal(saved.confirmedRecallCount, 0)
})

test('用户可以编辑、追溯来源、软删除、恢复和做 claim 级清除（原始 turns 保留）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'controls' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我希望以后先看结论，再看证据。',
    turnIndex: 0,
  })
  const edited = await memory.correct(result.candidate.id, { summary: '用户希望先看结论' })
  assert.equal(edited.summary, '用户希望先看结论')
  const explained = memory.explain(edited.id)
  assert.equal(explained.sources.length, 1)
  assert.equal(explained.sources[0].text, '我希望以后先看结论，再看证据。')
  await memory.forget(edited.id)
  assert.equal(memory.listMemories().length, 0)
  await memory.restore(edited.id)
  assert.equal(memory.listMemories().length, 1)
  const purgeResult = await memory.forget(edited.id, { hard: true })
  assert.equal(store.listMemories().length, 0)
  assert.equal(memory.listMemories({ includeDeleted: true }).length, 0)
  // 对外只承诺 claim 级：原始 turn 正文、归档和备份都不在这次清除范围内。
  assert.equal(purgeResult.purgeScope, 'claim-only')
  assert.deepEqual(purgeResult.retained, ['turns', 'archives', 'backups'])
})

test('选择性写入会跳过寒暄，但保留明确偏好和承诺', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'selective' })
  const greeting = await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '哈哈', turnIndex: 0 })
  const preference = await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '我喜欢先看结论。', turnIndex: 1 })
  const commitment = await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '请记得明天继续测试。', turnIndex: 2 })
  assert.equal(greeting.candidate, null)
  assert.equal(preference.candidate.kind, 'preference')
  assert.equal(commitment.candidate.kind, 'commitment')
  assert.equal(store.listMemories().length, 2)
})

test('数据完整性检查能发现损坏、重启恢复和异常退出残留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'integrity' })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我正在验证重启恢复。',
    turnIndex: 0,
  })
  const clean = await store.integrityCheck()
  assert.equal(clean.ok, true)
  await import('node:fs/promises').then(({ writeFile }) => writeFile(
    `${root}\\memories.jsonl.tmp`,
    '{"partial":',
    'utf8',
  ))
  const restart = await new ResearchStore(root).init({ test: true })
  assert.equal((await restart.integrityCheck()).ok, true)
  await import('node:fs/promises').then(({ appendFile }) => appendFile(
    `${root}\\memories.jsonl`,
    '\n{"broken":',
    'utf8',
  ))
  const damaged = await restart.integrityCheck()
  assert.equal(damaged.ok, false)
  assert.match(damaged.errors.join('\n'), /无法解析/)
})

test('检索和模型整理会记录耗时、注入规模与 token 统计', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({
    store,
    llm: {
      async chatJson() {
        return {
          value: { memories: [] },
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          model: 'test',
        }
      },
    },
  })
  const session = await memory.createSession({ title: 'metrics' })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我正在测试成本统计。',
    turnIndex: 0,
  })
  await memory.recall('成本统计', { sessionId: session.id })
  await memory.consolidateSession(session.id)
  const summary = await store.metricSummary()
  assert.equal(summary.recalls, 1)
  assert.equal(summary.modelCalls, 1)
  assert.equal(summary.modelTokens, 14)
  assert.ok(summary.averageRecallMs >= 0)
})

test('分类鲜活度使用不同半衰期，而不是统一 recent 分数', async () => {
  const at = '2026-11-22T00:00:00.000Z'
  const old = '2026-10-22T00:00:00.000Z'
  const relationship = { kind: 'relationship', importance: 0.8, strength: 0.8, lastSeenAt: old }
  const emotion = { kind: 'emotion', importance: 0.8, strength: 0.8, lastSeenAt: old }
  assert.ok(freshnessScore(relationship, at) > freshnessScore(emotion, at))
  assert.ok(decayHalfLifeHours('relationship') > decayHalfLifeHours('emotion'))
})

test('事件同时保存发生时间、记录时间和最近回忆时间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-time-'))
  const clock = new SimulatedClock('2026-11-22T02:00:00.000Z')
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store, clock: () => clock.now() })
  const session = await memory.createSession({ title: 'time-fields' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我昨天在研究事件时间字段。',
    occurredAt: '2026-11-21T10:00:00.000Z',
    turnIndex: 0,
  })
  assert.equal(result.turn.occurredAt, '2026-11-21T10:00:00.000Z')
  assert.equal(result.turn.recordedAt, '2026-11-22T02:00:00.000Z')
  assert.equal(result.candidate.occurredAt, result.turn.occurredAt)
  assert.equal(result.candidate.recordedAt, result.turn.recordedAt)
  assert.equal(result.candidate.lastRecalledAt, null)
  const confirmation = {
    id: 'turn_confirmation_time_fields',
    sessionId: session.id,
    speaker: 'user',
    text: '我仍在研究事件时间字段。',
    turnIndex: 1,
    occurredAt: clock.iso(),
    recordedAt: clock.iso(),
  }
  await store.saveTurn(confirmation)
  await memory.confirmRecall(result.candidate.id, {
    now: clock.iso(),
    confirmationTurnId: confirmation.id,
  })
  assert.equal(store.memoryMap.get(result.candidate.id).lastRecalledAt, clock.iso())
})

test('软每日配额抑制普通写入，但不阻断明确记住的高优先级内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-budget-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store, dailyWriteBudget: 1 })
  const session = await memory.createSession({ title: 'budget' })
  const first = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我今天在研究轻量记忆。',
    turnIndex: 0,
  })
  const second = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我最近正在测试低成本部署。',
    turnIndex: 1,
  })
  const priority = await memory.rememberText({
    sessionId: session.id,
    text: '请记得关系变化和明确承诺不能被每日配额挤掉。',
    turnIndex: 2,
  })
  assert.ok(first.memory)
  assert.equal(second.memory, null)
  assert.ok(priority.memory)
  assert.equal((await store.metricSummary()).suppressedWrites, 1)
})

test('日常共同事件会在跨会话重复后自动晋升，不需要用户手动整理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-daily-promotion-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const first = await memory.createSession({ title: 'daily-first' })
  const firstTurn = await memory.ingestTurn({
    sessionId: first.id,
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    turnIndex: 0,
    occurredAt: '2026-11-22T10:00:00.000Z',
  })
  assert.equal(firstTurn.candidate.kind, 'event')
  assert.equal(firstTurn.candidate.retentionClass, 'daily')
  const second = await memory.createSession({ title: 'daily-second', parentSessionId: first.id })
  const secondTurn = await memory.ingestTurn({
    sessionId: second.id,
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    turnIndex: 0,
    occurredAt: '2026-11-23T10:00:00.000Z',
  })
  assert.equal(secondTurn.memory.retentionClass, 'durable')
  assert.equal(secondTurn.memory.promotionState, 'promoted')
  assert.ok(store.memoryEvents.some((event) => event.type === 'promote'))
})

test('日常共同事件一周无人再提会自动淡出召回，但原始记录仍保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-daily-expiry-'))
  const clock = new SimulatedClock('2026-11-22T10:00:00.000Z')
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store, clock: () => clock.now() })
  const session = await memory.createSession({ title: 'daily-expiry' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    turnIndex: 0,
    occurredAt: clock.iso(),
  })
  clock.advanceDays(8)
  const hits = await memory.retrieve('神舟发射', { sessionId: session.id, now: clock.iso() })
  assert.equal(hits.length, 0)
  await memory.consolidate()
  assert.equal(store.listMemories()[0].status, 'faded')
  assert.equal(store.listTurns().length, 1)
  assert.equal(result.candidate.retentionClass, 'daily')
})

test('低置信度历史查询才触发一次语义门控，并且只允许选择候选记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-semantic-'))
  const store = await new ResearchStore(root).init({ test: true })
  let calls = 0
  const memory = new CompanionMemory({
    store,
    llm: {
      async chatJson() {
        calls++
        const candidate = store.listMemories()[0]
        return {
          value: { memoryIds: [candidate.id, 'invented-id'] },
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          model: 'test-semantic',
        }
      },
    },
  })
  const session = await memory.createSession({ title: 'semantic' })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我在海边看到了蓝色灯塔。',
    turnIndex: 0,
  })
  const hits = await memory.recall('上次那个蓝色的地方', { sessionId: session.id })
  assert.equal(calls, 1)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].memory.summary, '我在海边看到了蓝色灯塔。')
  assert.equal((await store.metricSummary()).modelCalls, 1)
})

test('模型整理统计 JSON 错误和证据拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-llm-metrics-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({
    store,
    llm: {
      async chatJson() {
        return {
          value: {
            memories: [
              {
                kind: 'fact',
                speaker: 'user',
                summary: '不存在的事实',
                evidence: '完全不在原话里的句子',
                sourceTurnIds: ['turn_1'],
                importance: 0.8,
              },
            ],
          },
          retried: true,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: 'test-llm',
        }
      },
    },
  })
  const session = await memory.createSession({ title: 'metrics-llm' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我正在测试模型整理指标。',
    turnIndex: 0,
  })
  await memory.consolidateSession(session.id)
  const summary = await store.metricSummary()
  assert.equal(result.turn.recordedAt !== undefined, true)
  assert.equal(summary.jsonErrors, 1)
  assert.equal(summary.evidenceRejected, 1)
})

test('LLM 整理不能用普通候选覆盖用户明确记住的高优先级事实', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-priority-protection-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({
    store,
    llm: {
      async chatJson() {
        const turn = store.listTurns()[0]
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
          usage: { total_tokens: 5 },
          model: 'test',
        }
      },
    },
  })
  const session = await memory.createSession({ title: 'priority-protection' })
  const explicit = await memory.rememberText({
    sessionId: session.id,
    text: '请记得我改成先看结论，再看证据。',
    turnIndex: 0,
  })
  await memory.consolidateSession(session.id)
  const saved = store.memoryMap.get(explicit.candidate.id)
  assert.equal(saved.status, 'open')
  assert.equal(saved.writePriority, 'priority')
  assert.equal(store.listMemories().filter((item) => item.status === 'superseded').length, 0)
  assert.ok(store.listMemories().some((item) => item.status === 'review'))
})
