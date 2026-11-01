/**
 * 真实 SDK 冒烟测试
 *
 * 单测里 defineTool 是替身；这里用宿主真实的 @deepseek-ai/dsh-tools 走一遍
 * schema 编译与校验，确认参数 DSL / output schema 在真 SDK 下合法。
 *
 * SDK 路径默认取 DSH 安装位置，可用 DSH_SDK_ROOT 覆盖：
 *   node test/sdk-smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createCcf, DEADLINE_PARAMETERS, VENUE_PARAMETERS } from '../lib/create.js'

const sdkRoot = process.env.DSH_SDK_ROOT
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

if (!existsSync(sdkRoot)) {
  console.log(`SKIP: 找不到 DSH SDK（${sdkRoot}），设置 DSH_SDK_ROOT 指向 @deepseek-ai/dsh-tools/lib/index.js`)
  process.exit(0)
}

const sdk = await import(pathToFileURL(sdkRoot).href)
const defineTool = sdk.defineTool
assert.equal(typeof defineTool, 'function', 'SDK 未导出 defineTool')
console.log(`SDK: ${sdkRoot}`)

function fakeContext() {
  const registered = { tools: [], commands: [], sections: [] }
  return {
    registered,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      services: {
        tools: { register: (tool) => registered.tools.push(tool) },
        commands: { register: (command) => registered.commands.push(command) },
        systemPrompt: { section: (section) => registered.sections.push(section) },
      },
      get(name) { return this.services[name] },
      on() { return () => {} },
    },
  }
}

const outputSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    report: { type: 'string', required: true },
    data: { type: 'object', additionalProperties: true },
  },
}
const compiledOutput = sdk.valueSchemaSpecToJsonSchema(outputSpec)
sdk.assertSupportedJsonSchema(compiledOutput)
assert.deepEqual(compiledOutput.required, ['ok', 'report'])
console.log('output schema 编译通过:', JSON.stringify(compiledOutput))

const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-sdk-'))
try {
  const now = Date.now()
  await writeFile(join(dir, 'cache.json'), JSON.stringify({
    schema: 'dsh-ccf/cache/v1',
    updatedAt: now,
    reports: [{ id: 'fixture', ok: true, count: 1 }],
    records: [{
      key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027', fullName: 'IEEE/CVF CVPR',
      rank: 'CCF-A', area: 'CV', core: 'A*', abstractDeadline: now + 6 * 86400e3,
      deadline: now + 13 * 86400e3, notification: null, confDate: '2027-06', place: 'TBD',
      link: 'https://cvpr.thecvf.com', submitLink: '', aliases: [], acceptRate: '~23%', h5: 300,
      history: [], verified: false, source: 'fixture',
    }],
  }), 'utf8')

  const { ctx, registered } = fakeContext()
  createCcf(ctx, { dataDir: dir }, defineTool)

  assert.equal(registered.tools.length, 3)
  const deadlines = registered.tools.find((tool) => tool.name === 'ccf_deadlines')
  const venue = registered.tools.find((tool) => tool.name === 'ccf_venue')
  const update = registered.tools.find((tool) => tool.name === 'ccf_update')
  assert.ok(deadlines && venue && update, '三个工具都要注册成功')
  console.log('真实 defineTool 接受三个工具定义（参数 DSL + output schema 均已编译）')

  if (typeof sdk.validateArgs === 'function') {
    assert.deepEqual(sdk.validateArgs(DEADLINE_PARAMETERS, { days: 30, rank: 'CCF-A' }), [])
    assert.deepEqual(sdk.validateArgs(VENUE_PARAMETERS, { venue: 'CVPR' }), [])
    const bad = sdk.validateArgs(DEADLINE_PARAMETERS, { days: 'thirty' })
    assert.ok(bad.length > 0, 'days 传字符串必须被判违规')
    console.log('validateArgs 正确接受合法参数、拒绝非法类型:', bad[0])
  }

  const value = await deadlines.execute({ days: 30 })
  assert.equal(value.ok, true)
  assert.match(value.report, /CVPR 2027/)

  if (typeof sdk.validateJsonSchemaValue === 'function') {
    const violations = sdk.validateJsonSchemaValue(compiledOutput, value)
    assert.deepEqual(violations, [], `输出校验不通过: ${JSON.stringify(violations)}`)
    console.log('返回值通过 output schema 校验')
  }

  const rendered = deadlines.output.render({ days: 30 }, value)
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
  assert.match(rendered[0].text, /CVPR 2027/)
  console.log('render 产出 text 卡片片段')

  const detail = await venue.execute({ venue: 'cvpr' })
  assert.equal(detail.ok, true)
  assert.match(detail.report, /CVPR 2027 · CCF-A/)

  const section = registered.sections[0]
  assert.match(section.text({}), /## 会议截稿（dsh-ccf）/)
  console.log('system-prompt 段（动态 provider）返回非空摘要')

  console.log('\nSMOKE OK')
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
