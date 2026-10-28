// usage-feed: keeps each Claude Code session's state from its events and sends it, with the plan's usage, to
// upMonitor over a Unix socket inside upMonitor's own folder. Every hook only observes: it records what it saw and
// returns what the hooks beneath returned. The classic hooks carry a `.catch` that only passes the event on, so one
// that fails (or overruns its time) leaves the event as the hooks beneath made it; the others are not gating.
import type { Register, EngineInterface } from 'claude-code'
import type { UsageFeedSnap } from '../types'
import {
  HEARTBEAT_MS,
  SELECT_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
  TABS_MS,
  TABS_READ_TIMEOUT_MS,
  TABS_SCRIPT,
  TABS_SLOW_MS,
  TTY_READ_TIMEOUT_MS,
  TTY_SCRIPT,
  UPDATE_MARKETPLACE_ARGV,
  UPDATE_PLUGIN_ARGV,
  UPDATE_TIMEOUT_MS,
  WAIT_RACE_MS,
  type Tabs,
  type UpdateResult,
  afterClear,
  applyWord,
  buildEnd,
  buildRecord,
  buildUpdate,
  candidateIds,
  classifyExit,
  classifyReject,
  emptySnap,
  nextTabs,
  marketplaceFailure,
  parseReply,
  parseTtyLine,
  parseWaitReply,
  parseUpdateJson,
  selectScript,
  slowAfter,
  socketPath,
  tabsKey,
  updateRejectCode,
  updateText,
  type ReadOutcome,
  type Word,
} from './model'

const SNAP = { plugin: 'usage-feed', key: 'snap' } as const

type Step = (snap: UsageFeedSnap, nowS: number) => UsageFeedSnap | null
// ask: the app's 200 reply said {"tabs":true}. wait: it said {"wait":true}. update: its token, when the reply carried one
type Result = { status?: number; error?: string; ask?: boolean; wait?: boolean; update?: string }

const agentOf = (e: unknown): string | undefined => {
  const a = (e as { agent_id?: unknown }).agent_id
  return typeof a === 'string' && a !== '' ? a : undefined
}

// The main thread's effort level from an event that carries it
const effortStep = (e: unknown): Step => snap => {
  if (agentOf(e)) return null
  const level = (e as { effort?: { level?: unknown } }).effort?.level
  if (typeof level !== 'string' || level === snap.effort) return null
  return { ...snap, effort: level }
}

const wordStep = (agentId: string | undefined, word: Word | null): Step => (snap, nowS) => applyWord(snap, agentId, word, nowS)

const titleStep = (title: unknown): Step => snap => (typeof title === 'string' && title !== '' && title !== snap.title ? { ...snap, title } : null)

// The first step that changes the snapshot carries on from its result; null when none changes it
const steps = (...all: Step[]): Step => (snap, nowS) => {
  let cur = snap
  let changed = false
  for (const s of all) {
    const n = s(cur, nowS)
    if (n !== null) {
      cur = n
      changed = true
    }
  }
  return changed ? cur : null
}

// One sender per Claude Code process. Its state is made by `register`, so a test that loads the mod twice has two.
type Ctx = {
  candidates: string[]
  inFlight: boolean
  pending: boolean
  closed: boolean
  timer: { cancel: () => void } | null
  tail: Promise<unknown>
  // Terminal's tab bar, read only while upMonitor asks; kept in module memory, never in $.state
  reader: { asked: boolean; busy: boolean; slow: boolean; lastMs: number; timer: { cancel: () => void } | null; tabs: Tabs | null }
  // Updates sent without tabs because they would pass 16,000 bytes
  tabsDropped: number
  // The update upMonitor asks for: one run at a time, each token once, the outcome kept for every later message
  update: { busy: boolean; done: Set<string>; result: UpdateResult | null }
  // A click on this session's row in upMonitor's panel: its tty (a promise, started on the first send that needs it; null
  // where there is none to use), one wait loop per app, when each last failed, and whether a select runs. Kept in module memory, never in $.state.
  wait: { tty: Promise<string | null> | null; loops: Map<string, boolean>; failedAt: Map<string, number>; selecting: boolean }
}

