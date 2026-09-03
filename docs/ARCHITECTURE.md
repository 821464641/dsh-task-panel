# 任务面板（dsh-task-panel）技术设计文档

> 面向开发者的架构说明。读者对象：需要维护、扩展或理解本插件内部机制的人。
> 用户向文档（功能、安装、FAQ）见 [README.md](../README.md)。

---

## 1. 概览

- **包名**：`@dsh-local/task-panel`
- **形态**：DeepSeek Harness「组合包（bundle）」——通过 profile 的 `dsh.profile.bundles` 列表挂载，
  含宿主端（Host）插件与浏览器端（Client）模块两个 plane。
- **数据流**：Client 周期轮询 → Host 只读路由 → 返回当前会话任务 JSON → Client 渲染。
- **依赖策略**：Host 零硬依赖（全部 `ctx.get()` 可选读取并降级）；Client 仅依赖 `sessions` 服务与平台种子模块（react / react-dom/client）。
- **无构建**：纯 JavaScript ESM（Host）+ 手写模块工厂（Client），无 TypeScript、无打包器、无 CSS 文件（内联样式）。

---

## 2. 包与挂载机制

### 2.1 清单元数据（package.json）

```json
{
  "name": "@dsh-local/task-panel",
  "exports": {
    ".": "./lib/index.js",          // Host 插件主入口
    "./client": "./lib/client.js"   // 浏览器模块
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  }
}
```

- `dsh.bundle.patch`：组合补丁路径，加载器按 `dsh.profile.bundles` 顺序叠加。
- `dsh.client.platform === "web"`：声明该包带浏览器模块；`dsh-client-modules` 的宿主半部
  会扫描 Loader 条目，把带此声明的包编排进 **browser roster**（服务端 `webserver/index-inject`
  注入 index.html，浏览器经 `window.__ModuleLoader__` 注册）。
- `dsh.client.inject`：浏览器模块的**前置加载顺序**。本插件为空——它被注入的平台服务
  （slots/runtime 等）与它无关，仅使用 `sessions` 客户端服务（由 `dsh-client-runtime` 提供，
  属于平台种子，永远先于业务模块就绪）。
- `exports["./client"]` 必须存在，否则 `dsh-client-modules` 的 invariant 检查会在启动时失败
  （`advertises … but resolves no client bundle path`）。
- 保留 `dshClient` 字段作为旧键名的兼容镜像（部分 rc 版本读取旧键）。

### 2.2 组合补丁（cordis.patch.yml）

```yaml
- insert:
    - id: task-panel
      name: '@dsh-local/task-panel'
```

单向插入一个插件行；行内无 `config`，插件为全默认。`id` 在全 profile 内唯一（已检查无冲突），
`name` 必须与 package.json `name` 一致（引号包裹以规避 YAML 中 `@` 的保留语义）。

### 2.3 安装接线

```sh
dsh plugin --profile web add <spec>      # spec 可为 link:/file:/npm 包名/git URL
```

- 命令会：pnpm 安装依赖 → 把包名追加进 profile `package.json` 的 `dsh.profile.bundles` 列表
  → 锁定文件更新。生效需要重启 `dsh web`。
- **Windows 中文/空格路径警告**：控制台代码页会把含非 ASCII 的 `link:` / `file:` 路径写坏
  （表现为 package.json 依赖值乱码）。应使用纯 ASCII 路径（本仓库目录即满足）。
- 图形替代：设置 → 插件 → 插件管理器（npm / git URL 安装）。

---

## 3. 数据契约

### 3.1 路由

```
GET /plugins/dsh-task-panel/state?session=<sessionId>
```

- 无 `session` 参数 → `200` 且 `session: null`（客户端据此清理数据）。
- 未知/不可达会话 → `200` + 空任务数组（优雅降级，不 4xx）。
- 内部异常 → `500` + `{ session, error }`（客户端保留上次快照并提示「连接中断」）。

### 3.2 响应 Schema

