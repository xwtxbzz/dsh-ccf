import assert from 'node:assert/strict'
import { dedupeVenueYear } from '../lib/core.js'

const base = { deadline: Date.parse('2026-11-17T07:59:59Z'), notification: null, abstractDeadline: null, link: '', place: '' }

// 同一个会、同一年、两个系列名：只留一条（信息更全的那条）
const merged = dedupeVenueYear([
  { key: 'sp|2027', venue: 'S&P', year: 2027, name: 'S&P 2027', source: 'ccfddl-api', ...base },
  { key: 'ieee sp|2027', venue: 'IEEE S&P', year: 2027, name: 'IEEE S&P 2027', source: 'ccfddl-api', ...base, link: 'https://sp2027.ieee-security.org', place: 'Montreal' },
])
assert.equal(merged.length, 1, '同一个会同年只算一条')
assert.equal(merged[0].venue, 'IEEE S&P', '留信息更全的那条')
assert.equal(merged[0].key, 'ieee sp|2027')

// 不同年份 / 不同会 / 卫星会都不能被合并
const kept = dedupeVenueYear([
  { key: 'sp|2027', venue: 'S&P', year: 2027, ...base },
  { key: 'sp|2026', venue: 'S&P', year: 2026, ...base },
  { key: 'cvpr|2027', venue: 'CVPR', year: 2027, ...base },
  { key: 'acm siggraph asia|2026', venue: 'ACM SIGGRAPH ASIA', year: 2026, ...base },
  { key: 'siggraph|2026', venue: 'SIGGRAPH', year: 2026, ...base },
])
assert.equal(kept.length, 5, '年份不同、会不同、卫星会都不能合并')

// 顺序要稳：合并后保留第一次出现的位置
const ordered = dedupeVenueYear([
  { key: 'a|2027', venue: 'S&P', year: 2027, ...base },
  { key: 'b|2027', venue: 'CVPR', year: 2027, ...base },
  { key: 'c|2027', venue: 'IEEE S&P', year: 2027, ...base, link: 'x' },
])
assert.deepEqual(ordered.map((row) => row.venue), ['IEEE S&P', 'CVPR'], '合并后保持原位置')

console.log('core dedupe: 3 passed')
