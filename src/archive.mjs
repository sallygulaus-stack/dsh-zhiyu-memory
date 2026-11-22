import { readFile } from 'node:fs/promises'
import { hash, writeJsonAtomic } from './util.mjs'
import { validateCandidate } from './evidence.mjs'

export const ARCHIVE_SCHEMA = 'dsh-companion-memory/archive@2'
export const ARCHIVE_SCHEMA_V3 = 'dsh-companion-memory/archive@3'
export const LEGACY_ARCHIVE_SCHEMA = 'dsh-companion-memory/archive@1'

function archiveFingerprint({ sessions = [], turns = [], memories = [] }) {
  return hash(JSON.stringify({ sessions, turns, memories }))
}

export function validateArchive(archive) {
  if (!Array.isArray(archive.sessions) || !Array.isArray(archive.turns) || !Array.isArray(archive.memories)) {
    throw new Error('记忆归档校验失败：sessions、turns、memories 必须是数组')
  }
  const sessionIds = archive.sessions.map((item) => item.id)
  const turnIds = archive.turns.map((item) => item.id)
  const memoryIds = archive.memories.map((item) => item.id)
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error('记忆归档校验失败：session id 重复')
  if (new Set(turnIds).size !== turnIds.length) throw new Error('记忆归档校验失败：turn id 重复')
  if (new Set(memoryIds).size !== memoryIds.length) throw new Error('记忆归档校验失败：memory id 重复')
  const sessions = new Set(sessionIds)
  for (const turn of archive.turns) {
    if (!sessions.has(turn.sessionId)) {
      throw new Error(`记忆归档校验失败：turn ${turn.id} 指向不存在的 session`)
    }
  }
  return archive
}

export function buildArchive(store, { exportedAt = new Date().toISOString(), metadata = {} } = {}) {
  const archive = {
    schema: ARCHIVE_SCHEMA_V3,
    version: 3,
    exportedAt,
    metadata,
    sessions: store.listSessions(),
    turns: store.listTurns().map(normalizeTurn),
    memories: store.listMemories()
      .filter((memory) => !['purged', 'export-excluded'].includes(memory.deletionState))
      .map(normalizeMemory),
  }
  archive.archiveId = archiveFingerprint(archive)
  archive.counts = {
    sessions: archive.sessions.length,
    turns: archive.turns.length,
    memories: archive.memories.length,
  }
  return validateArchive(archive)
}

export async function exportArchive(store, path, options = {}) {
  const archive = buildArchive(store, options)
  await writeJsonAtomic(path, archive)
  return archive
}

