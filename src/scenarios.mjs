export const SCENARIOS = [
  {
    id: 'recent-continuity',
    title: '近期内容与换会话连续性',
    sessions: [
      {
        id: 'a',
        userTurns: [
          '我这周在做一个记忆插件研究，今天先把测试框架搭起来。这个研究对我很重要。',
          '今晚我会先测试模型连通，明天再看长期记忆和换对话连续性。',
        ],
      },
      {
        id: 'b',
        userTurns: [
          '我们继续昨天的事情吧。你还记得我现在研究的重点是什么，以及今天应该先做什么吗？',
        ],
        expected: [
          { label: '研究重点', anyOf: ['记忆插件研究', '记忆插件'] },
          { label: '测试框架', anyOf: ['测试框架', '框架'] },
          { label: '长期记忆', anyOf: ['长期记忆'] },
          { label: '换对话连续性', anyOf: ['换对话连续性', '连续性'] },
        ],
      },
    ],
  },
  {
    id: 'preference-correction',
    title: '偏好改口与冲突处理',
    sessions: [
      {
        id: 'a',
        userTurns: ['我以前喜欢把研究结果写成很长的报告，但现在改了：我更喜欢先看结论，再看证据。'],
      },
      {
        id: 'b',
        userTurns: ['以后给我研究结论时，应该怎么组织？'],
        expected: [
          { label: '先给结论', anyOf: ['先看结论', '先给一句话结论', '结论'] },
          { label: '证据', anyOf: ['证据', '依据'] },
        ],
      },
    ],
  },
  {
    id: 'commitment-followup',
    title: '承诺与未完成事项',
    sessions: [
      {
        id: 'a',
        userTurns: ['请记得把自研方案做成真正的插件，不能只做交接纸。'],
      },
      {
        id: 'b',
        userTurns: ['上次我要求自研方案在交付形态上遵守什么？'],
        expected: [
          { label: '真正的插件', anyOf: ['真正的插件', '真正可运行的插件', '可加载、可运行的插件'] },
          { label: '不是交接纸', anyOf: ['不能只做交接纸', '不能只停留在交接文档', '不当作成果本身', '交接纸不算完成'] },
        ],
      },
    ],
  },
]
