import { createHash } from 'node:crypto'
import { id } from './util.mjs'

export const CLAIM_TYPES = new Set([
  'fact',
  'preference',
  'trait',
  'plan',
  'commitment',
  'episode',
  'affect',
  'relationship_state',
  'relationship',
  'emotion',
  'event',
])

export const POLARITIES = new Set(['affirmed', 'negated', 'uncertain', 'reported', 'hypothetical'])
export const MODALITIES = new Set(['assertion', 'plan', 'promise', 'wish', 'question', 'quotation', 'reported'])

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function inferSemanticState(text) {
  const value = String(text || '').trim()
  if (/^(请记得|请记住|记得|记住|别忘(?:了)?|不要忘(?:了)?)/u.test(value)) {
    return { polarity: 'affirmed', modality: 'assertion', epistemicStatus: 'supported' }
  }
  const question = /[?？]\s*$/u.test(value) || /^(是不是|是否|难道|你觉得)/u.test(value)
  if (question) return { polarity: 'uncertain', modality: 'question', epistemicStatus: 'candidate' }
  if (/(如果|假如|要是|以后一起.*就好了|希望|想要|但愿)/u.test(value)) {
    return {
      polarity: /希望|想要|但愿|就好了/u.test(value) ? 'hypothetical' : 'hypothetical',
      modality: /希望|想要|但愿|就好了/u.test(value) ? 'wish' : 'assertion',
      epistemicStatus: 'candidate',
    }
  }
  if (/(听说|聽說|据说|據說|有人说|有人說|传闻|傳聞|据.*说|據.*說)/u.test(value)) {
    return { polarity: 'reported', modality: 'reported', epistemicStatus: 'candidate' }
  }
  if (/(可能|也许|大概|似乎|应该是|不确定)/u.test(value)) {
    return { polarity: 'uncertain', modality: 'assertion', epistemicStatus: 'candidate' }
  }
  if (/(答应|承诺)/u.test(value)) {
    return { polarity: 'affirmed', modality: 'promise', epistemicStatus: 'supported' }
  }
  if (/(准备|準備|计划|計畫|打算|明天要|今晚会|下次|会继续|會繼續|将要|將要|我会|我會|会在|會在|将会|將會)/u.test(value)) {
    return { polarity: 'affirmed', modality: 'plan', epistemicStatus: 'supported' }
  }
  if (/(不|没|没有|从不|从来没有|未曾|不是|并非|别)/u.test(value)) {
    return { polarity: 'negated', modality: 'assertion', epistemicStatus: 'supported' }
  }
  return { polarity: 'affirmed', modality: 'assertion', epistemicStatus: 'supported' }
}

export function semanticClaimType(text, fallback = 'fact') {
  const value = String(text || '')
  if (/(我们(一直|仍然|就是|是).*(关系|家人|恋人|夫妻|朋友))/u.test(value)) return 'relationship_state'
  if (/(一直|通常|总是).*(喜欢|偏好|习惯)/u.test(value)) return 'trait'
  if (/(答应|承诺|请记得|别忘|回来告诉|提醒我)/u.test(value)) return 'commitment'
  if (/(准备|计划|打算|明天要|今晚会|下次|会继续|将要|我会|我会在)/u.test(value)) return 'plan'
  if (/(喜欢|不喜欢|讨厌|偏好|习惯|称呼|叫我|不要叫)/u.test(value)) return 'preference'
  if (/(难过|开心|生气|焦虑|累|害怕|失眠|委屈|想你|想念)/u.test(value)) return 'affect'
  if (/(我们|一起|那天|上次|第一次|纪念|发生)/u.test(value)) return 'episode'
  return CLAIM_TYPES.has(fallback) ? fallback : 'fact'
}

export function deriveAuthority(sources) {
  const speakers = new Set(sources.map((turn) => turn.speaker))
  if (speakers.size === 1) return speakers.has('user') ? 'user' : speakers.has('assistant') ? 'assistant' : 'external'
  return 'joint'
}

function meaningfulLength(value) {
  return [...String(value).replace(/[\s\p{P}\p{S}]/gu, '')].length
}