// Read-modify-write of the snapshot one at a time: hooks run side by side
const serial = <T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> => {
  const run = ctx.tail.then(fn)
  ctx.tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const getSnap = async ($: EngineInterface): Promise<UsageFeedSnap> => (await $.state.get(SNAP)).value ?? emptySnap()

const update = ($: EngineInterface, ctx: Ctx, step: Step): Promise<boolean> =>
  serial(ctx, async () => {
    const next = step(await getSnap($), Math.floor((await $.clock.now()) / 1000))
    if (next === null) return false
    await $.state.set(SNAP, next)
    return true
  })

// One POST to one app, never rejecting. The host gives up on a listener that accepts and never answers only after
// 30 s and HttpInit has no timeout, so the fetch is raced against 2 s and the late answer dropped.
const post = async ($: EngineInterface, home: string, bundleId: string, text: string): Promise<Result> => {
  try {
    const fetched: Promise<Result> = $.http
      .fetch('http://localhost/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
        socketPath: socketPath(home, bundleId),
      })
      .then(
        r => {
          const reply = r.status === 200 ? parseReply(r.text) : null
          return { status: r.status, ask: reply?.tabs === true, wait: reply?.wait === true, ...(reply?.update != null ? { update: reply.update } : {}) }
        },
        (err: unknown) => ({ error: String(err).slice(0, 200) }),
      )
    return await new Promise<Result>(resolve => {
      const t = $.clock.after(SEND_TIMEOUT_MS, () => resolve({ error: 'timeout' }))
      void fetched.then(r => {
        t.cancel()
        resolve(r)
      })
    })
  } catch (err) {
    return { error: String(err).slice(0, 200) }
  }
}

// One GET /v1/wait to one app, never rejecting: the app holds it up to 25 s and the host aborts only at 30 s, so the
// fetch is raced against WAIT_RACE_MS and the late answer dropped.
const waitOnce = async ($: EngineInterface, home: string, bundleId: string): Promise<'select' | 'none' | 'bad'> => {
  try {
    const fetched: Promise<'select' | 'none' | 'bad'> = $.http
      .fetch('http://localhost/v1/wait', { method: 'GET', socketPath: socketPath(home, bundleId) })
      .then(
        r => (r.status === 200 ? parseWaitReply(r.text) : 'bad'),
        () => 'bad' as const,
      )
    return await new Promise<'select' | 'none' | 'bad'>(resolve => {
      const t = $.clock.after(WAIT_RACE_MS, () => resolve('bad'))
      void fetched.then(r => {
        t.cancel()
        resolve(r)
      })
    })
  } catch {
    return 'bad'
  }
}

// This process's tty, read once: Terminal's only (TERM_PROGRAM exactly Apple_Terminal), else null and no waiting.
// $.process.run is called as a method, as in readTabs (see READS_TABS). Nothing of it is logged or stored.
const readTty = async ($: EngineInterface): Promise<string | null> => {
  try {
    const res = await $.process.run(TTY_SCRIPT, { timeoutMs: TTY_READ_TIMEOUT_MS })
    return res.exitCode === 0 ? parseTtyLine(res.stdout) : null
  } catch {
    return null
  }
}

// Select this session's Terminal tab, one at a time; the outcome is dropped and nothing is logged
const runSelect = async ($: EngineInterface, ctx: Ctx, tty: string): Promise<void> => {
  const w = ctx.wait
  if (ctx.closed || w.selecting) return
  w.selecting = true
  try {
    await $.process.run(['/usr/bin/osascript', ...selectScript(tty)], { timeoutMs: SELECT_TIMEOUT_MS })
  } catch {
    // nothing to do: the click selected nothing
  } finally {
    w.selecting = false
  }
}

