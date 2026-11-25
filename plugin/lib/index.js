import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { registerMemoryConsoleRoutes } from './console.js'
import { calculateDeepSeekCost } from './pricing.js'

const name = 'companion-memory'
const inject = ['tools', 'systemPrompt', 'llm']
const LOW_VALUE = /^(你好|嗨|哈[哈呵]+|嗯+|哦+|好的?|好呀|收到|谢谢|谢了|晚安|早安|ok|okay)$/iu
const MEMORY_META_QUERY = /(你还记得|你记得|记忆里|长期偏好|有什么.*偏好|只根据已有记忆|只根据.*记忆|不要猜|新开.*聊天|翻阅.*记忆|记忆插件|companion_memory|使用.*(记忆|recall|remember|consolidate)|测试数据|不要编造)/iu
const HALF_LIFE_HOURS = {
  relationship: 24 * 180,
  preference: 24 * 90,
  fact: 24 * 45,
  commitment: 24 * 60,
  event: 24 * 21,
  emotion: 24 * 14,
}
const DAILY_MEMORY_HALF_LIFE_HOURS = 48
const DAILY_MEMORY_RETENTION_DAYS = 7
const DEFAULT_DAILY_WRITE_BUDGET = 24
const DEFAULT_SEMANTIC_THRESHOLD = 0.18
const PARENT_WINDOW_MAX_AGE_MS = 72 * 3600000
const LEXICAL_STOP_CHARS = new Set('的了是我你他她它我们你们他们和与在于从到这那个也都一有没不要请记住什么哪吗呢吧会能可以已经还就按把为并且'.split(''))
const SEMANTIC_HISTORY_QUERY = /(上次|以前|之前|那次|记得|共同|经历|当时|曾经|换个说法|有关)/u
const DAILY_EVENT = /(?:(?:今天|今晚|明天|刚才|待会|这两天|最近).{0,24}(?:一起|我们|咱们|看|吃|喝|聊|玩|等|追|做|发射|比赛|直播|电影|饭|饺子))|(?:(?:一起|我们|咱们).{0,18}(?:看|吃|喝|聊|玩|等|追|做|去|守着|等着))/u
const CONTINUATION_CUE = /刚才|刚刚|上一(?:轮|个对话|个会话)|前面|之前说的|我们聊到|还没说完|(?:接着|继续)(?:说|聊|吧|下去|就|做)|上(?:回|次)(?:那|的)|那个|那样|那份|那套|这种|这样|一样|照旧|原样|照原来|老样子/u
const SHORT_CONTINUATION = /^(?:嗯|好|那|就|还|用|按|还是|再来|继续|老规矩|照旧|原样|照原来|老样子|不改了|不换了|那样|这样|那份|那套|那个|刚(?:才|刚)(?:说的)?|也|来吧|行吗|可以吗|吗|吧|呢|[，、,.。！!？?\s])+$/u
const OPEN_MEAL_QUERY = /^(?:现在|今天(?:晚上)?|今晚|中午|晚上|明天|早上|早餐|午餐|晚餐|夜宵)?[，、,\s]*(?:我们|咱们)?(?:想|要|该|可以|应该)?吃(?:点儿?|些)?什么(?:好|呢|呀|啊|吧|合适)?[。！!？?\s]*$/u
const MEAL_WORD = /吃|饭|菜|点餐|夜宵/u
const PAST_MEAL = /(?:吃了|吃过|点了|点过|那顿饭|昨晚的(?:饭|菜)|昨天的(?:饭|菜))/u
const REVIEWED_HISTORY_QUERY = /上(?:回|次)|以前|之前|曾经|当时|那天|那次|还?记得|说过|发过|送过|聊过|做过|提过/u
const FOCAL_STOP_WORDS = new Set('还是 希望 想要 喜欢 偏好 习惯 不要 知道 可以 这个 那个 这个事 这样 那样 那份 那套 那顿 那天 一样 原样 照旧 继续 接着 上次 上回 今天 今晚 最近 昨天 刚才 那次 搭配 记住 记得 内容 怎么 什么 当然 然后 我们 以前 之后 当时 晚餐 午餐 早餐 晚饭 吃饭 饭菜 夜宵 吃法'.split(' '))
const FADED_MEMORY_STRENGTH = 0.08
const RUNTIME_INJECTION_MARKERS = Object.freeze([
  /【角色卡(?:\s*——|已在本会话|请调用)/u,
  /【当前角色】[\s\S]{0,160}【(?:你的身份|会话令牌)】/u,
  /【会话令牌】[\s\S]{0,240}(?:qq_|readThroughSeq|调用二代状态工具)/u,
  /【此刻状态】[\s\S]{0,240}【当前唤醒】/u,
  /【当前唤醒】[\s\S]{0,240}【行动前】/u,
  /完整角色卡(?:请调用|已在本会话前面完整给过)/u,
])
const SUBCATEGORY_RULES = Object.freeze({
  fact: [
    ['residence', /(住在|居住|搬到|搬家|地址|城市|来自)/u],
    ['identity', /(我叫|我的名字|我是|身份|生日)/u],
    ['work', /(工作|公司|职业|上班|学习|学校|专业)/u],
    ['health', /(身体|生病|健康|过敏|吃药|看医生)/u],
    ['schedule', /(今天|昨天|明天|最近|正在|日程|安排)/u],
  ],
  preference: [
    ['response-format', /(回答|答复|顺序|结论|理由|细节|组织|表达|格式|先说|先看)/u],
    ['address', /(称呼|叫我|名字)/u],
    ['taste', /(吃|喝|菜|食物|口味|搭配|颜色|音乐|游戏|四格|盘)/u],
    ['routine', /(习惯|通常|每天|默认|喜欢.*方式)/u],
    ['media', /(书|电影|电视剧|动漫|音乐|游戏|作品)/u],
  ],
  relationship: [
    ['shared-experience', /(一起|共同|那天|上次|第一次|纪念|回忆|经历)/u],
    ['relationship-state', /(关系|家人|恋人|夫妻|朋友|亲近|信任)/u],
  ],
  emotion: [
    ['stress', /(焦虑|压力|紧张|担心|害怕|恐惧)/u],
    ['sleep', /(失眠|睡不着|做梦|疲惫|累)/u],
    ['affection', /(想你|想念|委屈|孤单|依赖)/u],
    ['mood', /(难过|开心|生气|烦|郁闷|高兴)/u],
  ],
  commitment: [
    ['reminder', /(请记得|别忘|提醒|回来告诉|约定)/u],
    ['promise', /(答应|承诺|保证)/u],
    ['plan', /(准备|计划|打算|明天要|今晚会|下次|我会|将要)/u],
    ['task', /(要做|完成|发给|处理|测试|修复|提交)/u],
  ],
  event: [
    ['travel', /(旅行|旅游|出发|回来|去了|到过|景点|海边|机场)/u],
    ['milestone', /(生日|纪念日|第一次|完成|上线|发布|搬迁|毕业)/u],
    ['conflict', /(争吵|吵架|冲突|误会|道歉|和好)/u],
    ['meal', /(吃了|饭菜|早餐|午餐|晚餐|点餐|菜盘)/u],
    ['conversation', /(聊天|谈到|说过|讨论|提起|对话)/u],
  ],
})
const CATEGORY_LABELS = Object.freeze({
  fact: '事实',
  preference: '偏好',
  relationship: '关系',
  emotion: '情绪',
  commitment: '承诺',
  event: '事件',
})

function now() {
  return new Date().toISOString()
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function semanticState(text) {
  const value = String(text || '').trim()
  if (/^(请记得|请记住|记得|记住|别忘(?:了)?|不要忘(?:了)?)/u.test(value)) {
    return { polarity: 'affirmed', modality: 'assertion', epistemicStatus: 'supported' }
  }
  if (/[?？]\s*$/u.test(value) || /^(是不是|是否|难道|你觉得)/u.test(value)) {
    return { polarity: 'uncertain', modality: 'question', epistemicStatus: 'candidate' }
  }
  if (/(如果|假如|要是|希望|想要|但愿|就好了)/u.test(value)) {
    return { polarity: 'hypothetical', modality: /(希望|想要|但愿|就好了)/u.test(value) ? 'wish' : 'assertion', epistemicStatus: 'candidate' }
  }
  if (/(听说|聽說|据说|據說|有人说|有人說|传闻|傳聞)/u.test(value)) {
    return { polarity: 'reported', modality: 'reported', epistemicStatus: 'candidate' }
  }
  if (/(可能|也许|大概|似乎|不确定)/u.test(value)) {
    return { polarity: 'uncertain', modality: 'assertion', epistemicStatus: 'candidate' }
  }
  if (/(答应|承诺)/u.test(value)) return { polarity: 'affirmed', modality: 'promise', epistemicStatus: 'supported' }
  if (/(准备|準備|计划|計畫|打算|明天要|今晚会|下次|会继续|會繼續|将要|將要|我会|我會|会在|會在|将会|將會)/u.test(value)) {
    return { polarity: 'affirmed', modality: 'plan', epistemicStatus: 'supported' }
  }
  if (/(不|没|没有|从不|从来没有|未曾|不是|并非|别)/u.test(value)) {
    return { polarity: 'negated', modality: 'assertion', epistemicStatus: 'supported' }
  }
  return { polarity: 'affirmed', modality: 'assertion', epistemicStatus: 'supported' }
}

function claimTypeFor(text, fallback, authority = null) {
  const value = String(text || '')
  if (/(我们(一直|仍然|就是|是).*(关系|家人|恋人|夫妻|朋友))/u.test(value)) return 'relationship_state'
  if (/(一直|通常|总是).*(喜欢|偏好|习惯)/u.test(value)) return 'trait'
  if (/(答应|承诺|请记得|别忘|回来告诉|提醒我)/u.test(value)) return 'commitment'
  if (/(准备|计划|打算|明天要|今晚会|下次|会继续|将要|我会|我会在)/u.test(value)) {
    return authority === 'assistant' ? 'commitment' : 'plan'
  }
  if (/(难过|开心|生气|焦虑|累|害怕|失眠|委屈|想你|想念)/u.test(value)) return 'affect'
  if (/(我们|一起|那天|上次|第一次|纪念|发生)/u.test(value)) return 'episode'
  return fallback
}

function evidenceRef(turn, quote) {
  const start = String(turn.text).indexOf(String(quote))
  if (start < 0 || [...String(quote).replace(/[\s\p{P}\p{S}]/gu, '')].length < 2) return null
  return {
    turnId: turn.id,
    start,
    end: start + String(quote).length,
    quote: String(quote),
    quoteHash: sha256(quote),
    speaker: turn.speaker,
    evidenceRole: 'assertion',
  }
}

function anchoredPuppetSource(memory, turns) {
  if (memory.sourceKind !== 'puppet-memory'
    || memory.visibility !== 'evidence-only'
    || memory.epistemicStatus !== 'candidate'
    || memory.migrationStatus !== 'quarantined'
    || memory.migrationReason !== 'legacy-span-speaker-polarity-unverified'
    || memory.speaker !== 'user'
    || !/^behavior\/diary\/\d{4}-\d{2}\.jsonl$/u.test(memory.sourceFile ?? '')) return false
  const quote = String(memory.evidence || '').trim()
  const summary = String(memory.summary || '').trim()
  if (quote.length < 4 || !summary || !quote.startsWith(summary) || !Array.isArray(memory.sourceTurnIds)
    || /[?？]|(?:如果|要是|假如|可能|也许|听说|据说)/u.test(quote)) return false
  return memory.sourceTurnIds.find((id) => {
    const source = turns.get(id)
    return source?.speaker === 'user'
      && source.sourceKind === 'puppet-memory'
      && source.sourceFile === memory.sourceFile
      && source.sessionId === memory.sourceSessionId
      && String(source.text ?? '').includes(quote)
  }) || false
}

function candidateIsRecallable(memory, verifiedLegacy = false) {
  // `recall-block` 只把 visibility 改成 'hidden'，原来这里只比对 'evidence-only'，
  // 于是「已阻断召回」的记忆照样被检索出来。deletionState 与 visibility 任一处标记都算阻断。
  return (memory?.visibility !== 'evidence-only' || verifiedLegacy)
    && memory?.visibility !== 'hidden'
    && !['deleted', 'superseded', 'hidden', 'review'].includes(memory?.status)
    && memory?.deletionState !== 'purged'
    && memory?.deletionState !== 'recall-blocked'
    && (['accepted', 'supported', undefined, null].includes(memory?.epistemicStatus)
      || verifiedLegacy)
}

function localEndOfDay(iso, timeZone = 'UTC', dayOffset = 0) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map((part) => [part.type, Number(part.value)]))
  const calendar = new Date(Date.UTC(values.year, values.month - 1, values.day + dayOffset))
  const target = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), 23, 59, 59, 999)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  let guess = target
  for (let index = 0; index < 4; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .map((part) => [part.type, Number(part.value)]))
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, new Date(guess).getUTCMilliseconds())
    const correction = target - localAsUtc
    guess += correction
    if (!correction) break
  }
  return new Date(guess).toISOString()
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function terms(text) {
  const value = normalize(text)
  const result = new Set()
  for (const token of value.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (token.length > 1) result.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      for (const char of token) if (!LEXICAL_STOP_CHARS.has(char)) result.add(char)
      for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2))
    }
  }
  return result
}

