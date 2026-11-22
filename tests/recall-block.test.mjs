import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchStore } from '../src/store.mjs'
import { CompanionMemory } from '../src/companion-memory.mjs'
import { buildArchive, migrateArchive } from '../src/archive.mjs'
import { MemoryEngine } from '../plugin/lib/index.js'

// 注意：这里刻意用两条 claimKey 不同的独立事实。
// 若用「我喜欢蓝色鲸鱼 / 我喜欢绿色鲸鱼」这种同 key 文本，
// 后写的一条会把前一条标成 superseded，测试就会假通过。
const RB_TEXT = '我住在青屿的海边。'
const EE_TEXT = '我周末常去黑岩爬山。'

async function seedKernel() {
  const root = await mkdtemp(join(tmpdir(), 'rb-kernel-'))
  const store = await new ResearchStore(root).init({ test: true })
  const memory = new CompanionMemory({ store })
  const session = await memory.createSession({ title: 'recall-block' })
  const blocked = await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: RB_TEXT, turnIndex: 0 })
  const excluded = await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text: EE_TEXT, turnIndex: 1 })
  return { root, store, memory, session, blocked, excluded }
}

async function reopenKernel(root) {
  const store = await new ResearchStore(root).init({ test: true })
  return { store, memory: new CompanionMemory({ store }) }
}

test('内核：recall-block 立即生效，export-exclude 不受影响', async () => {
  const { memory, blocked, excluded } = await seedKernel()
  await memory.forget(blocked.memory.id, { mode: 'recall-block' })
  await memory.forget(excluded.memory.id, { mode: 'export-exclude' })

  const hits = await memory.recall('青屿 海边')
  assert.equal(hits.some((item) => item.memory.id === blocked.memory.id), false, 'recall-block 后不应召回')
  const otherHits = await memory.recall('黑岩 爬山')
  assert.equal(otherHits.some((item) => item.memory.id === excluded.memory.id), true, 'export-exclude 仍应可召回')
})

test('内核：重启后 recall-block 仍然不可召回', async () => {
  const { root, memory, blocked } = await seedKernel()
  await memory.forget(blocked.memory.id, { mode: 'recall-block' })
  const reopened = await reopenKernel(root)
  const hits = await reopened.memory.recall('青屿 海边')
  assert.equal(hits.some((item) => item.memory.id === blocked.memory.id), false)
})

test('内核：consolidate 整理后 recall-block 仍然不可召回', async () => {
  const { root, memory, blocked } = await seedKernel()
  await memory.forget(blocked.memory.id, { mode: 'recall-block' })
  await memory.consolidate()
  const hits = await memory.recall('青屿 海边')
  assert.equal(hits.some((item) => item.memory.id === blocked.memory.id), false)
  const reopened = await reopenKernel(root)
  const afterRestart = await reopened.memory.recall('青屿 海边')
  assert.equal(afterRestart.some((item) => item.memory.id === blocked.memory.id), false)
})

test('内核：archive 导出再导入后 recall-block 仍然不可召回', async () => {
  const { store, memory, blocked } = await seedKernel()
  await memory.forget(blocked.memory.id, { mode: 'recall-block' })
  const archive = buildArchive(store)
  assert.ok(archive.memories.some((item) => item.id === blocked.memory.id), 'recall-block 不等于导出排除')

  const restored = migrateArchive(JSON.parse(JSON.stringify(archive)))
  const root2 = await mkdtemp(join(tmpdir(), 'rb-kernel-import-'))
  const store2 = await new ResearchStore(root2).init({ test: true })
  await store2.replaceSnapshot(restored)
  const memory2 = new CompanionMemory({ store: store2 })
  const hits = await memory2.recall('青屿 海边')
  assert.equal(hits.some((item) => item.memory.id === blocked.memory.id), false)
})

test('bundle：recall-block 重启后不可召回，export-exclude 仍可召回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rb-bundle-'))
  const engine = await new MemoryEngine(root, 6).init()
  const blocked = await engine.ingest({ sessionId: 's1', speaker: 'user', text: RB_TEXT, sourceKey: 'rb-1' })
  const excluded = await engine.ingest({ sessionId: 's1', speaker: 'user', text: EE_TEXT, sourceKey: 'rb-2' })
  await engine.forget(blocked.memory.id, false, 'recall-block')
  await engine.forget(excluded.memory.id, false, 'export-exclude')

  const hits = await engine.recall('青屿 海边')
  assert.equal(hits.some((item) => item.memory.id === blocked.memory.id), false, '删除后同进程内不应召回')

  const reopened = await new MemoryEngine(root, 6).init()
  const afterRestart = await reopened.recall('青屿 海边')
  assert.equal(afterRestart.some((item) => item.memory.id === blocked.memory.id), false, '重启后不应召回')

  const otherHits = await reopened.recall('黑岩 爬山')
  assert.equal(otherHits.some((item) => item.memory.id === excluded.memory.id), true, 'export-exclude 仍应可召回')
})
