// --bridge-prompts 冒烟测试（v0.6.37）：真实 dist CLI mcp-server 子进程 + 真实外部 prompts 服务器
// 验证：initialize（prompts 能力声明）→ listPrompts（元数据+参数）→ getPrompt（渲染代理转发）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCPClient } from '../dist/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const CLI = join(root, 'dist', 'cli', 'index.js')
const TSK_CLI = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const PROMPTS_FIXTURE = join(__dirname, 'fixtures', 'mcp-flare-server-prompts-bridge.ts')

const tmp = mkdtempSync(join(tmpdir(), 'flare-bridge-prompts-smoke-'))
const configPath = join(tmp, 'mcp.json')
writeFileSync(configPath, JSON.stringify({
  servers: [{ name: 'ext', command: process.execPath, args: [TSK_CLI, PROMPTS_FIXTURE] }],
}))

const client = new MCPClient({
  command: process.execPath,
  args: [CLI, 'mcp-server', '--bridge-prompts', '--config', configPath],
  timeoutMs: 15000,
})

const fail = (msg) => {
  console.error('SMOKE FAIL:', msg)
  client.close()
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

async function main() {
  const init = await client.initialize()
  console.log('serverInfo:', init.serverInfo?.name, init.serverInfo?.version)
  if (!init.capabilities?.prompts) return fail('prompts 能力未声明')
  console.log('capabilities.prompts: declared')

  const prompts = await client.listPrompts()
  console.log('listPrompts:', JSON.stringify(prompts))
  if (prompts.length !== 2) return fail(`期望 2 个提示词，实际 ${prompts.length}`)
  if (prompts[0].name !== 'greet' || prompts[1].name !== 'summarize') return fail(`提示词顺序/内容异常: ${JSON.stringify(prompts)}`)
  if (prompts[1].arguments?.[0]?.name !== 'topic') return fail('summarize 参数声明缺失')

  const greet = await client.getPrompt('greet')
  console.log('getPrompt(greet):', JSON.stringify(greet.messages))
  if (greet.messages[0]?.content?.text !== '你好') return fail('greet 渲染内容异常')

  const summary = await client.getPrompt('summarize', { topic: 'flare 引擎' })
  console.log('getPrompt(summarize,{topic}):', JSON.stringify(summary.messages))
  if (!summary.messages[0]?.content?.text.includes('flare 引擎')) return fail('summarize 渲染内容未带参数')

  const tools = await client.listTools()
  console.log('tools 数量:', tools.length, '（透传不破坏工具）')
  if (!tools.map((t) => t.name).includes('read_file')) return fail('flare 自身工具缺失')

  console.log('SMOKE PASS')
  client.close()
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

main().catch((e) => fail(String(e?.message || e)))