function lexicalScore(query, text) {
  const q = terms(query)
  if (!q.size) return 0
  const t = terms(text)
  let hits = 0
  for (const token of q) if (t.has(token)) hits++
  return hits / q.size
}

function puppetQueryAnchors(query) {
  const focused = normalize(query).replace(
    /你还记得|你记得|还记得|记不记得|接着|继续|之前|以前|上次|那次|关于|事情|怎么样|什么|怎样|怎么|哪些|我们|爸爸|今天|刚才|聊吧|(?<=[\p{Script=Han}])(?:吗|呢|吧)(?=[\p{P}\s]|$)/gu,
    ' ',
  )
  return puppetWords(focused)
}

const PUPPET_SEGMENTER = new Intl.Segmenter('zh-Hans', { granularity: 'word' })

function puppetWords(text) {
  return new Set([...PUPPET_SEGMENTER.segment(normalize(text))]
    .filter(({ isWordLike, segment }) => isWordLike && [...segment].length >= 2 && /\p{L}/u.test(segment))
    .map(({ segment }) => segment))
}

function focalWords(text) {
  return new Set([...puppetQueryAnchors(text)].filter((word) => !FOCAL_STOP_WORDS.has(word)))
}

function overlapCount(left, right) {
  let count = 0
  for (const word of left) if (right.has(word)) count++
  return count
}

function shortContinuation(text) {
  return text.length <= 32 && (CONTINUATION_CUE.test(text) || /再来|继续|老规矩|不改了|不换了/u.test(text))
    && SHORT_CONTINUATION.test(text)
}

function pastMealQuery(text) {
  return MEAL_WORD.test(text) && /上(?:次|回)|那顿|以前|之前|当时|那天|昨(?:天|晚)/u.test(text)
    && (PAST_MEAL.test(text) || (!/喜欢|偏好|习惯/u.test(text)
      && /(?:吃|点)上(?:次|回)|(?:上(?:次|回)|那天|当时).{0,8}(?:吃|点了)|那顿/u.test(text)))
}

function queryTopic(text) {
  const value = String(text || '')
  if (/(回答|答复|顺序|结论|理由|细节|组织|表达|格式|先说|先看)/u.test(value)
    && /(偏好|喜欢|顺序|结论|理由|细节|先说|先看)/u.test(value)) return 'preference:response-format'
  if (/(称呼|叫我|名字)/u.test(value)) return 'preference:address'
  if (/(吃|喝|菜|食物|口味|搭配|颜色|音乐|游戏|四格|盘)/u.test(value)) return 'preference:taste'
  if (/(住在|居住|搬家|地址|城市|来自)/u.test(value)) return 'fact:residence'
  if (/(焦虑|压力|紧张|担心|害怕|恐惧)/u.test(value)) return 'emotion:stress'
  if (/(失眠|睡不着|做梦|疲惫|累)/u.test(value)) return 'emotion:sleep'
  if (/(想你|想念|委屈|孤单|依赖)/u.test(value)) return 'emotion:affection'
  if (/(难过|开心|生气|烦|郁闷|高兴)/u.test(value)) return 'emotion:mood'
  if (/(承诺|答应|要求.*记住|请记得|别忘|周五|约定|提醒|要做|未完成|还没完成)/u.test(value)) return 'commitment'
  if (/(旅行|旅游|出发|回来|去了|到过|景点|海边|机场)/u.test(value)) return 'event:travel'
  if (/(生日|纪念日|第一次|完成|上线|发布|搬迁|毕业)/u.test(value)) return 'event:milestone'
  if (/(争吵|吵架|冲突|误会|道歉|和好)/u.test(value)) return 'event:conflict'
  if (/(吃了|饭菜|早餐|午餐|晚餐|点餐|菜盘)/u.test(value)) return 'event:meal'
  if (/(一起|海边|贝壳|共同|关系|那天|经历|发生)/u.test(value)) return 'relationship'
  return null
}

function stripRetrievalWrapper(text) {
  return String(text || '')
    .replace(/^不要调用记忆工具[，, ]*只依据系统上下文回答[；;，, ]*没有依据就明确说不知道[。.!！]*/u, '')
    .trim()
}

function topicMatches(memory, topic) {
  if (!topic || !memory) return false
  if (memory.factKey === topic || memory.claimKey === topic
    || memory.kind === topic
    || `${memory.kind}:${memory.subcategory || ''}` === topic) return true
  const text = `${memory.summary || ''} ${memory.evidence || ''}`
  if (topic === 'preference:response-format') return memory.kind === 'preference' && /(回答|答复|顺序|结论|理由|细节|组织|表达|格式|先说|先看)/u.test(text)
  if (topic === 'preference:address') return memory.kind === 'preference' && /(称呼|叫我|名字)/u.test(text)
  if (topic === 'preference:taste') return memory.kind === 'preference' && /(吃|喝|菜|食物|口味|搭配|颜色|音乐|游戏|四格|盘)/u.test(text)
  if (topic === 'fact:residence') return memory.kind === 'fact' && /(住在|居住|搬家|地址|城市|来自)/u.test(text)
  if (topic === 'commitment') return memory.kind === 'commitment'
  if (topic === 'relationship') return memory.kind === 'relationship'
  return false
}

function subcategoryFor(kind, text) {
  const value = String(text || '')
  const rules = SUBCATEGORY_RULES[kind] || []
  return rules.find(([, pattern]) => pattern.test(value))?.[0] || 'other'
}

function parseJsonLoose(text) {
  const raw = String(text ?? '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const starts = ['{', '['].map((mark) => candidate.indexOf(mark)).filter((index) => index >= 0)
    const start = starts.length ? Math.min(...starts) : -1
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (start < 0 || end <= start) throw new Error('模型没有返回可解析的 JSON')
    return JSON.parse(candidate.slice(start, end + 1))
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block === 'string') return block
    return block?.type === 'text' ? String(block.text ?? '') : ''
  }).filter(Boolean).join('\n')
}

function messageText(message) {
  return textOfContent(message?.content)
}