export function buildEvidenceRef(turn, { start = null, end = null, quote = null, evidenceRole = 'assertion' } = {}) {
  const text = String(turn?.text ?? '')
  let resolvedStart = Number.isInteger(start) ? start : -1
  if (resolvedStart < 0 && quote) resolvedStart = text.indexOf(String(quote))
  const resolvedQuote = resolvedStart >= 0
    ? text.slice(resolvedStart, Number.isInteger(end) ? end : resolvedStart + String(quote ?? '').length)
    : ''
  const resolvedEnd = resolvedStart >= 0 ? resolvedStart + resolvedQuote.length : -1
  return {
    id: id('evidence'),
    turnId: turn?.id ?? null,
    start: resolvedStart,
    end: resolvedEnd,
    quote: resolvedQuote,
    quoteHash: sha256(resolvedQuote),
    speaker: turn?.speaker ?? null,
    evidenceRole,
  }
}

export function validateEvidenceRef(ref, turnsById) {
  const turn = turnsById.get(String(ref?.turnId))
  if (!turn) return { ok: false, reason: 'missing-source-turn' }
  const start = Number(ref?.start)
  const end = Number(ref?.end)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > turn.text.length) {
    return { ok: false, reason: 'invalid-span' }
  }
  const quote = turn.text.slice(start, end)
  if (quote !== String(ref.quote || '') || sha256(quote) !== String(ref.quoteHash || '')) {
    return { ok: false, reason: 'quote-hash-mismatch' }
  }
  if (meaningfulLength(quote) < 2) return { ok: false, reason: 'evidence-too-short' }
  if (ref.speaker && ref.speaker !== turn.speaker) return { ok: false, reason: 'speaker-mismatch' }
  return { ok: true, turn, quote }
}

export function validateCandidate(raw, {
  turns = [],
  batchTurnIds = null,
  requireClaimKey = false,
  allowAcceptance = true,
  recordedAt = new Date().toISOString(),
} = {}) {
  const turnsById = new Map(turns.map((turn) => [String(turn.id), turn]))
  const sourceIds = Array.isArray(raw?.sourceTurnIds) ? raw.sourceTurnIds.map(String) : []
  const sourceTurns = sourceIds.map((sourceId) => turnsById.get(sourceId)).filter(Boolean)
  if (!sourceTurns.length) return { ok: false, reason: 'missing-source-turn' }
  if (batchTurnIds && sourceIds.some((sourceId) => !batchTurnIds.has(sourceId))) {
    return { ok: false, reason: 'source-outside-batch' }
  }
  const rawRefs = Array.isArray(raw?.evidenceRefs) ? raw.evidenceRefs : []
  const refs = rawRefs.length
    ? rawRefs
    : [buildEvidenceRef(sourceTurns[0], { quote: raw?.evidence })]
  const evidenceResults = refs.map((ref) => validateEvidenceRef(ref, turnsById))
  if (evidenceResults.some((result) => !result.ok)) {
    return { ok: false, reason: evidenceResults.find((result) => !result.ok)?.reason || 'invalid-evidence' }
  }
  const validRefs = refs.map((ref, index) => ({
    ...ref,
    turnId: String(ref.turnId),
    speaker: evidenceResults[index].turn.speaker,
    quote: evidenceResults[index].quote,
    quoteHash: sha256(evidenceResults[index].quote),
  }))
  if (validRefs.some((ref) => !sourceIds.includes(ref.turnId))) {
    return { ok: false, reason: 'evidence-source-not-declared' }
  }
  const semantic = inferSemanticState(validRefs.map((ref) => ref.quote).join(' '))
  const authority = deriveAuthority(validRefs.map((ref) => turnsById.get(ref.turnId)))
  const requestedSubject = String(raw?.subject || raw?.speaker || '').toLowerCase()
  if (requestedSubject === 'user' && authority !== 'user' && authority !== 'joint') {
    return { ok: false, reason: 'subject-source-mismatch' }
  }
  if (requestedSubject === 'joint' && authority !== 'joint') {
    return { ok: false, reason: 'joint-source-mismatch' }
  }
  const claimKey = String(raw?.claimKey ?? raw?.factKey ?? '').trim()
  if (requireClaimKey && !claimKey) return { ok: false, reason: 'empty-claim-key' }
  const inferredClaimType = semanticClaimType(validRefs.map((ref) => ref.quote).join(' '), raw?.claimType || raw?.kind)
  const claimType = authority === 'assistant' && inferredClaimType === 'plan'
    ? 'commitment'
    : inferredClaimType
  const evidenceText = validRefs.map((ref) => ref.quote).join(' ')
  const summary = String(raw?.summary || evidenceText).trim()
  const summaryState = inferSemanticState(summary)
  const summaryGrounded = summary.length > 0
    && summary.normalize('NFKC').replace(/\s+/g, '') === evidenceText.normalize('NFKC').replace(/\s+/g, '')
    && summaryState.polarity === semantic.polarity
    && summaryState.modality === semantic.modality
  const isAccepted = allowAcceptance
    && authority === 'user'
    && semantic.epistemicStatus === 'supported'
    && summaryGrounded
    && semantic.polarity === 'affirmed'
    && ['assertion', 'promise'].includes(semantic.modality)
    && (claimType !== 'relationship_state'
      || new Set(sourceTurns.map((turn) => turn.id)).size >= 2)
  const candidate = {
    ...raw,
    claimKey,
    factKey: claimKey,
    claimType,
    kind: raw?.kind || claimType,
    authority,
    subject: authority === 'user' ? 'user' : authority === 'assistant' ? 'assistant' : 'joint',
    speaker: authority,
    polarity: semantic.polarity,
    modality: semantic.modality,
    epistemicStatus: isAccepted ? 'accepted' : summaryGrounded ? semantic.epistemicStatus : 'candidate',
    visibility: (summaryGrounded
      && semantic.epistemicStatus === 'supported'
      && semantic.polarity === 'affirmed'
      && authority === 'user'
      && (['assertion', 'promise'].includes(semantic.modality) || claimType === 'commitment'))
      || (summaryGrounded && authority === 'assistant'
      && claimType === 'commitment'
      && ['promise', 'plan'].includes(semantic.modality))
      ? 'recallable'
      : 'evidence-only',
    deletionState: 'live',
    sourceTurnIds: sourceIds,
    evidenceRefs: validRefs,
    evidence: evidenceText.slice(0, 500),
    recordedAt,
    lastSupportedAt: recordedAt,
    lastReinforcedAt: null,
    lastRecalledAt: null,
  }
  return { ok: true, candidate }
}

