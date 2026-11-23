import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { migratePuppetMemory } from '../src/migrate-puppet-memory.mjs'

test('木偶记忆迁移保留来源链、时间字段并区分关系与承诺', async () => {
  const root = await mkdtemp(join(tmpdir(), 'puppet-migration-'))
  await mkdir(join(root, 'behavior', 'diary'), { recursive: true })
  await writeFile(join(root, 'behavior', 'diary', '2026-10.jsonl'), JSON.stringify({
    ts: '2026-10-01T00:00:00.000Z',
    session: 's1',
    userFull: '我们第一次一起看海。',
    assistantFull: '我记得那天的风。',
    important: true,
  }) + '\n')
  await writeFile(join(root, 'behavior', 'diary', '2026-11.jsonl'), '')
  await writeFile(join(root, 'behavior', 'notes.jsonl'), JSON.stringify({
    ts: '2026-10-02T00:00:00.000Z',
    kind: 'note',
    note: '爸爸答应下周提醒我',
    text: '爸爸答应下周提醒我',
    tags: ['待办'],
    state: 'open',
  }) + '\n')
  await writeFile(join(root, 'behavior', 'relations.jsonl'), JSON.stringify({
    ts: '2026-10-03T00:00:00.000Z',
    kind: 'relation',
    quote: '爸爸',
    meaning: '称呼关系',
    tags: ['关系', '称呼'],
  }) + '\n')
  await writeFile(join(root, 'behavior', 'user.jsonl'), JSON.stringify({
    ts: '2026-10-04T00:00:00.000Z',
    kind: 'user',
    text: '用户喜欢白米饭',
    tags: ['生活'],
  }) + '\n')
  await writeFile(join(root, 'behavior', 'memo.jsonl'), '')
  await writeFile(join(root, 'behavior', 'core-state.md'), '【最近在办】继续验证新记忆插件。')
  await writeFile(join(root, 'behavior', 'core.md'), '【红线】不要泄露隐私。')
  await writeFile(join(root, 'behavior', 'core-rules.md'), '说错了直接改口。')
  await writeFile(join(root, 'behavior', 'persona.md'), '# 人设\n- 角色卡负责身份。')

  const archive = await migratePuppetMemory(root, { exportedAt: '2026-11-22T00:00:00.000Z' })
  assert.equal(archive.schema, 'dsh-companion-memory/archive@2')
  assert.ok(archive.archiveId)
  assert.ok(archive.turns.length >= 3)
  assert.ok(archive.memories.some((memory) => memory.kind === 'relationship'))
  assert.ok(archive.memories.some((memory) => memory.kind === 'commitment'))
  assert.equal(
    archive.memories.find((memory) => memory.sourceFile === 'behavior/core-state.md')?.writePriority,
    'priority',
  )
  assert.deepEqual(archive.metadata.preservedHostFiles, [
    'behavior/persona.md',
    'behavior/core.md',
    'behavior/core-rules.md',
  ])
  for (const memory of archive.memories) {
    assert.ok(memory.occurredAt)
    assert.ok(memory.recordedAt)
    assert.ok(memory.lastRecalledAt === null)
    assert.ok(memory.sourceFile)
    assert.ok(memory.sourceTurnIds.every((id) => archive.turns.some((turn) => turn.id === id)))
  }
})
