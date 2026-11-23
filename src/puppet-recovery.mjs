import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const DIARY_FILE = /^behavior\/diary\/\d{4}-\d{2}\.jsonl$/u
const QUARANTINE_REASON = 'legacy-span-speaker-polarity-unverified'
const UNCERTAIN = /[？?「」『』“”"`]|(?:如果|假如|要是|万一|可能|大概|也许|听说|据说|有人说|打比方|举个例|假设|会不会|是不是|要不要|能不能|希望|但愿)|(?:吗|么|吧)[。！!\s]*$/u
const STABLE_PREFERENCE = /^(?:我(?:一直|通常|平时|最)?(?:喜欢|偏好|习惯)|(?:以后|平时|请)?(?:就)?叫我)/u
const COMPLETED_SHARED_EVENT = /^我们[^。！？\n]{0,30}(?:一起|共同)(?:去了|看了|看见了?|吃了|完成了|第一次)/u
const USER_PROMISE = /^我(?:之前|当时|已经)?(?:答应|承诺)(?!了?吗)/u
const STOP_WORDS = new Set('用户 喜欢 偏好 习惯 事情 事件 内容 记忆 关系 共同 一起 当时 那次 最近 今天 昨天 明天 一次 记录 强调 提到 知道 对话 表示 希望 想要 因为 所以 觉得 现在 说过 他们 你们 我们 她们 一直 重要'.split(' '))
const segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' })

function normalizedQuote(text) {
  return String(text ?? '').normalize('NFKC').trim().replace(/[。！!]+$/u, '')
    .replace(/^用户(?=(?:一直|通常|平时|最)?(?:喜欢|偏好|习惯|答应|承诺))/u, '我')
}

function keywords(text) {
  return new Set([...segmenter.segment(normalizedQuote(text))]
    .filter(({ isWordLike, segment }) => isWordLike && segment.length >= 2 && /\p{L}/u.test(segment) && !STOP_WORDS.has(segment))
    .map(({ segment }) => segment.toLowerCase()))
}

function originalUserTurn(turn) {
  return turn.speaker === 'user' && turn.sourceKind === 'puppet-memory' && DIARY_FILE.test(turn.sourceFile)
    && /^puppet-session-[a-f0-9]+$/u.test(turn.sessionId) && /^[a-f0-9]+$/u.test(turn.sourceRowHash)
    && turn.id === `turn_puppet_${turn.sourceRowHash}_user` && typeof turn.text === 'string'
    && Number.isFinite(Date.parse(turn.occurredAt))
}

function comparableKind(quote, kind) {
  if (kind === 'preference') return STABLE_PREFERENCE.test(quote)
  if (kind === 'relationship' || kind === 'event') return COMPLETED_SHARED_EVENT.test(quote)
  return kind === 'commitment' && USER_PROMISE.test(quote)
}

export function planPuppetRecovery({ memories, turns, blockedTurnIds = [] }) {
  const excluded = new Set(blockedTurnIds)
  for (const memory of memories) {
    if (memory.visibility === 'hidden' || ['deleted', 'hidden', 'superseded'].includes(memory.status)
      || ['soft-deleted', 'recall-blocked', 'purged'].includes(memory.deletionState)) {
      for (const id of memory.sourceTurnIds ?? []) excluded.add(id)
    }
  }
  const originals = turns.filter((turn) => originalUserTurn(turn) && !excluded.has(turn.id))
    .map((turn) => ({ turn, words: keywords(turn.text) }))
  const archived = memories.filter((memory) => memory.sourceKind === 'puppet-memory'
    && !DIARY_FILE.test(memory.sourceFile) && memory.visibility === 'evidence-only' && memory.epistemicStatus === 'candidate'
    && memory.migrationStatus === 'quarantined' && memory.migrationReason === QUARANTINE_REASON
    && (!memory.deletionState || memory.deletionState === 'live') && ['active', 'faded', 'open'].includes(memory.status))
  const items = archived.map((memory) => {
    const summary = normalizedQuote(memory.summary)
    const words = keywords(summary)
    const priority = memory.writePriority === 'priority' || memory.kind === 'preference'
    const row = { memoryId: memory.id, kind: memory.kind, priority }
    const hits = []
    const leads = []
    for (const { turn, words: spoken } of originals) {
      const shared = [...words].filter((word) => spoken.has(word)).length
      if (shared >= 2 && shared / words.size >= 0.25) leads.push({ turnId: turn.id, shared })
      // Whole utterances only: a matching substring can omit a negation, quote or condition.
      const quote = turn.text.trim()
      if (summary.length >= 6 && summary === normalizedQuote(memory.evidence)
        && !UNCERTAIN.test(quote) && comparableKind(quote, memory.kind)
        && summary === normalizedQuote(quote)) hits.push({ turn, quote })
    }
    if (hits.length === 1) {
      const { turn, quote } = hits[0]
      const start = turn.text.indexOf(quote)
      return {
        ...row, outcome: 'verified-historical-quote',
        recordedAt: turn.recordedAt || turn.occurredAt,
        evidenceRef: {
          turnId: turn.id, start, end: start + quote.length, speaker: 'user',
          quoteHash: createHash('sha256').update(quote).digest('hex'),
        },
      }
    }
    leads.sort((a, b) => b.shared - a.shared || a.turnId.localeCompare(b.turnId))
    return {
      ...row, outcome: hits.length > 1 ? 'ambiguous-quote' : leads.length ? 'related-only' : 'no-evidence',
      turnIds: (hits.length > 1 ? hits.map(({ turn }) => turn.id) : leads.map(({ turnId }) => turnId)).slice(0, 3),
    }
  }).sort((a, b) => Number(b.priority) - Number(a.priority))
  const outcomes = {}
  const priorityOutcomes = {}
  for (const { outcome, priority } of items) {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    if (priority) priorityOutcomes[outcome] = (priorityOutcomes[outcome] ?? 0) + 1
  }
  return { originalUserTurns: originals.length, scannedSummaries: archived.length, outcomes, priorityOutcomes, items }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archivePath, details, ...extra] = process.argv.slice(2)
  if (!archivePath || (details && details !== '--details') || extra.length) {
    console.error('用法：node src/puppet-recovery.mjs <archive@3.json> [--details]')
    process.exitCode = 2
  } else {
    const archive = JSON.parse(await readFile(archivePath, 'utf8'))
    if (archive.schema !== 'dsh-companion-memory/archive@3' || !Array.isArray(archive.memories) || !Array.isArray(archive.turns)) {
      throw new Error('需要有效的 archive@3 隔离副本')
    }
    const { items, ...summary } = planPuppetRecovery(archive)
    console.log(JSON.stringify(details ? { ...summary, items } : summary, null, 2))
  }
}
