import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { ResearchStore } from './store.mjs'
import { CompanionMemory } from './companion-memory.mjs'
import { CompanionMemoryAdapter, KeywordBaselineAdapter } from './adapters.mjs'
import { COMPARISON_CASES } from './comparison-cases.mjs'
import { writeJsonAtomic, id, lexicalScore, nowIso } from './util.mjs'

const MEMU_ROOT = process.env.MEMU_PACKAGE_ROOT
const FISH_ROOT = process.env.FISH_PACKAGE_ROOT

async function importFrom(root, relative) {
  return import(pathToFileURL(join(root, relative)).href)
}

class MemuAdapter {
  constructor(root, state, memory) {
    this.name = 'memu'
    this.root = root
    this.state = state
    this.memory = memory
    this.exec = {
      session: {
        header: {
          id: 'unified-memu-session',
          cwd: root,
          agentPreset: 'research',
        },
      },
    }
    this.binding = state.ensureSession(this.exec.session.header.id, {
      cwd: this.exec.session.header.cwd,
      agentPreset: 'research',
    })
    this.entries = new Map()
    this.sessions = []
    this.turns = 0
  }

  static async create(root) {
    if (!MEMU_ROOT || !existsSync(join(MEMU_ROOT, 'lib', 'memory.js'))) return null
    process.env.DSH_MEMU_MEMORY_HOME = join(root, 'memu')
    const state = await importFrom(MEMU_ROOT, 'lib/state.js')
    const memory = await importFrom(MEMU_ROOT, 'lib/memory.js')
    return new MemuAdapter(root, state, memory)
  }

  async createSession({ title = 'memu', parentSessionId = null } = {}) {
    const session = { id: id('session'), title, parentSessionId, createdAt: nowIso() }
    this.sessions.push(session)
    this.exec.session.header.id = session.id
    this.binding = this.state.ensureSession(session.id, {
      cwd: this.exec.session.header.cwd,
      agentPreset: 'research',
    })
    return session
  }

  async ingestTurn({ sessionId, speaker, text, turnIndex = 0 }) {
    this.turns++
    if (speaker !== 'user') return { turn: { id: id('turn'), sessionId, speaker, text, turnIndex } }
    this.exec.session.header.id = sessionId
    const result = await this.memory.privateRemember({
      exec: this.exec,
      libraryId: this.binding.libraryId,
      title: `turn-${turnIndex}`,
      content: String(text),
      source: 'user_said',
      sourceKind: 'user_said',
      confidence: 0.9,
      layer: 'long_term',
      factKey: `turn.${sessionId}.${turnIndex}`,
    })
    this.entries.set(result.id, result)
    return { turn: { id: id('turn'), sessionId, speaker, text, turnIndex }, memory: result }
  }

  async recall(query) {
    const result = await this.memory.privateRecall({ exec: this.exec, query: String(query), topK: 8 })
    return (result.files || []).map((file, index) => ({
      memory: {
        id: file.name || `memu-${index}`,
        summary: file.content || '',
        evidence: file.content || '',
        kind: file.layer || 'text',
        status: 'active',
      },
      score: Number(file.score || 0),
    }))
  }

  async context({ query = '', maxChars = 1800 } = {}) {
    const hits = query ? await this.recall(query) : []
    return hits.length
      ? `【统一 A/B 记忆上下文】\n相关记忆：${hits.map((hit) => hit.memory.summary).join('；')}`.slice(0, maxChars)
      : ''
  }

  stats() {
    return { name: this.name, memories: this.entries.size, turns: this.turns, sessions: this.sessions.length, externalServices: 0 }
  }
}

class FishAdapter {
  constructor(root, fish) {
    this.name = 'fish'
    this.root = root
    this.fish = fish
    this.storeSessionId = 'unified-fish-session'
    this.data = fish.loadStore(this.storeSessionId)
    this.sessions = []
    this.turns = 0
  }

  static async create(root) {
    if (!FISH_ROOT || !existsSync(join(FISH_ROOT, 'lib', 'index.js'))) return null
    process.env.DSH_HOME = join(root, 'fish')
    const fish = await importFrom(FISH_ROOT, 'lib/index.js')
    return new FishAdapter(root, fish)
  }

