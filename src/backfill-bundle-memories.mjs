import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { backfillLegacyEvidence } from './backfill-legacy-evidence.mjs'

/**
 * 在 bundle 的记忆根目录上跑一次旧证据回填。
 *
 * 默认只读：打印能补多少、剩多少、为什么剩下，不写盘。
 * 加 --apply 才真的写 memories.json，写之前把原文件复制成
 * memories.json.bak-backfill-<时间戳>。
 *
 * 用法：node src/backfill-bundle-memories.mjs --root <记忆根目录> [--apply]
 */

function readArgs(argv) {
  const options = { root: null, apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--apply') options.apply = true
    else if (item === '--root') {
      options.root = argv[i + 1] ?? null
      i += 1
    }
  }
  return options
}

async function readJsonArray(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

const options = readArgs(process.argv.slice(2))
if (!options.root) {
  console.error('缺少 --root <记忆根目录>')
  process.exit(2)
}

const memoriesPath = join(options.root, 'memories.json')
const turnsPath = join(options.root, 'turns.jsonl')
const memories = await readJsonArray(memoriesPath)
const turns = await readJsonl(turnsPath)

if (memories.length === 0) {
  console.error(`没有读到记忆：${memoriesPath}`)
  process.exit(3)
}

const result = backfillLegacyEvidence({ memories, turns })
const reasonCounts = {}
for (const item of result.skipped) reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1

const report = {
  root: options.root,
  mode: options.apply ? 'apply' : 'dry-run',
  turns: turns.length,
  counts: result.counts,
  skipReasons: reasonCounts,
  sample: result.filled.slice(0, 3).map((memory) => ({
    id: memory.id,
    turnId: memory.evidenceRefs[0].turnId,
    quote: memory.evidenceRefs[0].quote.slice(0, 40),
  })),
}

if (!options.apply) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await copyFile(memoriesPath, `${memoriesPath}.bak-backfill-${stamp}`)
const filledById = new Map(result.filled.map((memory) => [memory.id, memory]))
const next = memories.map((memory) => filledById.get(memory.id) ?? memory)
await mkdir(options.root, { recursive: true })
await writeFile(memoriesPath, `${JSON.stringify(next, null, 2)}\n`)
report.backup = `${memoriesPath}.bak-backfill-${stamp}`
report.written = result.filled.length
console.log(JSON.stringify(report, null, 2))
