/**
 * dsh-ccf · 极简 YAML 子集解析器
 *
 * 只服务一个用途：读 ccfddl 的 `conferences/<venue>.yml`。
 * 那种文件的结构极其规整（顶层是一个列表，每项是 map，里面再嵌 map / 列表 / 标量），
 * 所以这里不引入 npm 依赖，手写一个缩进驱动的解析器：
 *
 *   - title: ICASSP
 *     sub: SP
 *     confs:
 *       - year: 2023
 *         timeline:
 *           - deadline: '2022-09-14 23:59:59'
 *
 * 支持：注释、单双引号、行内 [a, b]、行内 {k: v}、true/false/null、数字。
 * 不支持（也不需要）：锚点/别名、多行块标量(| >)、复杂流式嵌套、tab 缩进。
 */

/** 去掉行内注释（引号内的 # 不算注释）。 */
function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index)
    }
  }
  return line
}

/** 拆成 {indent, text} 的有效行。 */
function toLines(source) {
  const lines = []
  const rawLines = String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  for (const raw of rawLines) {
    const withoutComment = stripComment(raw).replace(/\s+$/, '')
    if (!withoutComment.trim()) continue
    if (/^(---|\.\.\.)\s*$/.test(withoutComment.trim())) continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    if (withoutComment.slice(0, indent).includes('\t')) {
      throw new Error('YAML 里出现了 tab 缩进，无法解析')
    }
    lines.push({ indent, text: withoutComment.trim() })
  }
  return lines
}

/** 解析标量：去引号、识别布尔/空/数字、行内数组与行内 map。 */
export function parseScalar(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''

  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : value
  }
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((part) => parseScalar(part))
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim()
    const map = {}
    if (!inner) return map
    for (const part of splitFlow(inner)) {
      const index = part.indexOf(':')
      if (index < 0) continue
      map[String(parseScalar(part.slice(0, index)))] = parseScalar(part.slice(index + 1))
    }
    return map
  }
  return value
}

/** 按逗号切流行式集合，忽略引号/括号内的逗号。 */
function splitFlow(text) {
  const parts = []
  let current = ''
  let depth = 0
  let quote = null
  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** 找到一台机器上 `key:` 与 value 的分界（排除引号内的冒号）。 */
function splitKey(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':' && (index + 1 === text.length || /\s/.test(text[index + 1]))) {
      return { key: text.slice(0, index).trim(), rest: text.slice(index + 1).trim() }
    }
  }
  return null
}

function parseBlock(lines, start, indent) {
  const first = lines[start]
  if (!first) return { value: null, next: start }
  if (first.text.startsWith('- ') || first.text === '-') {
    return parseSequence(lines, start, indent)
  }
  return parseMapping(lines, start, indent)
}

function parseSequence(lines, start, indent) {
  const items = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent || !(line.text.startsWith('- ') || line.text === '-')) break
    if (line.indent > indent) break
    const body = line.text === '-' ? '' : line.text.slice(2).trim()
    if (!body) {
      const nested = lines[index + 1]
      if (nested && nested.indent > indent) {
        const result = parseBlock(lines, index + 1, nested.indent)
        items.push(result.value)
        index = result.next
      } else {
        items.push(null)
        index += 1
      }
      continue
    }
    const kv = splitKey(body)
    if (kv) {
      // 该项是一个 map：先解析首行的 key，再继续吃后续同层（> indent）的 key
      const map = {}
      assignKey(map, kv, lines, index, indent, body)
      index = advanceItem(lines, index, indent, kv, map)
      items.push(map)
      continue
    }
    items.push(parseScalar(body))
    index += 1
  }
  return { value: items, next: index }
}

/** 处理 `- key: value` 这一行本身（值可能在下一层缩进里）。 */
function assignKey(map, kv, lines, index, itemIndent, body) {
  if (kv.rest === '') {
    const nested = lines[index + 1]
    const childIndent = body.length + itemIndent // "- " 占两格
    if (nested && nested.indent > itemIndent) {
      // 由 advanceItem 负责解析嵌套块
      map[kv.key] = { __nestedAt: index + 1, __indent: nested.indent }
      return
    }
    map[kv.key] = null
    void childIndent
    return
  }
  map[kv.key] = parseScalar(kv.rest)
}

/**
 * 从 `- key: value` 这一行往后吃掉该 map 项的其余键。
 * 返回下一个待处理行的下标。
 */
function advanceItem(lines, index, itemIndent, firstKv, map) {
  let cursor = index + 1
  // 先解决首行的嵌套块（如果值是空的）
  const pending = map[firstKv.key]
  if (pending && typeof pending === 'object' && '__nestedAt' in pending) {
    const result = parseBlock(lines, pending.__nestedAt, pending.__indent)
    map[firstKv.key] = result.value
    cursor = result.next
  }
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.indent <= itemIndent) break
    const kv = splitKey(line.text)
    if (!kv) {
      cursor += 1
      continue
    }
    if (kv.rest === '') {
      const nested = lines[cursor + 1]
      if (nested && nested.indent > line.indent) {
        const result = parseBlock(lines, cursor + 1, nested.indent)
        map[kv.key] = result.value
        cursor = result.next
      } else {
        map[kv.key] = null
        cursor += 1
      }
      continue
    }
    map[kv.key] = parseScalar(kv.rest)
    cursor += 1
  }
  return cursor
}

function parseMapping(lines, start, indent) {
  const map = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) break
    if (line.text.startsWith('- ')) break
    const kv = splitKey(line.text)
    if (!kv) {
      index += 1
      continue
    }
    if (kv.rest === '') {
      const nested = lines[index + 1]
      if (nested && nested.indent > indent) {
        const result = parseBlock(lines, index + 1, nested.indent)
        map[kv.key] = result.value
        index = result.next
      } else {
        map[kv.key] = null
        index += 1
      }
      continue
    }
    map[kv.key] = parseScalar(kv.rest)
    index += 1
  }
  return { value: map, next: index }
}

/**
 * 解析 YAML 文本。
 * @param {string} source
 * @returns {unknown}
 */
export function parseYaml(source) {
  const lines = toLines(source)
  if (lines.length === 0) return null
  const result = parseBlock(lines, 0, lines[0].indent)
  return result.value
}
