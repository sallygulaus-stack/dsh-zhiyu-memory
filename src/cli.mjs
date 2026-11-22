import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { DeepSeekClient } from './deepseek-client.mjs'
import { ResearchStore } from './store.mjs'
import { CompanionMemory } from './companion-memory.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { localStamp, nowIso, redactApiError, pathIn } from './util.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNS = pathIn(ROOT, '_runs')

function stamp() {
  return localStamp()
}

async function createRun(kind) {
  const root = join(RUNS, `${stamp()}-${kind}-${randomBytes(3).toString('hex')}`)
  await mkdir(root, { recursive: true })
  return root
}

function systemPrompt(context = '') {
  return [
    '你是一个用于记忆系统研究的中性陪伴型测试 AI。',
    '你要自然地延续对话，但不能凭空创造用户没有说过的事实。',
    '如果记忆不确定，直接说不确定；不要把测试说明暴露给用户。',
    context,
  ].filter(Boolean).join('\n')
}

async function reply(client, messages, context) {
  const result = await client.chat([
    { role: 'system', content: systemPrompt(context) },
    ...messages,
  ], { temperature: 0.2, maxTokens: 500 })
  return result
}

async function judgeAnswer(client, { scenario, question, answer, expected }) {
  const response = await client.chatJson([
    {
      role: 'system',
      content: [
        '你是记忆系统的独立评审员，不是陪伴 AI。',
        '只根据用户问题、期望记忆和回答评分，不要因为回答说得好听就提高记忆分。',
        '输出严格 JSON：{"recall":0到1,"continuity":0到1,"naturalness":0到1,"unsupported":0到1,"notes":"一句话"}。',
        'recall 表示是否正确接住期望记忆；continuity 表示是否像延续上一段对话；naturalness 表示是否自然；unsupported 表示回答中无依据内容的比例。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ scenario, question, expected, answer }),
    },
  ], { temperature: 0, maxTokens: 700 })
  return { ...response.value, usage: response.usage, model: response.model }
}

async function runScenario({ client, store, memory, scenario, judge = false, extract = false }) {
  const sessions = new Map()
  const transcripts = []
  for (const sessionPlan of scenario.sessions) {
    const parent = [...sessions.values()].at(-1)
    const session = await memory.createSession({
      title: `${scenario.title}-${sessionPlan.id}`,
      parentSessionId: parent?.id ?? null,
    })
    sessions.set(sessionPlan.id, session)
    const messages = []
    for (const text of sessionPlan.userTurns) {
      const turnIndex = messages.length
      await memory.ingestTurn({ sessionId: session.id, speaker: 'user', text, turnIndex })
      messages.push({ role: 'user', content: text })
      const context = await memory.continuityContext({ sessionId: session.id, query: text })
      const response = await reply(client, messages, context)
      messages.push({ role: 'assistant', content: response.text })
      await memory.ingestTurn({
        sessionId: session.id,
        speaker: 'assistant',
        text: response.text,
        turnIndex: messages.length,
      })
      transcripts.push({
        scenarioId: scenario.id,
        sessionId: session.id,
        user: text,
        assistant: response.text,
        usage: response.usage,
        model: response.model,
      })
    }
    let consolidation = null
    if (extract) {
      try {
        consolidation = await memory.consolidateSession(session.id)
      } catch (error) {
        consolidation = { extracted: 0, rejected: 0, error: redactApiError(error) }
      }
      await store.recordResult({
        scenarioId: scenario.id,
        sessionId: session.id,
        kind: 'consolidation',
        consolidation,
      })
    }
    await memory.consolidate()
    if (sessionPlan.expected) {
      const last = transcripts.at(-1)
      const answer = last?.assistant ?? ''
      const checks = sessionPlan.expected.map((item) => {
        const expected = typeof item === 'string' ? { label: item, anyOf: [item] } : item
        const hit = expected.anyOf.find((needle) => answer.includes(needle)) ?? null
        return { label: expected.label, hit }
      })
      await store.recordResult({
        scenarioId: scenario.id,
        sessionId: session.id,
        kind: 'expected-keywords',
        expected: sessionPlan.expected,
        hits: checks.filter((item) => item.hit).map((item) => item.label),
        checks,
        score: checks.filter((item) => item.hit).length / checks.length,
        answer,
      })
      if (judge) {
        try {
          const review = await judgeAnswer(client, {
            scenario: scenario.title,
            question: sessionPlan.userTurns.at(-1),
            answer,
            expected: sessionPlan.expected,
          })
          await store.recordResult({
            scenarioId: scenario.id,
            sessionId: session.id,
            kind: 'llm-judge',
            ...review,
          })
        } catch (error) {
          await store.recordResult({
            scenarioId: scenario.id,
            sessionId: session.id,
            kind: 'llm-judge-error',
            error: redactApiError(error),
          })
        }
      }
    }
  }
  return { transcripts, sessions: [...sessions.values()] }
}

async function smoke() {
  const runRoot = await createRun('smoke')
  const client = new DeepSeekClient()
  const store = await new ResearchStore(runRoot).init({ mode: 'smoke', model: client.model })
  const memory = new CompanionMemory({ store, llm: client })
  const models = await client.models()
  await store.recordResult({
    kind: 'models',
    model: client.model,
    ids: (models?.data ?? []).map((item) => item.id),
  })
  const result = await runScenario({ client, store, memory, scenario: SCENARIOS[0] })
  console.log(JSON.stringify({
    ok: true,
    mode: 'smoke',
    runRoot,
    model: client.model,
    modelCount: (models?.data ?? []).length,
    transcriptCount: result.transcripts.length,
    memoryCount: store.listMemories().length,
  }, null, 2))
}

async function live() {
  const runRoot = await createRun('live')
  const client = new DeepSeekClient()
  const store = await new ResearchStore(runRoot).init({ mode: 'live', model: client.model })
  const memory = new CompanionMemory({ store, llm: client })
  const models = await client.models()
  await store.recordResult({
    kind: 'models',
    model: client.model,
    ids: (models?.data ?? []).map((item) => item.id),
  })
  for (const scenario of SCENARIOS) {
    await runScenario({ client, store, memory, scenario, judge: true, extract: true })
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'live',
    runRoot,
    model: client.model,
    scenarioCount: SCENARIOS.length,
    memoryCount: store.listMemories().length,
  }, null, 2))
}

const mode = process.argv[2] ?? 'smoke'
try {
  if (mode === 'smoke') await smoke()
  else if (mode === 'live') await live()
  else throw new Error(`未知模式：${mode}`)
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: redactApiError(error) }, null, 2))
  process.exitCode = 1
}
