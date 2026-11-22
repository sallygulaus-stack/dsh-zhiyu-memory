import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendJsonl, ensureDir, hash, readJsonl, readJsonlOrArray, writeJsonAtomic, writeJsonlAtomic, nowIso } from './util.mjs'

export class ResearchStore {
  constructor(root) {
    this.root = root
    this.files = {
      sessions: join(root, 'sessions.jsonl'),
      turns: join(root, 'turns.jsonl'),
      memories: join(root, 'memories.jsonl'),
      memoryEvents: join(root, 'memory-events.jsonl'),
      retrievals: join(root, 'retrievals.jsonl'),
      metrics: join(root, 'metrics.jsonl'),
      results: join(root, 'results.jsonl'),
      meta: join(root, 'meta.json'),
    }
    this.memoryMap = new Map()
    this.memoryEvents = []
    this.purgedTurnIds = new Set()
    this.sessions = new Map()
    this.turns = []
    this.meta = {}
  }

  async init(meta = {}) {
    await ensureDir(this.root)
    this.meta = await this.readMeta()
    const memories = await readJsonlOrArray(this.files.memories)
    for (const memory of memories) this.memoryMap.set(memory.id, normalizeMemory(memory))
    const sessions = await readJsonl(this.files.sessions)
    for (const session of sessions) this.sessions.set(session.id, session)
    this.turns = (await readJsonl(this.files.turns)).map(normalizeTurn)
    this.memoryEvents = await readJsonl(this.files.memoryEvents)
    this.purgedTurnIds = new Set(this.memoryEvents.flatMap((event) => event.type === 'purge'
      ? (Array.isArray(event.purgedTurnIds) ? event.purgedTurnIds : [])
      : []))
    if (!(await this.hasMeta())) {
      this.meta = { createdAt: nowIso(), ...meta }
      await this.saveMeta()
    }
    return this
  }