```jsonc
{
  "session": "session-… | null",
  "goal": {                      // 可空（无当前目标 / agent 不存活）
    "id": "string",
    "revision": "number",        // 比较并交换用的修订号
    "objective": "string",
    "phase": "active | paused | blocked | complete",
    "roundsStarted": "number",
    "maxGoalRounds": "number",   // 0 = 无上限
    "blockedReason": { "code": "string", "message": "string" } | null,
    "createdAt": "epoch-ms | null",
    "updatedAt": "epoch-ms | null"
  },
  "todos": [                     // 当前短期任务清单（按折叠后的顺序，非排序结果）
    {
      "content": "string",
      "status": "pending | in_progress | completed",
      "startedAt": "epoch-ms | null",   // 首次 in_progress 的日志时间
      "endedAt": "epoch-ms | null"      // 首次 completed 的日志时间
    }
  ]
}
```

**有意不包含**：子代理 / 后台任务 / 工作流数据。它们被定义为代理的内部执行机制（与工具调用同类），
不属于用户可见任务；宿主端也**不读取** `subagents` 服务（冒烟测试断言响应中不存在 `subagents` 字段）。

### 3.3 语义要点

| 项 | 语义 |
|---|---|
| todos 重置 | 与官方 `todos` 投影一致：`turn/start` 清空；`todo/write` 整表替换（事件溯源，last-write-wins） |
| **短期任务粒度** | 面板的短期任务=「用户要做的事」：用户每次让会话「去做某件事」都对应一条（一句话含多件事拆多条；与用户共同商定做的事同样计入；问题/咨询/确认语不记录）；其执行过程（装工具、跑命令、验证、清理、汇报等）不算任务。该约定由宿主在 apply 时通过系统提示词段（`task-panel:task-convention`，order 116）向每个会话的代理声明（见 §4.4） |
| **兜底自动识别** | 当 Agent 未写任何 todo 清单时（内置工具说明允许琐碎任务跳过清单），路由从**当前轮**（最后一个 turn/start 之后）的 `user/message`（`source.kind === 'user'`）推导任务：剔除确认语/问题/闲聊、去除「请/帮我」等礼貌前缀，每条请求一条任务，最新一条标记 `in_progress`（见 §4.5）。Agent 清单非空时优先于兜底 |
| **长期任务粒度** | 长期任务=同一目标的当前视图。目标应只对应「用户明确要求的长期完成目标」或「与用户共同商定的长期任务」：`create_goal` 官方约束（发起于直接用户请求）保持不变，约定进一步要求一个用户可见长期任务=一个目标、不为内部子目标/分段/代理自我推进计划创建目标 |
| **内部机制不展示** | 子代理、后台任务、工作流为代理执行手段，既不进入长期任务，也不被宿主路由读取（v0.1.3 起） |
| startedAt / endedAt | **派生时间**，不是待办自身字段（待办仅存 content+status）。取「首次出现该状态」的时间；状态反复不重置 |
| goal 存活条件 | `goals.get(agent)` 要求 agent 为注册表中的**精确存活实例**（assertLive），因此仅当会话 agent 存活（含空闲）时返回 |

---

## 4. Host 端设计（lib/index.js）

### 4.1 路由生命周期

```js
export function apply(ctx) {
  let done = false
  const register = () => {
    if (done) return
    const webServer = ctx.get('webServer')   // 可选读取
    if (webServer === undefined) return
    done = true
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), 'task-panel: state route')
  }
  register()
  ctx.on('internal/service', (name) => { if (name === 'webServer') register() })
}
```

- 与 AgentTeams 插件同款模式：`webServer` 可能在并发激活中晚于本插件就绪，因此**先试一次 + 监听 `internal/service` 再试**；
  headless profile 无 webServer 则插件静默降级为「没有任何功能」（本包不含 tool，headless 下即空插件）。
- `ctx.effect` 包裹路由注册，插件停用/更新时自动注销路由（webServer 的 disposer 协议）。

### 4.2 服务读取矩阵

