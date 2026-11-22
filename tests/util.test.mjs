import test from 'node:test'
import assert from 'node:assert/strict'
import { lexicalScore, parseJsonLoose, terms } from '../src/util.mjs'

test('词法索引保留中文单字和二元组', () => {
  const tokens = terms('记忆插件测试')
  assert.equal(tokens.has('记'), true)
  assert.equal(tokens.has('记忆'), true)
  assert.equal(tokens.has('插件'), true)
})

test('词法召回能识别相关短句', () => {
  assert.ok(lexicalScore('换对话连续性', '研究换对话时的连续性') > 0.5)
})

test('宽松 JSON 解析支持代码围栏', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"ok":true}\n```'), { ok: true })
})