// Wait on one app for a click on this session's row, one GET after another, run off the send's path, never awaited and
// never rejecting. A refusal, a non-200 or no answer ends it, and so does an {} that came back at once (an app that
// does not hold it); it starts again only from a later reply with "wait":true, 10 s after the failure at the earliest.
const waitLoop = async ($: EngineInterface, ctx: Ctx, home: string, id: string, tty: string): Promise<void> => {
  const w = ctx.wait
  try {
    while (!ctx.closed) {
      const t0 = await $.clock.now()
      const answer = await waitOnce($, home, id)
      if (ctx.closed) break
      if (answer === 'bad' || (answer === 'none' && (await $.clock.now()) - t0 < 1000)) {
        w.failedAt.set(id, await $.clock.now())
        break
      }
      if (answer === 'select') void runSelect($, ctx, tty)
    }
  } catch {
    // the next reply with "wait":true tries again
  } finally {
    w.loops.delete(id)
  }
}

// After a send: for each app that said "wait":true, a wait loop unless one runs or the last failure is under 10 s old
const startWaits = async ($: EngineInterface, ctx: Ctx, results: Result[]): Promise<void> => {
  try {
    const waiting = ctx.candidates.filter((_, i) => results[i]?.wait === true)
    if (ctx.closed || waiting.length === 0) return
    const home = await $.env.get('HOME')
    if (typeof home !== 'string' || home === '') return
    ctx.wait.tty ??= readTty($)
    const tty = await ctx.wait.tty
    if (tty === null) return
    const nowMs = await $.clock.now()
    for (const id of waiting) {
      const failed = ctx.wait.failedAt.get(id)
      if (ctx.closed || ctx.wait.loops.has(id) || (failed !== undefined && nowMs - failed < HEARTBEAT_MS)) continue
      ctx.wait.loops.set(id, true)
      void waitLoop($, ctx, home, id, tty)
    }
  } catch {
    // the next send tries again
  }
}

// The next sequence number, kept in the snapshot
const bump = ($: EngineInterface, ctx: Ctx): Promise<UsageFeedSnap> =>
  serial(ctx, async () => {
    const snap = await getSnap($)
    const next = { ...snap, seq: snap.seq + 1 }
    await $.state.set(SNAP, next)
    return next
  })

const sendAll = async ($: EngineInterface, ctx: Ctx, text: string): Promise<Result[]> => {
  const home = await $.env.get('HOME')
  if (typeof home !== 'string' || home === '') return []
  return Promise.all(ctx.candidates.map(id => post($, home, id, text)))
}

// Every update says reads_tabs: the host refuses a hooks module that reads $.process.run as a value ("hooks module did
// not load"), so whether it can run here is not tested; the app passes over a session whose reads never succeed.
const READS_TABS = true

// The reader turns on with the app's ask and off when a send gets none; it needs $.process.run
const setAsk = ($: EngineInterface, ctx: Ctx, ask: boolean): void => {
  const r = ctx.reader
  const on = ask && READS_TABS && !ctx.closed
  if (on === r.asked) return
  r.asked = on
  if (on) {
    r.timer = $.clock.every(TABS_MS, () => void readTabs($, ctx))
  } else {
    r.timer?.cancel()
    r.timer = null
    r.tabs = null
    r.slow = false
  }
}

// One read of the tab bar, one in flight at most; after a refusal or a timeout one every 30 s until a read succeeds.
// Nothing of a title is logged or stored besides the reading kept in ctx.reader.
const readTabs = async ($: EngineInterface, ctx: Ctx): Promise<void> => {
  const r = ctx.reader
  if (!r.asked || r.busy || ctx.closed) return
  const t0 = await $.clock.now()
  if (r.slow && t0 - r.lastMs < TABS_SLOW_MS) return
  r.busy = true
  r.lastMs = t0
  let outcome: ReadOutcome
  try {
    const res = await $.process.run(['/usr/bin/osascript', '-e', TABS_SCRIPT], { timeoutMs: TABS_READ_TIMEOUT_MS })
    outcome = res.exitCode === 0 ? { kind: 'ok', stdout: res.stdout } : classifyExit(res.stderr)
  } catch (err) {
    outcome = classifyReject(String(err), (await $.clock.now()) - t0)
  } finally {
    r.busy = false
  }
  if (!r.asked || ctx.closed) return
  const next = nextTabs(r.tabs, outcome, Math.floor((await $.clock.now()) / 1000))
  const changed = tabsKey(next) !== tabsKey(r.tabs)
  r.tabs = next
  r.slow = slowAfter(outcome, r.slow)
  if (changed) kick($, ctx)
}