export function isRecallable(memory) {
  // `recall-block` 必须单独判断：它只把 visibility 改成 'hidden'，
  // 而 visibility 这一层只排除 'evidence-only'，所以不显式拦就会照常召回。
  // 它同时存在于 deletionState 与 visibility 两处，任一处标记都算阻断。
  return memory?.visibility !== 'evidence-only'
    && memory?.visibility !== 'hidden'
    && memory?.deletionState !== 'purged'
    && memory?.deletionState !== 'recall-blocked'
    && !['deleted', 'superseded', 'hidden'].includes(memory?.status)
    && ['accepted', 'supported', undefined, null].includes(memory?.epistemicStatus)
}

export function stableCandidateFingerprint(candidate) {
  const refs = (candidate?.evidenceRefs || []).map((ref) => `${ref.turnId}:${ref.start}:${ref.end}:${ref.quoteHash}`).sort().join('|')
  return sha256([
    candidate?.claimKey || '',
    refs,
    candidate?.polarity || '',
    candidate?.modality || '',
  ].join('\n'))
}

export function localDateTimeIso(iso, timeZone = 'UTC', dayOffset = 0, endOfDay = false) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(dateParts.map((part) => [part.type, Number(part.value)]))
  const calendarDate = new Date(Date.UTC(values.year, values.month - 1, values.day + dayOffset))
  const target = Date.UTC(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
    endOfDay ? 23 : date.getUTCHours(),
    endOfDay ? 59 : date.getUTCMinutes(),
    endOfDay ? 59 : date.getUTCSeconds(),
    endOfDay ? 999 : date.getUTCMilliseconds(),
  )
  let guess = target
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const local = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .map((part) => [part.type, Number(part.value)]))
    const representedAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
      new Date(guess).getUTCMilliseconds(),
    )
    const correction = target - representedAsUtc
    guess += correction
    if (correction === 0) break
  }
  return new Date(guess).toISOString()
}

export function localDateEndIso(iso, timeZone = 'UTC', dayOffset = 0) {
  return localDateTimeIso(iso, timeZone, dayOffset, true)
}
