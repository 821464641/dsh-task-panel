/**
 * Smoke test for dsh-task-panel host half: drives apply() with a stub ctx
 * and exercises the registered route end to end.
 */
import { apply } from './lib/index.js'

const routes = []
let captured = null

const services = {
  systemPrompt: {
    section(s) { promptSections.push(s) },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  sessions: {
    get(id) {
      if (id === 's1') return sessions1
      if (id === 's2') return sessions2
      if (id === 's3') return sessions3
      return undefined
    },
  },
  agents: {
    get(id) {
      return id === 's1' ? { id: 's1' } : undefined
    },
  },
  goals: {
    get(agent) {
      if (agent.id !== 's1') throw new Error('not live')
      return {
        id: 'g1', revision: 3, objective: '完成插件开发', phase: 'active',
        roundsStarted: 2, maxGoalRounds: 5,
        blockedReason: null,
        createdAt: 1000, updatedAt: 3000,
      }
    },
  },
}

let onListeners = {}
const promptSections = []
const ctx = {
  get(name) { return services[name] },
  on(event, fn) { onListeners[event] = fn },
  effect(fn) { return fn() },
}

const sessions1 = {
  events: [
    { seq: 0, time: 1000, type: 'turn/start', data: {} },
    { seq: 1, time: 2000, type: 'todo/write', data: { todos: [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
    ] } },
    { seq: 2, time: 2500, type: 'step/start', data: {} },
    { seq: 3, time: 3000, type: 'todo/write', data: { todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'pending' },
    ] } },
    // A NEW TURN starts after the list was written: the panel must KEEP the
    // last list (persistence) instead of showing nothing.
    { seq: 4, time: 4000, type: 'turn/start', data: {} },
  ],
}

// No todo/write at all: the host must derive tasks from user messages ACROSS
// turns (accumulated, newest in_progress) + long-term hints.
const sessions2 = {
  events: [
    { seq: 0, time: 1000, type: 'turn/start', data: {} },
    { seq: 1, time: 1500, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请将这个插件提交到 GitHub' }] } },
    { seq: 2, time: 1600, type: 'turn/start', data: {} },
    { seq: 3, time: 1700, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请持续维护这个插件' }] } },
    { seq: 4, time: 1800, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '好了' }] } },
    { seq: 5, time: 1900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个怎么用？' }] } },
  ],
}

// Two real requests in one turn: both derived, newest in_progress.
const sessions3 = {
  events: [
    { seq: 0, time: 1000, type: 'turn/start', data: {} },
    { seq: 1, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '移动插件文件位置' }] } },
    { seq: 2, time: 1200, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '撰写介绍文档' }] } },
  ],
}

apply(ctx)

const convention = promptSections.find((s) => s.name === 'task-panel:task-convention')
if (convention === undefined) throw new Error('task convention prompt section not registered')
if (!convention.text.includes('去做某件事')) throw new Error('convention lacks expanded short-term rule')
if (!convention.text.includes('执行过程里的操作不算任务')) throw new Error('convention lacks execution-exclusion rule')
if (!convention.text.includes('长期任务')) throw new Error('convention lacks long-term rule')

const route = routes.find((r) => r.path === '/plugins/dsh-task-panel/state')
if (!route) throw new Error('state route not registered')

function invoke(url) {
  return new Promise((resolve, reject) => {
    let status = 0
    let body = null
    route.handler(
      { url },
      {
        writeHead(code, headers) { status = code; captured = headers },
        end(text) { body = text; resolve({ status, body: JSON.parse(text), headers: captured }) },
      },
    ).catch(reject)
  })
}

const re = await invoke('/plugins/dsh-task-panel/state?session=s1')
console.log('status:', re.status)
console.log('goal:', re.body.goal)
console.log('todos:', JSON.stringify(re.body.todos))
console.log('session:', re.body.session)