// The update upMonitor asked for with a token: the marketplace, then the plugin unless that failed. Run off the send's
// path, never awaited and never rejecting; only the bounded fields of UpdateResult are kept, nothing of the output.
// $.process.run is called as a method, as in readTabs (see READS_TABS).
const runUpdate = async ($: EngineInterface, ctx: Ctx, token: string): Promise<void> => {
  const u = ctx.update
  if (ctx.closed || u.busy || u.done.has(token)) return
  u.busy = true
  u.done.add(token)
  try {
    let result: Omit<UpdateResult, 'token'>
    const t0 = await $.clock.now()
    try {
      const m = await $.process.run(UPDATE_MARKETPLACE_ARGV, { timeoutMs: UPDATE_TIMEOUT_MS })
      const failure = marketplaceFailure(m.stdout, m.exitCode)
      if (failure !== null) {
        result = { outcome: 'failed', failure_code: failure }
      } else {
        const t1 = await $.clock.now()
        try {
          const p = await $.process.run(UPDATE_PLUGIN_ARGV, { timeoutMs: UPDATE_TIMEOUT_MS })
          result = parseUpdateJson(p.stdout, p.exitCode)
        } catch (err) {
          result = { outcome: 'failed', failure_code: updateRejectCode(String(err), (await $.clock.now()) - t1) }
        }
      }
    } catch (err) {
      result = { outcome: 'failed', failure_code: updateRejectCode(String(err), (await $.clock.now()) - t0) }
    }
    u.result = { token, ...result }
    kick($, ctx)
  } catch {
    // the next token tries again
  } finally {
    u.busy = false
  }
}

const sendUpdate = async ($: EngineInterface, ctx: Ctx): Promise<void> => {
  const snap = await bump($, ctx)
  const nowMs = await $.clock.now()
  const interactive = snap.interactive ?? (await $.session.surfaces()).length > 0
  const record = buildRecord({
    nowMs,
    sessionId: await $.session.id(),
    root: await $.session.root(),
    model: await $.session.model(),
    version: (await $.session.version()).version,
    usage: await $.session.usage(),
    title: snap.title,
    effort: snap.effort,
  })
  const built = buildUpdate(snap, interactive, record, Math.floor(nowMs / 1000), READS_TABS, ctx.reader.asked ? ctx.reader.tabs : null, ctx.update.result)
  const { text, droppedTabs } = updateText(built)
  if (droppedTabs) ctx.tabsDropped += 1
  const results = await sendAll($, ctx, text)
  // The ask is the latest send's: true when any candidate's 200 said so, false after a send in which none did
  if (!ctx.closed) setAsk($, ctx, results.some(x => x.ask === true))
  const token = results.find(x => x.update !== undefined)?.update
  if (token !== undefined) void runUpdate($, ctx, token)
  void startWaits($, ctx, results)
}

// One request in flight at most; a change during it is sent once more after it, as the latest snapshot
const kick = ($: EngineInterface, ctx: Ctx): void => {
  if (ctx.closed) return
  ctx.pending = true
  if (ctx.inFlight) return
  ctx.inFlight = true
  void (async () => {
    try {
      while (ctx.pending && !ctx.closed) {
        ctx.pending = false
        await sendUpdate($, ctx)
      }
    } catch {
      // the next change or heartbeat tries again
    } finally {
      ctx.inFlight = false
    }
  })()
}

const ensureTimer = ($: EngineInterface, ctx: Ctx): void => {
  if (ctx.timer !== null || ctx.closed) return
  ctx.timer = $.clock.every(HEARTBEAT_MS, () => kick($, ctx))
}

