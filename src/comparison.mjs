import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { ResearchStore } from './store.mjs'
import { CompanionMemory } from './companion-memory.mjs'
import { CompanionMemoryAdapter, KeywordBaselineAdapter } from './adapters.mjs'
import { COMPARISON_CASES } from './comparison-cases.mjs'
import { writeJsonAtomic, localStamp } from './util.mjs'

async function makeAdapter(root, kind) {
  const store = await new ResearchStore(join(root, kind)).init({ mode: 'comparison', adapter: kind })
  if (kind === 'fusion') return new CompanionMemoryAdapter(new CompanionMemory({ store }))
  return new KeywordBaselineAdapter(store)
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

export async function runComparison(outputRoot) {
  await mkdir(outputRoot, { recursive: true })
  const report = {
    schema: 'companion-memory/comparison@1',
    createdAt: new Date().toISOString(),
    cases: [],
  }
  for (const testCase of COMPARISON_CASES) {
    const result = { id: testCase.id, title: testCase.title, adapters: {} }
    for (const kind of ['fusion', 'baseline']) {
      const adapter = await makeAdapter(join(outputRoot, `${testCase.id}-${kind}`), kind)
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
      result.adapters[kind] = {
        context,
        expected: expectedScore(context, testCase.expected, testCase.forbidden),
        stats: adapter.stats(),
      }
    }
    result.delta = Number((
      result.adapters.fusion.expected.score - result.adapters.baseline.expected.score
    ).toFixed(4))
    report.cases.push(result)
  }
  const summary = {
    fusion: report.cases.reduce((sum, item) => sum + item.adapters.fusion.expected.score, 0) / report.cases.length,
    baseline: report.cases.reduce((sum, item) => sum + item.adapters.baseline.expected.score, 0) / report.cases.length,
  }
  report.summary = {
    ...summary,
    delta: Number((summary.fusion - summary.baseline).toFixed(4)),
  }
  await writeJsonAtomic(join(outputRoot, 'comparison.json'), report)
  return report
}

if (process.argv[1] && process.argv[1].endsWith('comparison.mjs')) {
  const outputRoot = process.argv[2]
    || join(process.cwd(), '_runs', `${localStamp()}-comparison-${randomBytes(3).toString('hex')}`)
  const report = await runComparison(outputRoot)
  console.log(JSON.stringify({
    ok: true,
    outputRoot,
    summary: report.summary,
  }, null, 2))
}
