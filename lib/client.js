/**
 * dsh-task-panel client half: the floating Task Panel.
 *
 * A body-portal floater pinned to the bottom-right of the web app:
 * draggable by its header, collapsible to a small dot, always available on
 * every page. It polls the host state route once per minute (manual refresh
 * via the ↻ button in the header) and renders the CURRENT session's tasks:
 *
 *   短期任务 — todo list items: the USER-VISIBLE tasks assigned or jointly
 *              agreed in the conversation (status, progress, derived time)
 *   长期任务 — the same-session goal: the long-running completion objective
 *              the user asked for or agreed to (round progress + phase +
 *              blocker reason). Subagent/background/workflow activity is the
 *              agent's internal execution mechanism and is intentionally not
 *              shown.
 *
 * Finished items stay visible but greyed, foldable behind a "已完成 N 项"
 * toggle. The panel never auto-expands and never badges a number: it keeps
 * exactly the open/collapsed state the user chose (remembered per browser).
 *
 * @module dsh-task-panel/client
 */

window.__ModuleLoader__.load({
  id: '@dsh-local/task-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var ReactDOMClient = require('react-dom/client')

    var inject = ['sessions']

    var POLL_MS = 60000
    var STATE_URL = '/plugins/dsh-task-panel/state'
    var LS_OPEN = 'dsh-task-panel:open'
    var LS_POS = 'dsh-task-panel:pos'
    var PANEL_WIDTH = 352
    var MAX_TEXT = 56

    // ── theme tokens (DSW design tokens with hard fallbacks) ────────────────

    var C = {
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surfaceSub: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
      text: 'var(--dsw-alias-label-primary, #1b1e24)',
      textSub: 'var(--dsw-alias-label-secondary, #5b6472)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #8a93a1)',
      line: 'var(--dsw-static-neutral-bluish-150, #e7e9ee)',
      neutral: 'var(--dsw-static-neutral-bluish-100, #eef0f4)',
      primary: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      success: 'var(--dsw-alias-state-success-primary, #12a150)',
      warn: 'var(--dsw-alias-state-warn-primary, #e08700)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      shadow: 'var(--dsw-alias-shadow-popover, rgba(16, 24, 40, 0.18))',
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function el(type, props) {
      var args = [type, props]
      for (var i = 2; i < arguments.length; i += 1) args.push(arguments[i])
      return React.createElement.apply(null, args)
    }

    function clampText(text) {
      if (typeof text !== 'string' || text.length === 0) return ''
      return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text
    }

    function fmtClock(ts) {
      if (ts === null || ts === undefined || typeof ts !== 'number' || !Number.isFinite(ts)) return ''
      var d = new Date(ts)
      var n = new Date()
      var pad = function (v) { return v < 10 ? '0' + v : String(v) }
      var hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
      if (d.toDateString() === n.toDateString()) return '今天 ' + hm
      var yesterday = new Date(n.getTime() - 86400000)
      if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + hm
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
    }

    function fmtElapsed(ms) {
      if (ms === null || ms === undefined || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
      if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + '秒'
      var min = Math.floor(ms / 60000)
      if (min < 60) {
        var sec = Math.floor((ms % 60000) / 1000)
        return min + '分' + (sec > 0 ? sec + '秒' : '')
      }
      var h = Math.floor(min / 60)
      var m = min % 60
      if (h < 24) return h + '小时' + (m > 0 ? m + '分' : '')
      var days = Math.floor(h / 24)
      var rest = h % 24
      return days + '天' + (rest > 0 ? rest + '小时' : '')
    }

    var TODO_LABEL = { pending: '等待', in_progress: '进行中', completed: '已完成' }
    var GOAL_LABEL = { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' }
    var TODO_TONE = { pending: 'warn', in_progress: 'primary', completed: 'muted' }
    var GOAL_TONE = { active: 'primary', paused: 'warn', blocked: 'danger', complete: 'muted' }

    function toneColor(tone) {
      if (tone === 'primary') return C.primary
      if (tone === 'success') return C.success
      if (tone === 'warn') return C.warn
      if (tone === 'danger') return C.danger
      return C.textTertiary
    }

    function todoSortKey(item) {
      var pri = item.status === 'in_progress' ? 0 : item.status === 'pending' ? 1 : 2
      var t0 = item.startedAt === null || item.startedAt === undefined ? 0 : item.startedAt
      return { pri: pri, t0: t0 }
    }

    function readPos() {
      try {
        var raw = window.localStorage.getItem(LS_POS)
        if (typeof raw !== 'string' || raw.length === 0) return null
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        var left = parsed.left
        var top = parsed.top
        if (typeof left !== 'number' || typeof top !== 'number' || !Number.isFinite(left) || !Number.isFinite(top)) return null
        var w = window.innerWidth
        var h = window.innerHeight
        return {
          left: Math.min(Math.max(left, 8), Math.max(8, w - PANEL_WIDTH - 8)),
          top: Math.min(Math.max(top, 8), Math.max(8, h - 64)),
        }
      } catch {
        return null
      }
    }

    function writePos(pos) {
      try {
        if (pos === null) window.localStorage.removeItem(LS_POS)
        else window.localStorage.setItem(LS_POS, JSON.stringify({ left: pos.left, top: pos.top }))
      } catch {
        /* private mode etc. — ignore */
      }
    }

    // ── small UI pieces ─────────────────────────────────────────────────────

    function Chip(props) {
      return el('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 7px', borderRadius: 999, fontSize: 11, lineHeight: '16px',
          whiteSpace: 'nowrap', flex: 'none',
          background: toneColor(props.tone) + '22',
          color: toneColor(props.tone),
        },
      }, props.label)
    }

    function Dot(props) {
      return el('button', {
        type: 'button',
        title: '展开任务面板',
        'aria-label': '展开任务面板',
        onClick: props.onClick,
        style: {
          position: 'fixed', right: 14, bottom: 14, zIndex: 2147482900,
          width: 46, height: 46, borderRadius: 999, border: '1px solid ' + C.line,
          background: C.surface, boxShadow: '0 6px 20px ' + C.shadow,
          cursor: 'pointer', padding: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        },
      },
        el('span', { style: { fontSize: 26, lineHeight: 1 } }, '🐳'),
        props.busy
          ? el('span', {
            style: {
              position: 'absolute', top: 6, right: 6, width: 9, height: 9,
              borderRadius: 999, background: C.primary,
              animation: 'dshTaskPanelPulse 1.4s ease-in-out infinite',
              boxShadow: '0 0 0 2px ' + C.surface,
            },
          })
          : null)
    }

    function ProgressBar(props) {
      var ratio = props.value !== null && props.value !== undefined
        ? Math.min(1, Math.max(0, props.value))
        : null
      return el('div', {
        style: {
          height: 4, borderRadius: 999, background: C.neutral, overflow: 'hidden',
          position: 'relative',
        },
      }, ratio === null
        ? el('div', { style: { position: 'absolute', inset: 0, background: C.neutral } })
        : el('div', {
          style: {
            height: '100%', width: (ratio * 100) + '%', borderRadius: 999,
            background: props.color === undefined ? C.primary : props.color,
            transition: 'width 300ms ease',
          },
        }))
    }

    function Section(props) {
      return el('div', { style: { marginBottom: 14 } },
        el('div', {
          style: {
            display: 'flex', alignItems: 'baseline', gap: 8,
            marginBottom: 6, padding: '0 2px',
          },
        },
          el('span', { style: { fontSize: 13, fontWeight: 700, color: C.text } }, props.title),
          el('span', { style: { fontSize: 11, color: C.textTertiary, flex: '1 1 auto' } }, props.stat),
          props.extra === undefined ? null : props.extra),
        props.children)
    }

    function DoneToggle(props) {
      var label = props.open ? '收起已完成' : '展开已完成'
      return el('button', {
        type: 'button',
        style: {
          display: 'block', width: '100%', textAlign: 'left', border: 'none',
          background: 'transparent', color: C.textSub, fontSize: 11, padding: '4px 2px',
          cursor: 'pointer',
        },
        onClick: props.onClick,
      }, label + ' ' + props.count + ' 项')
    }

    // ── task rows ───────────────────────────────────────────────────────────

    function TodoRow(props) {
      var item = props.item
      var started = fmtClock(item.startedAt)
      var elapsed = fmtElapsed(item.endedAt !== null && item.endedAt !== undefined
        ? (item.endedAt - (item.startedAt || item.endedAt))
        : (Date.now() - (item.startedAt || Date.now())))
      var timeText = [started, elapsed].filter(Boolean).join(' · ')
      var done = item.status === 'completed'
      return el('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 4px',
          borderRadius: 8, opacity: done ? 0.55 : 1,
        },
      },
        el('span', {
          style: {
            marginTop: 5, flex: 'none', width: 7, height: 7, borderRadius: 999,
            background: done ? C.textTertiary : toneColor(TODO_TONE[item.status] || 'muted'),
          },
        }),
        el('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          el('div', {
            style: {
              fontSize: 12, color: C.text, lineHeight: '18px',
              textDecoration: done ? 'line-through' : 'none',
              wordBreak: 'break-word',
            },
          }, clampText(item.content)),
          el('div', { style: { fontSize: 10.5, color: C.textTertiary, marginTop: 1 } },
            timeText.length > 0 ? timeText : ' ')),
        el('span', { style: { flex: 'none', paddingTop: 1 } },
          el(Chip, {
            tone: done ? 'muted' : (TODO_TONE[item.status] || 'muted'),
            label: TODO_LABEL[item.status] || item.status,
          })))
    }

    function GoalCard(props) {
      var goal = props.goal
      var phase = goal.phase || 'active'
      var tone = GOAL_TONE[phase] || 'muted'
      var label = GOAL_LABEL[phase] || phase
      var capped = typeof goal.maxGoalRounds === 'number' && goal.maxGoalRounds > 0
      var rounds = typeof goal.roundsStarted === 'number' ? goal.roundsStarted : 0
      var ratio = capped ? rounds / goal.maxGoalRounds : null
      var elapsed = fmtElapsed(Date.now() - (goal.createdAt || Date.now()))
      return el('div', {
        style: {
          border: '1px solid ' + C.line, borderRadius: 10, padding: '8px 10px',
          background: C.surfaceSub, marginBottom: 6, opacity: phase === 'complete' ? 0.6 : 1,
        },
      },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
          el('span', { style: { fontSize: 12, fontWeight: 700, color: C.text } }, '目标'),
          el('span', { style: { flex: '1 1 auto' } }, null),
          el(Chip, { tone: tone, label: label })),
        el('div', {
          style: { fontSize: 12, color: C.text, lineHeight: '18px', wordBreak: 'break-word', marginBottom: 6 },
        }, clampText(goal.objective || '')),
        el(ProgressBar, { value: ratio, color: toneColor(tone) }),
        el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 } },
          el('span', { style: { fontSize: 10.5, color: C.textSub } },
            capped ? ('已进行 ' + rounds + ' / ' + goal.maxGoalRounds + ' 轮') : ('已进行 ' + rounds + ' 轮')),
          el('span', { style: { fontSize: 10.5, color: C.textTertiary } },
            [fmtClock(goal.createdAt), elapsed].filter(function (x) { return x !== '' }).join(' · '))),
        goal.blockedReason !== null && goal.blockedReason !== undefined && goal.blockedReason.message
          ? el('div', {
            style: { fontSize: 10.5, color: C.danger, marginTop: 4, lineHeight: '15px', wordBreak: 'break-word' },
          }, '受阻原因：' + clampText(goal.blockedReason.message))
          : null)
    }

    function EmptyLine(props) {
      return el('div', { style: { fontSize: 11.5, color: C.textTertiary, padding: '6px 2px' } }, props.text)
    }

    // ── main panel ──────────────────────────────────────────────────────────

    function Panel(props) {
      var sessionsList = props.sessionsList
      var snapshot = React.useSyncExternalStore(sessionsList.subscribe, sessionsList.getSnapshot)
      var sessionId = snapshot === null || snapshot === undefined ? undefined : snapshot.current

      var initialOpen = true
      try {
        initialOpen = window.localStorage.getItem(LS_OPEN) !== '0'
      } catch (e) {
        initialOpen = true
      }
      var [open, setOpen] = React.useState(initialOpen)
      var [pos, setPos] = React.useState(readPos)
      var [data, setData] = React.useState(null)
      var [fetchFailed, setFetchFailed] = React.useState(false)
      var [showDoneShort, setShowDoneShort] = React.useState(true)
      var [refreshNonce, setRefreshNonce] = React.useState(0)
      var [updatedAt, setUpdatedAt] = React.useState(0)
      var rootRef = React.useRef(null)
      var posRef = React.useRef(pos)
      var dragRef = React.useRef(null)

      React.useEffect(function () {
        posRef.current = pos
      }, [pos])

      React.useEffect(function () {
        try { window.localStorage.setItem(LS_OPEN, open ? '1' : '0') } catch (e) { }
      }, [open])

      React.useEffect(function () {
        if (sessionId === undefined || sessionId === null) {
          setData(null)
          setFetchFailed(false)
          return undefined
        }
        var stop = false
        var inFlight = false
        var tick = function () {
          if (stop || inFlight) return
          inFlight = true
          fetch(STATE_URL + '?session=' + encodeURIComponent(sessionId), { cache: 'no-store' })
            .then(function (res) {
              if (!res.ok) throw new Error('status ' + res.status)
              return res.json()
            })
            .then(function (body) {
              if (stop) return
              if (body === null || typeof body !== 'object' || (body.session !== null && body.session !== sessionId)) {
                setData(null)
              } else {
                setData(body)
                setFetchFailed(false)
                setUpdatedAt(Date.now())
              }
            })
            .catch(function () {
              if (!stop) setFetchFailed(true)
            })
            .finally(function () { inFlight = false })
        }
        tick()
        var timer = setInterval(tick, POLL_MS)
        return function () {
          stop = true
          clearInterval(timer)
        }
      }, [sessionId, refreshNonce])

      var onHeaderPointerDown = function (ev) {
        if (ev === undefined || ev === null) return
        if (ev.button !== 0) return
        var target = ev.target
        if (target !== null && target !== undefined && target.closest !== undefined && target.closest('button') !== null) return
        var rootEl = rootRef.current
        if (rootEl === null || rootEl === undefined) return
        var rect = rootEl.getBoundingClientRect()
        dragRef.current = {
          startX: ev.clientX, startY: ev.clientY,
          startLeft: rect.left, startTop: rect.top,
          moved: false,
        }
        var onMove = function (moveEv) {
          var d = dragRef.current
          if (d === null || d === undefined) return
          var dx = moveEv.clientX - d.startX
          var dy = moveEv.clientY - d.startY
          if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) d.moved = true
          if (!d.moved) return
          var w = rootEl.offsetWidth > 0 ? rootEl.offsetWidth : PANEL_WIDTH
          var left = Math.min(Math.max(d.startLeft + dx, 8), Math.max(8, window.innerWidth - w - 8))
          var top = Math.min(Math.max(d.startTop + dy, 8), Math.max(8, window.innerHeight - 64))
          setPos({ left: left, top: top })
        }
        var onUp = function () {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          dragRef.current = null
          writePos(posRef.current)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      // Guard for SSR/no-js environments is irrelevant on the client; the
      // floater simply renders nothing until a session is open.
      if (sessionId === undefined || sessionId === null) return null

      // ── derive view data ──────────────────────────────────────────────────
      var todos = data !== null && Array.isArray(data.todos) ? data.todos : []
      var goal = data !== null && typeof data.goal === 'object' && data.goal !== null ? data.goal : null

      var activeTodos = todos.filter(function (t) { return t.status !== 'completed' })
      var doneTodos = todos.filter(function (t) { return t.status === 'completed' })

      activeTodos.sort(function (a, b) {
        var ka = todoSortKey(a); var kb = todoSortKey(b)
        if (ka.pri !== kb.pri) return ka.pri - kb.pri
        return (kb.t0 - ka.t0) || a.content.localeCompare(b.content)
      })
      doneTodos.sort(function (a, b) {
        var ta = a.endedAt || 0; var tb = b.endedAt || 0
        return (tb - ta) || a.content.localeCompare(b.content)
      })

      var anyTodo = todos.length > 0
      var busy = activeTodos.some(function (t) { return t.status === 'in_progress' })
        || (goal !== null && (goal.phase === 'active' || goal.phase === 'blocked'))

      if (!open) {
        return el(Dot, { busy: busy, onClick: function () { setOpen(true) } })
      }

      var panelStyle = {
        position: 'fixed', zIndex: 2147482900, width: PANEL_WIDTH,
        maxHeight: '72vh', display: 'flex', flexDirection: 'column',
        background: C.surface, border: '1px solid ' + C.line, borderRadius: 12,
        boxShadow: '0 12px 36px ' + C.shadow, overflow: 'hidden',
        fontFamily: 'inherit', fontSize: 12, color: C.text,
      }
      if (pos === null || pos === undefined) {
        panelStyle.right = 16
        panelStyle.bottom = 16
      } else {
        panelStyle.left = pos.left
        panelStyle.top = pos.top
      }

      var shortStat = anyTodo
        ? (doneTodos.length + ' / ' + todos.length + ' 已完成')
        : '暂无'
      var longStat = goal !== null ? '目标' : '暂无'

      return el('div', {
        ref: rootRef,
        style: panelStyle,
      },
        el('div', {
          onPointerDown: onHeaderPointerDown,
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px', borderBottom: '1px solid ' + C.line,
            background: C.surfaceSub, cursor: 'grab', userSelect: 'none',
            flex: 'none',
          },
        },
          el('span', {
            style: {
              width: 8, height: 8, borderRadius: 999, flex: 'none',
              background: busy ? C.primary : C.textTertiary,
              animation: busy ? 'dshTaskPanelPulse 1.4s ease-in-out infinite' : 'none',
            },
          }),
          el('span', { style: { fontSize: 13, fontWeight: 700, color: C.text, flex: 'none' } }, '任务面板'),
          el('span', { style: { flex: '1 1 auto' } }, null),
          el('span', {
            style: { fontSize: 10.5, color: C.textTertiary, paddingRight: 2 },
          }, fetchFailed ? '连接中断，正在重试…' : ('每 1 分钟刷新')),
          el('button', {
            type: 'button', title: '立即刷新', 'aria-label': '立即刷新',
            onPointerDown: function (ev) { ev.stopPropagation() },
            onClick: function (ev) {
              ev.stopPropagation()
              setRefreshNonce(function (n) { return n + 1 })
            },
            style: {
              border: 'none', background: 'transparent', color: C.textSub,
              cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '2px 5px',
              flex: 'none',
            },
          }, '↻'),
          el('button', {
            type: 'button', title: '折叠成小圆点', 'aria-label': '折叠任务面板',
            onPointerDown: function (ev) { ev.stopPropagation() },
            onClick: function (ev) { ev.stopPropagation(); setOpen(false) },
            style: {
              border: 'none', background: 'transparent', color: C.textSub,
              cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '2px 4px',
              flex: 'none',
            },
          }, '—')),
        el('div', {
          style: {
            overflowY: 'auto', padding: '10px 10px 6px', flex: '1 1 auto',
            minHeight: 0,
          },
        },
          el(Section, { title: '短期任务', stat: shortStat,
            extra: doneTodos.length > 0
              ? el(DoneToggle, { open: showDoneShort, count: doneTodos.length,
                onClick: function () { setShowDoneShort(!showDoneShort) } })
              : null },
            activeTodos.length === 0 && doneTodos.length === 0
              ? el(EmptyLine, { text: '暂无短期任务' })
              : el('div', null,
                activeTodos.map(function (item) {
                  return el(TodoRow, { key: item.content + ':' + (item.startedAt || 0), item: item })
                }),
                doneTodos.length > 0
                  ? (showDoneShort
                    ? el('div', { style: { opacity: 0.75 } },
                      doneTodos.map(function (item) {
                        return el(TodoRow, { key: 'done:' + item.content + ':' + (item.endedAt || 0), item: item })
                      }))
                    : null)
                  : null)),
          el(Section, { title: '长期任务', stat: longStat, extra: null },
            goal === null
              ? el(EmptyLine, { text: '暂无长期任务' })
              : el(GoalCard, { goal: goal }))),
        el('div', {
          style: {
            padding: '4px 10px', borderTop: '1px solid ' + C.line,
            fontSize: 10, color: C.textTertiary, background: C.surfaceSub,
            flex: 'none', display: 'flex', gap: 8, alignItems: 'center',
          },
        },
          el('span', { style: { flex: '1 1 auto' } },
            '仅当前会话' + (updatedAt > 0 ? ' · 更新于 ' + fmtClock(updatedAt) : '')
          )
        ),
      )
    }

    // ── plugin entry ────────────────────────────────────────────────────────

    function apply(ctx) {
      // Keyframes for the busy dot pulse; scoped to the floater's own name.
      var styleEl = document.createElement('style')
      styleEl.dataset.taskPanelStyle = ''
      styleEl.textContent = '@keyframes dshTaskPanelPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }'
      document.head.appendChild(styleEl)

      var host = document.createElement('div')
      host.dataset.taskPanelHost = ''
      document.body.appendChild(host)
      var root = ReactDOMClient.createRoot(host)
      root.render(el(Panel, { sessionsList: ctx.sessions.list }))
      ctx.effect(function () {
        return function () {
          root.unmount()
          host.remove()
          if (styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl)
        }
      }, 'task-panel: floater')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
