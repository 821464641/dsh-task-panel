/**
 * dsh-task-panel host half.
 *
 * Registers one read-only HTTP route served by the dsh web app:
 *
 *   GET /plugins/dsh-task-panel/state?session=<sessionId>
 *
 * It returns the session's USER-VISIBLE tasks as JSON, mirroring what the
 * built-in model-facing sources fold from the same session log:
 *
 *   - `todos`:    the current short-term task list (the session's todo list,
 *                 kept by convention at user-assigned/task granularity), with
 *                 derived first-`in_progress`/first-`completed` timestamps;
 *   - `goal`:     the current long-term task (the same-session goal view:
 *                 phase, round counters, blocker reason, timestamps) when its
 *                 agent is live.
 *
 * Subagent/background-job/workflow activity is the agent's internal execution
 * mechanism and is deliberately NOT user-visible, so this route never exposes
 * it. Every service is read optionally through ctx.get() and guarded by
 * try/catch, so the panel simply shows less on a capability-missing or
 * damaged session instead of failing the whole route. This plugin declares
 * no hard injection and never mutates state.
 *
 * @module dsh-task-panel
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'task-panel'

const ROUTE_PATH = '/plugins/dsh-task-panel/state'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

// ── LLM-authored panel task store (task_panel_update) ───────────────────────
// The agent writes the user-visible task list (titles, statuses, summaries)
// through the task_panel_update tool; the route serves that store as the
// authoritative short-term list when it exists. Lightweight: one JSON file
// per session under DSH_HOME/task-panel-state (overridable for tests).

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function stateDir() {
  return process.env.DSH_TASK_PANEL_STATE_DIR
    || join(process.env.DSH_HOME || homedir(), 'task-panel-state')
}

function stateFile(sessionId) {
  return join(stateDir(), sessionId + '.json')
}

/** Strict normalizer for the stored task shape; null on any violation. */
function normalizeTasks(input) {
  if (!Array.isArray(input)) return null
  const out = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') return null
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const status = typeof item.status === 'string' ? item.status : ''
    if (title.length === 0 || title.length > 300 || !TASK_STATUSES.has(status)) return null
    out.push({
      title,
      status,
      ...(typeof item.summary === 'string' && item.summary.trim().length > 0
        ? { summary: item.summary.trim().slice(0, 1200) }
        : {}),
    })
  }
  return out
}

/** Read the LLM-authored list; null when absent, corrupted, or empty-array absent. */
function readPanelTasks(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'))
    return normalizeTasks(parsed.tasks)
  } catch {
    return null
  }
}

function writePanelTasks(sessionId, tasks) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const file = stateFile(sessionId)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify({ session: sessionId, updatedAt: Date.now(), tasks }))
  renameSync(tmp, file)
  return tasks
}

/**
 * Fold the session log into the current todo list plus per-item timestamps.
 * Replicates the official `todos` projection: the list resets on
 * `turn/start` and is replaced wholesale by each `todo/write`.
 */
function foldTodos(session) {
  let current = null
  const startedAt = new Map()
  const endedAt = new Map()
  let lastWrite = null
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'todo/write') continue
    const data = event.data
    if (data === null || typeof data !== 'object' || !Array.isArray(data.todos)) continue
    current = data.todos
    lastWrite = event.time
    for (const item of data.todos) {
      if (item === null || typeof item !== 'object') continue
      const content = item.content
      if (typeof content !== 'string' || content.length === 0) continue
      if (item.status === 'in_progress' && !startedAt.has(content)) {
        startedAt.set(content, event.time)
      }
      if (item.status === 'completed' && !endedAt.has(content)) {
        endedAt.set(content, event.time)
      }
    }
  }
  if (!Array.isArray(current)) return []
  const out = []
  for (const item of current) {
    if (item === null || typeof item !== 'object') continue
    const content = item.content
    if (typeof content !== 'string' || content.length === 0) continue
    out.push({
      content,
      status: item.status,
      startedAt: startedAt.has(content) ? startedAt.get(content) : null,
      endedAt: endedAt.has(content) ? endedAt.get(content) : null,
    })
  }
  return out
}