export function migrateArchive(input) {
  if (!input || typeof input !== 'object') throw new Error('记忆归档必须是 JSON 对象')
  if (input.schema === ARCHIVE_SCHEMA_V3 && input.version === 3) {
    const archive = {
      ...input,
      sessions: Array.isArray(input.sessions) ? input.sessions : [],
      turns: (Array.isArray(input.turns) ? input.turns : []).map(normalizeTurn),
      memories: (Array.isArray(input.memories) ? input.memories : []).map(normalizeMemory),
    }
    const expected = archiveFingerprint(archive)
    if (archive.archiveId && archive.archiveId !== expected) {
      throw new Error('记忆归档校验失败：archiveId 不匹配')
    }
    archive.archiveId = expected
    return validateArchive(archive)
  }
  if (input.schema === ARCHIVE_SCHEMA && input.version === 2) {
    const archive = {
      ...input,
      sessions: Array.isArray(input.sessions) ? input.sessions : [],
      turns: (Array.isArray(input.turns) ? input.turns : []).map(normalizeTurn),
      memories: (Array.isArray(input.memories) ? input.memories : []).map(normalizeMemory),
    }
    const expected = archiveFingerprint(archive)
    if (archive.archiveId && archive.archiveId !== expected) {
      throw new Error('记忆归档校验失败：archiveId 不匹配')
    }
    archive.archiveId = expected
    const migrationCounts = { accepted: 0, quarantined: 0, rejected: 0, needsReview: 0 }
    const migratedMemories = archive.memories.map((memory) => {
      const hasReliableLegacySpan = Array.isArray(memory.evidenceRefs) && memory.evidenceRefs.length > 0
      if (!hasReliableLegacySpan) {
        migrationCounts.quarantined += 1
        return {
          ...memory,
          epistemicStatus: 'candidate',
          visibility: 'evidence-only',
          deletionState: memory.deletionState || 'live',
          migrationStatus: 'quarantined',
          migrationReason: 'legacy-span-speaker-polarity-unverified',
          claimKey: String(memory.claimKey || memory.factKey || '').trim(),
          lastSupportedAt: memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt || memory.recordedAt,
          lastReinforcedAt: memory.lastReinforcedAt || null,
        }
      }
      const validation = validateCandidate(memory, {
        turns: archive.turns,
        recordedAt: memory.recordedAt || archive.exportedAt,
      })
      if (!validation.ok) {
        migrationCounts.rejected += 1
        return {
          ...memory,
          epistemicStatus: 'rejected',
          visibility: 'evidence-only',
          deletionState: 'live',
          migrationStatus: 'rejected',
          migrationReason: validation.reason,
          lastSupportedAt: memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt || memory.recordedAt,
          lastReinforcedAt: memory.lastReinforcedAt || null,
        }
      }
      const epistemicStatus = hasReliableLegacySpan ? 'supported' : 'candidate'
      const visibility = hasReliableLegacySpan ? 'recallable' : 'evidence-only'
      if (hasReliableLegacySpan) migrationCounts.needsReview += 1
      else migrationCounts.quarantined += 1
      return {
        ...memory,
        ...validation.candidate,
        epistemicStatus,
        visibility,
        deletionState: memory.deletionState || 'live',
        migrationStatus: hasReliableLegacySpan ? 'needs-review' : 'quarantined',
        claimKey: String(memory.claimKey || memory.factKey || '').trim(),
        factKey: String(memory.claimKey || memory.factKey || '').trim(),
        lastSupportedAt: memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt || memory.recordedAt,
        lastReinforcedAt: memory.lastReinforcedAt || null,
      }
    })
    const migrated = {
      ...archive,
      schema: ARCHIVE_SCHEMA_V3,
      version: 3,
      metadata: { ...(archive.metadata || {}), migratedFrom: archive.metadata?.migratedFrom || ARCHIVE_SCHEMA },
      memories: migratedMemories,
      migrationReport: migrationCounts,
      counts: {
        sessions: archive.sessions.length,
        turns: archive.turns.length,
        memories: archive.memories.length,
      },
    }
    migrated.archiveId = archiveFingerprint(migrated)
    return validateArchive(migrated)
  }
  if (input.schema === LEGACY_ARCHIVE_SCHEMA && input.version === 1) {
    const legacy = {
      ...input,
      sessions: Array.isArray(input.sessions) ? input.sessions : [],
      turns: Array.isArray(input.turns) ? input.turns : [],
      memories: Array.isArray(input.memories) ? input.memories : [],
    }
    const legacyExpected = archiveFingerprint(legacy)
    if (legacy.archiveId && legacy.archiveId !== legacyExpected) {
      throw new Error('记忆归档校验失败：archiveId 不匹配')
    }
    const archive = {
      schema: ARCHIVE_SCHEMA,
      version: 2,
      exportedAt: legacy.exportedAt || new Date().toISOString(),
      metadata: { ...(legacy.metadata || {}), migratedFrom: LEGACY_ARCHIVE_SCHEMA },
      sessions: legacy.sessions,
      turns: legacy.turns.map(normalizeTurn),
      memories: legacy.memories.map(normalizeMemory),
    }
    archive.archiveId = archiveFingerprint(archive)
    archive.counts = {
      sessions: archive.sessions.length,
      turns: archive.turns.length,
      memories: archive.memories.length,
    }
    return migrateArchive(archive)
  }
  if (!input.schema && (Array.isArray(input.sessions) || Array.isArray(input.turns) || Array.isArray(input.memories))) {
    const archive = {
      schema: ARCHIVE_SCHEMA,
      version: 2,
      exportedAt: new Date().toISOString(),
      metadata: { migratedFrom: 'unversioned-snapshot' },
      sessions: input.sessions ?? [],
      turns: (input.turns ?? []).map(normalizeTurn),
      memories: (input.memories ?? []).map(normalizeMemory),
    }
    archive.archiveId = archiveFingerprint(archive)
    return validateArchive(archive)
  }
  throw new Error(`不支持的记忆归档格式：${input.schema || 'unknown'}@${input.version || 'unknown'}`)
}

export async function importArchive(store, source) {
  const raw = typeof source === 'string'
    ? JSON.parse(await readFile(source, 'utf8'))
    : source
  const archive = migrateArchive(raw)
  if (store.hasImportedArchive(archive.archiveId)) {
    return { ...archive, imported: false, status: 'duplicate' }
  }
  await store.replaceSnapshot(archive)
  await store.markArchiveImported(archive.archiveId)
  return { ...archive, imported: true, status: 'imported' }
}

function normalizeTurn(turn) {
  const occurredAt = turn.occurredAt || turn.createdAt || turn.recordedAt || new Date().toISOString()
  const recordedAt = turn.recordedAt || turn.createdAt || occurredAt
  return {
    ...turn,
    occurredAt,
    recordedAt,
    createdAt: turn.createdAt || occurredAt,
  }
}

function normalizeMemory(memory) {
  const occurredAt = memory.occurredAt || memory.createdAt || memory.recordedAt || new Date().toISOString()
  const recordedAt = memory.recordedAt || memory.createdAt || occurredAt
  return {
    ...memory,
    occurredAt,
    recordedAt,
    lastSeenAt: memory.lastSeenAt || occurredAt,
    lastSupportedAt: memory.lastSupportedAt || memory.lastSeenAt || occurredAt,
    lastReinforcedAt: memory.lastReinforcedAt || null,
    lastRecalledAt: memory.lastRecalledAt || null,
    recallCount: Number(memory.recallCount || 0),
    confirmedRecallCount: Number(memory.confirmedRecallCount ?? memory.recallCount ?? 0),
    reinforcementCount: Number(memory.reinforcementCount || 0),
  }
}
