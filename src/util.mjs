import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const nowIso = () => new Date().toISOString()
export const localStamp = (date = new Date(), timeZone = 'Asia/Hong_Kong') => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}${value.month}${value.day}-${value.hour}${value.minute}${value.second}`
}
export const id = (prefix = 'id') => `${prefix}_${randomUUID().replaceAll('-', '')}`
export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0))

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
  return path
}

export async function appendJsonl(path, value) {
  await ensureDir(dirname(path))
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

export async function writeJsonlAtomic(path, values) {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const body = values.map((value) => JSON.stringify(value)).join('\n')
  await writeFile(temp, body ? `${body}\n` : '', 'utf8')
  await rename(temp, path)
}

export async function readJsonl(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function readJsonlOrArray(path) {
  try {
    const text = await readFile(path, 'utf8')
    if (!text.trim()) return []
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to JSONL for older/hand-edited stores.
    }
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function terms(text) {
  const normalized = normalizeText(text)
  const result = new Set()
  for (const token of normalized.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (token.length > 1) result.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      for (const char of token) result.add(char)
      for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2))
    }
  }
  return result
}

export function lexicalScore(query, text) {
  const queryTerms = terms(query)
  if (!queryTerms.size) return 0
  const textTerms = terms(text)
  let hit = 0
  for (const token of queryTerms) if (textTerms.has(token)) hit++
  return hit / queryTerms.size
}

export function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

export function redactApiError(error) {
  const message = String(error?.message || error || '')
  return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
}

export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const start = Math.min(...['{', '['].map((mark) => {
      const index = candidate.indexOf(mark)
      return index < 0 ? Number.POSITIVE_INFINITY : index
    }))
    if (!Number.isFinite(start)) throw new Error('模型没有返回可解析的 JSON')
    const endObject = candidate.lastIndexOf('}')
    const endArray = candidate.lastIndexOf(']')
    const end = Math.max(endObject, endArray)
    if (end <= start) throw new Error('模型没有返回完整的 JSON')
    return JSON.parse(candidate.slice(start, end + 1))
  }
}

export function joinLines(lines, maxChars = 2400) {
  const result = []
  let size = 0
  for (const line of lines) {
    const value = String(line ?? '').trim()
    if (!value) continue
    if (size + value.length + 1 > maxChars) break
    result.push(value)
    size += value.length + 1
  }
  return result.join('\n')
}

export function pathIn(base, child) {
  return join(base, child)
}
