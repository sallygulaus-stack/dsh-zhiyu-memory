import { id, clamp, lexicalScore, normalizeText, joinLines } from './util.mjs'
import {
  buildEvidenceRef,
  isRecallable,
  localDateEndIso,
  sha256,
  stableCandidateFingerprint,
  validateCandidate,
} from './evidence.mjs'

const RECENT_HOURS = 72
const MIN_RECALL_SCORE = 0.12
const COMMITMENT_STATUSES = new Set(['open', 'done', 'cancelled', 'expired', 'stale'])
const DECAY_HALF_LIFE_HOURS = Object.freeze({
  relationship: 24 * 180,
  preference: 24 * 90,
  fact: 24 * 45,
  commitment: 24 * 60,
  event: 24 * 21,
  emotion: 24 * 14,
})
const DAILY_MEMORY_HALF_LIFE_HOURS = 48
const DAILY_MEMORY_RETENTION_DAYS = 7

const LOW_VALUE_TURNS = /^(你好|嗨|哈[哈呵]+|嗯+|哦+|好的?|好呀|收到|谢谢|谢了|晚安|早安|ok|okay)$/iu
const SEMANTIC_HISTORY_QUERY = /(上次|以前|之前|那次|记得|共同|经历|当时|曾经|换个说法|有关)/u
const MEMORY_META_QUERY = /(companion_memory|使用.*(记忆|recall|remember|consolidate)|测试数据|不要编造|只根据.*记忆)/iu
const DAILY_EVENT = /(?:(?:今天|今晚|明天|刚才|待会|这两天|最近).{0,24}(?:一起|我们|咱们|看|吃|喝|聊|玩|等|追|做|发射|比赛|直播|电影|饭|饺子))|(?:(?:一起|我们|咱们).{0,18}(?:看|吃|喝|聊|玩|等|追|做|去|守着|等着))/u

function kindFor(text, speaker) {
  const value = String(text)
  if (speaker === 'user' && MEMORY_META_QUERY.test(value)) return null
  const isQuestion = /[?？]\s*$/u.test(value)
    || /^(你还记得|你记得|应该怎么|怎么组织|是什么|是否|能不能|可以吗|为什么|什么时候|哪一个|哪些)/u.test(value.trim())
  if (isQuestion) return null
  if (speaker === 'user'
    && DAILY_EVENT.test(value)
    && !/(请记得|请记住|记得|别忘|答应|承诺|提醒)/u.test(value)) return 'event'
  if (speaker === 'assistant' && /(我会|我答应|我记住|下次我|我会把)/u.test(value)) return 'commitment'
  if (speaker === 'user' && /(答应|承诺|请记得|别忘|下次|要不要提醒|回来告诉|我会|我准备|计划|今晚会|明天要)/u.test(value)) return 'commitment'
  if (/(喜欢|不喜欢|讨厌|偏好|习惯|称呼|叫我|希望你|不要叫)/u.test(value)
    || (/(改了|改成|现在)/u.test(value) && /(结论|证据|报告|背景|格式|称呼|喜欢|偏好)/u.test(value))) return 'preference'
  if (/(难过|开心|生气|焦虑|累|害怕|失眠|委屈|想你|想念)/u.test(value)) return 'emotion'
  if (/(我们|一起|那天|上次|第一次|纪念|发生)/u.test(value)) return 'relationship'
  return speaker === 'user' ? 'fact' : 'event'
}

function recordTypeFor(kind) {
  if (kind === 'commitment') return 'commitment'
  if (kind === 'relationship' || kind === 'emotion' || kind === 'event') return 'event'
  return 'entity'
}

function subjectTypeFor(kind) {
  if (kind === 'relationship') return 'relationship'
  if (kind === 'emotion') return 'person-state'
  if (kind === 'commitment') return 'agreement'
  return 'person'
}

function shouldWrite(text, speaker, kind) {
  const value = String(text).trim()
  if (!value || LOW_VALUE_TURNS.test(value)) return false
  if (speaker === 'assistant') return kind === 'commitment'
  if (kind !== 'fact') return true
  return /(我|我的|我叫|我是|今天|昨天|明天|最近|正在|已经|准备|计划|住在|来自|工作|学习|发生)/u.test(value)
}

function importanceFor(kind, text) {
  let score = kind === 'commitment' || kind === 'relationship' ? 0.85 : 0.55
  if (/(重要|一直|永远|最|第一次|答应|不能忘)/u.test(text)) score += 0.1
  if (text.length > 80) score += 0.05
  return clamp(score)
}

function isDailyMemory(kind, text) {
  return kind === 'event' && DAILY_EVENT.test(String(text))
}

function dailyExpiresAt(occurredAt) {
  const value = new Date(occurredAt)
  if (Number.isNaN(value.getTime())) return null
  value.setUTCDate(value.getUTCDate() + DAILY_MEMORY_RETENTION_DAYS)
  return value.toISOString()
}

function shouldPromoteDaily(memory, candidate) {
  if (memory.retentionClass !== 'daily') return false
  if (candidate.retentionClass !== 'daily') return true
  const sessions = new Set([
    ...(memory.supportSessionIds || []),
    memory.sourceSessionId,
    candidate.sourceSessionId,
  ].filter(Boolean))
  const dates = new Set([
    ...(memory.supportDates || []),
    dayKey(memory.occurredAt),
    dayKey(candidate.occurredAt),
  ].filter(Boolean))
  return sessions.size >= 2 || (dates.size >= 2 && Number(memory.reinforcementCount || 0) >= 2)
}