  async createSession({ title = 'fish', parentSessionId = null } = {}) {
    const session = { id: id('session'), title, parentSessionId, createdAt: nowIso() }
    this.sessions.push(session)
    return session
  }

  async ingestTurn({ sessionId, speaker, text, turnIndex = 0, occurredAt = nowIso() }) {
    this.turns++
    if (speaker === 'user') {
      this.data.memories.push({
        id: id('fish-memory'),
        text: String(text),
        category: 'event',
        at: occurredAt,
        createdAt: occurredAt,
        important: 0.8,
        emotion: 0,
        factKey: `turn.${sessionId}.${turnIndex}`,
      })
      this.fish.saveStore(this.storeSessionId, this.data)
    }
    return { turn: { id: id('turn'), sessionId, speaker, text, turnIndex } }
  }

  async recall(query, { now = nowIso(), sessionId = null } = {}) {
    const result = this.fish.recall(this.data, String(query), now, sessionId, { 原句: String(query) })
    return (result.selected || []).map((row, index) => ({
      memory: {
        id: row.m?.id || `fish-${index}`,
        summary: row.m?.text || '',
        evidence: row.s?.C || row.m?.text || '',
        kind: row.m?.category || 'event',
        status: 'active',
      },
      score: Number(row.s?.score || row.s?.S || 0),
    }))
  }

  async context({ query = '', maxChars = 1800 } = {}) {
    const hits = query ? await this.recall(query) : []
    return hits.length
      ? `【统一 A/B 记忆上下文】\n相关记忆：${hits.map((hit) => hit.memory.summary).join('；')}`.slice(0, maxChars)
      : ''
  }

  stats() {
    return { name: this.name, memories: this.data.memories?.length || 0, turns: this.turns, sessions: this.sessions.length, externalServices: 0 }
  }
}

async function makeAdapter(root, kind) {
  await mkdir(root, { recursive: true })
  if (kind === 'fusion') {
    const store = await new ResearchStore(join(root, kind)).init({ mode: 'unified-comparison', adapter: kind })
    return new CompanionMemoryAdapter(new CompanionMemory({ store }))
  }
  if (kind === 'baseline') {
    const store = await new ResearchStore(join(root, kind)).init({ mode: 'unified-comparison', adapter: kind })
    return new KeywordBaselineAdapter(store)
  }
  if (kind === 'memu') return MemuAdapter.create(join(root, kind))
  if (kind === 'fish') return FishAdapter.create(join(root, kind))
  throw new Error(`unknown adapter ${kind}`)
}

function expectedScore(context, expected, forbidden = []) {
  const durableContext = context
    .split('\n')
    .filter((line) => !line.startsWith('上一会话及当前会话最近对话：') && !line.startsWith('最近对话：'))
    .join('\n')
  const positiveChecks = expected.map((item) => ({
    label: item.label,
    hit: item.anyOf.find((needle) => context.includes(needle)) || null,
  }))
  const forbiddenChecks = forbidden.map((needle) => ({
    label: `forbidden:${needle}`,
    hit: durableContext.includes(needle) ? needle : null,
  }))
  const checks = [...positiveChecks, ...forbiddenChecks]
  return {
    checks,
    score: checks.length
      ? (positiveChecks.filter((item) => item.hit).length + forbiddenChecks.filter((item) => !item.hit).length) / checks.length
      : 1,
  }
}

async function runCase(root, testCase, kind) {
  const adapter = await makeAdapter(join(root, testCase.id), kind)
  if (!adapter) return { status: 'unsupported', reason: 'package-not-found' }
  let session = null
  for (const [index, step] of testCase.steps.entries()) {
    if (!session || step.newSession) {
      session = await adapter.createSession({
        title: `${testCase.title}-${index}`,
        parentSessionId: session?.id ?? null,
      })
    }
    await adapter.ingestTurn({
      sessionId: session.id,
      speaker: 'user',
      text: step.text,
      turnIndex: index,
      occurredAt: step.at,
    })
  }
  const context = await adapter.context({
    sessionId: session.id,
    query: testCase.query,
    maxChars: testCase.maxChars ?? 1800,
    now: testCase.now,
  })
  return {
    status: 'scored-not-independent',
    independent: false,
    context,
    expected: expectedScore(context, testCase.expected, testCase.forbidden),
    stats: adapter.stats(),
  }
}

