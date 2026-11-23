import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const HUMAN_REVIEW_SCHEMA = 'dsh-zhiyu-memory/human-review@1'

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function reviewKey(memory) {
  return sha256(JSON.stringify({
    id: memory.id,
    summary: memory.summary ?? '',
    evidence: memory.evidence ?? '',
    sourceKind: memory.sourceKind ?? '',
    sourceFile: memory.sourceFile ?? '',
    sourceTurnIds: memory.sourceTurnIds ?? [],
  }))
}

function isQuarantinedCandidate(memory) {
  return memory
    && memory.visibility === 'evidence-only'
    && memory.epistemicStatus === 'candidate'
    && memory.migrationStatus === 'quarantined'
    && (!memory.deletionState || memory.deletionState === 'live')
}

export function createHumanReviewManifest(memories, {
  reviewer = 'user',
  reviewedAt = new Date().toISOString(),
  scope = 'legacy-puppet-memory-candidates',
  note = '用户已人工审阅本批旧木偶记忆摘要，确认内容可作为小鱼的历史记忆使用。',
} = {}) {
  const candidates = (Array.isArray(memories) ? memories : [])
    .filter(isQuarantinedCandidate)
    .map((memory) => ({
      id: memory.id,
      reviewKey: reviewKey(memory),
      sourceFile: memory.sourceFile ?? null,
      kind: memory.kind ?? null,
    }))
  return {
    schema: HUMAN_REVIEW_SCHEMA,
    reviewer,
    reviewedAt,
    scope,
    note,
    count: candidates.length,
    memories: candidates,
  }
}

export function applyHumanReview(memories, manifest, { now = new Date().toISOString() } = {}) {
  if (!manifest || manifest.schema !== HUMAN_REVIEW_SCHEMA) {
    throw new Error('人工确认清单格式不受支持')
  }
  if (!String(manifest.reviewer || '').trim()) throw new Error('人工确认清单缺少 reviewer')
  if (!Date.parse(manifest.reviewedAt)) throw new Error('人工确认清单缺少有效 reviewedAt')
  if (!Array.isArray(manifest.memories) || manifest.memories.length !== Number(manifest.count)) {
    throw new Error('人工确认清单 count 与 memories 不一致')
  }

  const entries = new Map()
  for (const entry of manifest.memories) {
    if (!entry?.id || entries.has(entry.id)) throw new Error(`人工确认清单存在重复或空 ID：${entry?.id ?? ''}`)
    entries.set(entry.id, entry)
  }

  const rows = Array.isArray(memories) ? memories : []
  const found = new Set()
  const reviewedAt = new Date(manifest.reviewedAt).toISOString()
  const appliedAt = Date.parse(now) ? new Date(now).toISOString() : new Date().toISOString()
  const result = rows.map((memory) => {
    const entry = entries.get(memory.id)
    if (!entry) return memory
    found.add(memory.id)
    if (!isQuarantinedCandidate(memory)) {
      throw new Error(`目标记忆不是可晋升的隔离候选：${memory.id}`)
    }
    if (entry.reviewKey !== reviewKey(memory)) {
      throw new Error(`目标记忆内容已变化，拒绝套用人工确认：${memory.id}`)
    }
    return {
      ...memory,
      visibility: 'recallable',
      epistemicStatus: 'accepted',
      migrationStatus: 'human-reviewed',
      migrationReason: 'user-manual-review',
      humanReview: {
        schema: HUMAN_REVIEW_SCHEMA,
        reviewer: String(manifest.reviewer),
        reviewedAt,
        appliedAt,
        scope: String(manifest.scope || 'legacy-puppet-memory-candidates'),
        note: String(manifest.note || ''),
        machineEvidence: 'legacy-summary-without-verified-span',
      },
      lastSupportedAt: memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt || memory.recordedAt || appliedAt,
    }
  })

  for (const id of entries.keys()) {
    if (!found.has(id)) throw new Error(`人工确认清单中的记忆未在目标库找到：${id}`)
  }
  return result
}

export function applyHumanReviewToDocument(document, manifest, options = {}) {
  if (Array.isArray(document)) return applyHumanReview(document, manifest, options)
  if (!document || !Array.isArray(document.memories)) throw new Error('输入必须是记忆数组或包含 memories 的归档')
  return { ...document, memories: applyHumanReview(document.memories, manifest, options) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, manifestPath, outputPath, ...flags] = process.argv.slice(2)
  if (!inputPath || !manifestPath || !outputPath || flags.length) {
    throw new Error('用法：node src/human-review.mjs <输入 JSON> <人工确认清单 JSON> <输出 JSON>')
  }
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const output = applyHumanReviewToDocument(input, manifest)
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const rows = Array.isArray(output) ? output : output.memories
  console.log(JSON.stringify({
    schema: HUMAN_REVIEW_SCHEMA,
    reviewed: manifest.memories.length,
    recallable: rows.filter((row) => row.migrationStatus === 'human-reviewed').length,
    total: rows.length,
  }))
}