| 服务 | 读取方式 | 缺失/异常处理 |
|---|---|---|
| webServer | `ctx.get('webServer')` | 不注册路由 |
| sessions | `ctx.get('sessions')` + `get(id)` | 返回空数据 |
| agents | `ctx.get('agents')` + `get(sessionId)` | goal 置 null |
| goals | `ctx.get('goals')` + `get(agent)` | try/catch → null（assertLive 抛错、服务未挂载等） |
| systemPrompt | `ctx.get('systemPrompt')` + `.section(...)` | 未挂载则跳过（不注册约定段） |

**原则**：绝不 `inject` 硬依赖（避免等待/阻塞装配）；绝不调用任何写方法；JSON 序列化前只取标量叶子字段（遵守「内部实时数据不外泄/不全量拷贝」约束）。注意：`subagents` 服务**不再读取**（v0.1.3 起，其数据属于内部执行机制）。

### 4.3 foldTodos 算法

```
state = null
for event in session.events (顺序遍历):
  if event.type == 'turn/start':  state = null
  if event.type == 'todo/write':  state = event.data.todos
                                  记录每项首次 in_progress / completed 的 event.time
输出: state.map(item => { content, status, startedAt, endedAt })
```

复杂度 O(事件数) 每请求；会话日志长时依赖数组遍历（无缓存），但频率每分钟一次，可接受。
未来优化：改为增量游标缓存（记录上次折叠到的 seq）。

### 4.4 任务粒度约定（系统提示词段）

面板的两组任务都直接映射到「用户要做的事」：短期=todo 清单，长期=目标。为落实统一的两级定义
（**用户让会话做的事列入面板；执行过程的操作与内部执行机制不计入**），
宿主在 apply 时向 `systemPrompt` 注册提示词段：

```js
ctx.get('systemPrompt').section({
  name: 'task-panel:task-convention',
  order: 116,            // 晚于 tool:goal(114) 与 tool:cordis(115)，优先于 agent-teams(117)
  text: [
    '【短期任务 = todo 清单】...用户每次让会话「去做某件事」= 一条任务...执行过程里的操作不算任务...',
    '【长期任务 = 目标（goal）】...只对应用户明确要求/共同商定的长期目标...',
    '子代理、后台任务、工作流是内部执行机制，不创建目标、不写入清单...',
  ].join('\n'),
})
```

- 该段对 profile 内所有会话生效（与 AgentTeams usage 段同一机制）；
- 给出用户侧示例（「请将这个插件提交到 GitHub」→「发布插件到 GitHub」一条；「将该插件移入 D:\...，并且要有详细的文档」→「移动插件文件位置」「撰写介绍文档」两条）以锚定短期粒度；
- 强调**必须**登记（覆盖工具描述中「琐碎任务可跳过」的豁免），并说明未登记时面板会以用户消息原文临时展示；
- 明确排除项（短期）：安装工具、生成密钥、运行命令、语法检查、验证/预检、清理旧副本、写测试、汇总汇报等执行过程操作，以及用户的问题/咨询/确认语（「好了」「可以」「谢谢」）；
- 长期规则：目标只对应用户明确/商定的长期完成目标，一个用户可见长期任务=一个目标，不为内部子目标/分段创建；子代理等内部机制不产生目标、不进入清单；

### 4.5 foldUserTasks 兜底推导（无清单时的自动识别）

当 Agent 未写 todo 清单时（内置说明允许琐碎工作跳过，导致其他会话长期看不到任务），
宿主路由用确定性启发式从会话日志推导短期任务：

```
for event in session.events (顺序遍历，turn/start 重置收集器):
  if event.type == 'user/message' 且 data.source.kind == 'user':
      text    = 拼接 content 中 type='text' 块的 text
      title   = cleanTaskTitle(text)          # 见下
      tasks.push({ content: title, status: 'pending', startedAt: event.time })
最新一条 → status = 'in_progress'
```

`cleanTaskTitle` 判定规则（保守设计，宁缺勿滥；Agent 清单可完全覆盖兜底结果）：
1. 截断核对：空串、纯确认语（`好了/可以/谢谢/好的/嗯/ok/收到…`）→ 排除；
2. 含 `？/?`、结尾问词（`吗/呢/吧/怎么/什么/哪/是否…`）或开头问词（`为什么/怎么/如何/什么…`）→ 排除（咨询不算任务）；
3. 无动作信号且长度 < 8 → 排除；存在动作词（请/帮我/做/写/修改/发布/提交/更新/检查/修复…）或长度 ≥ 8 → 作为任务；
4. 去除开头礼貌前缀（`请你/麻烦你/请帮我/帮我/帮忙/请/麻烦`）作为标题；
5. `source.kind !== 'user'`（goal 轮、插件通知）不参与。

