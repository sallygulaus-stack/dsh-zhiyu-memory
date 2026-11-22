import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchStore } from '../src/store.mjs'
import { CompanionMemory } from '../src/companion-memory.mjs'
import { buildArchive, migrateArchive } from '../src/archive.mjs'
import { evaluateBlindCases, loadBlindCases } from '../src/blind-evaluator.mjs'

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'companion-memory-hardening-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store, ...options })
  const session = await memory.createSession({ title: 'hardening' })
  return { root, store, memory, session }
}

test('模型不能把 assistant 来源改标成 user，且必须保留结构化 evidence ref', async () => {
  const { store, memory, session } = await fixture({
    llm: {
      async chatJson() {
        const turn = store.listTurns()[0]
        return {
          value: {
            memories: [{
              kind: 'fact',
              speaker: 'user',
              summary: '用户答应明天上线',
              evidence: '我会在明天上线。',
              sourceTurnIds: [turn.id],
              factKey: 'user.commitment.launch',
            }],
          },
        }
      },
    },
  })
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'assistant',
    text: '我会在明天上线。',
    turnIndex: 0,
  })
  const result = await memory.consolidateSession(session.id)
  assert.equal(result.extracted, 0)
  assert.equal(result.rejected, 1)
})

test('单字 evidence、否定、假设和转述不能进入 affirmed 普通事实', async () => {
  const { store, memory, session } = await fixture()
  const rows = [
    ['我', 'single'],
    ['我不住在上海。', 'negated'],
    ['如果以后一起旅行就好了。', 'hypothetical'],
    ['我听说爸爸明天会搬家。', 'reported'],
  ]
  for (const [text] of rows) {
    await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text })
  }
  const memories = store.listMemories()
  assert.equal(memories.some((item) => item.summary === '我'), false)
  assert.ok(memories.length >= 3)
  assert.ok(memories.every((item) => item.epistemicStatus !== 'accepted'
    || (item.polarity === 'affirmed' && item.modality === 'assertion')))
})

test('confirmRecall 需要确认回合，并刷新 lastReinforcedAt 作为衰减锚点', async () => {
  const { memory, store, session } = await fixture()
  const created = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我喜欢先看结论。',
    turnIndex: 0,
    occurredAt: '2026-01-01T00:00:00.000Z',
  })
  await assert.rejects(
    memory.confirmRecall(created.memory.id, { now: '2026-11-22T00:00:00.000Z' }),
    /confirmationTurnId/,
  )
  const confirmation = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '对，我还是喜欢先看结论。',
    turnIndex: 1,
    occurredAt: '2026-11-22T00:00:00.000Z',
  })
  await memory.confirmRecall(created.memory.id, {
    confirmationTurnId: confirmation.turn.id,
    now: '2026-11-22T00:00:00.000Z',
  })
  const saved = store.memoryMap.get(created.memory.id)
  assert.equal(saved.lastReinforcedAt, '2026-11-22T00:00:00.000Z')
  assert.equal(saved.lastRecalledAt, '2026-11-22T00:00:00.000Z')
})

test('隔离实验 purge 隐藏并排除 claim；旧来源回合保持不变，物理擦除待复核', async () => {
  const { root, store, memory, session } = await fixture()
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我的秘密住址是蓝屋。',
    turnIndex: 0,
  })
  await memory.forget(result.memory.id, { hard: true })
  assert.equal(store.listTurns().some((turn) => turn.text.includes('蓝屋')), true)
  const rawTurns = await readFile(join(root, 'turns.jsonl'), 'utf8')
  assert.match(rawTurns, /蓝屋/u)
  assert.equal(buildArchive(store).memories.some((item) => item.id === result.memory.id), false)
  const restarted = await new ResearchStore(root).init({ test: true })
  assert.equal(restarted.listTurns().some((turn) => turn.text.includes('蓝屋')), true)
  assert.equal(restarted.listMemories().some((item) => item.summary.includes('蓝屋')), false)
  const reorganizer = new CompanionMemory({
    store: restarted,
    llm: {
      async chatJson() {
        return {
          value: {
            memories: [{
              kind: 'fact',
              summary: '我的秘密住址是蓝屋。',
              evidence: '我的秘密住址是蓝屋。',
              sourceTurnIds: [result.turn.id],
              factKey: 'user.private.address',
            }],
          },
        }
      },
    },
  })
  const reorganized = await reorganizer.consolidateSession(session.id)
  assert.equal(reorganized.extracted, 0)
  assert.equal(reorganized.reason, 'no-new-turns')
  assert.equal(restarted.listMemories().some((item) => item.summary.includes('蓝屋')), false)
})

test('recall-block 与 export-exclude 是独立状态，只有后者影响新归档', async () => {
  const { store, memory, session } = await fixture()
  // 两条必须落在不同 claimKey 上：同 key 会让后写的一条把前一条标成 superseded，
  // 断言就会因为「被取代」而假通过，测不到 recall-block 本身。
  const recallBlocked = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我住在青屿的海边。',
    turnIndex: 0,
  })
  const exportExcluded = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我周末常去黑岩爬山。',
    turnIndex: 1,
  })
  assert.notEqual(store.memoryMap.get(recallBlocked.memory.id).status, 'superseded')
  assert.notEqual(store.memoryMap.get(exportExcluded.memory.id).status, 'superseded')
  await memory.forget(recallBlocked.memory.id, { mode: 'recall-block' })
  await memory.forget(exportExcluded.memory.id, { mode: 'export-exclude' })
  assert.equal((await memory.recall('青屿 海边')).some((item) => item.memory.id === recallBlocked.memory.id), false)
  const archive = buildArchive(store)
  assert.ok(archive.memories.some((item) => item.id === recallBlocked.memory.id))
  assert.equal(archive.memories.some((item) => item.id === exportExcluded.memory.id), false)
})