/** Whether the agent ever wrote a todo list in this session. When it did,
 * the latest list is authoritative (even when empty) and the heuristic
 * fallback must NOT resurrect old user requests. */
function hasTodoHistory(session) {
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'todo/write') continue
    const data = event.data
    if (data !== null && typeof data === 'object' && Array.isArray(data.todos)) return true
  }
  return false
}

// ── Fallback: derive short-term tasks from the current turn's user ──────────
// messages. The agent's own todo list (above) is the preferred source; this
// heuristic only kicks in when that list is empty, so the panel still shows
// "what the user asked the session to do" even when the agent never wrote a
// todo list (the built-in todo tool is documented as skippable for trivial
// work, which broke task visibility in other sessions).

/** Bare confirmations / acknowledgements: not tasks. */
const CONFIRM_RE = /^(好的?|好|嗯|嗯嗯|哦|可以|行|ok|okay|收到|谢谢|感谢|多谢|没问题|是的|对|对了|好了|完成|就这样|继续|稍等|等一下|来吧|开始吧)[!！。.~～\s]*$/i
/** Question-request words: a question is consultation, not a task. */
const QUESTION_TAIL_RE = /(为什么|为何|什么意思|什么是|是什么|怎么|如何|啥|什么|哪|是否|能不能|可不可以|是不是|对不对|多少|几个|几点|谁|吗|呢|吧|么)$/
const QUESTION_HEAD_RE = /^(为什么|为何|什么是|是什么|怎么|如何|啥|什么|哪|是否|能不能|可不可以|会不会|有没有|可以|能)/
/** Action-ish signals that mark a message as "ask the session to do X". */
const TASK_VERB_RE = /(请|帮我|帮忙|麻烦|希望|要求|需要|做|写|创建|修改|编辑|移动|提交|发布|推送|部署|更新|检查|验证|测试|修复|处理|安排|整理|完成|实现|开发|安装|配置|运行|执行|切换|迁移|升级|删除|清理|备份|生成|转换|导出|导入|上传|下载|搜索|查询|计算|汇总|统计|演示|介绍|设计|扩展|调整|添加|替换|移除|同步|补齐|补充|说明|解释|看看|查一下|检查一下)/

/** Slice the text content out of a stored UserMessage (string or blocks). */
function messageText(message) {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        out += block.text
      }
    }
    return out
  }
  return ''
}

/** Clean a user message into a task title, or null when it is not a task. */
function cleanTaskTitle(raw) {
  const text = String(raw).replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '')
  if (text.length === 0) return null
  const stripped = text.replace(/[!！。.~～\s]+$/u, '')
  if (stripped.length === 0) return null
  if (CONFIRM_RE.test(stripped)) return null
  if (/[?？]/.test(stripped)) return null
  // Pure source-location messages ("源码地址在这里：…") are information, not requests.
  if (/^(源码地址|代码地址|文件路径|路径在这里|位置在这里|源码在|代码在|文件在)/.test(stripped)) return null
  const tail = stripped.slice(-6)
  if (QUESTION_TAIL_RE.test(tail)) return null
  if (QUESTION_HEAD_RE.test(stripped)) return null
  const asked = TASK_VERB_RE.test(stripped) || stripped.length >= 8
  if (!asked) return null
  // Strip leading politeness forms for a compact title.
  const title = stripped
    .replace(/^(请你|麻烦你|请帮我|麻烦帮我|帮我|帮忙|请|麻烦)[，,：:\s、]*/u, '')
    .trim()
  return title.length > 0 ? title : stripped
}

/**
 * Fold ALL direct-human messages of the session (across turns) into fallback
 * short-term tasks, newest first by first-seen time, deduped per title.
 * Only used when the agent never wrote a todo list. Goal-round and
 * plugin-sourced messages are ignored. The newest request is marked
 * `in_progress`; the rest stay pending.
 */