function keyFor(kind, text) {
  if (kind === 'preference') {
    if (/(结论|证据|报告|背景|格式|组织|呈现|先看)/u.test(text)) return 'preference:response-format'
    if (/(称呼|叫我|名字)/u.test(text)) return 'preference:address'
    if (/(喜欢|不喜欢|讨厌).*(吃|喝|食物|颜色|音乐|游戏)/u.test(text)) return 'preference:taste'
  }
  const normalized = normalizeText(text)
    .replace(/(我|你|她|他|我们|以后|现在|今天|最近|请|希望|记得|别忘了)/gu, '')
    .replace(/[，。！？、,.!?：:；;]/gu, ' ')
    .trim()
  return `${kind}:${normalized.slice(0, 90)}`
}

function freshness(memory, now) {
  const seenAt = new Date(memory.lastReinforcedAt || memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt || memory.recordedAt).getTime()
  const ageHours = Math.max(0, (new Date(now).getTime() - seenAt) / 3_600_000)
  const halfLife = memory.retentionClass === 'daily'
    ? DAILY_MEMORY_HALF_LIFE_HOURS
    : decayHalfLifeHours(memory.kind)
  return clamp(Math.pow(0.5, ageHours / halfLife), 0.02, 1)
}

export function decayHalfLifeHours(kind) {
  return DECAY_HALF_LIFE_HOURS[kind] ?? DECAY_HALF_LIFE_HOURS.fact
}

export function memoryStrength(memory, now) {
  const seenAt = new Date(memory.lastReinforcedAt || memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt).getTime()
  const nowAt = new Date(now).getTime()
  const ageHours = Math.max(0, (nowAt - seenAt) / 3_600_000)
  const base = clamp(memory.strength ?? memory.importance, 0.05, 1)
  const confirmedRecalls = Number(memory.confirmedRecallCount ?? memory.recallCount ?? 0)
  const rehearsals = confirmedRecalls + Number(memory.reinforcementCount || 0)
  const rehearsalBoost = Math.min(0.35, Math.log2(rehearsals + 1) * 0.08)
  const halfLife = memory.retentionClass === 'daily'
    ? DAILY_MEMORY_HALF_LIFE_HOURS
    : decayHalfLifeHours(memory.kind)
  return clamp((base + rehearsalBoost) * Math.pow(0.5, ageHours / halfLife), 0, 1)
}

function dueAtFor(text, occurredAt, timeZone = 'UTC') {
  const base = new Date(occurredAt)
  if (Number.isNaN(base.getTime())) return null
  if (/今晚/u.test(text)) return localDateEndIso(base.toISOString(), timeZone)
  if (/后天/u.test(text)) return localDateEndIso(base.toISOString(), timeZone, 2)
  if (/明天/u.test(text)) return localDateEndIso(base.toISOString(), timeZone, 1)
  return null
}

export function freshnessScore(memory, now) {
  return freshness(memory, now)
}

export class CompanionMemory {
  constructor({
    store,
    llm = null,
    clock = () => new Date(),
    dailyWriteBudget = 24,
    semanticThreshold = 0.18,
    semanticHistoryQuery = SEMANTIC_HISTORY_QUERY,
    modelCost = {},
    timezone = 'UTC',
  }) {
    this.store = store
    this.llm = llm
    this.clock = clock
    this.dailyWriteBudget = Number(dailyWriteBudget)
    this.semanticThreshold = Number(semanticThreshold)
    this.semanticHistoryQuery = semanticHistoryQuery
    this.timezone = timezone
    this.modelCost = {
      inputPerMillion: Number(modelCost.inputPerMillion || 0),
      outputPerMillion: Number(modelCost.outputPerMillion || 0),
    }
  }

  async createSession({ title = 'research session', parentSessionId = null } = {}) {
    const session = {
      id: id('session'),
      title,
      parentSessionId,
      createdAt: this.clock().toISOString(),
      lastTurnAt: null,
      turnCount: 0,
    }
    await this.store.saveSession(session)
    return session
  }

  async ingestTurn({
    sessionId,
    speaker,
    text,
    turnId = id('turn'),
    sourceKey = null,
    turnIndex = 0,
    occurredAt = this.clock().toISOString(),
    recordedAt = this.clock().toISOString(),
    writePriority = null,
  }) {
    if (!['user', 'assistant', 'system', 'external'].includes(speaker)) {
      throw new Error(`invalid turn speaker: ${speaker}`)
    }
    const rawText = String(text)
    const turn = {
      id: turnId,
      sessionId,
      speaker,
      text: rawText,
      sourceKey,
      contentHash: sha256(rawText),
      turnIndex,
      occurredAt,
      recordedAt,
      createdAt: occurredAt,
    }
    await this.store.saveTurn(turn)
    const candidate = this.extractCandidate(turn)
    if (candidate) {
      candidate.writePriority = writePriority
        || (['commitment', 'relationship'].includes(candidate.kind) ? 'priority' : 'normal')
      const memory = await this.remember(candidate)
      return { turn, candidate, memory, suppressed: !memory }
    }
    return { turn, candidate: null, memory: null, suppressed: false }
  }

