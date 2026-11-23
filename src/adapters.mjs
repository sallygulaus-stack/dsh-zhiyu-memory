import { id, lexicalScore } from './util.mjs'

export class CompanionMemoryAdapter {
  constructor(memory) {
    this.name = 'dsh-zhiyu-memory'
    this.memory = memory
  }

  async createSession(options) {
    return this.memory.createSession(options)
  }

  async ingestTurn(options) {
    return this.memory.ingestTurn(options)
  }

  async recall(query, options) {
    return this.memory.recall(query, options)
  }

  async confirmRecall(memoryIds, options) {
    return this.memory.confirmRecall(memoryIds, options)
  }

  async context(options) {
    return this.memory.continuityContext(options)
  }

  async consolidate() {
    return this.memory.consolidate()
  }

  async correct(memoryId, patch) {
    return this.memory.correct(memoryId, patch)
  }

  stats() {
    return {
      name: this.name,
      memories: this.memory.store.listMemories().length,
      turns: this.memory.store.listTurns().length,
      sessions: this.memory.store.listSessions().length,
      externalServices: 0,
    }
  }
}

/**
 * 对照组只做“把用户说过的话按词法搜回来”。
 * 它故意没有事实版本、承诺优先级和父会话窗口，用来测融合机制的增益。
 */
export class KeywordBaselineAdapter {
  constructor(store) {
    this.name = 'keyword-baseline'
    this.store = store
    this.memories = []
  }

  async createSession({ title = 'baseline', parentSessionId = null } = {}) {
    const session = {
      id: id('session'),
      title,
      parentSessionId,
      createdAt: new Date().toISOString(),
      lastTurnAt: null,
      turnCount: 0,
    }
    await this.store.saveSession(session)
    return session
  }

  async ingestTurn({ sessionId, speaker, text, turnIndex = 0, occurredAt = new Date().toISOString() }) {
    const turn = { id: id('turn'), sessionId, speaker, text: String(text), turnIndex, createdAt: occurredAt }
    await this.store.saveTurn(turn)
    if (speaker === 'user' && turn.text.trim().length >= 4) {
      const memory = {
        id: id('memory'),
        kind: 'text',
        speaker,
        summary: turn.text.slice(0, 240),
        evidence: turn.text.slice(0, 500),
        occurredAt,
        lastSeenAt: occurredAt,
        status: 'active',
        source: `${sessionId}/${turnIndex}`,
      }
      this.memories.push(memory)
      await this.store.upsertMemory(memory, { type: 'baseline-create' })
    }
    return { turn }
  }

  async recall(query, { topK = 8 } = {}) {
    return this.memories
      .map((memory) => ({ memory, score: lexicalScore(query, `${memory.summary} ${memory.evidence}`) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  async context({ sessionId, query = '', maxChars = 1800 } = {}) {
    const turns = this.store.listTurns()
      .filter((turn) => turn.sessionId === sessionId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6)
      .reverse()
    const recalled = query ? await this.recall(query, { topK: 5 }) : []
    const lines = [
      '【连续性上下文】',
      turns.length ? `最近对话：${turns.map((turn) => `${turn.speaker === 'user' ? '用户' : '助手'}：${turn.text}`).join(' / ')}` : '',
      recalled.length ? `相关记忆：${recalled.map((item) => item.memory.summary).join('；')}` : '',
    ]
    let result = ''
    for (const line of lines) {
      if (!line || result.length + line.length + 1 > maxChars) break
      result += `${result ? '\n' : ''}${line}`
    }
    return result
  }

  async consolidate() {
    return { extracted: 0, rejected: 0, reason: 'baseline-no-consolidation' }
  }

  stats() {
    return {
      name: this.name,
      memories: this.memories.length,
      turns: this.store.listTurns().length,
      sessions: this.store.listSessions().length,
      externalServices: 0,
    }
  }
}
