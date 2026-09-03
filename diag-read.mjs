// Session inspection tool: locate a session by id, decode its multi-frame
// zstd log (frame scanner per RFC 8878, same checks as the official backend),
// and print diagnostics: recent user messages, last todo list, and what the
// panel (v0.1.6 semantics) would derive for the session.
//
// Usage: node diag-read.mjs <sessionIdFragment> [lastN]
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import {
  foldTodos, hasTodoHistory, foldUserTasks, foldUserTasksAfter,
  lastTodoWriteTime, mergeTodos, collectGoalHints, cleanTaskTitle, messageText,
} from './lib/index.js'

const root = 'C:\\Users\\Windows User\\.dsh\\sessions'
const fragment = process.argv[2]
const lastN = Number(process.argv[3] ?? 8)

const ZSTD_MAGIC = 0xfd2fb528

/** Locate complete zstd frames in a buffer (RFC 8878 structural walk). */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    const start = offset
    offset += 4
    const fhd = buffer[offset]; offset += 1
    if ((fhd & 24) !== 0) throw new Error('reserved frame-header bits')
    const singleSegment = (fhd & 32) !== 0
    const fcsFlag = (fhd >> 6) & 3
    const dictFlag = fhd & 3
    if (!singleSegment) offset += 1 // window descriptor
    offset += [0, 1, 2, 4][dictFlag]
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    offset += fcsBytes
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error('torn frame')
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0
      const type = (bh >> 1) & 3
      const size = (bh >> 3) & 0x1fffff
      if (type === 3) throw new Error('reserved block type')
      offset += type === 1 ? 1 : size
      if (offset > buffer.length) throw new Error('torn block')
      if (last) break
    }
    if ((fhd & 4) !== 0) offset += 4 // content checksum
    frames.push({ start, end: offset })
  }
  return frames
}

function decodeFile(file) {
  const buffer = readFileSync(file)
  const frames = scanFrames(buffer)
  let out = ''
  for (const frame of frames) out += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  return out
}

// find the file
let found = null
for (const ws of readdirSync(root, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  for (const d of readdirSync(join(root, ws.name), { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (d.name.includes(fragment)) {
      found = join(root, ws.name, d.name, 'session.jsonl.zstd')
      break
    }
  }
  if (found) break
}
if (!found) { console.error('session not found for fragment:', fragment); process.exit(1) }

console.log('file:', found)
const text = decodeFile(found)
const lines = text.split('\n').filter(Boolean)
const events = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('events:', events.length)

const userMessages = events
  .filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
  .map((e) => ({
    time: e.time,
    turn: e.data.turn ?? e.data?.seq ?? '',
    text: (Array.isArray(e.data?.content) ? e.data.content.map((b) => b.text ?? '').join('') : String(e.data?.content ?? '')).slice(0, 200),
  }))

console.log('\n=== 最近用户消息 ===')
for (const m of userMessages.slice(-lastN)) {
  console.log(new Date(m.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), '|', m.text.replace(/\n/g, ' '))
}

const lastWrite = [...events].reverse().find((e) => e.type === 'todo/write')
console.log('\n=== 最近 todo/write ===')
if (lastWrite) {
  console.log('time:', new Date(lastWrite.time).toLocaleString('zh-CN'))
  for (const t of lastWrite.data.todos) console.log('  [' + t.status + '] ' + t.content)
} else console.log('(无)')

console.log('\n=== 倒数第2条 todo/write ===')
const writes = events.filter((e) => e.type === 'todo/write')
if (writes.length > 1) {
  const w = writes[writes.length - 2]
  for (const t of w.data.todos) console.log('  [' + t.status + '] ' + t.content)
}

// what the panel would derive (v0.1.7 merge semantics)
console.log('\n=== 面板推导（v0.1.7 语义）===')
const session = { events }
const agentTodos = foldTodos(session)
const writeTime = lastTodoWriteTime(session)
console.log('hasTodoHistory:', hasTodoHistory(session), '| lastTodoWrite:', writeTime === null ? null : new Date(writeTime).toLocaleString('zh-CN'))
const todos = mergeTodos(agentTodos, foldUserTasksAfter(session, writeTime))
console.log('todos:', JSON.stringify(todos, null, 1).slice(0, 2000))
console.log('goalHints (无目标时适用):', JSON.stringify(collectGoalHints(session)).slice(0, 200))
