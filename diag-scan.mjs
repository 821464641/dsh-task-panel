// Batch inspection: for every session, decode its log and compute what the
// task panel will show under v0.1.8 semantics. Summaries per session.
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import {
  foldTodos, hasTodoHistory, foldUserTasksAfter, lastTodoWriteTime, mergeTodos,
  collectGoalHints, readPanelTasks,
} from './lib/index.js'

const root = 'C:\\Users\\Windows User\\.dsh\\sessions'
const cacheFile = 'C:\\Users\\Windows User\\.dsh\\storages\\session_projcache.json'

const cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
const cachedSessions = cache?.tables?.sessions ?? {}

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) break
    const start = offset
    offset += 4
    const fhd = buffer[offset]; offset += 1
    if ((fhd & 24) !== 0) throw new Error('reserved bits')
    const singleSegment = (fhd & 32) !== 0
    const fcsFlag = (fhd >> 6) & 3
    const dictFlag = fhd & 3
    if (!singleSegment) offset += 1
    offset += [0, 1, 2, 4][dictFlag]
    offset += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error('torn')
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0
      const type = (bh >> 1) & 3
      const size = (bh >> 3) & 0x1fffff
      if (type === 3) throw new Error('reserved block')
      offset += type === 1 ? 1 : size
      if (offset > buffer.length) throw new Error('torn block')
      if (last) break
    }
    if ((fhd & 4) !== 0) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

function decode(file) {
  const buffer = readFileSync(file)
  let out = ''
  for (const f of scanFrames(buffer)) out += zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8')
  return out
}

const rows = []
for (const ws of readdirSync(root, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  for (const d of readdirSync(join(root, ws.name), { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const sid = d.name
    const file = join(root, ws.name, sid, 'session.jsonl.zstd')
    let text
    try { text = decode(file) } catch { continue }
    const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    if (events.length < 4) continue
    const userMsgs = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
    if (userMsgs.length < 2) continue

    const session = { events }
    const agentTodos = foldTodos(session)
    const writeTime = lastTodoWriteTime(session)
    const todos = mergeTodos(agentTodos, foldUserTasksAfter(session, writeTime))
    const hints = collectGoalHints(session)

    const cc = cachedSessions[sid]
    const title = cc?.rows?.title?.val ?? ''
    const goalVal = cc?.rows?.goal?.val?.goal
    const goalPhase = goalVal ? goalVal.phase : 'no-goal'

    const source = readPanelTasks(sid) !== null ? 'LLM' : (hasTodoHistory(session) ? 'todo' : (todos.length > 0 ? 'derive' : 'none'))

    rows.push({
      sid: sid.slice(0, 13),
      title: String(title).slice(0, 26),
      msgs: userMsgs.length,
      todoN: todos.length,
      todoStatuses: todos.reduce((m, t) => { m[t.status] = (m[t.status] ?? 0) + 1; return m }, {}),
      first: todos[0]?.content?.slice(0, 30) ?? '',
      goal: goalPhase,
      hints: hints.length,
      source,
    })
  }
}

rows.sort((a, b) => b.msgs - a.msgs)
for (const r of rows) {
  const st = Object.entries(r.todoStatuses).map(([k, v]) => `${k}:${v}`).join(' ')
  console.log(
    `[${r.source.padEnd(6)}] 任务${String(r.todoN).padStart(2)} (${st}) 目标:${r.goal.padEnd(10)} 疑似:${r.hints} msgs:${String(r.msgs).padStart(4)} | ${r.title} | ${r.first}`,
  )
}
console.log('\n总巡检会话数:', rows.length)