function foldUserTasks(session) {
  const byTitle = new Map()
  let order = 0
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const source = data.source
    if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    const title = cleanTaskTitle(messageText(data))
    if (title === null || byTitle.has(title)) continue
    byTitle.set(title, {
      content: title,
      status: 'pending',
      startedAt: typeof event.time === 'number' ? event.time : null,
      endedAt: null,
      order,
    })
    order += 1
  }
  const tasks = [...byTitle.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.order - a.order)
  if (tasks.length === 0) return []
  tasks[0].status = 'in_progress' // newest request = the active work
  return tasks.slice(0, 12)
}

/** Time of the session's latest todo/write, or null when never written. */
function lastTodoWriteTime(session) {
  let last = null
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'todo/write') continue
    const data = event.data
    if (data === null || typeof data !== 'object' || !Array.isArray(data.todos)) continue
    if (typeof event.time === 'number') last = event.time
  }
  return last
}

/**
 * Derive the NEW user-requested tasks that arrived AFTER the latest
 * todo/write — the agent's stale list must not hide them. Newest first,
 * deduped by title, capped at 5. Empty when nothing new was requested.
 */
function foldUserTasksAfter(session, afterTime) {
  const byTitle = new Map()
  let order = 0
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const source = data.source
    if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    if (afterTime !== null && !(typeof event.time === 'number' && event.time > afterTime)) continue
    const title = cleanTaskTitle(messageText(data))
    if (title === null || byTitle.has(title)) continue
    byTitle.set(title, {
      content: title,
      status: 'pending',
      startedAt: typeof event.time === 'number' ? event.time : null,
      endedAt: null,
      order,
    })
    order += 1
  }
  const tasks = [...byTitle.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.order - a.order)
  return tasks.slice(0, 5)
}

/** Merge the authoritative agent list with unacknowledged new requests. */
function mergeTodos(agentTodos, newDerived) {
  if (newDerived.length === 0) return agentTodos
  const existing = new Set(agentTodos.map((t) => t.content))
  const extra = newDerived.filter((t) => !existing.has(t.content))
  if (extra.length === 0) return agentTodos
  const hasActive = agentTodos.some((t) => t.status === 'in_progress')
  if (!hasActive) extra[0].status = 'in_progress' // newest unacknowledged = active work
  return agentTodos.concat(extra)
}

/** Long-term intent keywords: a message carrying one is a candidate for the
 * "疑似长期需求" hint shown when the session has no goal. */
const GOAL_HINT_RE = /(长期|持续|维护|跟踪|定期|常态化|一直|系列|项目|规划|阶段|迭代|持续推进|长期维护|长期跟踪)/

/**
 * Derive "疑似长期需求" hints from user messages when the session has no
 * goal at all — the panel then suggests establishing one instead of showing
 * an empty long-term section silently.
 */
function collectGoalHints(session) {
  const seen = new Set()
  const hints = []
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const source = data.source
    if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    const raw = messageText(data)
    const title = cleanTaskTitle(raw)
    if (title === null || seen.has(title)) continue
    if (!GOAL_HINT_RE.test(raw) && !GOAL_HINT_RE.test(title)) continue
    seen.add(title)
    hints.push(title)
    if (hints.length >= 3) break
  }
  return hints
}

/** Read the current same-session goal when the owning agent is live. */
function readGoal(ctx, sessionId) {
  const agents = ctx.get('agents')
  const goals = ctx.get('goals')
  if (agents === undefined || goals === undefined) return null
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    return null
  }
  if (agent === undefined) return null
  try {
    const goal = goals.get(agent)
    if (goal === undefined || goal === null) return null
    return {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      blockedReason: goal.blockedReason === undefined || goal.blockedReason === null
        ? null
        : {
          code: goal.blockedReason.code,
          message: goal.blockedReason.message,
        },
      createdAt: goal.createdAt === undefined ? null : goal.createdAt,
      updatedAt: goal.updatedAt === undefined ? null : goal.updatedAt,
    }
  } catch {
    return null
  }
}

