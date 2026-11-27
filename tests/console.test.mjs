import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { MemoryEngine } from '../plugin/lib/index.js'
import { registerMemoryConsoleRoutes } from '../plugin/lib/console.js'

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body = String(body)
    },
  }
}

function contextFor(routes, { auth = true, rejection } = {}) {
  const ctx = {
    get(name) {
      if (name === 'connection' && auth) return {
        requestRejection: () => rejection,
        authorizeIndex(req, res) {
          if (req.browserSession !== false) return true
          res.writeHead(401, {})
          res.end()
          return false
        },
      }
      return name === 'webServer' ? {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      } : undefined
    },
  }
  return ctx
}

test('记忆观察面板注册网页和只读数据路由', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-console-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({
    sessionId: 'session-1',
    speaker: 'user',
    text: '我喜欢先看结论。',
    sourceKey: 'console-turn-1',
    occurredAt: '2026-11-22T10:00:00.000Z',
  })
  const routes = new Map()
  const dispose = registerMemoryConsoleRoutes({ ctx: contextFor(routes), engine })
  assert.ok(routes.has('/companion-memory/console'))
  assert.ok(routes.has('/companion-memory/console/data'))

  const pageResponse = responseRecorder()
  await routes.get('/companion-memory/console').handler({ method: 'GET', url: '/' }, pageResponse)
  assert.equal(pageResponse.status, 200)
  assert.match(pageResponse.headers['content-type'], /text\/html/)
  assert.match(pageResponse.body, /小鱼记忆观察/u)
  assert.match(pageResponse.body, /来源与状态/u)
  assert.match(pageResponse.body, /自动注入命中/u)
  assert.match(pageResponse.body, /分类概览|事实|偏好/u)
  assert.match(pageResponse.body, /<option value="daily">日常记忆<\/option>/u)
  assert.match(pageResponse.body, /日常/u)

  const dataResponse = responseRecorder()
  await routes.get('/companion-memory/console/data').handler({ method: 'GET', url: '/' }, dataResponse)
  assert.equal(dataResponse.status, 200)
  const data = JSON.parse(dataResponse.body)
  assert.equal(data.memories.length, 1)
  assert.equal(data.memories[0].evidence, '我喜欢先看结论。')
  assert.equal(data.memories[0].subcategory, 'response-format')
  assert.equal(data.memories[0].occurredAt, '2026-11-22T10:00:00.000Z')
  assert.equal(data.stats.categoryCounts.preference, 1)
  assert.equal(data.stats.subcategoryCounts['preference:response-format'], 1)
  assert.equal(data.stats.autoInjectHitCount, 0)
  assert.ok(data.stats.storageBytes >= 0)
  dispose()
  assert.equal(routes.size, 0)
})

test('记忆观察面板显示日常保留层与自动晋升信息', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-console-daily-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({
    sessionId: 'daily-console-1',
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    sourceKey: 'daily-console-1',
    occurredAt: '2026-11-22T10:00:00.000Z',
  })
  await engine.ingest({
    sessionId: 'daily-console-2',
    speaker: 'user',
    text: '今晚一起看神舟发射吧。',
    sourceKey: 'daily-console-2',
    occurredAt: '2026-11-23T10:00:00.000Z',
  })
  const routes = new Map()
  registerMemoryConsoleRoutes({ ctx: contextFor(routes), engine })
  const pageResponse = responseRecorder()
  await routes.get('/companion-memory/console').handler({ method: 'GET', url: '/' }, pageResponse)
  assert.match(pageResponse.body, /日常记忆/u)
  assert.match(pageResponse.body, /已自动晋升/u)
  assert.match(pageResponse.body, /日常到期/u)
  const dataResponse = responseRecorder()
  await routes.get('/companion-memory/console/data').handler({ method: 'GET', url: '/' }, dataResponse)
  const data = JSON.parse(dataResponse.body)
  assert.equal(data.stats.dailyMemories, 0)
  assert.equal(data.stats.promotedMemories, 1)
  assert.equal(data.memories[0].promotionState, 'promoted')
})

