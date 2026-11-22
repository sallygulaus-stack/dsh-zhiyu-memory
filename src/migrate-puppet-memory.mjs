import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { hash, nowIso, writeJsonAtomic } from './util.mjs'
import { fileURLToPath } from 'node:url'

export const PUPPET_MIGRATION_VERSION = 'puppet-memory@0.41-compatible'
const ARCHIVE_SCHEMA = 'dsh-companion-memory/archive@2'

const KNOWN_KINDS = new Set(['fact', 'preference', 'relationship', 'emotion', 'commitment', 'event'])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

async function readJsonl(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function timestamp(row, fallback) {
  const value = row?.ts || row?.occurredAt || row?.createdAt || fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function sourceHash(file, index, row) {
  return hash(`${file}:${index}:${JSON.stringify(row)}`)
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function textFor(row) {
  return String(row?.note || row?.text || row?.quote || row?.proof || '').trim()
}

function kindFor(row, sourceFile) {
  const explicit = String(row?.kind || '').toLowerCase()
  if (KNOWN_KINDS.has(explicit)) return explicit
  const tags = asArray(row?.tags).map(String).join(' ')
  const text = `${tags} ${textFor(row)}`
  if (sourceFile.includes('relations') || /关系|称呼|身份/u.test(text)) return 'relationship'
  if (/待办|承诺|答应|提醒|下次|别忘/u.test(text)) return 'commitment'
  if (/喜欢|不喜欢|偏好|习惯|希望|不要叫/u.test(text)) return 'preference'
  if (/难过|开心|生气|焦虑|累|害怕|失眠|想念/u.test(text)) return 'emotion'
  if (/那天|上次|一起|第一次|发生|纪念/u.test(text)) return 'event'
  return sourceFile.includes('user') ? 'fact' : 'fact'
}

function recordType(kind) {
  return kind === 'commitment' ? 'commitment' : ['relationship', 'emotion', 'event'].includes(kind) ? 'event' : 'entity'
}

function subjectType(kind) {
  if (kind === 'relationship') return 'relationship'
  if (kind === 'emotion') return 'person-state'
  if (kind === 'commitment') return 'agreement'
  return 'person'
}

function importanceFor(row, kind) {
  const tags = asArray(row?.tags).map(String).join(' ')
  let value = ['relationship', 'commitment'].includes(kind) ? 0.85 : 0.62
  if (/第一次|重要|永远|不能忘|身份|称呼/u.test(`${tags} ${textFor(row)}`)) value += 0.1
  if (row?.state === 'done' && kind === 'commitment') value -= 0.05
  return Math.min(1, Math.max(0.2, value))
}

function statusFor(row, kind) {
  if (kind !== 'commitment') return 'active'
  if (row?.state === 'done') return 'done'
  if (row?.state === 'cancelled') return 'cancelled'
  return 'open'
}

function createSession(id, occurredAt, source) {
  return {
    id,
    title: `木偶迁移：${source}`,
    parentSessionId: null,
    createdAt: occurredAt,
    lastTurnAt: occurredAt,
    turnCount: 0,
    sourceKind: 'puppet-memory',
    sourceFile: source,
  }
}

function createTurn({ id, sessionId, speaker, text, occurredAt, sourceFile, sourceRowHash }) {
  return {
    id,
    sessionId,
    speaker,
    text: String(text).slice(0, 12_000),
    sourceKey: `puppet:${sourceFile}:${sourceRowHash}:${speaker}`,
    occurredAt,
    recordedAt: occurredAt,
    createdAt: occurredAt,
    sourceKind: 'puppet-memory',
    sourceFile,
    sourceRowHash,
  }
}

function canonicalKey(kind, text) {
  return `${kind}:${normalize(text).replace(/[，。！？、,.!?：:；;]/gu, ' ').slice(0, 240)}`
}

function addMemory({ memories, memoryKeys, sessions, turns, row, sourceFile, index, recordedAt }) {
  const evidence = textFor(row)
  if (!evidence) return false
  const kind = kindFor(row, sourceFile)
  const occurredAt = timestamp(row, recordedAt)
  const rowHash = sourceHash(sourceFile, index, row)
  const sessionId = `puppet-import-${hash(sourceFile)}`
  if (!sessions.has(sessionId)) sessions.set(sessionId, createSession(sessionId, occurredAt, sourceFile))
  const turnId = `turn_puppet_${rowHash}`
  turns.push(createTurn({
    id: turnId,
    sessionId,
    speaker: 'user',
    text: evidence,
    occurredAt,
    sourceFile,
    sourceRowHash: rowHash,
  }))
  const session = sessions.get(sessionId)
  session.turnCount += 1
  if (new Date(occurredAt) > new Date(session.lastTurnAt)) session.lastTurnAt = occurredAt
  const summary = String(row.note || row.text || row.quote || evidence).trim().slice(0, 240)
  const key = canonicalKey(kind, summary)
  const existing = memoryKeys.get(key)
  if (existing) {
    existing.sourceTurnIds = [...new Set([...existing.sourceTurnIds, turnId])]
    existing.sourceFiles = [...new Set([...existing.sourceFiles, sourceFile])]
    existing.evidence = existing.evidence || evidence.slice(0, 500)
    existing.occurredAt = new Date(existing.occurredAt) <= new Date(occurredAt) ? existing.occurredAt : occurredAt
    existing.lastSeenAt = new Date(existing.lastSeenAt) >= new Date(occurredAt) ? existing.lastSeenAt : occurredAt
    return true
  }
  const importance = importanceFor(row, kind)
  const memory = {
    id: `memory_puppet_${rowHash}`,
    kind,
    recordType: recordType(kind),
    subjectType: subjectType(kind),
    subject: 'user',
    speaker: 'user',
    summary,
    evidence: evidence.slice(0, 500),
    sourceTurnIds: [turnId],
    sourceSessionId: sessionId,
    sourceKind: 'puppet-memory',
    sourceFile,
    sourceRowHash: rowHash,
    sourceFiles: [sourceFile],
    occurredAt,
    recordedAt,
    lastSeenAt: occurredAt,
    lastRecalledAt: null,
    importance,
    strength: importance,
    freshness: 1,
    recallCount: 0,
    confirmedRecallCount: 0,
    reinforcementCount: 0,
    status: statusFor(row, kind),
    factKey: `${sourceFile}:${row.keyword || rowHash}`,
    writePolicy: 'migration',
    writePriority: ['relationship', 'commitment'].includes(kind) ? 'priority' : 'normal',
  }
  memories.push(memory)
  memoryKeys.set(key, memory)
  return true
}

function addDiaryTurns({ diaryRows, sessions, turns, importantRows, recordedAt, sourceFile }) {
  for (const [index, row] of diaryRows.entries()) {
    const occurredAt = timestamp(row, recordedAt)
    const rowHash = sourceHash(sourceFile, index, row)
    const rawSession = String(row.session || row.cwd || 'default')
    const sessionId = `puppet-session-${hash(rawSession)}`
    if (!sessions.has(sessionId)) sessions.set(sessionId, createSession(sessionId, occurredAt, rawSession))
    const session = sessions.get(sessionId)
    const userText = String(row.userFull || row.user || '').trim()
    const assistantText = String(row.assistantFull || row.assistant || '').trim()
    if (userText) {
      turns.push(createTurn({
        id: `turn_puppet_${rowHash}_user`,
        sessionId,
        speaker: 'user',
        text: userText,
        occurredAt,
        sourceFile,
        sourceRowHash: rowHash,
      }))
      session.turnCount += 1
    }
    if (assistantText) {
      turns.push(createTurn({
        id: `turn_puppet_${rowHash}_assistant`,
        sessionId,
        speaker: 'assistant',
        text: assistantText,
        occurredAt,
        sourceFile,
        sourceRowHash: rowHash,
      }))
      session.turnCount += 1
    }
    if (row.important) importantRows.push({ ...row, sourceFile, index })
    if (new Date(occurredAt) > new Date(session.lastTurnAt)) session.lastTurnAt = occurredAt
  }
}

function archiveId(archive) {
  return hash(JSON.stringify({
    sessions: archive.sessions,
    turns: archive.turns,
    memories: archive.memories,
  }))
}

export async function migratePuppetMemory(root, { exportedAt = nowIso() } = {}) {
  const behavior = join(root, 'behavior')
  const sessions = new Map()
  const turns = []
  const memories = []
  const memoryKeys = new Map()
  const importantRows = []
  const recordedAt = exportedAt

  for (const month of ['2026-10', '2026-11']) {
    const rows = await readJsonl(join(behavior, 'diary', `${month}.jsonl`))
    addDiaryTurns({
      diaryRows: rows,
      sessions,
      turns,
      importantRows,
      recordedAt,
      sourceFile: `behavior/diary/${month}.jsonl`,
    })
  }

  const sources = [
    ['behavior/notes.jsonl', await readJsonl(join(behavior, 'notes.jsonl'))],
    ['behavior/relations.jsonl', await readJsonl(join(behavior, 'relations.jsonl'))],
    ['behavior/user.jsonl', await readJsonl(join(behavior, 'user.jsonl'))],
    ['behavior/memo.jsonl', await readJsonl(join(behavior, 'memo.jsonl'))],
  ]
  for (const [sourceFile, rows] of sources) {
    for (const [index, row] of rows.entries()) {
      addMemory({ memories, memoryKeys, sessions, turns, row, sourceFile, index, recordedAt })
    }
  }
  for (const [index, row] of importantRows.entries()) {
    addMemory({
      memories,
      memoryKeys,
      sessions,
      turns,
      row,
      sourceFile: row.sourceFile || 'behavior/diary/important',
      index,
      recordedAt,
    })
  }

  const archive = {
    schema: ARCHIVE_SCHEMA,
    version: 2,
    exportedAt,
    metadata: {
      migratedFrom: PUPPET_MIGRATION_VERSION,
      sourceRoot: relative(process.cwd(), root),
      policy: 'diary-kept-as-evidence; durable rows imported selectively; guide/index excluded to avoid duplicate prompt material',
      sourceFiles: sources.map(([file, rows]) => ({ file, rows: rows.length })),
    },
    sessions: [...sessions.values()],
    turns,
    memories,
  }
  archive.archiveId = archiveId(archive)
  archive.counts = {
    sessions: archive.sessions.length,
    turns: archive.turns.length,
    memories: archive.memories.length,
  }
  return archive
}

export async function writePuppetMigration(root, outputPath, options = {}) {
  const archive = await migratePuppetMemory(root, options)
  await writeJsonAtomic(outputPath, archive)
  return archive
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [root, outputPath] = process.argv.slice(2)
  if (!root || !outputPath) {
    console.error('用法：node src/migrate-puppet-memory.mjs <木偶 memory 目录> <archive.json>')
    process.exit(2)
  }
  const archive = await writePuppetMigration(root, outputPath)
  console.log(JSON.stringify({ archiveId: archive.archiveId, counts: archive.counts }, null, 2))
}
