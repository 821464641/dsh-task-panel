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

export const name = 'task-panel'

const ROUTE_PATH = '/plugins/dsh-task-panel/state'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
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
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      current = null
      continue
    }
    if (event.type !== 'todo/write') continue
    const data = event.data
    if (data === null || typeof data !== 'object' || !Array.isArray(data.todos)) continue
    current = data.todos
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
 * Fold the CURRENT turn's direct-human messages into fallback short-term
 * tasks. Only messages from the last `turn/start` boundary count; goal-round
 * and plugin-sourced messages are ignored. The newest request is marked
 * `in_progress` so the panel shows it as the active work; others stay pending.
 */
function foldUserTasks(session) {
  const tasks = []
  let sawTurnStart = false
  for (const event of session.events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      tasks.length = 0
      sawTurnStart = true
      continue
    }
    if (event.type !== 'user/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const source = data.source
    if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    const title = cleanTaskTitle(messageText(data))
    if (title === null) continue
    tasks.push({ content: title, status: 'pending', startedAt: typeof event.time === 'number' ? event.time : null, endedAt: null })
  }
  if (tasks.length === 0) return []
  tasks[tasks.length - 1].status = 'in_progress'
  return tasks
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
    return { session: sessionId, goal: null, todos: [] }
  }
  // Preferred source: the agent's todo list (convention keeps it at
  // user-task granularity). Fallback: derive the user's requests from the
  // current turn when no list was written — so the panel proactively shows
  // short-term tasks even in sessions where the agent skipped todo_write.
  const agentTodos = foldTodos(session)
  return {
    session: sessionId,
    goal: readGoal(ctx, sessionId),
    todos: agentTodos.length > 0 ? agentTodos : foldUserTasks(session),
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
        '任务面板约定（task-panel）：面板的「短期任务」与「长期任务」都以「用户要做的事」为粒度；',
        '代理的执行过程与内部机制不计入。',
        '',
        '【短期任务 = todo 清单】',
        '1. 用户每次让会话「去做某件事」都对应一条短期任务，并且**必须**马上用 todo_write 登记——',
        '   不要因为任务简单而跳过（工具描述中「琐碎任务可跳过」的提示不适用于本插件配置的会话）。',
        '   例如用户说「请将这个插件提交到 GitHub」→ 一条：`发布插件到 GitHub`；',
        '   用户说「将该插件移入 D:\\... 并且要有详细的文档介绍该插件」→ 两条：',
        '   `移动插件文件位置`、`撰写介绍文档`。',
        '2. 一句话里若包含多件事，拆成多条任务；与用户共同商定要做的事同样计入。',
        '3. 任务以「用户要做的事」为粒度：**具体执行过程里的操作不算任务**。例如安装工具、生成密钥、',
        '   运行命令、语法检查、验证预检、清理旧副本、写测试、汇总汇报等，都不写入 todo 清单；',
        '   需要说明时在回复里简要交代即可。',
        '4. 用户的问题、咨询、确认语（如「好了」「可以」「谢谢」「怎么用？」）不属于让会话做事，不记录为任务。',
        '5. 若你尚未登记，任务面板会先以该用户消息的原文作为临时任务展示（无进度）；',
        '   你登记后以你的清单为准。',
        '6. 清单其余规则不变：完成即标记 completed；全部完成后保留已完成状态，不重复新建。',
        '',
        '【长期任务 = 目标（goal）】',
        '7. 目标只对应「用户在对话中明确要求的长期完成目标」或「与用户共同商定的长期任务」；',
        '   create_goal 本身要求发起于用户的直接请求，请始终保持这一要求。',
        '8. 一个用户可见的长期任务对应一个目标；不要为内部子目标、执行分段或代理自己推进计划而创建目标。',
        '9. 目标推进由 goal 轮次机制管理；受阻时如实标记 blocked 并给出具体原因。',
        '10. 子代理、后台任务、工作流等是代理的内部执行机制，不属于用户可见任务，',
        '   不需要为它们创建目标或写入清单。',
      ].join('\n'),
    })
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
          const body = JSON.stringify({ session: null, goal: null, todos: [] })
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