test('consolidateSession 增量且幂等，空 claimKey 不参与匹配', async () => {
  const calls = []
  const { store, memory, session } = await fixture({
    llm: {
      async chatJson(messages) {
        calls.push(messages.at(-1).content)
        const turnId = store.listTurns().at(-1).id
        return {
          value: {
            memories: [{
              kind: 'fact',
              summary: '我在研究增量整理。',
              evidence: '我在研究增量整理。',
              sourceTurnIds: [turnId],
              factKey: 'user.fact.incremental-consolidation',
            }],
          },
        }
      },
    },
  })
  await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '我在研究增量整理。', turnIndex: 0 })
  const first = await memory.consolidateSession(session.id)
  const second = await memory.consolidateSession(session.id)
  assert.equal(first.extracted, 1)
  assert.equal(second.extracted, 0)
  assert.equal(calls.length, 1)
})

test('空 claimKey 的模型候选会隔离，不会进入事实库', async () => {
  const { store, memory, session } = await fixture({
    llm: {
      async chatJson() {
        const turn = store.listTurns()[0]
        return {
          value: {
            memories: [{
              kind: 'fact',
              summary: '我正在研究空 key。',
              evidence: '我正在研究空 key。',
              sourceTurnIds: [turn.id],
              factKey: '',
            }],
          },
        }
      },
    },
  })
  await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: '我正在研究空 key。', turnIndex: 0 })
  const result = await memory.consolidateSession(session.id)
  assert.equal(result.extracted, 0)
  assert.equal(result.rejected, 1)
})

test('普通任务句只注入主题相关的 open commitment', async () => {
  const { memory, session } = await fixture()
  await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '请记得明天完成记忆插件回放测试。',
    turnIndex: 0,
  })
  const unrelatedSession = await memory.createSession({ title: 'unrelated-topic' })
  const unrelated = await memory.continuityContext({
    sessionId: unrelatedSession.id,
    query: '继续整理今天的天气。',
  })
  assert.doesNotMatch(unrelated, /回放测试/u)
  const related = await memory.continuityContext({
    sessionId: unrelatedSession.id,
    query: '继续整理记忆插件回放测试。',
  })
  assert.match(related, /回放测试/u)
})

test('相对日期按显式时区计算本地今晚', async () => {
  const { memory, session } = await fixture({ timezone: 'Asia/Hong_Kong' })
  const result = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '请记得今晚完成测试。',
    turnIndex: 0,
    occurredAt: '2026-11-22T15:30:00.000Z',
  })
  assert.equal(result.memory.dueAt, '2026-11-22T15:59:59.999Z')
})

test('archive@2 迁移到新 schema 时，不可靠证据进入 quarantine', () => {
  const archive = migrateArchive({
    schema: 'dsh-companion-memory/archive@2',
    version: 2,
    sessions: [{ id: 's1' }],
    turns: [{ id: 't1', sessionId: 's1', speaker: 'user', text: '原话' }],
    memories: [{
      id: 'm1',
      kind: 'fact',
      summary: '旧摘要',
      evidence: '摘要',
      sourceTurnIds: ['t1'],
    }],
  })
  assert.equal(archive.schema, 'dsh-companion-memory/archive@3')
  assert.equal(archive.memories[0].visibility, 'evidence-only')
  assert.equal(archive.memories[0].epistemicStatus, 'candidate')
})

test('独立盲测 harness 按真实 engine API 验证主体、语义状态与 purge claim', async () => {
  const cases = await loadBlindCases(new URL('./fixtures/independent-blind-cases.json', import.meta.url))
  const report = await evaluateBlindCases({
    cases,
    adapterFactory: async () => {
      const { store, memory } = await fixture()
      const sessions = new Map()
      return {
        async ingest(turn) {
          let session = sessions.get(turn.sessionId)
          if (!session) {
            session = await memory.createSession({ title: turn.sessionId })
            sessions.set(turn.sessionId, session)
          }
          return memory.ingestTurn({
            sessionId: session.id,
            speaker: turn.speaker,
            text: turn.text,
            turnId: turn.id,
            turnIndex: turn.turnIndex,
            occurredAt: turn.occurredAt,
            recordedAt: turn.recordedAt,
          })
        },
        async listClaims() {
          return store.listMemories()
        },
        async purgeClaim(memoryId) {
          return memory.forget(memoryId, { hard: true })
        },
        async exportClaims() {
          return buildArchive(store).memories
        },
      }
    },
  })
  assert.equal(report.status, 'passed', JSON.stringify(report))
  assert.equal(report.metrics.subjectAccuracy, 1)
  assert.equal(report.metrics.polarityModalityVisibilityAccuracy, 1)
  assert.equal(report.metrics.evidenceSpanHashAccuracy, 1)
  assert.equal(report.metrics.purgeClaimResidualRate, 0)
  assert.equal(report.physicalTurnErasure, 'not-tested-blocked-pending-privacy-review')
})