test('记忆观察面板分类卡片的数字、子类和点击结果不混入日常层', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-console-layers-'))
  const engine = await new MemoryEngine(root, 6).init()
  await engine.ingest({ sessionId: 's1', speaker: 'user', text: '我住在上海市。', forcedKind: 'fact' })
  const daily = await engine.ingest({
    sessionId: 's1', speaker: 'user', text: '我正在测试宽带。', writeMode: 'auto',
    historicalTimeBasis: 'snapshot-captured-at',
  })
  await engine.correct(daily.memory.id, { subcategory: 'daily-only' })
  await engine.ingest({ sessionId: 's1', speaker: 'user', text: '我们一起练过钢琴。', forcedKind: 'relationship' })
  await engine.ingest({ sessionId: 's1', speaker: 'user', text: '我们一起学着调音。', writeMode: 'auto' })
  const routes = new Map()
  registerMemoryConsoleRoutes({ ctx: contextFor(routes), engine })
  const page = responseRecorder()
  const data = responseRecorder()
  await routes.get('/companion-memory/console').handler({ method: 'GET', url: '/' }, page)
  await routes.get('/companion-memory/console/data').handler({ method: 'GET', url: '/' }, data)
  const payload = JSON.parse(data.body)
  assert.equal(payload.stats.categoryCounts.fact, 2)
  assert.equal(payload.stats.durableCategoryCounts.fact, 1)
  assert.equal(payload.stats.durableCategoryCounts.relationship, 1)
  assert.equal(payload.stats.durableSubcategoryCounts['fact:daily-only'], undefined)

  const ids = ['search', 'kind', 'retention', 'categories', 'stats', 'list', 'detail', 'count', 'status', 'events', 'refresh', 'auto']
  const elements = Object.fromEntries(ids.map((id) => [id, { value: '', innerHTML: '', querySelectorAll: () => [] }]))
  let buttons, rows
  elements.categories.querySelectorAll = () => buttons = Array.from(
    elements.categories.innerHTML.matchAll(/data-retention="([^"]+)" data-kind="([^"]*)"/gu),
    ([, retention, kind]) => ({ dataset: { retention, kind } }),
  )
  elements.list.querySelectorAll = () => rows = Array.from(
    elements.list.innerHTML.matchAll(/data-id="([^"]+)"/gu),
    ([, id]) => ({ dataset: { id } }),
  )
  await runInNewContext(page.body.match(/<script>([\s\S]*)<\/script>/u)[1], {
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: (id) => elements[id] },
    fetch: async () => ({ ok: true, json: async () => payload }),
  })
  assert.match(elements.categories.innerHTML, /事实<\/span><strong>1<\/strong>/u)
  assert.match(elements.categories.innerHTML, /关系<\/span><strong>1<\/strong>/u)
  assert.match(elements.categories.innerHTML, /日常<\/span><strong>2<\/strong>/u)
  assert.doesNotMatch(elements.categories.innerHTML, /daily-only/u)
  buttons.find((button) => button.dataset.retention === 'daily').onclick()
  assert.equal(rows.length, 2)
  assert.doesNotMatch(elements.list.innerHTML, /上海市|练过钢琴/u)
  rows.find((row) => row.dataset.id === daily.memory.id).onclick()
  assert.match(elements.detail.innerHTML, /测试宽带/u)
  assert.match(elements.detail.innerHTML, /收录时间/u)
  buttons.find((button) => button.dataset.kind === 'fact').onclick()
  assert.equal(elements.retention.value, 'durable')
  assert.equal(rows.length, 1)
  assert.match(elements.list.innerHTML, /上海市/u)
  assert.doesNotMatch(elements.detail.innerHTML, /测试宽带/u)
  buttons.find((button) => button.dataset.kind === 'relationship').onclick()
  assert.match(elements.list.innerHTML, /练过钢琴/u)
  assert.doesNotMatch(elements.list.innerHTML, /学着调音/u)
  elements.retention.value = ''
  elements.retention.onchange()
  assert.equal(rows.length, 2)
})

test('记忆观察面板未经 DSH 浏览器鉴权不读取记忆数据', async () => {
  const routes = new Map()
  registerMemoryConsoleRoutes({ ctx: contextFor(routes, { auth: false }), engine: null })
  assert.equal(routes.size, 0)
  for (const [options, expected] of [[{}, 401], [{ rejection: 401 }, 401], [{ rejection: 403 }, 403]]) {
    registerMemoryConsoleRoutes({ ctx: contextFor(routes, options), engine: null })
    for (const route of routes.values()) {
      const res = responseRecorder()
      await route.handler({ method: 'GET', browserSession: false }, res)
      assert.equal(res.status, expected)
    }
  }
})

test('记忆观察面板拒绝写请求，不提供未确认的修改入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-console-readonly-'))
  const engine = await new MemoryEngine(root, 6).init()
  const routes = new Map()
  registerMemoryConsoleRoutes({ ctx: contextFor(routes), engine })
  const response = responseRecorder()
  await routes.get('/companion-memory/console/data').handler({ method: 'POST', url: '/' }, response)
  assert.equal(response.status, 405)
  assert.deepEqual(JSON.parse(response.body), { error: 'method-not-allowed' })
})
