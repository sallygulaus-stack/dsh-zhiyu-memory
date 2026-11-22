export const COMPARISON_CASES = [
  {
    id: 'recent-cross-session',
    title: '近期内容跨会话',
    steps: [
      {
        at: '2026-11-22T00:00:00.000Z',
        text: '我今天先把记忆插件研究的测试框架搭起来，晚上再测模型连通。',
      },
      {
        at: '2026-11-22T00:10:00.000Z',
        text: '测试框架已经能跑了，但长期记忆和换对话连续性还没验证。',
      },
      {
        newSession: true,
        at: '2026-11-22T01:00:00.000Z',
        text: '我们继续刚才的研究，下一步安排还接得上吗？',
      },
    ],
    query: '下一步安排是什么',
    expected: [
      { label: '长期记忆', anyOf: ['长期记忆'] },
      { label: '换对话连续性', anyOf: ['换对话连续性', '连续性'] },
    ],
  },
  {
    id: 'preference-correction',
    title: '偏好改口',
    steps: [
      {
        at: '2026-11-22T00:00:00.000Z',
        text: '我以前喜欢把研究结果写成长报告。',
      },
      {
        at: '2026-11-22T00:05:00.000Z',
        text: '我改了，现在先给结论，再给证据，不要先铺很长的背景。',
      },
      {
        newSession: true,
        at: '2026-11-22T00:30:00.000Z',
        text: '以后研究结论怎么组织？',
      },
    ],
    query: '以后研究结论怎么组织',
    expected: [
      { label: '先给结论', anyOf: ['先给结论', '先看结论'] },
      { label: '再给证据', anyOf: ['再给证据', '证据'] },
    ],
  },
  {
    id: 'commitment-priority',
    title: '承诺优先',
    steps: [
      {
        at: '2026-11-22T00:00:00.000Z',
        text: '请记得自研方案必须有自己的代码、数据格式和迁移能力。',
      },
      {
        at: '2026-11-22T00:10:00.000Z',
        text: '普通聊天可以自然一点，但不要把没有证据的猜测写成长久事实。',
      },
      {
        newSession: true,
        at: '2026-11-22T01:00:00.000Z',
        text: '上次你需要记住的研究要求是什么？',
      },
    ],
    query: '上次你需要记住的研究要求是什么',
    expected: [
      { label: '自己的代码', anyOf: ['自己的代码', '独立'] },
      { label: '迁移能力', anyOf: ['迁移能力', '迁移'] },
    ],
  },
  {
    id: 'conflict-correction',
    title: '偏好冲突取代',
    steps: [
      {
        at: '2026-11-22T00:00:00.000Z',
        text: '我以前喜欢把研究结果写成长报告。',
      },
      {
        at: '2026-11-22T00:10:00.000Z',
        text: '我改了，现在先看结论，再看证据。',
      },
      {
        newSession: true,
        at: '2026-11-22T01:00:00.000Z',
        text: '以后研究结论怎么组织？',
      },
    ],
    query: '以后研究结论怎么组织',
    expected: [
      { label: '当前偏好', anyOf: ['先看结论', '先给结论'] },
    ],
    forbidden: ['长报告'],
  },
  {
    id: 'semantic-paraphrase',
    title: '改写后的共同经历',
    steps: [
      {
        at: '2026-11-22T00:00:00.000Z',
        text: '我在海边看到了蓝色灯塔。',
      },
      {
        newSession: true,
        at: '2026-11-22T02:00:00.000Z',
        text: '那片蓝色的地方是什么？',
      },
    ],
    query: '那片蓝色的地方是什么',
    expected: [
      { label: '蓝色灯塔', anyOf: ['蓝色灯塔', '灯塔'] },
    ],
  },
  {
    id: 'unrelated-restraint',
    title: '无关问题克制',
    steps: [
      {
        at: '2026-11-22T00:00:00.000Z',
        text: '请记得明天完成记忆插件回放测试。',
      },
      {
        newSession: true,
        at: '2026-11-22T01:00:00.000Z',
        text: '你觉得今天的天气怎么样？',
      },
    ],
    query: '你觉得今天的天气怎么样',
    expected: [],
    forbidden: ['回放测试'],
  },
]
