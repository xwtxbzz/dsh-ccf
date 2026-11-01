/**
 * package.json 的护栏。2026-11-01 有过一次事故：用 PowerShell
 * `(Get-Content -Raw) -replace ... | Set-Content -Encoding ascii` 改版本号，
 * 中文描述被写成一串问号，JSON 里于是留下坏字符——
 * 本地 `npm test` 跑在改版本号之前，没发现；CI 上 `require('./package.json')`
 * 直接 `Bad control character in string literal` 才暴露。
 *
 * 这类损坏的特点：JSON 也许还能解析（问号是合法字符），但**中文没了**。
 * 所以这里既查"能解析"，也查"中文还在"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'package.json'), 'utf8')

let parsed = null
assert.doesNotThrow(() => { parsed = JSON.parse(raw) }, 'package.json 必须是合法 JSON（别用会改写编码的编辑器/命令）')

assert.equal(parsed.name, 'dsh-ccf')
assert.match(String(parsed.version), /^\d+\.\d+\.\d+$/, 'version 要是纯 x.y.z')
assert.ok(parsed.dsh && parsed.dsh.bundle && parsed.dsh.bundle.patch, '缺少 dsh.bundle.patch')
assert.ok(parsed.dsh.client && parsed.dsh.client.platform === 'web', '缺少 dsh.client.platform=web')

// 中文是"编码被毁"的第一现场：问号串、替换字符都算坏。
assert.match(String(parsed.description), /[\u4e00-\u9fff]/, 'description 里的中文被写坏了（多半是 Set-Content -Encoding ascii 干的）')
assert.doesNotMatch(String(parsed.description), /\uFFFD/, 'description 里出现替换字符，文件编码已坏')
assert.doesNotMatch(String(parsed.description), /\?{3,}/, 'description 里出现连续问号，中文被写坏了')

console.log('package: ok')