if (re.status !== 200) throw new Error('expected 200')
if (re.body.session !== 's1') throw new Error('session echo mismatch')
// Subagents are internal execution mechanism — the route must NOT expose them.
if ('subagents' in re.body) throw new Error('route must not expose subagents')
if (re.body.goal.roundsStarted !== 2 || re.body.goal.maxGoalRounds !== 5) throw new Error('goal mismatch')
// The list written BEFORE the trailing turn/start must persist (no wipe).
if (re.body.todos.length !== 3) throw new Error('todos must persist across turns: ' + JSON.stringify(re.body.todos))
const a = re.body.todos.find((t) => t.content === 'A')
if (!a || a.status !== 'completed' || a.startedAt !== 2000 || a.endedAt !== 3000) throw new Error('todo A mismatch: ' + JSON.stringify(a))
const b = re.body.todos.find((t) => t.content === 'B')
if (!b || b.status !== 'in_progress' || b.startedAt !== 3000) throw new Error('todo B mismatch: ' + JSON.stringify(b))
const c = re.body.todos.find((t) => t.content === 'C')
if (!c || c.status !== 'pending' || c.startedAt !== null) throw new Error('todo C mismatch: ' + JSON.stringify(c))
if (!Array.isArray(re.body.goalHints) || re.body.goalHints.length !== 0) throw new Error('goal hints must be empty when a goal exists')

const empty = await invoke('/plugins/dsh-task-panel/state')
if (empty.body.session !== null) throw new Error('empty session param should return session null')
if (empty.body.todos.length !== 0) throw new Error('empty param should have no todos')

const missing = await invoke('/plugins/dsh-task-panel/state?session=nope')
if (missing.status !== 200 || missing.body.session !== 'nope' || missing.body.todos.length !== 0) {
  throw new Error('missing session should degrade gracefully')
}

// Fallback derivation: no todo history → tasks accumulate ACROSS turns.
// Newest first; 持续维护 is both a task and a long-term hint.
const derived = await invoke('/plugins/dsh-task-panel/state?session=s2')
if (derived.body.todos.length !== 2) throw new Error('derived tasks: expected 2, got ' + derived.body.todos.length)
const d0 = derived.body.todos[0]
if (d0.content !== '持续维护这个插件') throw new Error('derived newest should be 持续维护: ' + JSON.stringify(d0))
if (d0.status !== 'in_progress' || d0.startedAt !== 1700 || d0.endedAt !== null) throw new Error('derived newest status/time mismatch: ' + JSON.stringify(d0))
const d1 = derived.body.todos[1]
if (d1.content !== '将这个插件提交到 GitHub' || d1.status !== 'pending' || d1.startedAt !== 1500) {
  throw new Error('derived older task mismatch: ' + JSON.stringify(d1))
}
if (!Array.isArray(derived.body.goalHints) || derived.body.goalHints.length !== 1) {
  throw new Error('expected 1 goal hint: ' + JSON.stringify(derived.body.goalHints))
}
if (derived.body.goalHints[0] !== '持续维护这个插件') throw new Error('goal hint mismatch: ' + JSON.stringify(derived.body.goalHints))

const derived2 = await invoke('/plugins/dsh-task-panel/state?session=s3')
if (derived2.body.todos.length !== 2) throw new Error('derived tasks s3: expected 2, got ' + derived2.body.todos.length)
if (derived2.body.todos[0].content !== '撰写介绍文档' || derived2.body.todos[0].status !== 'in_progress') {
  throw new Error('derived s3 newest should be in_progress: ' + JSON.stringify(derived2.body.todos[0]))
}
if (derived2.body.todos[1].content !== '移动插件文件位置' || derived2.body.todos[1].status !== 'pending') {
  throw new Error('derived s3 second mismatch: ' + JSON.stringify(derived2.body.todos[1]))
}
if (derived2.body.goalHints.length !== 0) throw new Error('s3 should have no goal hints')

console.log('\nSMOKE TEST PASSED ✔')