该推导每条请求一条任务、最新一条标记进行中，使面板在**任何会话**都能主动显示短期任务；
Agent 一旦写入清单（列表非空）即整体切换为清单数据（带真实进度与完成态）。
- 不改变 todo / goal 的工具语义（todo 整表替换 + turn/start 清空；goal 轮次/阶段机制不变），只改变「写什么粒度」。

---

## 5. Client 端设计（lib/client.js）

### 5.1 模块协议

```js
window.__ModuleLoader__.load({
  id: '@dsh-local/task-panel',
  factory: (require) => {
    const React = require('react')
    const ReactDOMClient = require('react-dom/client')
    ...
    exports.inject = ['sessions']
    exports.apply = function (ctx) { ... }
    return module.exports
  },
})
```

- `inject`：客户端服务名数组，模块在服务就绪后才激活（`sessions` 由平台运行时提供）。
- `apply(ctx)`：
  - 注入 `<style>`（`@keyframes dshTaskPanelPulse`，命名空间避免冲突）；
  - 创建 `document.body` 门户（`createRoot`），挂载 `<Panel>` —— **不依赖任何 Slot**，
    因此在对话页 / 设置页 / 侧栏等所有路由下都可见（web shell 没有"右下角"的既有 slot，
    门户是社区插件（AgentTeams 等）验证过的模式）；
  - `ctx.effect` 返回清理函数（卸载 React 根、移除 DOM 与样式），满足 Cordis 生命周期约束。

### 5.2 数据获取

- 轮询：`fetch('/plugins/dsh-task-panel/state?session=' + encodeURIComponent(sessionId))`，
  `cache: 'no-store'`；间隔 `POLL_MS = 60000`（1 分钟）。
- 手动刷新：`refreshNonce` state 递增 → 轮询 effect 依赖 `[sessionId, refreshNonce]` 重跑
  （立即 fetch 一次并重置定时器）。
- 容错：任一请求失败 → `fetchFailed=true`（页头显示「连接中断，正在重试…」），**保留上次快照**，
  下次成功恢复。响应 `session` 与当前不一致 → 清空数据（会话切换竞态保护）。
- 成功时记录 `updatedAt`，页脚显示「更新于 今天 HH:MM」。

### 5.3 状态与视图

| State | 用途 |
|---|---|
| open | 面板/鲸鱼切换；localStorage `dsh-task-panel:open`（默认展开，'0' 表示折叠） |
| pos | 拖动位置（left/top）；localStorage `dsh-task-panel:pos`（无则默认右下 16px） |
| data | 最近一次成功 JSON |
| showDoneShort | 「短期任务已完成 N 项」的展开/折叠 |
| refreshNonce / updatedAt / fetchFailed | 刷新控制与状态提示 |

排序（两组语义一致）：**进行中 > 等待 > 已完成**；同状态按时间倒序（新任务在前），再按 content 字典序稳定排序。
已完成区：状态置灰（透明度 0.55~0.75）、标题删除线（待办）、按完成时间倒序。
长期组仅一张目标卡（v0.1.3 起不再渲染子代理行，也不存在「已完成」折叠——目标完成即整体置灰）。

### 5.4 拖动

- 标题栏 `onPointerDown`（排除按钮点击）→ 记录起点与面板 rect；
- `window` 上的 pointermove/pointerup（不依赖 Pointer Capture，兼容性最好）；
- 位移 > 3px 判定为拖动并实时 setPos（**同时做视口限幅**），抬起后写 localStorage；
- header 内按钮 `stopPropagation`，避免误拖。

### 5.5 主题

所有颜色引用 `--dsw-*` 设计令牌并带硬回退：

