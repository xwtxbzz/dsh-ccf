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

// 商店卡片上「适用 dsh 版本」读的就是这个字段：没有它只能写「宿主要求未知」。
assert.match(String(parsed.engines?.dsh ?? ''), /^>=0\.\d+\.\d+/, '缺少 engines.dsh，商店只能显示「宿主要求未知」')
assert.match(String(parsed.engines?.node ?? ''), /^>=/, '缺少 engines.node')

// peer 范围必须给预发布版本留一个同元组的比较符：只写 `>=0.1.0-rc.6` 时，
// node-semver 不会让 0.2.1-rc.5 命中（没有任何比较符落在 0.2.1 这个元组上），
// 用户 npm install 会撞 ERESOLVE —— 上游 contributing.md 专门警告过这一点。
const peerTools = String(parsed.peerDependencies?.['@deepseek-ai/dsh-tools'] ?? '')
assert.ok(peerTools.includes('||'), 'dsh-tools 的 peer 范围要留预发布分支（如 >=0.1.0-rc.6 || >=0.2.0-0），否则 0.2.x-rc 的宿主会 ERESOLVE')

// 中文是"编码被毁"的第一现场：问号串、替换字符都算坏。
assert.match(String(parsed.description), /[\u4e00-\u9fff]/, 'description 里的中文被写坏了（多半是 Set-Content -Encoding ascii 干的）')
assert.doesNotMatch(String(parsed.description), /\uFFFD/, 'description 里出现替换字符，文件编码已坏')
assert.doesNotMatch(String(parsed.description), /\?{3,}/, 'description 里出现连续问号，中文被写坏了')

console.log('package: ok')