// Run an observer's work: it never throws into the hook, and a change asks for a send
const observe = async ($: EngineInterface, ctx: Ctx, step: Step | null): Promise<void> => {
  try {
    ensureTimer($, ctx)
    const changed = step === null ? false : await update($, ctx, step)
    if (changed) kick($, ctx)
  } catch {
    // an observer must not fail the event
  }
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    candidates: candidateIds(options.extraBundleIds),
    inFlight: false,
    pending: false,
    closed: false,
    timer: null,
    tail: Promise.resolve(),
    reader: { asked: false, busy: false, slow: false, lastMs: 0, timer: null, tabs: null },
    tabsDropped: 0,
    update: { busy: false, done: new Set(), result: null },
    wait: { tty: null, loops: new Map(), failedAt: new Map(), selecting: false },
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      ctx.closed = false
      await update($, ctx, snap => (snap.interactive === e.isInteractive ? null : { ...snap, interactive: e.isInteractive }))
      ensureTimer($, ctx)
      kick($, ctx)
    } catch {
      // as observe
    }
    return r
  })
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    await observe($, ctx, titleStep(e.session_title))
    kick($, ctx)
    return r

  }).catch((_, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    await observe($, ctx, steps(titleStep(r.sessionTitle ?? e.session_title), wordStep(agentOf(e), 'busy')))
    return r

  }).catch((_, e, next) => next(e))
  on('classic.PostToolUse', async ($, e, next) => {
    await observe($, ctx, steps(effortStep(e), wordStep(agentOf(e), 'busy')))
    return next(e)

  }).catch((_, e, next) => next(e))
  on('classic.PostToolUseFailure', async ($, e, next) => {
    await observe($, ctx, wordStep(agentOf(e), 'busy'))
    return next(e)

  }).catch((_, e, next) => next(e))
  // Before next: the hooks beneath may wait for the person's answer
  on('classic.PermissionRequest', async ($, e, next) => {
    await observe($, ctx, steps(effortStep(e), wordStep(agentOf(e), 'waiting')))
    return next(e)

  }).catch((_, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    await observe($, ctx, steps(effortStep(e), agentOf(e) ? () => null : wordStep(undefined, 'idle')))
    return next(e)

  }).catch((_, e, next) => next(e))
  on('classic.StopFailure', async ($, e, next) => {
    await observe($, ctx, agentOf(e) ? null : wordStep(undefined, 'idle'))
    return next(e)

  }).catch((_, e, next) => next(e))
  on('classic.SubagentStart', async ($, e, next) => {
    const a = agentOf(e)
    await observe($, ctx, a ? wordStep(a, 'busy') : null)
    return next(e)

  }).catch((_, e, next) => next(e))
  on('classic.SubagentStop', async ($, e, next) => {
    const a = agentOf(e)
    await observe($, ctx, a ? wordStep(a, null) : null)
    return next(e)

  }).catch((_, e, next) => next(e))
  // Every turn's end, whatever its reason: main idle, or that agent removed (an Escape on a permission prompt gives
  // only this event, and a stopped agent gets no SubagentStop)
  on('turn.complete', async ($, e, next) => {
    await observe($, ctx, e.agentId ? wordStep(e.agentId, null) : wordStep(undefined, 'idle'))
    return next(e)
  })
  on('session.measure', async ($, e, next) => {
    await observe($, ctx, null)
    kick($, ctx)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    try {
      const clearing = e.reason === 'clear' || e.reason === 'resume'
      ctx.pending = false
      if (!clearing) {
        ctx.closed = true
        ctx.timer?.cancel()
        ctx.timer = null
        setAsk($, ctx, false)
      }
      const snap = await bump($, ctx)
      await sendAll($, ctx, JSON.stringify(buildEnd(snap.seq, e.sessionId)))
      // The process goes on under a new id: idle, no agents, no name, until its events arrive
      if (clearing) await update($, ctx, (s, nowS) => afterClear(s, nowS))
    } catch {
      // the app drops a session whose process has gone
    }
    return next(e)
  })
}
