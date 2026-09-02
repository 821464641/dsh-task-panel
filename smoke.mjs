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
const a = re.body.todos.find((t) => t.content === 'A')
if (!a || a.status !== 'completed' || a.startedAt !== 2000 || a.endedAt !== 3000) throw new Error('todo A mismatch: ' + JSON.stringify(a))
const b = re.body.todos.find((t) => t.content === 'B')
if (!b || b.status !== 'in_progress' || b.startedAt !== 3000) throw new Error('todo B mismatch: ' + JSON.stringify(b))
const c = re.body.todos.find((t) => t.content === 'C')
if (!c || c.status !== 'pending' || c.startedAt !== null) throw new Error('todo C mismatch: ' + JSON.stringify(c))

const empty = await invoke('/plugins/dsh-task-panel/state')
if (empty.body.session !== null) throw new Error('empty session param should return session null')
if (empty.body.todos.length !== 0) throw new Error('empty param should have no todos')

const missing = await invoke('/plugins/dsh-task-panel/state?session=nope')
if (missing.status !== 200 || missing.body.session !== 'nope' || missing.body.todos.length !== 0) {
  throw new Error('missing session should degrade gracefully')
}

console.log('\nSMOKE TEST PASSED ✔')