  async readMeta() {
    try {
      return JSON.parse(await readFile(this.files.meta, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
  }

  async saveMeta(patch = {}) {
    this.meta = { ...this.meta, ...patch }
    await writeJsonAtomic(this.files.meta, this.meta)
    return this.meta
  }

  async hasMeta() {
    try {
      await access(this.files.meta)
      return true
    } catch {
      return false
    }
  }

  async saveSession(session) {
    this.sessions.set(session.id, session)
    await appendJsonl(this.files.sessions, session)
    await this.refreshIntegrityMetadata()
  }

  async saveTurn(turn) {
    const normalized = normalizeTurn(turn)
    await appendJsonl(this.files.turns, normalized)
    this.turns.push(normalized)
    const session = this.sessions.get(turn.sessionId)
    if (session) {
      session.lastTurnAt = normalized.occurredAt
      session.turnCount = (session.turnCount || 0) + 1
      await this.saveSession(session)
    }
    await this.refreshIntegrityMetadata()
  }

  async upsertMemory(memory, event = {}) {
    const normalized = normalizeMemory(memory)
    this.memoryMap.set(normalized.id, normalized)
    const current = [...this.memoryMap.values()]
    await writeJsonAtomic(this.files.memories, current)
    const eventRow = {
      createdAt: nowIso(),
      type: event.type || 'upsert',
      memoryId: normalized.id,
      event,
    }
    if (event.includeMemory !== false) eventRow.memory = normalized
    await appendJsonl(this.files.memoryEvents, eventRow)
    this.memoryEvents.push(eventRow)
    await this.refreshIntegrityMetadata()
    return normalized
  }

  async recordMemoryEvent(event) {
    const row = { createdAt: nowIso(), ...event }
    await appendJsonl(this.files.memoryEvents, row)
    this.memoryEvents.push(row)
    return row
  }

  async recordRetrieval(record) {
    await appendJsonl(this.files.retrievals, { createdAt: nowIso(), ...record })
  }

  async recordMetric(metric) {
    await appendJsonl(this.files.metrics, { createdAt: nowIso(), ...metric })
  }

  async recordResult(result) {
    await appendJsonl(this.files.results, { createdAt: nowIso(), ...result })
  }

  async writeCurrentFiles() {
    await writeJsonlAtomic(this.files.sessions, [...this.sessions.values()])
    await writeJsonlAtomic(this.files.turns, this.turns)
    await writeJsonAtomic(this.files.memories, [...this.memoryMap.values()])
  }

  snapshot() {
    return {
      sessions: [...this.sessions.values()],
      turns: [...this.turns],
      memories: [...this.memoryMap.values()],
    }
  }

  snapshotHash(snapshot = this.snapshot()) {
    return hash(JSON.stringify(snapshot))
  }

  async refreshIntegrityMetadata() {
    await this.saveMeta({
      snapshotSchema: 'dsh-companion-memory/snapshot@1',
      snapshotHash: this.snapshotHash(),
      snapshotUpdatedAt: nowIso(),
    })
  }

  async replaceSnapshot({ sessions = [], turns = [], memories = [] } = {}) {
    const previous = this.snapshot()
    const previousMeta = { ...this.meta }
    this.sessions = new Map(sessions.map((session) => [session.id, session]))
    this.turns = turns.map(normalizeTurn)
    this.memoryMap = new Map(memories.map((memory) => {
      const normalized = normalizeMemory(memory)
      return [normalized.id, normalized]
    }))
    try {
      await this.writeCurrentFiles()
      await this.refreshIntegrityMetadata()
    } catch (error) {
      this.sessions = new Map(previous.sessions.map((session) => [session.id, session]))
      this.turns = [...previous.turns]
      this.memoryMap = new Map(previous.memories.map((memory) => [memory.id, memory]))
      this.meta = previousMeta
      await this.writeCurrentFiles()
      await this.saveMeta()
      throw error
    }
    return this
  }

  async forgetMemory(memoryId, { hard = false, mode = null, reason = 'user-request' } = {}) {
    const memory = this.memoryMap.get(memoryId)
    if (!memory) throw new Error(`找不到记忆 ${memoryId}`)
    const deletionMode = mode || (hard ? 'purge' : 'soft-delete')
    if (deletionMode !== 'purge') {
      if (!['soft-delete', 'recall-block', 'export-exclude'].includes(deletionMode)) {
        throw new Error(`无效的删除模式：${deletionMode}`)
      }
      memory.deletionState = deletionMode === 'soft-delete'
        ? 'soft-deleted'
        : deletionMode === 'recall-block'
          ? 'recall-blocked'
          : 'export-excluded'
      if (deletionMode === 'soft-delete') memory.status = 'deleted'
      if (deletionMode === 'recall-block') memory.visibility = 'hidden'
      memory.deletedAt = nowIso()
      memory.deletedReason = String(reason).slice(0, 200)
      await this.upsertMemory(memory, { type: deletionMode, reason, includeMemory: false })
      return { ...memory, deleted: true, purged: false }
    }
    if (!memory.sandboxOwned) {
      throw new Error('purge is limited to claims created and owned in this isolated sandbox')
    }
    memory.deletionState = 'purged'
    this.memoryMap.delete(memoryId)
    await writeJsonAtomic(this.files.memories, [...this.memoryMap.values()])
    const events = await readJsonl(this.files.memoryEvents)
    await writeJsonlAtomic(
      this.files.memoryEvents,
      events.filter((event) => event.memoryId !== memoryId),
    )
    this.memoryEvents = events.filter((event) => event.memoryId !== memoryId)
    const stillReferenced = new Set([...this.memoryMap.values()]
      .flatMap((item) => Array.isArray(item.sourceTurnIds) ? item.sourceTurnIds : []))
    const purgedTurnIds = (Array.isArray(memory.sourceTurnIds) ? memory.sourceTurnIds : [])
      .filter((turnId) => !stillReferenced.has(turnId))
    for (const turnId of purgedTurnIds) this.purgedTurnIds.add(turnId)
    const purgeEvent = {
      createdAt: nowIso(),
      type: 'purge',
      memoryId,
      reason: String(reason).slice(0, 200),
      purgedTurnIds,
    }
    await appendJsonl(this.files.memoryEvents, purgeEvent)
    this.memoryEvents.push(purgeEvent)
    await this.refreshIntegrityMetadata()
    // 对外语义：只清 claim 级数据。原始 turns、已有归档和备份都还在，
    // 所以不能把 purged===true 读成「全链路擦除」。
    return {
      id: memoryId,
      deleted: true,
      purged: true,
      purgeScope: 'claim-only',
      retained: ['turns', 'archives', 'backups'],
    }
  }

  async restoreMemory(memoryId) {
    const memory = this.memoryMap.get(memoryId)
    if (!memory) throw new Error(`找不到记忆 ${memoryId}`)
    if (memory.status !== 'deleted' && !memory.deletionState) return memory
    delete memory.deletedAt
    delete memory.deletedReason
    delete memory.deletionState
    if (memory.visibility === 'hidden') memory.visibility = 'recallable'
    memory.status = memory.kind === 'commitment' ? 'open' : 'active'
    await this.upsertMemory(memory, { type: 'restore' })
    return memory
  }

  async markArchiveImported(archiveId) {
    const ids = new Set(Array.isArray(this.meta.importedArchiveIds) ? this.meta.importedArchiveIds : [])
    ids.add(String(archiveId))
    await this.saveMeta({ importedArchiveIds: [...ids] })
    return [...ids]
  }

  hasImportedArchive(archiveId) {
    return Array.isArray(this.meta.importedArchiveIds)
      && this.meta.importedArchiveIds.includes(String(archiveId))
  }

  async integrityCheck() {
    const errors = []
    let sessions = []
    let turns = []
    let memories = []
    try {
      sessions = await readJsonl(this.files.sessions)
      turns = await readJsonl(this.files.turns)
      memories = await readJsonlOrArray(this.files.memories)
    } catch (error) {
      errors.push(`数据文件无法解析：${String(error?.message || error)}`)
    }
    const sessionIds = new Set(sessions.map((item) => item.id))
    const turnIds = turns.map((item) => item.id)
    const memoryIds = memories.map((item) => item.id)
    if (new Set(turnIds).size !== turnIds.length) errors.push('turns 存在重复 id')
    if (new Set(memoryIds).size !== memoryIds.length) errors.push('memories 存在重复 id')
    for (const turn of turns) {
      if (!sessionIds.has(turn.sessionId)) errors.push(`turn ${turn.id} 指向不存在的 session ${turn.sessionId}`)
    }
    const snapshot = {
      sessions: [...new Map(sessions.map((session) => [session.id, session])).values()],
      turns,
      memories,
    }
    const currentHash = this.snapshotHash(snapshot)
    if (this.meta.snapshotHash && this.meta.snapshotHash !== currentHash) {
      errors.push('snapshotHash 与数据文件不一致')
    }
    return {
      ok: errors.length === 0,
      errors,
      warnings: [],
      snapshotHash: currentHash,
      counts: {
        sessions: new Set(sessions.map((item) => item.id)).size,
        turns: turns.length,
        memories: memories.length,
      },
    }
  }

  async repairIntegrity() {
    await this.writeCurrentFiles()
    await this.refreshIntegrityMetadata()
    return this.integrityCheck()
  }

  async metricSummary() {
    const rows = await readJsonl(this.files.metrics)
    const recalls = rows.filter((row) => row.kind === 'recall')
    const modelCalls = rows.filter((row) => row.kind === 'model-call')
    const jsonErrors = rows.reduce((sum, row) => (
      sum + Number(row.jsonErrors || 0) + (row.kind === 'model-call-error' && row.jsonError ? 1 : 0)
    ), 0)
    const evidenceRejected = rows.reduce((sum, row) => sum + (Number(row.evidenceRejected) || 0), 0)
    const suppressedWrites = rows.filter((row) => row.kind === 'write-suppressed')
    const average = (items, field) => items.length
      ? items.reduce((sum, item) => sum + (Number(item[field]) || 0), 0) / items.length
      : 0
    return {
      rows: rows.length,
      recalls: recalls.length,
      averageRecallMs: Number(average(recalls, 'durationMs').toFixed(2)),
      recallChars: recalls.reduce((sum, item) => sum + (Number(item.injectedChars) || 0), 0),
      modelCalls: modelCalls.length,
      modelTokens: modelCalls.reduce((sum, item) => sum + (Number(item.totalTokens) || 0), 0),
      jsonErrors,
      evidenceRejected,
      suppressedWrites: suppressedWrites.length,
      estimatedCostUsd: Number(rows.reduce((sum, item) => sum + (Number(item.estimatedCostUsd) || 0), 0).toFixed(8)),
    }
  }

  listMemories() {
    return [...this.memoryMap.values()]
  }

  listSessions() {
    return [...this.sessions.values()]
  }

  listTurns() {
    return [...this.turns]
  }
}

function normalizeTurn(turn) {
  const occurredAt = turn.occurredAt || turn.createdAt || turn.recordedAt || nowIso()
  const recordedAt = turn.recordedAt || turn.createdAt || occurredAt
  return {
    ...turn,
    occurredAt,
    recordedAt,
    // Keep the old field as a compatibility alias for existing readers.
    createdAt: turn.createdAt || occurredAt,
  }
}

function normalizeMemory(memory) {
  const occurredAt = memory.occurredAt || memory.createdAt || memory.recordedAt || nowIso()
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