  async rememberText({ sessionId, text, turnIndex = 0, occurredAt = this.clock().toISOString() }) {
    return this.ingestTurn({
      sessionId,
      speaker: 'user',
      text,
      turnIndex,
      occurredAt,
      writePriority: 'priority',
    })
  }

  extractCandidate(turn) {
    const text = turn.text.trim()
    if (!text || text.length < 4) return null
    const kind = kindFor(text, turn.speaker)
    if (!kind) return null
    if (!shouldWrite(text, turn.speaker, kind)) return null
    const important = importanceFor(kind, text)
    const candidate = {
      id: id('memory'),
      kind,
      recordType: recordTypeFor(kind),
      subjectType: subjectTypeFor(kind),
      subject: turn.speaker,
      speaker: turn.speaker,
      summary: text.slice(0, 240),
      evidence: text.slice(0, 500),
      sourceTurnIds: [turn.id],
      sourceSessionId: turn.sessionId,
      sourceKind: 'turn',
      sandboxOwned: true,
      occurredAt: turn.createdAt,
      recordedAt: turn.recordedAt,
      lastSeenAt: turn.createdAt,
      lastSupportedAt: turn.createdAt,
      lastReinforcedAt: null,
      lastRecalledAt: null,
      importance: important,
      strength: important,
      retentionClass: isDailyMemory(kind, text) ? 'daily' : 'durable',
      dailyExpiresAt: isDailyMemory(kind, text) ? dailyExpiresAt(turn.createdAt) : null,
      promotionScore: isDailyMemory(kind, text) ? 0.25 : 1,
      promotionState: isDailyMemory(kind, text) ? 'watching' : 'durable',
      supportSessionIds: [turn.sessionId],
      supportDates: [dayKey(turn.createdAt)],
      recallCount: 0,
      confirmedRecallCount: 0,
      reinforcementCount: 0,
      freshness: 1,
      emotion: kind === 'emotion' ? text.slice(0, 120) : null,
      relationshipWeight: kind === 'relationship' ? 0.9 : 0.2,
      status: kind === 'commitment' ? 'open' : 'active',
      dueAt: kind === 'commitment' ? dueAtFor(text, turn.createdAt, this.timezone) : null,
      factKey: keyFor(kind, text),
      aliases: [],
      source: `${turn.sessionId}/${turn.turnIndex}`,
      writePolicy: 'local-signal',
    }
    const validation = validateCandidate(candidate, {
      turns: [turn],
      recordedAt: turn.recordedAt,
    })
    if (validation.ok) {
      Object.assign(candidate, {
        claimType: validation.candidate.claimType,
        authority: validation.candidate.authority,
        polarity: validation.candidate.polarity,
        modality: validation.candidate.modality,
        epistemicStatus: validation.candidate.epistemicStatus,
        visibility: validation.candidate.visibility,
        deletionState: validation.candidate.deletionState,
        evidenceRefs: validation.candidate.evidenceRefs,
      })
    }
    return candidate
  }

