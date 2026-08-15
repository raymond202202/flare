/**
 * 本地小模型路由测试（v0.6.134，混合模式方向）
 *
 * - classifyTaskComplexity：规则/启发式任务复杂度分类（零网络、零 LLM 调用）
 * - routeTaskModel：简单任务 → 本地路由模型；复杂任务 → 主模型（纯决策，不发起调用）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { classifyTaskComplexity, classifyTaskDetail, routeTaskModel } from '../src/core/routing.js'
import { config } from '../src/core/config.js'

const savedLocal = config.get('LOCAL_MODEL') || ''
const savedMain = config.get('DEFAULT_MODEL') || 'deepseek-chat'
afterEach(() => {
  config.set('LOCAL_MODEL', savedLocal)
  config.set('DEFAULT_MODEL', savedMain)
})

describe('classifyTaskComplexity（规则/启发式分类）', () => {
  it('空文本 → simple', () => {
    expect(classifyTaskComplexity('')).toBe('simple')
    expect(classifyTaskComplexity('   ')).toBe('simple')
  })

  it('代码特征（``` / function / import / 花括号）→ complex', () => {
    expect(classifyTaskComplexity('帮我写一个函数：```\nfunction add(a, b) { return a + b }\n```')).toBe('complex')
    expect(classifyTaskComplexity('const x = 1; export default x')).toBe('complex')
    expect(classifyTaskComplexity('class Foo { constructor() {} }')).toBe('complex')
  })

  it('复杂特征词（分析/推理/为什么/对比/设计/创作/算法）→ complex', () => {
    expect(classifyTaskComplexity('分析一下这段代码的性能瓶颈')).toBe('complex')
    expect(classifyTaskComplexity('为什么天空是蓝色的？')).toBe('complex')
    expect(classifyTaskComplexity('对比 React 和 Vue 的架构设计')).toBe('complex')
    expect(classifyTaskComplexity('写一篇关于秋天的文章')).toBe('complex')
    expect(classifyTaskComplexity('解释一下快速排序算法的时间复杂度')).toBe('complex')
  })

  it('长文本（> 300 字符）→ complex（需要上下文理解/推理）', () => {
    const long = '这是一段很长的用户输入。'.repeat(40) // 440 字符
    expect(classifyTaskComplexity(long)).toBe('complex')
  })

  it('简单特征词（分类/抽取/摘要/翻译/格式化）→ simple', () => {
    expect(classifyTaskComplexity('把这句话翻译成英文：你好世界')).toBe('simple')
    expect(classifyTaskComplexity('总结这段文字的主要内容')).toBe('simple')
    expect(classifyTaskComplexity('提取这段文本里的关键词')).toBe('simple')
    expect(classifyTaskComplexity('把这段 JSON 格式化一下')).toBe('simple')
  })

  it('默认短文本无特征 → simple（简单问答/闲聊）', () => {
    expect(classifyTaskComplexity('你好')).toBe('simple')
    expect(classifyTaskComplexity('今天天气怎么样？')).toBe('simple')
  })
})

describe('classifyTaskDetail（分类命中特征能力标签，v0.6.143）', () => {
  it('代码特征 → complex + 代码特征标签', () => {
    const r = classifyTaskDetail('帮我写一个函数：```\nfunction add(a, b) { return a + b }\n```')
    expect(r.tier).toBe('complex')
    expect(r.feature).toContain('代码特征')
  })

  it('复杂特征词 → complex + 复杂特征词标签', () => {
    const r = classifyTaskDetail('分析一下这段代码的性能瓶颈')
    expect(r.tier).toBe('complex')
    expect(r.feature).toContain('复杂特征词')
  })

  it('长文本 → complex + 长文本标签', () => {
    const r = classifyTaskDetail('这是一段很长的用户输入。'.repeat(40))
    expect(r.tier).toBe('complex')
    expect(r.feature).toContain('长文本')
  })

  it('简单特征词 → simple + 简单特征词标签', () => {
    const r = classifyTaskDetail('把这句话翻译成英文：你好世界')
    expect(r.tier).toBe('simple')
    expect(r.feature).toContain('简单特征词')
  })

  it('空文本/默认短文本 → simple + 默认标签', () => {
    expect(classifyTaskDetail('').feature).toContain('空文本')
    expect(classifyTaskDetail('你好').feature).toContain('默认')
  })

  it('与 classifyTaskComplexity 判定一致（同一规则集）', () => {
    const cases = ['你好', '把这句话翻译成英文', '分析代码', '写代码：const x = 1', '长文本'.repeat(200)]
    for (const c of cases) {
      expect(classifyTaskDetail(c).tier).toBe(classifyTaskComplexity(c))
    }
  })
})

describe('routeTaskModel（路由决策）', () => {
  it('简单任务 + 配置 LOCAL_MODEL → 本地模型（ollama provider）', () => {
    config.set('LOCAL_MODEL', 'qwen2.5:7b')
    config.set('DEFAULT_MODEL', 'deepseek-chat')
    const r = routeTaskModel('把这句话翻译成英文：你好')
    expect(r.tier).toBe('simple')
    expect(r.model).toBe('qwen2.5:7b')
    expect(r.provider).toBe('ollama')
    expect(r.reason).toContain('本地')
    expect(r.feature).toContain('简单特征词')
  })

  it('简单任务 + 未配置 LOCAL_MODEL → 回退主模型并注明', () => {
    config.set('LOCAL_MODEL', '')
    config.set('DEFAULT_MODEL', 'deepseek-chat')
    const r = routeTaskModel('你好')
    expect(r.tier).toBe('simple')
    expect(r.model).toBe('deepseek-chat')
    expect(r.provider).toBe('deepseek')
    expect(r.reason).toContain('未配置 LOCAL_MODEL')
  })

  it('复杂任务 → 主模型（保质量）', () => {
    config.set('LOCAL_MODEL', 'qwen2.5:7b')
    config.set('DEFAULT_MODEL', 'deepseek-chat')
    const r = routeTaskModel('分析一下这段代码的性能瓶颈')
    expect(r.tier).toBe('complex')
    expect(r.model).toBe('deepseek-chat')
    expect(r.provider).toBe('deepseek')
    expect(r.reason).toContain('主模型')
    expect(r.feature).toContain('复杂特征词')
  })

  it('显式 opts 覆盖 config（宿主可传入指定模型）', () => {
    const r = routeTaskModel('把这句话翻译成英文', {
      localModel: 'qwen2.5vl:3b',
      mainModel: 'gpt-4o',
    })
    expect(r.tier).toBe('simple')
    expect(r.model).toBe('qwen2.5vl:3b')
    expect(r.provider).toBe('ollama')
    const c = routeTaskModel('为什么天空是蓝色的？', {
      localModel: 'qwen2.5:7b',
      mainModel: 'gpt-4o',
    })
    expect(c.tier).toBe('complex')
    expect(c.model).toBe('gpt-4o')
    expect(c.provider).toBe('openai')
  })

  it('默认主模型回退（config 与 opts 均缺省）→ deepseek-chat', () => {
    config.set('DEFAULT_MODEL', '')
    config.set('LOCAL_MODEL', '')
    const r = routeTaskModel('为什么天空是蓝色的？')
    expect(r.model).toBe('deepseek-chat')
  })
})