| 令牌 | 回退 | 用途 |
|---|---|---|
| `--dsw-alias-bg-layer-1` | `#ffffff` | 面板表面 |
| `--dsw-alias-bg-layer-2` | `#f6f7f9` | 标题栏/页脚次级表面 |
| `--dsw-alias-label-primary/secondary/tertiary` | `#1b1e24/#5b6472/#8a93a1` | 文本三级 |
| `--dsw-static-neutral-bluish-150/100` | `#e7e9ee/#eef0f4` | 边框/进度轨道 |
| `--dsw-alias-state-business-primary` | `#4d6bfe` | 进行中/主色 |
| `--dsw-alias-state-success-primary` | `#12a150` | 成功 |
| `--dsw-alias-state-warn-primary` | `#e08700` | 等待 |
| `--dsw-alias-state-error-primary` | `#e5484d` | 失败/受阻 |
| `--dsw-alias-shadow-popover` | `rgba(16,24,40,.18)` | 阴影 |

面板 z-index `2147482900`（低于 AgentTeams 的面板 `2147483000`，两者不会同时抢占同区）。

---

## 6. 时序

```
Browser                                 Host
  │ 页面加载 → __ModuleLoader__ 注册模块   │
  │ apply() → createRoot 门户挂载          │
  │ sessionId 就绪（sessions.list）        │
  │ ── 60s 轮询 / ↻ ───────────────────▶  │
  │                                       │ webServer handler
  │                                       │  session = sessions.get(id)
  │                                       │  todos   = foldTodos(session.events)
  │                                       │  goal    = goals.get(agents.get(id))
  │ ◀─── JSON snapshot（<1KB）─────────   │
  │ setData → 分组/排序/渲染              │
```

（v0.1.3 起时序中不再包含 subagents 读取——内部执行机制不外泄。）

---

## 7. 测试

`smoke.mjs`（Node，无框架）：
1. 断言任务粒度约定段已注册（`task-panel:task-convention`，含短期与长期规则）；
2. 构造带 `turn/start` + 两次 `todo/write` 的会话日志 → 断言折叠结果与 derived 时间；
3. 构造 goal 视图与 agent → 断言映射（含 maxGoalRounds/blockedReason/时间戳）；
4. **断言响应中不存在 `subagents` 字段**（内部执行机制不外泄）；
5. 兜底推导：无 todo 清单的会话 → 用户消息衍生任务（礼貌前缀去除、确认语/问题剔除、最新一条 in_progress）；
6. 多方请求一轮 → 各成一条，最新 in_progress；
7. 断言空 session 参数 → `session: null` 空载荷；
8. 断言未知 session → 200 + 空数据（优雅降级）。

运行：`node smoke.mjs`。另有静态检查：`node --check lib/*.js`。

---

## 8. 已知限制与扩展点

### 限制

| 限制 | 原因 | 缓解 |
|---|---|---|
| 仅 Web profile 生效 | 依赖 `webServer`；headless 下为空插件 | 无（符合定位） |
| 时间数据为派生近似 | 待办本身不记录时间 | 已在 UI 文案中说明 |
| 折叠 O(n) 全量扫日志 | 无游标缓存 | 1 分钟频率下可忽略；可加增量缓存 |
| 与宠物图标可能重叠 | 均为右下角固定元素 | 宠物默认隐藏；需要时调整 position |
| 无鉴权 | 本机回环服务（与 Web 同源） | 与 AgentTeams 等社区插件一致 |

### 扩展点

- **配置化**：给 `cordis.patch.yml` 行加 `config`（如 `pollMs`、`defaultOpen`），Host 读 config 传给客户端（经路由下发）。
- **任务源扩展**：若未来定义「用户级」的额外任务形态（如用户明确要求的 AgentTeams 协作），按同一粒度约定扩展路由；后台任务（jobs）、工作流等内部执行机制默认不进入面板。
- **事件订阅替代轮询**：Host 侧监听 `todo/write` / `goal/changed` 等会话事件并广播（需引入推送通道，当前保持零依赖设计）。
- **多会话汇总视图**：路由改为按会话列出（当前刻意保持「仅当前会话」）。
