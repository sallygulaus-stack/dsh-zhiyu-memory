import { createHash } from 'node:crypto'

/**
 * 给旧归档迁来的记忆回填真实证据定位。
 *
 * 背景：archive@2 迁到 @3 时，旧档没有 evidenceRefs / polarity，全部被 quarantine 成
 * evidence-only，一条都召回不了。这里不做「让模型凭摘要补证据」那种事——只做机械定位：
 * 拿记忆自带的原话（evidence）回到它自己声明的 sourceTurnIds 里逐字搜，搜到才补 span/hash，
 * 说话人以 turn 为准。搜不到、说话人对不上、原文是问句或假设句的，一律保持隔离。
 */

const QUESTION_TAIL = /(吗|呢|吧|么)[？?]?$/
const HYPOTHETICAL = /(如果|要是|假如|万一|会不会|是不是|要不要|能不能)/u

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

/** 决定一条原文能不能当作「用户肯定陈述」的证据。 */
export function classifyQuote(quote, { speaker }) {
  const text = String(quote ?? '').trim()
  if (!text) return { ok: false, reason: 'empty-quote' }
  if (speaker !== 'user' && speaker !== 'assistant') return { ok: false, reason: `unsupported-speaker:${speaker || 'none'}` }
  if (HYPOTHETICAL.test(text)) return { ok: false, reason: 'hypothetical-or-question' }
  if (QUESTION_TAIL.test(text)) return { ok: false, reason: 'question-form' }
  return { ok: true, polarity: 'affirmed', modality: 'assertion' }
}

/** 在声明的来源 turn 里逐字定位一段原文。 */
export function locateQuote(memory, turns) {
  const wanted = [memory.evidence, memory.summary]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const sourceIds = Array.isArray(memory.sourceTurnIds) ? memory.sourceTurnIds : []
  for (const turnId of sourceIds) {
    const turn = byId.get(turnId)
    if (!turn) continue
    const haystack = String(turn.text ?? '')
    for (const quote of wanted) {
      const start = haystack.indexOf(quote)
      if (start < 0) continue
      return { turn, start, end: start + quote.length, quote }
    }
  }
  return null
}

/**
 * @returns {{ filled: object[], skipped: object[], counts: object }}
 */
export function backfillLegacyEvidence({ memories, turns }) {
  const filled = []
  const skipped = []
  for (const memory of Array.isArray(memories) ? memories : []) {
    const needsRefs = !Array.isArray(memory.evidenceRefs) || memory.evidenceRefs.length === 0
    if (!needsRefs) {
      skipped.push({ id: memory.id, reason: 'already-has-evidence-refs' })
      continue
    }
    const hit = locateQuote(memory, turns)
    if (!hit) {
      skipped.push({ id: memory.id, reason: 'quote-not-found-in-source-turns' })
      continue
    }
    if (memory.speaker && hit.turn.speaker && memory.speaker !== hit.turn.speaker) {
      skipped.push({ id: memory.id, reason: `speaker-mismatch:${memory.speaker}!=${hit.turn.speaker}` })
      continue
    }
    const verdict = classifyQuote(hit.quote, { speaker: hit.turn.speaker })
    if (!verdict.ok) {
      skipped.push({ id: memory.id, reason: verdict.reason })
      continue
    }
    filled.push({
      ...memory,
      evidenceRefs: [{
        turnId: hit.turn.id,
        start: hit.start,
        end: hit.end,
        quote: hit.quote,
        quoteHash: sha256(hit.quote),
        speaker: hit.turn.speaker,
        evidenceRole: 'assertion',
      }],
      speaker: memory.speaker || hit.turn.speaker,
      polarity: verdict.polarity,
      modality: verdict.modality,
      epistemicStatus: 'supported',
      visibility: 'recallable',
      migrationStatus: 'needs-review',
      migrationNote: 'evidence-backfilled-from-source-turn',
    })
  }
  const total = Array.isArray(memories) ? memories.length : 0
  return {
    filled,
    skipped,
    counts: {
      total,
      filled: filled.length,
      stillQuarantined: skipped.filter((item) => item.reason !== 'already-has-evidence-refs').length,
      untouched: skipped.filter((item) => item.reason === 'already-has-evidence-refs').length,
    },
  }
}
