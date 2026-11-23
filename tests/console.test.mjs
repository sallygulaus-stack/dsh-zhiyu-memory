import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function contextFor(routes) {
  const ctx = {
    get(name) {
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

  const dataResponse = responseRecorder()
  await routes.get('/companion-memory/console/data').handler({ method: 'GET', url: '/' }, dataResponse)
  assert.equal(dataResponse.status, 200)
  const data = JSON.parse(dataResponse.body)
  assert.equal(data.memories.length, 1)
  assert.equal(data.memories[0].evidence, '我喜欢先看结论。')
  assert.equal(data.memories[0].occurredAt, '2026-11-22T10:00:00.000Z')
  assert.equal(data.stats.autoInjectHitCount, 0)
  assert.ok(data.stats.storageBytes >= 0)
  dispose()
  assert.equal(routes.size, 0)
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