function message(id, text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function keyFor(kind, text) {
  if (kind === 'preference') {
    if (/(结论|证据|报告|背景|格式|组织|呈现|先看)/u.test(text)) return 'preference:response-format'
    if (/(称呼|叫我|名字)/u.test(text)) return 'preference:address'
    if (/(喜欢|不喜欢|讨厌).*(吃|喝|食物|颜色|音乐|游戏)/u.test(text)) return 'preference:taste'
  }
  if (kind === 'fact' && /(住在|居住|搬到|搬家|地址|城市|来自)/u.test(text)) return 'fact:residence'
  return `${kind}:${normalize(text)
    .replace(/(我|你|她|他|我们|以后|现在|今天|最近|请|希望|记得|别忘了)/gu, '')
    .replace(/[，。！？、,.!?：:；;]/gu, ' ')
    .trim().slice(0, 100)}`
}

function classify(text, speaker) {
  const value = String(text)
  if (!value.trim() || value.trim().length < 4 || LOW_VALUE.test(value.trim())) return null
  if (speaker === 'user' && MEMORY_META_QUERY.test(value)) return null
  if (/[?？]\s*$/u.test(value) || /^(你还记得|你记得|是什么|是否|能不能|可以吗|为什么|什么时候|哪一个|哪些)/u.test(value.trim())) return null
  if (speaker === 'assistant' && isAssistantAcknowledgement(value)) return null
  if (speaker === 'user'
    && DAILY_EVENT.test(value)
    && !/(请记得|请记住|记得|别忘|答应|承诺|提醒)/u.test(value)) return 'event'
  if (speaker === 'assistant' && /(我会|我答应|下次我|我会把)/u.test(value)) return 'commitment'
  if (speaker === 'assistant') return null
  if (speaker === 'user' && /(答应|承诺|请记得|别忘|下次|要不要提醒|回来告诉|我会|我准备|计划|今晚会|明天要)/u.test(value)) return 'commitment'
  if (/(喜欢|不喜欢|讨厌|偏好|习惯|称呼|叫我|希望你|不要叫)/u.test(value)
    || (/(改了|改成|现在)/u.test(value) && /(结论|证据|报告|背景|格式|称呼|喜欢|偏好)/u.test(value))) return 'preference'
  if (/(难过|开心|生气|焦虑|累|害怕|失眠|委屈|想你|想念)/u.test(value)) return 'emotion'
  if (/(我们|一起|那天|上次|第一次|纪念|发生)/u.test(value)) return 'relationship'
  if (/(昨天|昨晚|刚才|后来|当时|结果|遇到|去了|旅行|旅游|吃了|看了|完成了|结束了|开始了|发生了)/u.test(value)) return 'event'
  if (speaker === 'user' && /(我|我的|我叫|我是|今天|昨天|明天|最近|正在|已经|准备|计划|住在|来自|工作|学习|发生)/u.test(value)) return 'fact'
  return null
}

function isRuntimeInjection(text, speaker, forcedKind = null) {
  // DSH may prepend a large runtime prompt as a user-sourced message. It is
  // context for the current turn, not a user claim, so do not persist it.
  if (speaker !== 'user' || forcedKind) return false
  const value = String(text || '').trim()
  if (value.length < 80) return false
  const header = /^【当前时间】/u.test(value) || /^【当前角色】/u.test(value)
  return header && RUNTIME_INJECTION_MARKERS.some((pattern) => pattern.test(value))
}

function isAssistantAcknowledgement(text) {
  const value = String(text || '').trim()
  return /(?:好的?[，, ]*)?(?:收到|明白|了解|我)?(?:已经|已)?(?:记住了|记下了|记录好了|存好了)/u.test(value)
    || /^(?:好的?[，, ]*)?(?:我会|以后我会|我将会|我会照着)(?:按|按照|照着).*(?:回答|记|执行)/u.test(value)
    || /^(?:这条|这个)(?:偏好|约定|记忆).*(?:记住|记录|存下)/u.test(value)
    || /(?:以后|默认)(?:我)?(?:按|会按|照着).*(?:回答|顺序|结论|理由|细节)/u.test(value)
    || /(?:自动检索到|自动注入.*记忆|本会话.*记忆|当前.*上下文.*记忆|根据.*上下文.*记忆|系统上下文里.*记忆|这条记录|我没有调用.*记忆工具)/u.test(value)
}

function recordType(kind) {
  return kind === 'commitment' ? 'commitment' : ['relationship', 'emotion', 'event'].includes(kind) ? 'event' : 'entity'
}

function subjectType(kind) {
  if (kind === 'relationship') return 'relationship'
  if (kind === 'emotion') return 'person-state'
  if (kind === 'commitment') return 'agreement'
  return 'person'
}

function importance(kind, text) {
  let value = kind === 'commitment' || kind === 'relationship' ? 0.85 : 0.55
  if (/(重要|一直|永远|最|第一次|答应|不能忘)/u.test(text)) value += 0.1
  if (text.length > 80) value += 0.05
  return clamp(value)
}

function isDailyMemory(kind, text) {
  return kind === 'event' && DAILY_EVENT.test(String(text))
}

function dailyExpiresAt(occurredAt) {
  const value = new Date(occurredAt)
  if (Number.isNaN(value.getTime())) return null
  value.setUTCDate(value.getUTCDate() + DAILY_MEMORY_RETENTION_DAYS)
  return value.toISOString()
}

function shouldPromoteDaily(memory, candidate) {
  if (memory.retentionClass !== 'daily') return false
  if (candidate.retentionClass !== 'daily') return true
  const sessions = new Set([
    ...(memory.supportSessionIds || []),
    memory.sourceSessionId,
    candidate.sourceSessionId,
  ].filter(Boolean))
  const dates = new Set([
    ...(memory.supportDates || []),
    dayKey(memory.occurredAt),
    dayKey(candidate.occurredAt),
  ].filter(Boolean))
  return sessions.size >= 2 || (dates.size >= 2 && Number(memory.reinforcementCount || 0) >= 2)
}

function strength(memory, at) {
  const seen = new Date(memory.lastReinforcedAt || memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt).getTime()
  const ageHours = Math.max(0, (new Date(at).getTime() - seen) / 3600000)
  const base = clamp(memory.strength ?? memory.importance, 0.05, 1)
  const confirmedRecalls = Number(memory.confirmedRecallCount ?? memory.recallCount ?? 0)
  const rehearsals = confirmedRecalls + Number(memory.reinforcementCount || 0)
  const boost = Math.min(0.35, Math.log2(rehearsals + 1) * 0.08)
  const halfLife = memory.retentionClass === 'daily'
    ? DAILY_MEMORY_HALF_LIFE_HOURS
    : HALF_LIFE_HOURS[memory.kind] ?? HALF_LIFE_HOURS.fact
  return clamp((base + boost) * Math.pow(0.5, ageHours / halfLife))
}

function freshness(memory, at) {
  const seen = new Date(memory.lastReinforcedAt || memory.lastSupportedAt || memory.lastSeenAt || memory.occurredAt || memory.recordedAt).getTime()
  const ageHours = Math.max(0, (new Date(at).getTime() - seen) / 3600000)
  const halfLife = memory.retentionClass === 'daily'
    ? DAILY_MEMORY_HALF_LIFE_HOURS
    : HALF_LIFE_HOURS[memory.kind] ?? HALF_LIFE_HOURS.fact
  return clamp(Math.pow(0.5, ageHours / halfLife), 0.02, 1)
}

function dayKey(value) {
  return new Date(value).toISOString().slice(0, 10)
}

function normalizeMemoryRow(row) {
  const recordedAt = row.recordedAt || row.createdAt || row.occurredAt || now()
  return {
    ...row,
    subcategory: row.subcategory || subcategoryFor(row.kind, `${row.summary || ''} ${row.evidence || ''}`),
    retentionClass: row.retentionClass || 'durable',
    dailyExpiresAt: row.dailyExpiresAt || null,
    promotionScore: Number(row.promotionScore ?? (row.retentionClass === 'daily' ? 0.25 : 1)),
    promotionState: row.promotionState || (row.retentionClass === 'daily' ? 'watching' : 'durable'),
    supportSessionIds: [...new Set([
      ...(Array.isArray(row.supportSessionIds) ? row.supportSessionIds : []),
      row.sourceSessionId,
    ].filter(Boolean))],
    supportDates: [...new Set([
      ...(Array.isArray(row.supportDates) ? row.supportDates : []),
      row.occurredAt ? dayKey(row.occurredAt) : null,
    ].filter(Boolean))],
    occurredAt: row.occurredAt || recordedAt,
    recordedAt,
    lastSeenAt: row.lastSeenAt || row.occurredAt || recordedAt,
    lastSupportedAt: row.lastSupportedAt || row.lastSeenAt || row.occurredAt || recordedAt,
    lastReinforcedAt: row.lastReinforcedAt || null,
    lastRecalledAt: row.lastRecalledAt || null,
    recallCount: Number(row.recallCount || 0),
    confirmedRecallCount: Number(row.confirmedRecallCount ?? row.recallCount ?? 0),
    reinforcementCount: Number(row.reinforcementCount || 0),
  }
}

function normalizeTurnRow(row) {
  const occurredAt = row.occurredAt || row.createdAt || row.recordedAt || now()
  const recordedAt = row.recordedAt || row.createdAt || occurredAt
  return {
    ...row,
    occurredAt,
    recordedAt,
    createdAt: row.createdAt || occurredAt,
  }
}

class MemoryEngine {
  constructor(root, maxRecall = 6, options = {}) {
    this.root = resolve(root)
    this.maxRecall = maxRecall
    this.dailyWriteBudget = Number(options.dailyWriteBudget ?? DEFAULT_DAILY_WRITE_BUDGET)
    this.semanticThreshold = Number(options.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD)
    this.timezone = options.timezone || 'UTC'
    this.llm = options.llm ?? null
    this.llmEveryTurns = Math.max(1, Number(options.llmEveryTurns ?? 8))
    this.modelCost = {
      inputPerMillion: Number(options.modelCost?.inputPerMillion || 0),
      outputPerMillion: Number(options.modelCost?.outputPerMillion || 0),
    }
    this.pricingModel = options.pricingModel || options.llmModel || 'deepseek-flash'
    this.pricingPeak = options.pricingPeriod === 'peak' || options.pricingPeak === true
    this.sessions = new Map()
    this.turns = []
    this.memories = new Map()
    this.events = []
    this.seenSources = new Set()
    this.seenUsageSources = new Set()
    this.consolidationCursors = {}
    this.purgedTurnIds = new Set()
    this.metricsRows = []
    this.usage = {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      estimatedCostCny: 0,
    }
    this.llmStats = {
      calls: 0,
      jsonErrors: 0,
      evidenceRejected: 0,
      estimatedCostUsd: 0,
      estimatedCostCny: 0,
    }
  }

  async init() {
    await mkdir(this.root, { recursive: true })
    for (const row of await this.readJsonl('sessions.jsonl')) this.sessions.set(row.id, row)
    this.turns = (await this.readJsonl('turns.jsonl')).map(normalizeTurnRow)
    for (const row of this.turns) if (row.sourceKey) this.seenSources.add(row.sourceKey)
    try {
      const value = JSON.parse(await readFile(join(this.root, 'memories.json'), 'utf8'))
      for (const row of Array.isArray(value) ? value : []) {
        const normalized = normalizeMemoryRow(row)
        this.memories.set(normalized.id, normalized)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.events = await this.readJsonl('events.jsonl')
    try {
      this.consolidationCursors = JSON.parse(await readFile(join(this.root, 'consolidation-cursors.json'), 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      this.purgedTurnIds = new Set(JSON.parse(await readFile(join(this.root, 'purged-turn-ids.json'), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.metricsRows = await this.readJsonl('metrics.jsonl')
    for (const row of this.metricsRows) {
      if (row.kind !== 'model-call') continue
      if (row.sourceKey) this.seenUsageSources.add(row.sourceKey)
      this.usage.modelCalls += 1
      this.usage.inputTokens += Number(row.inputTokens || 0)
      this.usage.outputTokens += Number(row.outputTokens || 0)
      this.usage.cacheReadTokens += Number(row.cacheReadTokens || 0)
      this.usage.cacheWriteTokens += Number(row.cacheWriteTokens || 0)
      this.usage.totalTokens += Number(row.totalTokens || 0)
      this.usage.estimatedCostUsd += Number(row.estimatedCostUsd || 0)
      this.usage.estimatedCostCny += Number(row.estimatedCostCny || 0)
      if (row.purpose) {
        this.llmStats.calls += 1
        this.llmStats.jsonErrors += Number(row.jsonErrors || 0)
        this.llmStats.evidenceRejected += Number(row.evidenceRejected || 0)
        this.llmStats.estimatedCostUsd += Number(row.estimatedCostUsd || 0)
        this.llmStats.estimatedCostCny += Number(row.estimatedCostCny || 0)
      }
    }
    return this
  }

  async readJsonl(file) {
    try {
      const value = await readFile(join(this.root, file), 'utf8')
      return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async append(file, value) {
    await mkdir(dirname(join(this.root, file)), { recursive: true })
    await appendFile(join(this.root, file), `${JSON.stringify(value)}\n`, 'utf8')
  }

  async recordUsage(usage, sourceKey) {
    if (!usage || typeof usage !== 'object' || (sourceKey && this.seenUsageSources.has(sourceKey))) return
    const row = {
      at: now(),
      kind: 'model-call',
      inputTokens: Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? usage.prompt_cache_hit_tokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      totalTokens: Number(usage.totalTokens ?? usage.total_tokens ?? 0),
      model: usage.model ?? this.pricingModel,
      sourceKey,
    }
    row.estimatedCostUsd = this.estimateCost(row)
    row.estimatedCostCny = this.estimateDeepSeekCost(row).totalCny
    this.metricsRows.push(row)
    this.usage.modelCalls += 1
    this.usage.inputTokens += row.inputTokens
    this.usage.outputTokens += row.outputTokens
    this.usage.cacheReadTokens += row.cacheReadTokens
    this.usage.cacheWriteTokens += row.cacheWriteTokens
    this.usage.totalTokens += row.totalTokens
    this.usage.estimatedCostUsd += row.estimatedCostUsd
    this.usage.estimatedCostCny += row.estimatedCostCny
    if (sourceKey) this.seenUsageSources.add(sourceKey)
    await this.append('metrics.jsonl', row)
  }

  async recordModelMetric(metric) {
    const row = {
      at: now(),
      kind: 'model-call',
      inputTokens: Number(metric.inputTokens ?? metric.promptTokens ?? metric.prompt_tokens ?? 0),
      outputTokens: Number(metric.outputTokens ?? metric.completionTokens ?? metric.completion_tokens ?? 0),
      cacheReadTokens: Number(metric.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(metric.cacheWriteTokens ?? 0),
      totalTokens: Number(metric.totalTokens ?? metric.total_tokens ?? 0),
      model: metric.model ?? null,
      purpose: metric.purpose ?? null,
      jsonErrors: Number(metric.jsonErrors || 0),
      evidenceRejected: Number(metric.evidenceRejected || 0),
      estimatedCostUsd: Number(metric.estimatedCostUsd ?? 0),
      sessionId: metric.sessionId ?? null,
    }
    row.estimatedCostCny = Number(metric.estimatedCostCny ?? this.estimateDeepSeekCost(row).totalCny)
    this.metricsRows.push(row)
    this.usage.modelCalls += 1
    this.usage.inputTokens += row.inputTokens
    this.usage.outputTokens += row.outputTokens
    this.usage.cacheReadTokens += row.cacheReadTokens
    this.usage.cacheWriteTokens += row.cacheWriteTokens
    this.usage.totalTokens += row.totalTokens
    this.usage.estimatedCostUsd += row.estimatedCostUsd
    this.usage.estimatedCostCny += row.estimatedCostCny
    this.llmStats.calls += 1
    this.llmStats.jsonErrors += row.jsonErrors
    this.llmStats.evidenceRejected += row.evidenceRejected
    this.llmStats.estimatedCostUsd += row.estimatedCostUsd
    this.llmStats.estimatedCostCny += row.estimatedCostCny
    await this.append('metrics.jsonl', row)
    return row
  }

  estimateCost(usage) {
    const providerCost = Number(usage?.costUsd ?? usage?.cost_usd ?? usage?.cost)
    if (Number.isFinite(providerCost) && providerCost > 0) return providerCost
    const input = Number(usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.promptTokens ?? 0)
    const output = Number(usage?.outputTokens ?? usage?.completion_tokens ?? usage?.completionTokens ?? 0)
    return (input * this.modelCost.inputPerMillion + output * this.modelCost.outputPerMillion) / 1_000_000
  }

  estimateDeepSeekCost(usage, model = null) {
    return calculateDeepSeekCost({
      model: model || usage?.model || this.pricingModel,
      inputTokens: usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.promptTokens ?? 0,
      outputTokens: usage?.outputTokens ?? usage?.completion_tokens ?? usage?.completionTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? usage?.prompt_cache_hit_tokens ?? 0,
      peak: this.pricingPeak,
    })
  }

  async writeJson(file, value) {
    const target = join(this.root, file)
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temp, target)
  }

  async session(sessionId, parentSessionId = null) {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = {
        id: sessionId,
        parentSessionId,
        createdAt: now(),
        lastTurnAt: null,
        turnCount: 0,
      }
      this.sessions.set(sessionId, session)
      await this.append('sessions.jsonl', session)
    }
    return session
  }

  async ingest({
    sessionId,
    parentSessionId = null,
    speaker,
    text,
    sourceKey,
    occurredAt = now(),
    writePriority = null,
    forcedKind = null,
  }) {
    const value = String(text ?? '').trim()
    if (!value || (sourceKey && this.seenSources.has(sourceKey))) return { stored: false, reason: 'duplicate-or-empty' }
    if (!['user', 'assistant', 'system', 'external'].includes(speaker)) {
      throw new Error(`invalid turn speaker: ${speaker}`)
    }
    if (isRuntimeInjection(value, speaker, forcedKind)) {
      const event = {
        at: now(),
        type: 'write-filtered',
        reason: 'internal-runtime-injection',
        sessionId,
        sourceKey: sourceKey ?? null,
        textHash: sha256(value),
        textLength: value.length,
      }
      this.events.push(event)
      if (sourceKey) this.seenSources.add(sourceKey)
      await this.append('events.jsonl', event)
      return { stored: false, filtered: true, reason: 'internal-runtime-injection' }
    }
    await this.session(sessionId, parentSessionId)
    const turn = {
      id: `turn_${randomUUID().replaceAll('-', '')}`,
      sessionId,
      speaker,
      text: value,
      sourceKey: sourceKey ?? null,
      contentHash: sha256(value),
      occurredAt,
      recordedAt: now(),
    }
    this.turns.push(turn)
    if (sourceKey) this.seenSources.add(sourceKey)
    await this.append('turns.jsonl', turn)
    const kind = ['fact', 'preference', 'relationship', 'emotion', 'commitment', 'event'].includes(forcedKind)
      ? forcedKind
      : classify(value, speaker)
    if (!kind) return { stored: true, candidate: null, turn }
    const score = importance(kind, value)
    const candidate = {
      id: `memory_${randomUUID().replaceAll('-', '')}`,
      kind,
      subcategory: subcategoryFor(kind, value),
      recordType: recordType(kind),
      subjectType: subjectType(kind),
      subject: speaker,
      speaker,
      summary: value.slice(0, 240),
      evidence: value.slice(0, 500),
      sourceTurnIds: [turn.id],
      sourceSessionId: sessionId,
      sourceKind: 'dsh-event',
      sandboxOwned: true,
      occurredAt,
      recordedAt: now(),
      lastSeenAt: occurredAt,
      lastSupportedAt: turn.recordedAt,
      lastReinforcedAt: null,
      lastRecalledAt: null,
      importance: score,
      strength: score,
      retentionClass: isDailyMemory(kind, value) ? 'daily' : 'durable',
      dailyExpiresAt: isDailyMemory(kind, value) ? dailyExpiresAt(occurredAt) : null,
      promotionScore: isDailyMemory(kind, value) ? 0.25 : 1,
      promotionState: isDailyMemory(kind, value) ? 'watching' : 'durable',
      supportSessionIds: [sessionId],
      supportDates: [dayKey(occurredAt)],
      recallCount: 0,
      confirmedRecallCount: 0,
      reinforcementCount: 0,
      freshness: 1,
      status: kind === 'commitment' ? 'open' : 'active',
      dueAt: kind === 'commitment' && /今晚/u.test(value)
        ? localEndOfDay(occurredAt, this.timezone)
        : kind === 'commitment' && /后天/u.test(value)
          ? localEndOfDay(occurredAt, this.timezone, 2)
          : kind === 'commitment' && /明天/u.test(value)
            ? localEndOfDay(occurredAt, this.timezone, 1)
            : null,
      factKey: keyFor(kind, value),
      source: sourceKey ?? turn.id,
      writePolicy: 'local-signal',
      writePriority: writePriority || (['commitment', 'relationship'].includes(kind) ? 'priority' : 'normal'),
    }
    const semantic = semanticState(value)
    const ref = evidenceRef(turn, value)
    const authority = turn.speaker === 'user' ? 'user' : turn.speaker === 'assistant' ? 'assistant' : 'external'
    candidate.claimType = claimTypeFor(value, kind, authority)
    candidate.authority = authority
    candidate.polarity = semantic.polarity
    candidate.modality = semantic.modality
    const explicitRemember = Boolean(forcedKind)
    candidate.epistemicStatus = authority === 'user'
      && ref
      && (explicitRemember
        ? !['question', 'wish', 'reported'].includes(semantic.modality)
        : semantic.polarity === 'affirmed'
          && ['assertion', 'promise'].includes(semantic.modality))
      ? 'accepted'
      : semantic.epistemicStatus
    candidate.visibility = candidate.epistemicStatus === 'accepted'
      || (authority === 'assistant' && candidate.claimType === 'commitment' && ['promise', 'plan'].includes(semantic.modality))
      ? 'recallable'
      : 'evidence-only'
    candidate.deletionState = 'live'
    candidate.claimKey = candidate.factKey
    candidate.evidenceRefs = ref ? [ref] : []
    const memory = await this.remember(candidate)
    return {
      stored: true,
      candidate: memory ? candidate : { ...candidate, writeStatus: 'suppressed' },
      memory,
      suppressed: !memory,
      turn,
    }
  }

  async remember(candidate) {
    const priority = candidate.writePriority
      || (['commitment', 'relationship'].includes(candidate.kind) ? 'priority' : 'normal')
    candidate.writePriority = priority
    if (candidate.status === 'review') return this.saveMemory(candidate, 'candidate-review')
    const existing = [...this.memories.values()]
      .filter((row) => !['superseded', 'deleted'].includes(row.status)
        && (row.kind === candidate.kind
          || (row.factKey && candidate.factKey && row.factKey === candidate.factKey))
        && row.speaker === candidate.speaker
        && ((row.factKey && candidate.factKey && row.factKey === candidate.factKey)
          || Math.max(lexicalScore(row.summary, candidate.summary), lexicalScore(candidate.summary, row.summary)) >= 0.45))
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))[0]
    if (existing) {
      if (normalize(existing.summary) === normalize(candidate.summary)) {
        const sourceTurnIds = new Set(existing.sourceTurnIds || [])
        const newEvidence = (candidate.sourceTurnIds || []).some((turnId) => !sourceTurnIds.has(turnId))
        existing.lastSeenAt = candidate.lastSeenAt
        existing.freshness = 1
        existing.evidence = candidate.evidence
        existing.sourceTurnIds = [...new Set([...(existing.sourceTurnIds || []), ...(candidate.sourceTurnIds || [])])]
        if (newEvidence) {
          existing.reinforcementCount = Number(existing.reinforcementCount || 0) + 1
          existing.supportSessionIds = [...new Set([
            ...(existing.supportSessionIds || []),
            existing.sourceSessionId,
            candidate.sourceSessionId,
          ].filter(Boolean))]
          existing.supportDates = [...new Set([
            ...(existing.supportDates || []),
            dayKey(existing.occurredAt),
            dayKey(candidate.occurredAt),
          ].filter(Boolean))]
          if (existing.retentionClass === 'daily') {
            existing.promotionScore = clamp(
              Number(existing.promotionScore || 0.25)
                + (existing.supportSessionIds.length > 1 ? 0.4 : 0.2),
            )
          }
        }
        if (newEvidence && shouldPromoteDaily(existing, candidate)) {
          existing.retentionClass = 'durable'
          existing.dailyExpiresAt = null
          existing.promotionState = 'promoted'
          existing.promotedAt = now()
          existing.promotionReason = candidate.retentionClass === 'daily'
            ? 'cross-session-or-cross-day-rehearsal'
            : 'later-durable-evidence'
          existing.importance = Math.max(Number(existing.importance || 0), 0.72)
          existing.strength = Math.max(Number(existing.strength || 0), existing.importance)
          await this.saveMemory(existing, 'promote', { reason: existing.promotionReason })
          return existing
        }
        existing.recordedAt = existing.recordedAt || now()
        await this.saveMemory(existing, 'refresh', { source: candidate.source ?? null })
        return existing
      }
      if (priority === 'normal' && existing.writePriority === 'priority') {
        const event = {
          at: now(),
          type: 'write-suppressed',
          memoryId: candidate.id,
          kind: candidate.kind,
          reason: 'priority-memory-protected',
          protectedMemoryId: existing.id,
        }
        this.events.push(event)
        await this.append('events.jsonl', event)
        // Keep an auditable, non-recallable copy so a low-frequency model
        // candidate cannot silently disappear when a user-priority claim wins.
        candidate.status = 'review'
        candidate.visibility = 'evidence-only'
        candidate.epistemicStatus = 'candidate'
        await this.saveMemory(candidate, 'candidate-review', {
          protectedMemoryId: existing.id,
          reason: 'priority-memory-protected',
        })
        return existing
      }
      existing.status = 'superseded'
      await this.saveMemory(existing, 'supersede')
      candidate.supersedes = existing.id
    }
    if (priority === 'normal' && this.dailyWriteBudget >= 0) {
      const date = dayKey(candidate.recordedAt || now())
      const writes = this.events.filter((event) => (
        event.type === 'create'
        && event.priority === 'normal'
        && dayKey(event.at) === date
      )).length
      if (writes >= this.dailyWriteBudget) {
        const event = {
          at: now(),
          type: 'write-suppressed',
          memoryId: candidate.id,
          kind: candidate.kind,
          reason: 'daily-soft-budget',
          budget: this.dailyWriteBudget,
          date,
        }
        this.events.push(event)
        await this.append('events.jsonl', event)
        return null
      }
    }
    candidate.writePriority = priority
    return this.saveMemory(candidate, 'create')
  }

  async saveMemory(memory, type, extra = {}) {
    this.memories.set(memory.id, memory)
    await this.writeJson('memories.json', [...this.memories.values()])
    const event = {
      at: now(),
      type,
      memoryId: memory.id,
      priority: memory.writePriority ?? null,
      ...extra,
    }
    this.events.push(event)
    await this.append('events.jsonl', event)
    return memory
  }

  async retrieve(query, sessionId = null, { logQuery = null, mode = 'tool', reference = null, skip = false } = {}) {
    const started = Date.now()
    const value = stripRetrievalWrapper(query)
    const direct = stripRetrievalWrapper(logQuery ?? query)
    const commitmentIntent = /(承诺|答应|要求.*记住|别忘|未完成|还没完成)/u.test(direct)
    const relationshipIntent = /(我们|共同|关系|那次|上次发生|修复)/u.test(direct)
    const historic = SEMANTIC_HISTORY_QUERY.test(direct) || /上回/u.test(direct)
    const mealHistory = pastMealQuery(direct)
    const topic = queryTopic(direct) || (commitmentIntent ? 'commitment' : relationshipIntent ? 'relationship' : null)
    const at = now()
    const legacyTurns = new Map(this.turns
      .filter((turn) => turn.sourceKind === 'puppet-memory' && !this.purgedTurnIds.has(turn.id))
      .map((turn) => [turn.id, turn]))
    const legacyAnchors = reference?.words ?? puppetQueryAnchors(direct)
    const directWords = focalWords(direct)
    const candidates = (skip ? [] : [...this.memories.values()])
      .flatMap((row) => {
        const legacy = anchoredPuppetSource(row, legacyTurns)
        if (!candidateIsRecallable(row, legacy)) return []
        if (row.retentionClass === 'daily'
          && row.dailyExpiresAt
          && new Date(row.dailyExpiresAt).getTime() <= new Date(at).getTime()) return []
        const text = `${row.summary} ${row.evidence}`
        const lexical = lexicalScore(direct, `${text} ${row.factKey}`)
        if (reference && !overlapCount(reference.words, focalWords(text))) return []
        if (mealHistory && (!['event', 'relationship'].includes(row.kind) || !PAST_MEAL.test(row.evidence || '')
          || (row.polarity && row.polarity !== 'affirmed')
          || (!reference && !overlapCount(directWords, focalWords(text))))) return []
        const reviewedHistory = row.sourceKind === 'puppet-qq-reviewed'
        if (reviewedHistory) {
          const anchors = overlapCount(directWords, focalWords(text))
          if (!REVIEWED_HISTORY_QUERY.test(direct) || !(anchors >= 2 || (anchors === 1 && lexical >= 0.38))) return []
        }
        const recent = freshness(row, at)
        const effectiveStrength = strength(row, at)
        if (mode === 'auto' && row.kind === 'emotion' && effectiveStrength < FADED_MEMORY_STRENGTH
          && !(historic && overlapCount(directWords, focalWords(text)))) return []
        const intent = commitmentIntent && row.kind === 'commitment' ? (row.speaker === 'user' ? 0.55 : 0.18) : relationshipIntent && row.kind === 'relationship' ? 0.4 : 0
        const sameSession = sessionId && row.sourceSessionId === sessionId ? 0.08 : 0
        const priorityBoost = row.writePriority === 'priority' ? 0.12 : 0
        const topicMatch = topicMatches(row, topic)
        const topicBoost = topic && topicMatch ? 0.3 : 0
        const topicPenalty = topic && !topicMatch && lexical < 0.4 ? 0.35 : 0
        const focusScore = reference ? lexicalScore(reference.focus.text, text) : 0
        const score = Math.max(lexical, focusScore) * 0.52 + recent * 0.1 + effectiveStrength * 0.12 + row.importance * 0.08
          + intent + sameSession + priorityBoost + topicBoost - topicPenalty
        if (legacy) {
          const sourceTerms = puppetWords(row.evidence)
          const anchors = [...legacyAnchors].filter((token) => sourceTerms.has(token)).length
          if (!anchors) return []
          return [{ memory: row, score: anchors / legacyAnchors.size * 0.72 + lexical * 0.18 + recent * 0.05, lexical, semantic: false, topicMatch, legacy }]
        }
        return [{ memory: row, score, lexical, focusScore, semantic: false, topicMatch, reviewedHistory }]
      })
    const lexicalMax = candidates.reduce((max, item) => Math.max(max, item.lexical), 0)
    let semanticUsed = false
    if (!skip && this.llm && historic && !reference && lexicalMax < this.semanticThreshold) {
      const semantic = await this.semanticRetrieve(value, candidates, sessionId)
      semanticUsed = semantic.used
      for (const item of semantic.items) {
        const candidate = candidates.find((entry) => entry.memory.id === item.memoryId)
        if (candidate) {
          candidate.score += item.score
          candidate.semantic = true
        }
      }
    }
    const hits = candidates
      .filter((item) => {
        if (item.legacy || item.semantic || item.reviewedHistory) return true
        if (reference) return item.focusScore >= 0.2
        if (mealHistory) return true
        if (topic) return item.topicMatch || item.lexical >= 0.6
        return item.lexical >= 0.2
          || (commitmentIntent && item.memory.kind === 'commitment')
          || (relationshipIntent && item.memory.kind === 'relationship')
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, reference || mealHistory ? Math.min(1, this.maxRecall) : this.maxRecall)
    this.events.push({
      at,
      type: 'recall',
      query: String(logQuery ?? value).slice(0, 180),
      retrievalQuery: value !== String(logQuery ?? value) ? value.slice(0, 1800) : undefined,
      mode,
      durationMs: Date.now() - started,
      hitCount: hits.length,
      semanticUsed,
    })
    await this.append('events.jsonl', this.events.at(-1))
    return hits
  }

  async semanticRetrieve(query, candidates, sessionId = null) {
    const pool = [...candidates]
      .sort((a, b) => (b.score + b.memory.importance * 0.1) - (a.score + a.memory.importance * 0.1))
      .slice(0, 12)
    if (!pool.length) return { used: false, items: [] }
    const prompt = [
      '你是轻量记忆检索器，只能从候选 memoryId 中选择真正相关的记忆。',
      '不要创造 ID，不要改写记忆。输出严格 JSON：{"memoryIds":["候选ID"]}。',
      `查询：${String(query).slice(0, 240)}`,
      `候选：${pool.map((item) => `${item.memory.id} | ${item.memory.summary} | ${item.memory.evidence}`).join('\n')}`,
    ].join('\n')
    try {
      const response = await this.llm.chatJson([
        { role: 'system', content: prompt },
        { role: 'user', content: String(query).slice(0, 240) },
      ], { temperature: 0, maxTokens: 300 })
      const allowed = new Set(pool.map((item) => item.memory.id))
      const ids = Array.isArray(response.value?.memoryIds) ? response.value.memoryIds.map(String) : []
      const items = ids.filter((idValue) => allowed.has(idValue)).map((memoryId, index) => ({
        memoryId,
        score: 0.22 - index * 0.01,
      }))
      const metric = {
        model: response.model ?? null,
        purpose: 'semantic-retrieve',
        totalTokens: response.usage?.totalTokens ?? response.usage?.total_tokens ?? 0,
        inputTokens: response.usage?.inputTokens ?? response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? response.usage?.completion_tokens ?? 0,
        cacheReadTokens: response.usage?.cacheReadTokens ?? response.usage?.prompt_cache_hit_tokens ?? 0,
        estimatedCostUsd: this.estimateCost(response.usage),
        jsonErrors: response.retried ? 1 : 0,
        evidenceRejected: 0,
        sessionId,
      }
      await this.recordModelMetric(metric)
      return { used: true, items }
    } catch (error) {
      this.llmStats.jsonErrors += /JSON|解析|parse/i.test(String(error?.message || error)) ? 1 : 0
      await this.append('metrics.jsonl', {
        at: now(),
        kind: 'model-call-error',
        purpose: 'semantic-retrieve',
        jsonError: /JSON|解析|parse/i.test(String(error?.message || error)),
        error: String(error?.message || error).slice(0, 240),
      })
      return { used: true, items: [] }
    }
  }

  async recall(query, sessionId = null) {
    return this.retrieve(query, sessionId)
  }

  async confirmRecall(memoryIds, {
    query = null,
    sessionId = null,
    reason = 'explicit-confirmation',
    confirmationTurnId = null,
  } = {}) {
    const confirmationTurn = this.turns.find((turn) => turn.id === confirmationTurnId)
    if (!confirmationTurn || confirmationTurn.speaker !== 'user') {
      throw new Error('confirmationTurnId must reference a user turn')
    }
    const confirmationState = semanticState(confirmationTurn.text)
    if (confirmationState.polarity !== 'affirmed' || confirmationState.modality !== 'assertion') {
      throw new Error('confirmation turn must be an explicit affirmed user assertion')
    }
    const ids = Array.isArray(memoryIds) ? memoryIds : [memoryIds]
    const at = now()
    const confirmed = []
    for (const memoryId of ids.filter(Boolean)) {
      const memory = this.memories.get(memoryId)
      if (!memory || ['superseded', 'deleted'].includes(memory.status)) continue
      if (lexicalScore(confirmationTurn.text, `${memory.summary} ${memory.evidence}`) < 0.12) continue
      memory.recallCount = Number(memory.recallCount || 0) + 1
      memory.confirmedRecallCount = Number(memory.confirmedRecallCount || 0) + 1
      memory.lastRecalledAt = at
      memory.lastReinforcedAt = at
      memory.strength = clamp(Math.max(memory.strength || memory.importance, strength(memory, at)) + 0.04)
      memory.freshness = 1
      if (memory.status === 'faded') memory.status = 'active'
      await this.saveMemory(memory, 'confirm-recall', {
        query: query == null ? null : String(query).slice(0, 180),
        sessionId,
        reason,
      })
      confirmed.push(memory)
    }
    const event = { at, type: 'confirm-recall', memoryIds: confirmed.map((memory) => memory.id), sessionId, reason }
    this.events.push(event)
    await this.append('events.jsonl', event)
    return confirmed
  }

  async context(sessionId, query) {
    const originalQuery = String(query ?? '').trim()
    const direct = stripRetrievalWrapper(originalQuery)
    const reference = this.contextReference(sessionId, direct)
    const retrievalQuery = reference
      ? [direct, ...reference.turns.map((turn) => `${turn.speaker === 'user' ? '用户' : '助手'}：${turn.text}`)]
        .join('\n').slice(0, 1800)
      : direct
    const hits = await this.retrieve(retrievalQuery, sessionId, {
      logQuery: originalQuery,
      mode: 'auto',
      reference,
      skip: OPEN_MEAL_QUERY.test(direct) || (shortContinuation(direct) && !reference),
    })
    const parentContext = this.parentWindowContext(reference)
    const unclearReference = !reference && !hits.length && !OPEN_MEAL_QUERY.test(direct)
      && (shortContinuation(direct) || pastMealQuery(direct))
    const lines = []
    if (parentContext) lines.push(parentContext)
    if (hits.length) {
      lines.push(
        '【伴生记忆回忆】',
        '以下是自动检索到的有来源参考；普通连续性不需要再次调用记忆工具。只有需要完整原话、确认、纠正或删除时才调用工具。',
        hits.map(({ memory, semantic, legacy, reviewedHistory }) => {
          const evidence = String(memory.evidence || memory.summary || '').replace(/\s+/gu, ' ').slice(0, 160)
          const occurred = memory.occurredAt ? String(memory.occurredAt).slice(0, 10) : '未知'
          const match = semantic ? '语义关联' : '词面关联'
          const provenance = legacy ? '迁移对话用户原话（历史陈述，不等于当前事实）'
            : reviewedHistory ? `旧私聊${memory.speaker === 'assistant' ? '助手' : '用户'}原话（仅证明当时说过）`
              : memory.humanReview?.reviewer === 'user'
                ? '爸爸人工确认的旧木偶记忆摘要（历史陈述；未保留逐字原话）'
                : '证据'
          const timeLabel = memory.historicalTimeBasis === 'snapshot-captured-at' ? '收录日期（UTC）' : '发生于'
          return `- ${memory.kind}/${memory.status}：${memory.summary}（${provenance}：“${evidence}”；${timeLabel} ${occurred}；来源：${legacy || memory.sourceTurnIds.join(',')}；${match}）`
        }).join('\n'),
      )
    }
    const context = lines.join('\n').slice(0, 3000)
    const recallEvent = this.events.at(-1)
    const autoEvent = {
      at: now(),
      type: 'auto-inject',
      sessionId,
      query: originalQuery.slice(0, 180),
      retrievalExpanded: retrievalQuery !== originalQuery,
      memoryIds: hits.map(({ memory }) => memory.id),
      hitCount: hits.length,
      parentWindow: Boolean(parentContext),
      unclearReference,
      injected: Boolean(context),
      injectedChars: context.length,
      semanticUsed: Boolean(recallEvent?.type === 'recall' && recallEvent.semanticUsed),
    }
    this.events.push(autoEvent)
    await this.append('events.jsonl', autoEvent)
    if (unclearReference) {
      return '【本轮接话】这句指代没有匹配的对话线索或记忆。下一条直接、简短地问用户指哪一件；不调用工具，不访问文件，不猜测。'
    }
    return context
  }

  contextReference(sessionId, query) {
    if (!CONTINUATION_CUE.test(query) && !shortContinuation(query)) return null
    const session = this.sessions.get(sessionId)
    const queryWords = focalWords(query)
    const topic = queryTopic(query)
    const parentCutoff = Date.now() - PARENT_WINDOW_MAX_AGE_MS
    for (const id of [sessionId, session?.parentSessionId].filter(Boolean)) {
      const nearby = this.turns
        .filter((turn) => turn.sessionId === id && ['user', 'assistant'].includes(turn.speaker)
          && !this.purgedTurnIds.has(turn.id))
        .slice(-4)
      const latest = nearby.at(-1)
      if (id === sessionId && latest?.speaker === 'user' && stripRetrievalWrapper(latest.text) === query) nearby.pop()
      const index = nearby.findLastIndex((turn) => turn.speaker === 'user'
        && !LOW_VALUE.test(turn.text) && !shortContinuation(turn.text) && focalWords(turn.text).size > 0)
      if (index < 0) continue
      const focus = nearby[index]
      if (id !== sessionId && !(Date.parse(focus.recordedAt) >= parentCutoff)) return null
      const words = focalWords(focus.text)
      if (topic ? queryTopic(focus.text) !== topic && !overlapCount(queryWords, words)
        : queryWords.size && !shortContinuation(query) && !overlapCount(queryWords, words)) return null
      const answer = nearby[index + 1]
      const turns = answer?.speaker === 'assistant' ? [focus, answer] : [focus]
      const ids = new Set(turns.map((turn) => turn.id))
      if ([...this.memories.values()].some((memory) => (
        memory.visibility === 'hidden' || ['deleted', 'hidden'].includes(memory.status)
          || ['soft-deleted', 'recall-blocked', 'purged'].includes(memory.deletionState)
      ) && memory.sourceTurnIds?.some((turnId) => ids.has(turnId)))) return null
      return { focus, words, turns, fromParent: id !== sessionId }
    }
    return null
  }

  parentWindowContext(reference) {
    if (!reference?.fromParent) return ''
    const text = reference.turns
      .map((turn) => `${turn.speaker === 'user' ? '用户' : turn.speaker === 'assistant' ? '助手' : '记录'}：${turn.text}`)
      .join(' / ')
    return [
      '【上一会话最近内容】',
      '以下只是上一会话的临时接话线索。建议不等于已经发生；指代不明确时请简短确认。',
      text,
    ].join('\n').slice(0, 1200)
  }

  async consolidate() {
    const at = now()
    for (const memory of this.memories.values()) {
      memory.freshness = freshness(memory, at)
      memory.effectiveStrength = strength(memory, at)
      if (memory.status === 'active'
        && ((memory.dailyExpiresAt && new Date(memory.dailyExpiresAt).getTime() <= new Date(at).getTime())
          || memory.effectiveStrength < FADED_MEMORY_STRENGTH)) memory.status = 'faded'
      if (memory.kind === 'commitment' && memory.status === 'open' && memory.dueAt && new Date(memory.dueAt) <= new Date(at)) memory.status = 'expired'
      await this.saveMemory(memory, 'consolidate')
    }
    return { count: this.memories.size }
  }

  async consolidateSession(sessionId, { maxChars = 10_000 } = {}) {
    if (!this.llm) return { extracted: 0, rejected: 0, reason: 'no-llm' }
    const allTurns = this.turns
      .filter((turn) => turn.sessionId === sessionId && !this.purgedTurnIds.has(turn.id))
    const cursor = this.consolidationCursors[sessionId]
    const cursorIndex = cursor ? allTurns.findIndex((turn) => turn.id === cursor) : -1
    const turns = cursorIndex >= 0 ? allTurns.slice(cursorIndex + 1) : allTurns
    if (!turns.length) return { extracted: 0, rejected: 0, reason: 'no-turns' }
    const transcript = turns
      .map((turn) => `[${turn.id}] ${turn.speaker === 'user' ? '用户' : '助手'}：${turn.text}`)
      .join('\n')
      .slice(0, maxChars)
    const messages = [
      {
        role: 'system',
        content: [
          '你是陪伴型 AI 的长期记忆整理员，不是聊天角色。',
          '只提取未来仍有价值的事实、偏好、关系事件、情绪状态和承诺。',
          '不要记录问题、寒暄、模型猜测或没有证据的内容。',
          '每条必须给出 sourceTurnIds，并且 evidence 必须是对应原话的连续片段。',
          '输出严格 JSON：{"memories":[{"kind":"fact|preference|relationship|emotion|commitment|event","subcategory":"可选子类","speaker":"user|assistant|both","summary":"短句","evidence":"原话片段","sourceTurnIds":["turn_id"],"factKey":"稳定对象.方面或空","importance":0到1}]}。',
        ].join('\n'),
      },
      { role: 'user', content: transcript },
    ]
    let response
    try {
      response = await this.llm.chatJson(messages, { temperature: 0, maxTokens: 1400 })
    } catch (error) {
      const jsonError = /JSON|解析|parse/i.test(String(error?.message || error))
      this.llmStats.jsonErrors += jsonError ? 1 : 0
      await this.append('metrics.jsonl', {
        at: now(),
        kind: 'model-call-error',
        purpose: 'consolidate',
        jsonError,
        error: String(error?.message || error).slice(0, 240),
      })
      return {
        extracted: 0,
        rejected: 0,
        reason: 'llm-json-failed',
        fallback: 'local-immediate-candidates-retained',
      }
    }
    const sourceById = new Map(turns.map((turn) => [turn.id, turn]))
    let extracted = 0
    let rejected = 0
    let suppressed = 0
    for (const raw of Array.isArray(response.value?.memories) ? response.value.memories : []) {
      const sourceIds = Array.isArray(raw.sourceTurnIds) ? raw.sourceTurnIds.map(String) : []
      const sources = sourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean)
      const evidence = String(raw.evidence || '').trim()
      const source = sources.find((turn) => turn.text.includes(evidence))
      const ref = source && evidenceRef(source, evidence)
      const factKey = String(raw.claimKey || raw.factKey || '').trim().slice(0, 120)
      if (!sources.length || !evidence || !source || !ref || !factKey
        || sourceIds.some((sourceId) => !sourceById.has(sourceId) || this.purgedTurnIds.has(sourceId))) {
        rejected++
        continue
      }
      const kind = ['fact', 'preference', 'relationship', 'emotion', 'commitment', 'event'].includes(raw.kind) ? raw.kind : 'fact'
      const speaker = source.speaker
      if (raw.speaker === 'user' && speaker !== 'user') {
        rejected++
        continue
      }
      if (speaker === 'assistant' && isAssistantAcknowledgement(evidence)) {
        rejected++
        continue
      }
      const occurredAt = sources.map((turn) => turn.occurredAt || turn.createdAt).sort()[0]
      const semantic = semanticState(evidence)
      const inferredKind = classify(evidence, speaker)
      const effectiveKind = speaker === 'user'
        && inferredKind
        && inferredKind !== 'fact'
        && !(inferredKind === 'commitment' && kind !== 'commitment')
        ? inferredKind
        : kind
      const claimType = claimTypeFor(evidence, effectiveKind, speaker)
      const summary = String(raw.summary || evidence).trim()
      const summaryGrounded = normalize(summary) === normalize(evidence)
        || (speaker === 'user'
          && lexicalScore(summary, evidence) >= 0.2
          && (!inferredKind || inferredKind === effectiveKind || kind === 'commitment')
          && (keyFor(effectiveKind, summary) === keyFor(effectiveKind, evidence)
            || effectiveKind === 'relationship'
            || effectiveKind === 'commitment'))
      const candidate = {
        id: `memory_${randomUUID().replaceAll('-', '')}`,
        kind: effectiveKind,
        subcategory: subcategoryFor(effectiveKind, evidence),
        recordType: recordType(effectiveKind),
        subjectType: subjectType(effectiveKind),
        subject: speaker,
        speaker,
        summary: summary.slice(0, 240),
        evidence: evidence.slice(0, 500),
        sourceTurnIds: sourceIds,
        sourceSessionId: sessionId,
        sourceKind: 'consolidation',
        sandboxOwned: true,
        occurredAt,
        recordedAt: now(),
        lastSeenAt: occurredAt,
        lastSupportedAt: now(),
        lastReinforcedAt: null,
        lastRecalledAt: null,
        importance: clamp(raw.importance, 0.2, 1),
        strength: clamp(raw.importance, 0.2, 1),
        retentionClass: isDailyMemory(effectiveKind, evidence) ? 'daily' : 'durable',
        dailyExpiresAt: isDailyMemory(effectiveKind, evidence) ? dailyExpiresAt(occurredAt) : null,
        promotionScore: isDailyMemory(effectiveKind, evidence) ? 0.25 : 1,
        promotionState: isDailyMemory(effectiveKind, evidence) ? 'watching' : 'durable',
        supportSessionIds: [sessionId],
        supportDates: [dayKey(occurredAt)],
        recallCount: 0,
        confirmedRecallCount: 0,
        reinforcementCount: 0,
        freshness: 1,
        status: effectiveKind === 'commitment' ? 'open' : 'active',
        factKey,
        claimKey: factKey,
        claimType,
        authority: speaker,
        polarity: semantic.polarity,
        modality: semantic.modality,
        epistemicStatus: summaryGrounded && semantic.epistemicStatus === 'supported' ? 'supported' : 'candidate',
        visibility: summaryGrounded
          && semantic.epistemicStatus === 'supported'
          && semantic.polarity === 'affirmed'
          && ((speaker === 'user' && (['assertion', 'promise'].includes(semantic.modality) || claimType === 'commitment'))
            || (speaker === 'assistant' && claimType === 'commitment'))
          ? 'recallable'
          : 'evidence-only',
        deletionState: 'live',
        evidenceRefs: [ref],
        source: sourceIds.join(','),
        writePolicy: 'llm-evidence-grounded',
        writePriority: ['commitment', 'relationship'].includes(effectiveKind) ? 'priority' : 'normal',
      }
      if (candidate.visibility === 'evidence-only') candidate.status = 'review'
      const saved = await this.remember(candidate)
      if (saved) extracted++
      else suppressed++
    }
    this.consolidationCursors[sessionId] = turns.at(-1).id
    await this.writeJson('consolidation-cursors.json', this.consolidationCursors)
    await this.recordModelMetric({
      purpose: 'consolidate',
      model: response.model ?? null,
      totalTokens: response.usage?.totalTokens ?? response.usage?.total_tokens ?? 0,
      inputTokens: response.usage?.inputTokens ?? response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? response.usage?.completion_tokens ?? 0,
      cacheReadTokens: response.usage?.cacheReadTokens ?? response.usage?.prompt_cache_hit_tokens ?? 0,
      estimatedCostUsd: this.estimateCost(response.usage),
      jsonErrors: response.retried ? 1 : 0,
      evidenceRejected: rejected,
      sessionId,
    })
    return { extracted, rejected, suppressed, usage: response.usage, model: response.model }
  }

  list(includeDeleted = false) {
    return [...this.memories.values()].filter((row) => includeDeleted || row.status !== 'deleted')
  }

  async correct(memoryId, patch = {}) {
    const memory = this.memories.get(memoryId)
    if (!memory) throw new Error(`memory not found: ${memoryId}`)
    Object.assign(memory, patch, { lastSeenAt: now() })
    if (memory.status === 'superseded' && patch.status === undefined) memory.status = 'active'
    return this.saveMemory(memory, 'correction', { patch })
  }

  async forget(memoryId, hard = false, mode = null) {
    const memory = this.memories.get(memoryId)
    if (!memory) throw new Error(`memory not found: ${memoryId}`)
    const deletionMode = mode || (hard ? 'purge' : 'soft-delete')
    if (deletionMode !== 'purge') {
      if (!['soft-delete', 'recall-block', 'export-exclude'].includes(deletionMode)) {
        throw new Error(`invalid deletion mode: ${deletionMode}`)
      }
      memory.deletionState = deletionMode === 'soft-delete'
        ? 'soft-deleted'
        : deletionMode === 'recall-block'
          ? 'recall-blocked'
          : 'export-excluded'
      if (deletionMode === 'soft-delete') memory.status = 'deleted'
      if (deletionMode === 'recall-block') memory.visibility = 'hidden'
      memory.deletedAt = now()
      return this.saveMemory(memory, deletionMode)
    }
    if (!memory.sandboxOwned) {
      throw new Error('purge is limited to claims created and owned in this isolated sandbox')
    }
    this.memories.delete(memoryId)
    const referencedTurnIds = new Set([...this.memories.values()]
      .flatMap((item) => Array.isArray(item.sourceTurnIds) ? item.sourceTurnIds : []))
    for (const turnId of memory.sourceTurnIds || []) {
      if (!referencedTurnIds.has(turnId)) this.purgedTurnIds.add(turnId)
    }
    await this.writeJson('purged-turn-ids.json', [...this.purgedTurnIds])
    await this.writeJson('memories.json', [...this.memories.values()])
    const event = { at: now(), type: 'purge', memoryId }
    await this.append('events.jsonl', event)
    return { id: memoryId, purged: true }
  }

  async restore(memoryId) {
    const memory = this.memories.get(memoryId)
    if (!memory) throw new Error(`memory not found: ${memoryId}`)
    if (memory.status === 'deleted' || memory.deletionState) {
      memory.status = memory.kind === 'commitment' ? 'open' : 'active'
      delete memory.deletedAt
      delete memory.deletionState
      if (memory.visibility === 'hidden') memory.visibility = 'recallable'
      return this.saveMemory(memory, 'restore')
    }
    return memory
  }

  async exportClaims() {
    return [...this.memories.values()].filter((memory) => (
      !['purged', 'export-excluded'].includes(memory.deletionState)
    ))
  }

  explain(memoryId) {
    const memory = this.memories.get(memoryId)
    if (!memory) throw new Error(`memory not found: ${memoryId}`)
    return {
      memory,
      sources: this.turns.filter((turn) => memory.sourceTurnIds.includes(turn.id)),
    }
  }

  async stats() {
    const files = ['sessions.jsonl', 'turns.jsonl', 'memories.json', 'events.jsonl', 'metrics.jsonl']
    let storageBytes = 0
    for (const file of files) {
      try {
        storageBytes += (await stat(join(this.root, file))).size
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const recalls = this.events.filter((row) => row.type === 'recall')
    const autoInjects = this.events.filter((row) => row.type === 'auto-inject')
    const categoryCounts = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((kind) => [
      kind,
      [...this.memories.values()].filter((memory) => memory.kind === kind).length,
    ]))
    const subcategoryCounts = {}
    for (const memory of this.memories.values()) {
      const key = `${memory.kind}:${memory.subcategory || subcategoryFor(memory.kind, `${memory.summary || ''} ${memory.evidence || ''}`)}`
      subcategoryCounts[key] = (subcategoryCounts[key] || 0) + 1
    }
    const dailyMemories = [...this.memories.values()].filter((memory) => memory.retentionClass === 'daily').length
    const promotedMemories = [...this.memories.values()].filter((memory) => memory.promotionState === 'promoted').length
    return {
      root: this.root,
      sessions: this.sessions.size,
      turns: this.turns.length,
      memories: this.memories.size,
      activeMemories: this.list().length,
      categoryCounts,
      subcategoryCounts,
      dailyMemories,
      promotedMemories,
      events: this.events.length,
      storageBytes,
      recallCount: recalls.length,
      autoInjectCount: autoInjects.length,
      autoInjectHitCount: autoInjects.reduce((sum, row) => sum + Number(row.hitCount || 0), 0),
      autoInjectWithHits: autoInjects.filter((row) => Number(row.hitCount || 0) > 0).length,
      filteredRuntimeInjections: this.events.filter((row) => (
        row.type === 'write-filtered' && row.reason === 'internal-runtime-injection'
      )).length,
      averageRecallMs: recalls.length
        ? Number((recalls.reduce((sum, row) => sum + Number(row.durationMs || 0), 0) / recalls.length).toFixed(2))
        : 0,
      usage: { ...this.usage },
      llm: { ...this.llmStats },
    }
  }
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function compactMemory(memory) {
  return {
    id: memory.id,
    kind: memory.kind,
    subcategory: memory.subcategory,
    recordType: memory.recordType,
    subjectType: memory.subjectType,
    summary: memory.summary,
    evidence: memory.evidence,
    sourceTurnIds: memory.sourceTurnIds,
    sourceSessionId: memory.sourceSessionId,
    occurredAt: memory.occurredAt,
    recordedAt: memory.recordedAt,
    lastRecalledAt: memory.lastRecalledAt,
    factKey: memory.factKey,
    claimType: memory.claimType,
    epistemicStatus: memory.epistemicStatus,
    status: memory.status,
    writePriority: memory.writePriority,
  }
}

function compactRecallHits(hits) {
  return hits.map(({ memory, ...hit }) => ({
    ...hit,
    memory: compactMemory(memory),
  }))
}

function output(value) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  }
}

function sessionFor(exec) {
  return exec?.agent?.session ?? null
}

function sessionIdFor(exec, args) {
  return args.sessionId || sessionFor(exec)?.id || exec?.agent?.id || 'manual'
}

function createDshLlmAdapter(ctx, config = {}) {
  if (!ctx?.llm?.stream) return null
  const model = config.llmModel || 'deepseek-flash'
  const provider = config.llmProvider || 'deepseek-official'
  return {
    async chatJson(messages, options = {}) {
      const request = {
        provider,
        model: options.model || model,
        messages: messages.map((item) => ({
          role: item.role,
          content: Array.isArray(item.content)
            ? item.content
            : [{ type: 'text', text: String(item.content ?? '') }],
        })),
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? 800,
      }
      const collect = async () => {
        let text = ''
        let usage = null
        let finish = null
        const stream = await ctx.llm.stream(request)
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += String(chunk.text || '')
          if (chunk?.type === 'usage') usage = chunk.usage || chunk
          if (chunk?.type === 'finish') finish = chunk.reason || null
        }
        return { text, usage, finish }
      }
      let attempt = await collect()
      try {
        return { ...attempt, value: parseJsonLoose(attempt.text), model: request.model }
      } catch (firstError) {
        attempt = await collect()
        try {
          return { ...attempt, value: parseJsonLoose(attempt.text), model: request.model, retried: true }
        } catch {
          throw firstError
        }
      }
    },
  }
}

/**
 * 记忆库落在哪：作为正式 DSH 插件，默认位置必须稳。
 *
 * 以前默认是 `process.cwd()/.companion-memory`，换个工作区就是另一个记忆库，
 * 同一个 profile 里跑两间房会得到两套记忆。现在按下面的顺序定：
 *   1. config.root 是绝对路径 → 照用（想放到某个工作区里就这样写）
 *   2. config.root 以 ~ 开头 → 展开到家目录
 *   3. config.root 是相对路径 → 按 DSH_HOME 解析，不跟会话 cwd 走
 *   4. 没配 → $DSH_HOME/companion-memory，没有 DSH_HOME 就 ~/.dsh/companion-memory
 */
function resolveMemoryRoot(configured) {
  const raw = String(configured ?? '').trim()
  const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  if (!raw) return resolve(dshHome, 'companion-memory')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return resolve(homedir(), raw.slice(2))
  }
  if (isAbsolute(raw)) return resolve(raw)
  return resolve(dshHome, raw)
}

async function apply(ctx, config = {}) {
  const llm = createDshLlmAdapter(ctx, config)
  const engine = await new MemoryEngine(
    resolveMemoryRoot(config.root),
    config.maxRecall || 6,
    {
      ...config,
      llm,
    },
  ).init()
  const latestQuery = new Map()
  const assistantSeq = new Map()
  let consoleDisposed
  const ensureConsole = () => {
    if (consoleDisposed !== undefined) return
    const webServer = ctx.get('webServer')
    if (!webServer || !ctx.get('connection')) return
    consoleDisposed = registerMemoryConsoleRoutes({ ctx, engine })
  }
  ensureConsole()
  try {
    ctx.inject(['webServer', 'connection'], () => ensureConsole())
  } catch {
    // Headless compositions do not mount a web server; the memory tool still works.
  }

  ctx.systemPrompt.section({
    name: 'companion-memory-guidance',
    order: (ctx.systemPrompt.getSectionOrder('TOOLS_SDK') ?? 5000) + 10,
    text: '伴生记忆已启用。插件会在每轮自动检索并注入相关记忆；普通连续性不需要重复调用 recall。只把自动注入或记忆工具返回的内容当作有来源参考；需要完整原话、确认、纠正或删除时再使用记忆工具。工具可用性以本回合工具清单和本回合调用结果为准；历史回合出现过的拒绝或白名单错误，不代表工具当前仍不可用。如果 companion_memory 在本回合工具清单中，遇到用户明确要求记住、纠正事实或补充重要细节时，应直接尝试调用；只有本次调用返回失败，才能说这次没有写入。只有本次工具调用返回成功写入回执（例如 stored=true 且带有记忆 ID），才能说内容已写入长期记忆；仅在聊天中回应或复述不等于持久化。如果用户问以前是否提过某事，而没有相符的记忆或原话，请直接说目前无法确认，不要把推测当成回忆。遇到「还是那样」「上次那套」等指代，能从当前对话或相关记忆接上就自然接话；如果缺少具体线索且没有匹配的注入，先简短问用户指哪一件，不调用 recall 来盲找，不把相近偏好当成发生过的事。用户明确纠正、删除或要求忘记时，以最新要求为准。不要因为一次临时情绪或寒暄就扩大长期记忆。',
  })
  ctx.systemPrompt.context({
    name: 'companion-memory-recall',
    order: (ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') ?? 200) + 20,
    text: ({ scope }) => {
      const id = scope?.session?.id || scope?.id
      return latestQuery.get(id)?.context || ''
    },
    required: false,
  })

  ctx.tools.register({
    name: 'companion_memory',
    description: 'Manage the lightweight companion memory. Use remember for an explicit durable fact or correction, recall for candidate retrieval, confirm_recall only after an explicit confirmation, list/explain for audit, correct/forget/restore for user control, and consolidate for maintenance. Deletion levels are separate: soft-delete stops recall, recall-block stops recall but keeps the claim, export-exclude hides it from new archives, and purge removes the claim only — original turns, existing archives and backups are still kept, so purge is NOT a full erasure.',
    parameters: {
      action: { type: 'string', required: true, enum: ['remember', 'recall', 'confirm_recall', 'list', 'explain', 'correct', 'forget', 'restore', 'stats', 'consolidate'] },
      text: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['fact', 'preference', 'relationship', 'emotion', 'commitment', 'event'],
      },
      query: { type: 'string' },
      confirmationTurnId: { type: 'string' },
      memoryId: { type: 'string' },
      memoryIds: { type: 'json' },
      sessionId: { type: 'string' },
      patch: { type: 'json' },
      hard: { type: 'boolean', description: 'Shortcut for deletionMode=purge. Claim-level only: original turns, existing archives and backups remain.' },
      deletionMode: { type: 'string', enum: ['soft-delete', 'recall-block', 'export-exclude', 'purge'], description: 'soft-delete: stop recall. recall-block: stop recall, keep the claim. export-exclude: hide from new archives, still recallable. purge: remove the claim only; original turns, archives and backups remain.' },
    },
    output: output({}),
    async execute(args, exec) {
      const sessionId = sessionIdFor(exec, args)
      if (args.action === 'remember') return engine.ingest({
        sessionId,
        speaker: 'user',
        text: asText(args.text),
        sourceKey: `tool:${sessionId}:${Date.now()}`,
        writePriority: 'priority',
        forcedKind: args.kind || 'fact',
      })
      if (args.action === 'recall') {
        return { hits: compactRecallHits(await engine.recall(asText(args.query || args.text), sessionId)) }
      }
      if (args.action === 'confirm_recall') {
        const memoryIds = Array.isArray(args.memoryIds)
          ? args.memoryIds
          : args.memoryId
            ? [args.memoryId]
            : []
        const confirmationTurnId = args.confirmationTurnId || engine.turns
          .filter((turn) => turn.sessionId === sessionId && turn.speaker === 'user')
          .at(-1)?.id
        return {
          confirmed: await engine.confirmRecall(memoryIds, {
            query: args.query || null,
            sessionId,
            confirmationTurnId,
          }),
        }
      }
      if (args.action === 'list') return { memories: engine.list(true) }
      if (args.action === 'explain') return engine.explain(args.memoryId)
      if (args.action === 'correct') return engine.correct(args.memoryId, args.patch || {})
      if (args.action === 'forget') {
        return engine.forget(args.memoryId, Boolean(args.hard), args.deletionMode || null)
      }
      if (args.action === 'restore') return engine.restore(args.memoryId)
      if (args.action === 'stats') return engine.stats()
      if (args.action === 'consolidate') {
        const local = await engine.consolidate()
        const llmResult = args.sessionId && engine.llm ? await engine.consolidateSession(args.sessionId) : null
        return { local, llm: llmResult }
      }
      throw new Error(`unknown action: ${args.action}`)
    },
  })

  const disposePreStep = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const session = sessionFor({ agent })
    const sessionId = session?.id || agent?.id || 'unknown'
    const parentSessionId = session?.header?.parentSession || null
    const userMessages = messages.filter((item) => item?.source?.kind === 'user')
    const query = userMessages.map(messageText).filter(Boolean).join('\n').trim()
    for (const item of userMessages) {
      const text = messageText(item)
      if (text) await engine.ingest({
        sessionId,
        parentSessionId,
        speaker: 'user',
        text,
        sourceKey: `user:${sessionId}:${item.id}`,
      })
    }
    latestQuery.set(sessionId, {
      query,
      context: query ? await engine.context(sessionId, query) : '',
    })
    return next()
  })

  const disposeTurnStopping = ctx.on('agent/turn-stopping', async ({ agent }) => {
    const session = sessionFor({ agent })
    if (!session) return
    const sessionId = session.id
    const lastSeq = assistantSeq.get(sessionId) ?? -1
    for (const event of session.snapshotEvents()) {
      if (event.seq <= lastSeq || event.type !== 'assistant/message') continue
      const text = messageText(event.data?.message || event.data)
      const sourceKey = `assistant:${sessionId}:${event.seq}`
      const saved = text ? await engine.ingest({
        sessionId,
        parentSessionId: session.header?.parentSession || null,
        speaker: 'assistant',
        text,
        sourceKey,
      }) : null
      if (!text || saved?.stored) await engine.recordUsage(event.data?.usage, sourceKey)
    }
    assistantSeq.set(sessionId, session.seq)
    await engine.consolidate()
    const turnCount = engine.turns.filter((turn) => turn.sessionId === sessionId).length
    if (engine.llm && turnCount > 0 && turnCount % engine.llmEveryTurns === 0) {
      await engine.consolidateSession(sessionId)
    }
  })

  return () => {
    consoleDisposed?.()
    disposePreStep()
    disposeTurnStopping()
  }
}

export {
  apply,
  inject,
  name,
  MemoryEngine,
  freshness,
  strength,
  compactMemory,
  compactRecallHits,
}