/** Build the full JSON payload for one session id. */
async function collectState(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  let session
  try {
    session = sessions === undefined ? undefined : sessions.get(sessionId)
  } catch {
    session = undefined
  }
  if (session === undefined) {
    return { session: sessionId, goal: null, todos: [], goalHints: [] }
  }
  // Data-source priority:
  //   1. LLM-authored list (task_panel_update store) — authoritative when it
  //      exists, including an intentionally empty list;
  //   2. Otherwise the agent's todo list (persists across turns) merged with
  //      unacknowledged user requests, so a stale list never hides a task.
  const goal = readGoal(ctx, sessionId)
  const panelTasks = readPanelTasks(sessionId)
  let todos
  if (panelTasks !== null) {
    todos = panelTasks.map((t) => ({
      content: t.title,
      status: t.status,
      startedAt: null,
      endedAt: null,
      ...(t.summary !== undefined ? { summary: t.summary } : {}),
    }))
  } else {
    const agentTodos = foldTodos(session)
    todos = mergeTodos(agentTodos, foldUserTasksAfter(session, lastTodoWriteTime(session)))
  }
  return {
    session: sessionId,
    goal,
    todos,
    goalHints: goal === null ? collectGoalHints(session) : [],
  }
}

/** Register the state route once `webServer` is available. */
export function apply(ctx) {
  // Task-granularity convention: the panel mirrors the tasks VISIBLE to the
  // user — short-term tasks live in the todo list, long-term tasks in the
  // goal. The agent's own operational steps and internal mechanisms
  // (subagents, background jobs, workflows) are NOT user-visible tasks.
  // Every session of the profile receives this rule through a prompt section.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'task-panel:task-convention',
      order: 116,
      text: [
        '任务面板约定（task-panel，智能规则 v2）：面板的「短期任务」与「长期任务」都以「用户要做的事」为粒度；',
        '代理的执行过程与内部机制不计入。**短期任务的唯一书写口是 task_panel_update 工具**（整表提交，每次覆盖）；',
        '用户每次让会话「去做某件事」，都必须调用它登记/更新，不要跳过、不要延迟。',
        '',
        '【判断什么算任务】',
        '1. 用户任何一句「让会话去做某件事」都算一条（或几条）任务；一句话含多件事拆成多条；',
        '   与用户共同商定要做的事同样计入。',
        '2. 以下是「不算任务」的边界，必须排除：用户的问题/咨询/确认语（「好了」「可以」「谢谢」「怎么用？」）；',
        '   执行过程的操作（安装工具、运行命令、语法检查、验证、清理、汇报等）；纯信息来源消息',
        '   （「源码地址在这里：…」）；闲聊与状态陈述（「感觉不错」「在跑实验」）。',
        '3. 场景例库（用于校准判断）：',
        '   - 论文写作：「请整理实验结果，补充§4表格」→ 一条 `整理实验结果并补充 §4 表格`；',
        '   - 研究实验：「检测C6计算状态，准备论文支撑资料（代码库/基础数据/每图每表excel归档）」',
        '     → 两条：`检测 C6 计算状态`、`准备论文支撑资料（代码库+基础数据+图表归档）`；',
        '   - HPC/文档：「重写penalty_selection_pressure.md，单双罚值独立成篇」→ 一条：',
        '     `重写惩罚压力文档（单双罚值独立成篇）`；',
        '   - 参考资料：「用AgentTeams做X」→ 一条任务本身（团队是执行机制）。',
        '',
        '【概括规则】',
        '4. 任务名 = 一句话：动词 + 对象 + 关键限定（≤30字，宁短勿长）；',
        '   多指令请求：按「主题」合并为主任务，不逐句拆条（除非明显独立才拆分）；',
        '   summary 字段用 1-2 句写清该任务的实质内容/约束（含用户强调的细节、交付物与范围）。',
        '',
        '【完成判定】',
        '5. 任务的动作实际执行完毕即标 `completed`：不需要等用户确认；产出交付/汇报完成即完成；',
        '   任务被用户取消或改为其他后标 `completed`（或并入其他任务）。',
        '6. 每次调用 task_panel_update 都提交**完整列表**（含历史已完成项与当前状态）；',
        '   每轮结束时自检：本轮用户布置的任务若未登记、或已干完未更新完成态，必须补一次调用。',
        '7. 若你尚未登记，任务面板会以该用户消息的原文作为临时任务展示（无进度），但你登记后立即以你的为准。',
        '',
        '【长期任务 = 目标（goal）】',
        '8. 当用户明确表达长期目标（「长期维护」「持续跟踪」「一直做」「以后定期」「项目总目标」）时，',
        '   你**必须**建立目标（create_goal）；目标对应用户明确要求/共同商定的长期任务，',
        '   不为内部子目标、执行分段或代理自己推进计划创建目标；一个用户可见长期任务=一个目标。',
        '9. 目标推进由 goal 轮次机制管理；受阻时如实标记 blocked 并给出具体原因。',
        '10. 子代理、后台任务、工作流等是代理的内部执行机制，不创建目标、不写入任务清单。',
      ].join('\n'),
    })
  }

  // The agent-facing write port: LLM judgement lands here as one JSON file.
  // Hand-built registration (JSON Schema directly, no defineTool import) to
  // keep the bundle dependency-free; args are validated in execute.
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    const taskSchema = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          summary: { type: 'string' },
        },
        required: ['title', 'status'],
      },
    }
    ctx.effect(() => tools.register({
      name: 'task_panel_update',
      description: [
        '更新任务面板的短期任务清单（权威数据源，整表替换）。',
        '用户每次让会话「去做某件事」都必须用本工具登记/更新任务；',
        '任务名=一句话概括（动词+对象+关键限定，≤30字）；summary=1-2句实质内容；',
        '动作执行完毕即标 completed，不需等用户确认；每次提交完整列表。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: { tasks: taskSchema },
        required: ['tasks'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tasks: taskSchema },
          required: ['tasks'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => {
        const sessionId = exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new Error('task_panel_update requires a live agent session')
        }
        const tasks = normalizeTasks(args.tasks)
        if (tasks === null) throw new Error('task_panel_update: invalid tasks payload')
        writePanelTasks(sessionId, tasks)
        return { tasks }
      },
      presentCall: () => ({ card: 'generic', title: '更新任务面板', kind: 'other' }),
    }), 'task-panel: task_panel_update tool')
  }

  let done = false
  const register = () => {
    if (done) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    done = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        let sessionId = ''
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          sessionId = url.searchParams.get('session') ?? ''
        } catch {
          sessionId = ''
        }
        if (sessionId === '') {
          const body = JSON.stringify({ session: null, goal: null, todos: [], goalHints: [] })
          res.writeHead(200, JSON_HEADERS)
          res.end(body)
          return
        }
        try {
          const body = JSON.stringify(await collectState(ctx, sessionId))
          res.writeHead(200, JSON_HEADERS)
          res.end(body)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, JSON_HEADERS)
          res.end(JSON.stringify({ session: sessionId, error: message }))
        }
      },
    }), 'task-panel: state route')
  }
  register()
  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'webServer') register()
  })
}

// Exported for diagnostics/offline inspection (diag tools in this repo).
// The loader only reads name/inject/Config/apply; extra exports are inert.
export {
  foldTodos,
  hasTodoHistory,
  foldUserTasks,
  foldUserTasksAfter,
  lastTodoWriteTime,
  mergeTodos,
  collectGoalHints,
  cleanTaskTitle,
  messageText,
  normalizeTasks,
  readPanelTasks,
  writePanelTasks,
  stateDir,
}
