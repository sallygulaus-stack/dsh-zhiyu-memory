import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('DSH web client exposes the in-page memory observer entry point', async () => {
  const source = await readFile(resolve(root, 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /id:\s*'dsh-zhiyu-memory'/)
  assert.match(source, /\/companion-memory\/console\?embed=1/)
  assert.match(source, /data-dsh-zhiyu-memory-fab/)
  assert.match(source, /data-dsh-zhiyu-memory-window/)
})