  async remember(candidate) {
    const priority = candidate.writePriority
      || (['commitment', 'relationship'].includes(candidate.kind) ? 'priority' : 'normal')
    candidate.writePriority = priority
    if (candidate.status === 'review') {
      return this.store.upsertMemory(candidate, { type: 'candidate-review', reason: 'accepted-claim-conflict' })
    }
    const existing = this.store.listMemories()
      .filter((memory) => {
        if (memory.status === 'superseded' || memory.kind !== candidate.kind || memory.speaker !== candidate.speaker) return false
        if (!candidate.factKey || !memory.factKey) return false
        return memory.factKey === candidate.factKey
          || lexicalScore(memory.summary, candidate.summary) >= 0.45
      })
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))[0]

    if (existing) {
      const same = normalizeText(existing.summary) === normalizeText(candidate.summary)
        || (existing.factKey === candidate.factKey
          && existing.polarity === candidate.polarity
          && existing.modality === candidate.modality
          && lexicalScore(existing.summary, candidate.summary) >= 0.4
          && !/(改成|改为|不再|现在不|以前.*现在)/u.test(candidate.summary))
      if (same) {
        const sourceTurnIds = new Set(existing.sourceTurnIds || [])
        const newEvidence = (candidate.sourceTurnIds || []).some((turnId) => !sourceTurnIds.has(turnId))
        existing.lastSeenAt = candidate.lastSeenAt
        existing.lastSupportedAt = candidate.lastSupportedAt || candidate.lastSeenAt
        existing.freshness = 1
        existing.evidence = candidate.evidence
        existing.sourceTurnIds = [...new Set([...(existing.sourceTurnIds || []), ...(candidate.sourceTurnIds || [])])]
        existing.evidenceRefs = [...(existing.evidenceRefs || []), ...(candidate.evidenceRefs || [])]
        if (newEvidence) {
          existing.reinforcementCount = Number(existing.reinforcementCount || 0) + 1
          existing.supportSessionIds = [...new Set([
            ...(existing.supportSessionIds || []),
            existing.sourceSessionId,
            candidate.sourceSessionId,
          ].filter(Boolean))]
          existing.supportDates = [...new Set([
            ...(existing.supportDates || []),
            dayKey(existing.occurredAt),
            dayKey(candidate.occurredAt),
          ].filter(Boolean))]
          if (existing.retentionClass === 'daily') {
            existing.promotionScore = clamp(
              Number(existing.promotionScore || 0.25)
                + (existing.supportSessionIds.length > 1 ? 0.4 : 0.2),
            )
          }
        }
        if (newEvidence && shouldPromoteDaily(existing, candidate)) {
          existing.retentionClass = 'durable'
          existing.dailyExpiresAt = null
          existing.promotionState = 'promoted'
          existing.promotedAt = this.clock().toISOString()
          existing.promotionReason = candidate.retentionClass === 'daily'
            ? 'cross-session-or-cross-day-rehearsal'
            : 'later-durable-evidence'
          existing.importance = Math.max(Number(existing.importance || 0), 0.72)
          existing.strength = Math.max(Number(existing.strength || 0), existing.importance)
          await this.store.upsertMemory(existing, {
            type: 'promote',
            reason: existing.promotionReason,
          })
          return existing
        }
        await this.store.upsertMemory(existing, { type: 'refresh', source: candidate.source })
        return existing
      }
      if (priority === 'normal' && existing.writePriority === 'priority') {
        await this.store.recordMetric({
          kind: 'write-suppressed',
          memoryKind: candidate.kind,
          priority,
          reason: 'priority-memory-protected',
          protectedMemoryId: existing.id,
        })
        return existing
      }
      existing.status = 'superseded'
      await this.store.upsertMemory(existing, {
        type: 'supersede',
        supersededBy: candidate.id,
        reason: 'same fact key received a newer statement',
      })
      candidate.supersedes = existing.id
    }
    candidate.writePriority = priority
    if (priority === 'normal' && this.dailyWriteBudget >= 0) {
      const date = dayKey(candidate.recordedAt || this.clock().toISOString())
      const normalCreates = this.store.memoryEvents.filter((event) => (
        event.type === 'create'
        && dayKey(event.createdAt) === date
        && (event.event?.writePriority || event.event?.priority || 'normal') === 'normal'
      )).length
      if (normalCreates >= this.dailyWriteBudget) {
        await this.store.recordMetric({
          kind: 'write-suppressed',
          date,
          budget: this.dailyWriteBudget,
          memoryKind: candidate.kind,
          priority,
          reason: 'daily-soft-budget',
        })
        return null
      }
    }
    return this.store.upsertMemory(candidate, { type: 'create', writePriority: priority })
  }

  async retrieve(query, { sessionId = null, topK = 8, now = this.clock().toISOString() } = {}) {
    const startedAt = Date.now()
    const commitmentIntent = /(承诺|答应|要求.*记住|要求.*原则|别忘|记得|上次.*原则|未完成|还没完成)/u.test(String(query))
    const relationshipIntent = /(我们|共同|关系|那次|上次发生|修复)/u.test(String(query))
    const memories = this.store.listMemories()
      .filter((memory) => !['superseded', 'deleted'].includes(memory.status))
      .filter((memory) => !memory.dailyExpiresAt || new Date(memory.dailyExpiresAt).getTime() > new Date(now).getTime())
      .map((memory) => {
        const lexical = lexicalScore(query, `${memory.summary} ${memory.evidence} ${memory.factKey}`)
        const recent = freshness(memory, now)
        const strength = memoryStrength(memory, now)
        const continuityBoost = memory.kind === 'commitment' || memory.kind === 'relationship' ? 0.12 : 0
        const intentBoost = commitmentIntent && memory.kind === 'commitment'
          ? (memory.speaker === 'user' ? 0.55 : 0.18)
          : relationshipIntent && memory.kind === 'relationship'
            ? 0.4
            : 0
        const sessionBoost = sessionId && memory.source?.startsWith(`${sessionId}/`) ? 0.08 : 0
        const priorityBoost = memory.writePriority === 'priority' ? 0.12 : 0
        const score = lexical * 0.52 + recent * 0.10 + strength * 0.12 + memory.importance * 0.08 + continuityBoost + intentBoost + sessionBoost + priorityBoost
        return { memory, score, lexical, recent, strength, semantic: false }
      })
    const lexicalMax = memories.reduce((max, item) => Math.max(max, item.lexical), 0)
    let semanticUsed = false
    if (this.llm && this.semanticHistoryQuery.test(String(query)) && lexicalMax < this.semanticThreshold) {
      const semantic = await this.semanticRetrieve(query, memories, { sessionId })
      semanticUsed = semantic.used
      for (const item of semantic.items) {
        const existing = memories.find((candidate) => candidate.memory.id === item.memoryId)
        if (existing) {
          existing.score += item.score
          existing.semantic = true
        }
      }
    }
    const selected = memories
      .filter((item) => item.lexical >= MIN_RECALL_SCORE
        || (commitmentIntent && item.memory.kind === 'commitment')
        || (relationshipIntent && item.memory.kind === 'relationship')
        || item.semantic)
      .filter((item) => isRecallable(item.memory))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
    await this.store.recordRetrieval({
      query,
      sessionId,
      topK,
      durationMs: Date.now() - startedAt,
      candidateCount: memories.length,
      selectedCount: selected.length,
      injectedChars: selected.reduce((sum, item) => sum + item.memory.summary.length, 0),
      hits: selected.map((item) => ({
        id: item.memory.id,
        score: item.score,
        strength: item.strength,
        kind: item.memory.kind,
        retrievalOnly: true,
        semantic: item.semantic,
      })),
      semanticUsed,
    })
    await this.store.recordMetric({
      kind: 'recall',
      durationMs: Date.now() - startedAt,
      candidateCount: memories.length,
      selectedCount: selected.length,
      injectedChars: selected.reduce((sum, item) => sum + item.memory.summary.length, 0),
      hitCount: selected.length,
      semanticUsed,
    })
    return selected
  }

  async semanticRetrieve(query, candidates, { sessionId = null } = {}) {
    const pool = [...candidates]
      .sort((a, b) => (b.score + b.memory.importance * 0.1) - (a.score + a.memory.importance * 0.1))
      .slice(0, 12)
    if (!pool.length) return { used: false, items: [] }
    const prompt = [
      '你是轻量记忆检索器，只能从候选 memoryId 中选择真正相关的记忆。',
      '不要创造 ID，不要改写记忆，不要因为情绪或礼貌而选择。',
      '输出严格 JSON：{"memoryIds":["候选ID"]}。',
      `查询：${String(query).slice(0, 240)}`,
      `候选：${pool.map((item) => `${item.memory.id} | ${item.memory.summary} | ${item.memory.evidence}`).join('\n')}`,
    ].join('\n')
    try {
      const response = await this.llm.chatJson([
        { role: 'system', content: prompt },
        { role: 'user', content: String(query).slice(0, 240) },
      ], { temperature: 0, maxTokens: 300 })
      const ids = Array.isArray(response.value?.memoryIds)
        ? response.value.memoryIds.map(String)
        : []
      const allowed = new Set(pool.map((item) => item.memory.id))
      const items = ids.filter((idValue) => allowed.has(idValue)).map((memoryId, index) => ({
        memoryId,
        score: 0.22 - index * 0.01,
      }))
      await this.store.recordMetric({
        kind: 'model-call',
        purpose: 'semantic-retrieve',
        model: response.model ?? null,
        totalTokens: response.usage?.total_tokens ?? response.usage?.totalTokens ?? 0,
        promptTokens: response.usage?.prompt_tokens ?? response.usage?.promptTokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? response.usage?.completionTokens ?? 0,
        estimatedCostUsd: this.estimateCost(response.usage),
        jsonErrors: 0,
        evidenceRejected: 0,
        sessionId,
      })
      return { used: true, items }
    } catch (error) {
      await this.store.recordMetric({
        kind: 'model-call-error',
        purpose: 'semantic-retrieve',
        jsonError: /JSON|解析|parse/i.test(String(error?.message || error)),
        sessionId,
        error: String(error?.message || error).slice(0, 240),
      })
      return { used: true, items: [] }
    }
  }

  async recall(query, options = {}) {
    return this.retrieve(query, options)
  }

  async confirmRecall(memoryIds, {
    query = null,
    sessionId = null,
    now = this.clock().toISOString(),
    reason = 'explicit-confirmation',
    confirmationTurnId = null,
  } = {}) {
    if (!confirmationTurnId) throw new Error('confirmationTurnId is required for confirmRecall')
    const confirmationTurn = this.store.listTurns().find((turn) => turn.id === confirmationTurnId)
    if (!confirmationTurn || confirmationTurn.speaker !== 'user') {
      throw new Error('confirmationTurnId must reference a user turn')
    }
    const confirmation = validateCandidate({
      sourceTurnIds: [confirmationTurnId],
      evidence: confirmationTurn.text,
      subject: 'user',
      factKey: 'confirmation',
    }, {
      turns: [confirmationTurn],
      recordedAt: confirmationTurn.recordedAt,
    })
    if (!confirmation.ok || confirmation.candidate.epistemicStatus !== 'accepted') {
      throw new Error('confirmation turn must be an explicit affirmed user assertion')
    }
    const ids = Array.isArray(memoryIds) ? memoryIds : [memoryIds]
    const confirmed = []
    for (const memoryId of ids.filter(Boolean)) {
      const memory = this.store.memoryMap.get(memoryId)
      if (!memory || ['superseded', 'deleted'].includes(memory.status)) continue
      if (lexicalScore(confirmationTurn.text, `${memory.summary} ${memory.evidence}`) < 0.12) continue
      memory.recallCount = Number(memory.recallCount || 0) + 1
      memory.confirmedRecallCount = Number(memory.confirmedRecallCount || 0) + 1
      memory.lastRecalledAt = now
      memory.lastReinforcedAt = now
      const currentStrength = memoryStrength(memory, now)
      memory.strength = clamp(Math.max(Number(memory.strength || memory.importance || 0), currentStrength) + 0.04)
      memory.freshness = 1
      if (memory.status === 'faded') memory.status = 'active'
      await this.store.upsertMemory(memory, {
        type: 'confirm-recall',
        source: reason,
        query: query == null ? null : String(query).slice(0, 180),
        sessionId,
      })
      confirmed.push(memory)
    }
    await this.store.recordMetric({
      kind: 'confirm-recall',
      confirmedCount: confirmed.length,
      reason,
    })
    return confirmed
  }

  async continuityContext({ sessionId, query = '', now = this.clock().toISOString(), maxChars = 1800 } = {}) {
    const session = this.store.sessions.get(sessionId)
    const commitmentIntent = /(承诺|答应|要求.*记住|要求.*原则|别忘|记得|上次.*原则|未完成|还没完成)/u.test(String(query))
    const relationshipIntent = /(我们|共同|关系|那次|上次发生|修复)/u.test(String(query))
    const taskIntent = !query || /(下一步|继续|完成|安排|计划|还要|待办|未完成|提醒|记得|做什么|怎么做)/u.test(String(query))
    const historyIntent = /(上次|以前|之前|刚才|继续|共同|经历|研究|这件事)/u.test(String(query))
    const includeRecentTurns = taskIntent || historyIntent || commitmentIntent || relationshipIntent
    const continuitySessionIds = []
    let cursor = session
    for (let depth = 0; cursor && depth < 3; depth++) {
      continuitySessionIds.push(cursor.id)
      cursor = cursor.parentSessionId ? this.store.sessions.get(cursor.parentSessionId) : null
    }
    const recentTurns = this.store.listTurns()
      .filter((turn) => continuitySessionIds.includes(turn.sessionId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6)
      .reverse()
    const open = this.store.listMemories()
      .filter((memory) => memory.status === 'open')
      .filter((memory) => !query || lexicalScore(query, `${memory.summary} ${memory.evidence} ${memory.factKey}`) >= MIN_RECALL_SCORE)
      .sort((a, b) => (b.importance + freshness(b, now)) - (a.importance + freshness(a, now)))
      .slice(0, 3)
    const recalled = query ? await this.retrieve(query, { sessionId, topK: 5, now }) : []
    const userCommitments = recalled
      .filter((item) => item.memory.kind === 'commitment' && item.memory.speaker === 'user')
      .slice(0, 3)
    const assistantCommitments = recalled
      .filter((item) => item.memory.kind === 'commitment' && item.memory.speaker !== 'user')
      .slice(0, 2)
    const relationships = recalled
      .filter((item) => item.memory.kind === 'relationship')
      .slice(0, 2)
    const lines = [
      '【连续性上下文】',
      session?.parentSessionId ? `这是从上一会话继续的实验会话：${session.parentSessionId}` : '这是独立会话，但共享同一份陪伴记忆。',
      includeRecentTurns && recentTurns.length
        ? `${session?.parentSessionId ? '上一会话及当前会话最近对话' : '最近对话'}：${recentTurns.map((turn) => `${turn.speaker === 'user' ? '用户' : '助手'}：${turn.text}`).join(' / ')}`
        : '',
      commitmentIntent && userCommitments.length
        ? `用户明确提出的要求/承诺（优先）：${userCommitments.map((item) => item.memory.summary).join('；')}`
        : '',
      commitmentIntent && assistantCommitments.length
        ? `助手自己的承诺（次要）：${assistantCommitments.map((item) => item.memory.summary).join('；')}`
        : '',
      relationshipIntent && relationships.length
        ? `关系与共同经历：${relationships.map((item) => item.memory.summary).join('；')}`
        : '',
      (!commitmentIntent && taskIntent && open.length) ? `未完成事项：${open.map((item) => item.summary).join('；')}` : '',
      recalled.length && !commitmentIntent && !relationshipIntent
        ? `相关长期记忆：${recalled.map((item) => item.memory.summary).join('；')}`
        : '',
    ]
    return joinLines(lines, maxChars)
  }

  async correct(memoryId, patch) {
    const memory = this.store.memoryMap.get(memoryId)
    if (!memory) throw new Error(`找不到记忆 ${memoryId}`)
    Object.assign(memory, patch, { lastSeenAt: this.clock().toISOString() })
    if (patch.status === undefined && memory.status === 'superseded') memory.status = 'active'
    return this.store.upsertMemory(memory, { type: 'correction', patch })
  }

  listMemories({ includeDeleted = false, includeSuperseded = false } = {}) {
    return this.store.listMemories().filter((memory) => (
      (includeDeleted || memory.status !== 'deleted')
      && (includeSuperseded || memory.status !== 'superseded')
    ))
  }

  explain(memoryId) {
    const memory = this.store.memoryMap.get(memoryId)
    if (!memory) throw new Error(`找不到记忆 ${memoryId}`)
    const sourceTurnIds = Array.isArray(memory.sourceTurnIds)
      ? memory.sourceTurnIds
      : String(memory.source || '').split(',').filter(Boolean)
    return {
      memory: { ...memory },
      sources: this.store.listTurns()
        .filter((turn) => sourceTurnIds.includes(turn.id) || `${turn.sessionId}/${turn.turnIndex}` === memory.source)
        .map((turn) => ({
          turnId: turn.id,
          sessionId: turn.sessionId,
          speaker: turn.speaker,
          text: turn.text,
          occurredAt: turn.occurredAt || turn.createdAt,
          recordedAt: turn.recordedAt || turn.createdAt,
        })),
    }
  }

  async forget(memoryId, options = {}) {
    return this.store.forgetMemory(memoryId, options)
  }

  async restore(memoryId) {
    return this.store.restoreMemory(memoryId)
  }

  async updateCommitment(memoryId, status, { at = this.clock().toISOString(), note = null } = {}) {
    if (!COMMITMENT_STATUSES.has(status) || status === 'stale') {
      throw new Error(`无效的承诺状态：${status}`)
    }
    const memory = this.store.memoryMap.get(memoryId)
    if (!memory || memory.kind !== 'commitment') throw new Error(`找不到承诺 ${memoryId}`)
    memory.status = status
    memory.lastSeenAt = at
    if (note) memory.statusNote = String(note).slice(0, 300)
    return this.store.upsertMemory(memory, { type: 'commitment-status', status, note })
  }

  async consolidate() {
    const now = this.clock().toISOString()
    const memories = this.store.listMemories()
    for (const memory of memories) {
      memory.freshness = freshness(memory, now)
      memory.effectiveStrength = memoryStrength(memory, now)
      if (memory.kind === 'commitment' && memory.status === 'open') {
        if (memory.dueAt && new Date(memory.dueAt).getTime() <= new Date(now).getTime()) {
          memory.status = 'expired'
        } else if (!memory.dueAt && freshness(memory, now) < 0.1) {
          memory.status = 'stale'
        }
      } else if (memory.status === 'active'
        && ((memory.dailyExpiresAt && new Date(memory.dailyExpiresAt).getTime() <= new Date(now).getTime())
          || memory.effectiveStrength < 0.08)) {
        memory.status = 'faded'
      }
      await this.store.upsertMemory(memory, { type: 'consolidate' })
    }
    return memories
  }

  async consolidateSession(sessionId, { maxChars = 10_000 } = {}) {
    if (!this.llm) return { extracted: 0, rejected: 0, reason: 'no-llm' }
    const sessionState = this.store.sessions.get(sessionId)
    const allTurns = this.store.listTurns()
      .filter((turn) => turn.sessionId === sessionId && !this.store.purgedTurnIds?.has(turn.id))
    const cursor = sessionState?.lastConsolidatedTurnId
    const cursorIndex = cursor ? allTurns.findIndex((turn) => turn.id === cursor) : -1
    const turns = cursorIndex >= 0 ? allTurns.slice(cursorIndex + 1) : allTurns
    if (!turns.length) return { extracted: 0, rejected: 0, reason: 'no-new-turns' }
    const transcript = turns
      .map((turn) => `[${turn.id}] ${turn.speaker === 'user' ? '用户' : '助手'}：${turn.text}`)
      .join('\n')
      .slice(0, maxChars)
    let response
    try {
      response = await this.llm.chatJson([
        {
          role: 'system',
          content: [
            '你是陪伴型 AI 的长期记忆整理员，不是聊天角色。',
            '只提取未来仍有价值的事实、偏好、关系事件、情绪状态和承诺。',
            '不要记录问题本身、寒暄、临时措辞、模型猜测或没有证据的内容。',
            '每条必须给出 sourceTurnIds，并且 evidence 必须是对应原话的连续片段。',
            '输出严格 JSON：{"memories":[{"kind":"fact|preference|relationship|emotion|commitment|event","speaker":"user|assistant|both","summary":"短句","evidence":"原话片段","sourceTurnIds":["turn_id"],"factKey":"稳定对象.方面或空","importance":0到1,"status":"active|open"}]}。',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ], { temperature: 0, maxTokens: 1400 })
    } catch (error) {
      await this.store.recordMetric({
        kind: 'model-call-error',
        purpose: 'consolidate',
        jsonError: /JSON|解析|parse/i.test(String(error?.message || error)),
        error: String(error?.message || error).slice(0, 240),
      })
      return {
        extracted: 0,
        rejected: 0,
        reason: 'llm-json-failed',
        fallback: 'local-immediate-candidates-retained',
        error: String(error?.message || error),
      }
    }
    const sourceById = new Map(turns.map((turn) => [turn.id, turn]))
    let extracted = 0
    let rejected = 0
    for (const raw of Array.isArray(response.value?.memories) ? response.value.memories : []) {
      const sourceIds = Array.isArray(raw.sourceTurnIds) ? raw.sourceTurnIds.map(String) : []
      const sources = sourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean)
      const evidence = String(raw.evidence || '').trim()
      if (!sources.length || !evidence || !sources.some((turn) => turn.text.includes(evidence))) {
        rejected++
        continue
      }
      const kind = ['fact', 'preference', 'relationship', 'emotion', 'commitment', 'event'].includes(raw.kind)
        ? raw.kind
        : 'fact'
      const speaker = ['user', 'assistant', 'both'].includes(raw.speaker)
        ? raw.speaker
        : sources.length > 1 && new Set(sources.map((turn) => turn.speaker)).size > 1
          ? 'both'
          : sources[0].speaker
      const occurredAt = sources
        .map((turn) => turn.occurredAt || turn.createdAt)
        .sort()[0]
      const candidate = {
        id: id('memory'),
        kind,
        recordType: recordTypeFor(kind),
        subjectType: subjectTypeFor(kind),
        subject: speaker,
        speaker,
        summary: String(raw.summary || evidence).trim().slice(0, 240),
        evidence: evidence.slice(0, 500),
        sourceTurnIds: sourceIds,
        sourceSessionId: turns[0]?.sessionId ?? null,
        sourceKind: 'consolidation',
        sandboxOwned: true,
        occurredAt,
        recordedAt: this.clock().toISOString(),
        lastSeenAt: occurredAt,
        lastSupportedAt: this.clock().toISOString(),
        lastReinforcedAt: null,
        lastRecalledAt: null,
        importance: clamp(raw.importance, 0.2, 1),
        strength: clamp(raw.importance, 0.2, 1),
        retentionClass: isDailyMemory(kind, evidence) ? 'daily' : 'durable',
        dailyExpiresAt: isDailyMemory(kind, evidence) ? dailyExpiresAt(occurredAt) : null,
        promotionScore: isDailyMemory(kind, evidence) ? 0.25 : 1,
        promotionState: isDailyMemory(kind, evidence) ? 'watching' : 'durable',
        supportSessionIds: [sessionId],
        supportDates: [dayKey(occurredAt)],
        recallCount: 0,
        confirmedRecallCount: 0,
        reinforcementCount: 0,
        freshness: 1,
        emotion: kind === 'emotion' ? evidence.slice(0, 120) : null,
        relationshipWeight: kind === 'relationship' ? 0.9 : 0.2,
        status: kind === 'commitment' ? 'open' : 'active',
        factKey: String(raw.factKey || '').trim().slice(0, 120),
        aliases: [],
        source: sourceIds.join(','),
        writePolicy: 'llm-evidence-grounded',
        writePriority: ['commitment', 'relationship'].includes(kind) ? 'priority' : 'normal',
      }
      const validation = validateCandidate(candidate, {
        turns,
        batchTurnIds: new Set(turns.map((turn) => turn.id)),
        requireClaimKey: true,
        allowAcceptance: false,
        recordedAt: candidate.recordedAt,
      })
      if (!validation.ok) {
        rejected++
        continue
      }
      Object.assign(candidate, validation.candidate)
      candidate.id = id('memory')
      candidate.kind = kind
      candidate.recordType = recordTypeFor(kind)
      candidate.subjectType = subjectTypeFor(kind)
      candidate.summary = String(raw.summary || candidate.evidence).trim().slice(0, 240)
      candidate.sourceKind = 'consolidation'
      candidate.sourceSessionId = turns[0]?.sessionId ?? null
      candidate.source = sourceIds.join(',')
      candidate.writePolicy = 'llm-evidence-grounded'
      candidate.writePriority = ['commitment', 'relationship'].includes(kind) ? 'priority' : 'normal'
      if (candidate.visibility === 'evidence-only') candidate.status = 'review'
      const acceptedConflict = this.store.listMemories().find((item) => (
        item.epistemicStatus === 'accepted'
        && item.factKey
        && item.factKey === candidate.factKey
        && item.speaker === candidate.speaker
        && normalizeText(item.summary) !== normalizeText(candidate.summary)
      ))
      if (acceptedConflict) {
        candidate.status = 'review'
        candidate.epistemicStatus = 'disputed'
        candidate.visibility = 'evidence-only'
      }
      const fingerprint = stableCandidateFingerprint(candidate)
      const session = this.store.sessions.get(sessionId)
      const priorFingerprints = new Set(session?.consolidatedCandidateFingerprints || [])
      if (priorFingerprints.has(fingerprint)) continue
      priorFingerprints.add(fingerprint)
      await this.remember(candidate)
      extracted++
      if (session) session.consolidatedCandidateFingerprints = [...priorFingerprints]
    }
    const session = this.store.sessions.get(sessionId)
    if (session) {
      session.lastConsolidatedTurnId = turns.at(-1)?.id || null
      session.lastConsolidatedTranscriptHash = stableCandidateFingerprint({ evidenceRefs: turns.map((turn) => ({ turnId: turn.id, start: 0, end: turn.text.length, quoteHash: turn.text })) })
      await this.store.saveSession(session)
    }
    await this.store.recordMetric({
      kind: 'model-call',
      purpose: 'consolidate',
      model: response.model ?? null,
      totalTokens: response.usage?.total_tokens ?? response.usage?.totalTokens ?? 0,
      promptTokens: response.usage?.prompt_tokens ?? response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? response.usage?.completionTokens ?? 0,
      estimatedCostUsd: this.estimateCost(response.usage),
      extracted,
      rejected,
      evidenceRejected: rejected,
      jsonErrors: response.retried ? 1 : 0,
    })
    return { extracted, rejected, usage: response.usage, model: response.model }
  }

  estimateCost(usage) {
    const providerCost = Number(usage?.costUsd ?? usage?.cost_usd ?? usage?.cost)
    if (Number.isFinite(providerCost) && providerCost > 0) return providerCost
    const input = Number(usage?.prompt_tokens ?? usage?.promptTokens ?? usage?.inputTokens ?? 0)
    const output = Number(usage?.completion_tokens ?? usage?.completionTokens ?? usage?.outputTokens ?? 0)
    return (input * this.modelCost.inputPerMillion + output * this.modelCost.outputPerMillion) / 1_000_000
  }
}

function dayKey(value) {
  return new Date(value).toISOString().slice(0, 10)
}
