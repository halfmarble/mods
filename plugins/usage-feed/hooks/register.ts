// usage-feed: keeps each Claude Code session's state from its events and sends it, with the plan's usage, to
// upMonitor over a Unix socket inside upMonitor's own folder. Every hook only observes: it records what it saw and
// returns what the hooks beneath returned. The classic hooks carry a `.catch` that only passes the event on, so one
// that fails (or overruns its time) leaves the event as the hooks beneath made it; the others are not gating.
import type { Register, EngineInterface } from 'claude-code'
import type { UsageFeedSnap } from '../types'
import {
  HEARTBEAT_MS,
  SEND_TIMEOUT_MS,
  afterClear,
  applyWord,
  buildEnd,
  buildRecord,
  buildUpdate,
  candidateIds,
  emptySnap,
  socketPath,
  type Word,
} from './model'

const SNAP = { plugin: 'usage-feed', key: 'snap' } as const

type Step = (snap: UsageFeedSnap, nowS: number) => UsageFeedSnap | null
type Result = { status?: number; error?: string }

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
        r => ({ status: r.status }),
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

// The next sequence number, kept in the snapshot
const bump = ($: EngineInterface, ctx: Ctx): Promise<UsageFeedSnap> =>
  serial(ctx, async () => {
    const snap = await getSnap($)
    const next = { ...snap, seq: snap.seq + 1 }
    await $.state.set(SNAP, next)
    return next
  })

const sendAll = async ($: EngineInterface, ctx: Ctx, text: string): Promise<void> => {
  const home = await $.env.get('HOME')
  if (typeof home !== 'string' || home === '') return
  await Promise.all(ctx.candidates.map(id => post($, home, id, text)))
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
  await sendAll($, ctx, JSON.stringify(buildUpdate(snap, interactive, record, Math.floor(nowMs / 1000))))
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
  const ctx: Ctx = { candidates: candidateIds(options.extraBundleIds), inFlight: false, pending: false, closed: false, timer: null, tail: Promise.resolve() }

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
