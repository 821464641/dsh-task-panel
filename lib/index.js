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
  return {
    session: sessionId,
    goal: readGoal(ctx, sessionId),
    todos: foldTodos(session),
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
        '任务面板约定（task-panel）：本会话的「短期任务」与「长期任务」都只包含会话中',
        '「明确委派或共同商定的任务」（用户级粒度）；代理自己的执行步骤与内部执行机制不计入。',
        '',
        '【短期任务 = todo 清单】',
        '1. 一个用户可见的任务对应一条 todo。例如用户说「将该插件移入 D:\\...，并且要有详细的文档介绍该插件」，',
        '   清单应为两条：`移动插件文件位置`、`撰写介绍文档` —— 而不是把该请求的内部执行步骤逐条展开。',
        '2. 不要把内部操作步骤单独成条：例如创建/检查目录、备份文件、运行安装命令、语法检查、',
        '   验证/预检、清理旧副本、汇总汇报等，都属于执行步骤，不写入 todo 清单；',
        '   这些步骤你可以在任务内部自行处理，或在回复中简要说明进度。',
        '3. 若某条用户任务需要进一步拆解子步骤，仍保持为同一条 todo（必要时在描述中概括），',
        '   除非用户明确要求逐项列出。',
        '4. 清单其余规则不变：完成即标记 completed；全部完成后保留已完成状态，不重复新建。',
        '',
        '【长期任务 = 目标（goal）】',
        '5. 目标只对应「用户在对话中明确要求的长期完成目标」或「与用户共同商定的长期任务」；',
        '   create_goal 本身要求发起于用户的直接请求，请始终保持这一要求。',
        '6. 一个用户可见的长期任务对应一个目标；不要为内部子目标、执行分段或代理自己推进计划而创建目标。',
        '7. 目标推进由 goal 轮次机制管理；受阻时如实标记 blocked 并给出具体原因。',
        '8. 子代理、后台任务、工作流等是代理的内部执行机制，不属于用户可见任务，',
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
