/**
 * 迷你 YAML 解析器测试：只喂 ccfddl 真正会出现的那种结构。
 *
 * 运行：node test/yaml.test.mjs
 */
import assert from 'node:assert/strict'

import { parseScalar, parseYaml } from '../lib/yaml.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('yaml.test')

test('标量：引号、数字、布尔、空、行内数组', () => {
  assert.equal(parseScalar("'2026-09-09 23:59:59'"), '2026-09-09 23:59:59')
  assert.equal(parseScalar('"hello # not a comment"'), 'hello # not a comment')
  assert.equal(parseScalar('2027'), 2027)
  assert.equal(parseScalar('1.5'), 1.5)
  assert.equal(parseScalar('true'), true)
  assert.equal(parseScalar('null'), null)
  assert.deepEqual(parseScalar('[a, b, c]'), ['a', 'b', 'c'])
  assert.deepEqual(parseScalar('{a: 1, b: two}'), { a: 1, b: 'two' })
})

test('ccfddl 风格的整份文件', () => {
  const source = `# ICASSP
- title: ICASSP
  description: International Conference on Acoustics, Speech and Signal Processing
  sub: SP
  rank: B
  dblp: icassp
  confs:
    - year: 2027
      id: icassp27
      link: https://2027.ieeeicassp.org/
      timeline:
        - abstract_deadline: '2026-09-02 23:59:59'
          deadline: '2026-09-09 23:59:59'
        - deadline: '2026-10-14 23:59:59'
      timezone: AoE
      date: May 2027
      place: TBD
`
  const parsed = parseYaml(source)
  assert.equal(Array.isArray(parsed), true, '顶层应是列表')
  assert.equal(parsed.length, 1)
  const venue = parsed[0]
  assert.equal(venue.title, 'ICASSP')
  assert.equal(venue.sub, 'SP')
  assert.equal(venue.rank, 'B')
  assert.equal(venue.confs.length, 1)
  const conf = venue.confs[0]
  assert.equal(conf.year, 2027)
  assert.equal(conf.id, 'icassp27')
  assert.equal(conf.link, 'https://2027.ieeeicassp.org/')
  assert.equal(conf.timezone, 'AoE')
  assert.equal(conf.date, 'May 2027')
  assert.equal(conf.place, 'TBD')
  assert.equal(conf.timeline.length, 2)
  assert.equal(conf.timeline[0].abstract_deadline, '2026-09-02 23:59:59')
  assert.equal(conf.timeline[0].deadline, '2026-09-09 23:59:59')
  assert.equal(conf.timeline[1].deadline, '2026-10-14 23:59:59')
})

test('多会议 + 标量列表 + 行内数组 + 注释', () => {
  const source = `- title: KDD
  sub: DB
  rank: A
  tags: [数据挖掘, top]
  confs:
    - year: 2027
      timeline: [{deadline: '2027-02-05 23:59:59'}]
- title: OSDI
  rank: A
  confs:
    - year: 2027
      timeline:
        - deadline: 2027-12-08 23:59:59   # 行尾注释
`
  const parsed = parseYaml(source)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0].tags, ['数据挖掘', 'top'])
  assert.equal(parsed[0].confs[0].timeline[0].deadline, '2027-02-05 23:59:59')
  assert.equal(parsed[1].title, 'OSDI')
  assert.equal(parsed[1].confs[0].timeline[0].deadline, '2027-12-08 23:59:59')
})

test('空文档与纯注释', () => {
  assert.equal(parseYaml(''), null)
  assert.equal(parseYaml('# only a comment\n\n'), null)
})

test('tab 缩进直接报错，不静默出错', () => {
  assert.throws(() => parseYaml('- title: X\n\t- year: 1\n'), /tab/i)
})

console.log(`\n${passed} passed`)