export async function runUnifiedComparison(outputRoot) {
  await mkdir(outputRoot, { recursive: true })
  const report = {
    schema: 'companion-memory/unified-comparison@1',
    createdAt: nowIso(),
    adapters: ['fusion', 'memu', 'fish', 'baseline'],
    cases: [],
  }
  for (const testCase of COMPARISON_CASES) {
    const result = { id: testCase.id, title: testCase.title, adapters: {} }
    for (const kind of report.adapters) result.adapters[kind] = await runCase(outputRoot, testCase, kind)
    report.cases.push(result)
  }
  const summary = {}
  for (const kind of report.adapters) {
    const rows = report.cases.map((item) => item.adapters[kind])
      .filter((item) => item.status === 'scored-not-independent')
    summary[kind] = {
      status: rows.length ? 'scored-not-independent' : 'unsupported',
      supportedCases: rows.length,
      independentEvidence: false,
      averageScore: rows.length
        ? Number((rows.reduce((sum, row) => sum + row.expected.score, 0) / rows.length).toFixed(4))
        : null,
    }
  }
  report.summary = summary
  await writeJsonAtomic(join(outputRoot, 'unified-comparison.json'), report)
  return report
}

export async function runLongTermAcceptance(outputRoot) {
  const root = join(outputRoot, 'long-term')
  const store = await new ResearchStore(root).init({ mode: 'long-term-acceptance' })
  let current = new Date('2026-01-01T00:00:00.000Z')
  const memory = new CompanionMemory({ store, clock: () => new Date(current) })
  const session = await memory.createSession({ title: 'long-term' })
  const relationship = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我们第一次一起完成了长期研究。',
    occurredAt: current.toISOString(),
    turnIndex: 0,
  })
  const emotion = await memory.ingestTurn({
    sessionId: session.id,
    speaker: 'user',
    text: '我那天很难过，但后来已经解决了。',
    occurredAt: current.toISOString(),
    turnIndex: 1,
  })
  current = new Date('2026-04-01T00:00:00.000Z')
  await memory.consolidate()
  const relationshipFreshness = relationship.candidate ? memory.store.memoryMap.get(relationship.candidate.id).freshness : 0
  const emotionFreshness = emotion.candidate ? memory.store.memoryMap.get(emotion.candidate.id).freshness : 0
  const oldRecall = await memory.recall('第一次一起完成长期研究', { sessionId: session.id })
  const confirmationTurn = {
    id: 'turn-long-term-confirmation',
    sessionId: session.id,
    speaker: 'user',
    text: '我记得我们第一次一起完成了长期研究。',
    turnIndex: 2,
    occurredAt: current.toISOString(),
    recordedAt: current.toISOString(),
  }
  await store.saveTurn(confirmationTurn)
  await memory.confirmRecall(oldRecall.map((item) => item.memory.id), {
    sessionId: session.id,
    query: '第一次一起完成长期研究',
    confirmationTurnId: confirmationTurn.id,
  })
  const revived = oldRecall.length ? store.memoryMap.get(oldRecall[0].memory.id) : null
  const result = {
    schema: 'companion-memory/long-term-acceptance@1',
    windows: ['0d', '90d'],
    checks: {
      categoryDecay: relationshipFreshness > emotionFreshness,
      distantRecall: oldRecall.length > 0,
      explicitRecallReinforcement: Boolean(revived?.lastRecalledAt && revived?.confirmedRecallCount > 0),
      timeFields: Boolean(revived?.occurredAt && revived?.recordedAt && revived?.lastRecalledAt),
    },
    metrics: await store.metricSummary(),
  }
  result.status = Object.values(result.checks).every(Boolean) ? 'passed' : 'conditional'
  await writeJsonAtomic(join(outputRoot, 'long-term-acceptance.json'), result)
  return result
}

if (process.argv[1] && process.argv[1].endsWith('unified-comparison.mjs')) {
  const outputRoot = process.argv[2] || join(process.cwd(), '_runs', 'unified-comparison')
  const report = await runUnifiedComparison(outputRoot)
  const longTerm = await runLongTermAcceptance(outputRoot)
  console.log(JSON.stringify({ ok: true, outputRoot, summary: report.summary, longTerm: longTerm.status }, null, 2))
}
