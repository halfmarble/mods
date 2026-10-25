import { expect, mock, test } from 'claude-code/testing'
import {
  AGENT_BUSY_MAX_AGE_S,
  afterClear,
  agentKey,
  agentsToSend,
  applyWord,
  buildEnd,
  buildRecord,
  candidateIds,
  emptySnap,
  fnv1a64,
  lastPart,
  socketPath,
} from './model'

// Run by `claude plugin test`: the pure functions by plain calls, the hooks and the sender through the kit, whose
// hooks stand for the engine (the clock, the session, the network). The mocked clock moves only when a test moves it.
const NOW = 1_700_000_000_000
const SOCK = '/home/t/Library/Containers/com.halfmarblellc.upmonitor/Data/m.sock'

type Sent = { path: string; body: any; init: any }
type Opts = {
  fetch?: (e: any, sent: Sent[]) => unknown
  surfaces?: unknown[]
  home?: Record<string, string>
  // A snapshot the mod's $.state already holds, as after a reload; the first write of the mod replaces it
  seed?: unknown
}

// The engine beneath the mod: every call the mod makes is answered here; bodies POSTed are collected in `sent`
const wire = (on: any, o: Opts = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, o.home ?? { HOME: '/home/t' })
  const w = {
    clock,
    sent: [] as Sent[],
    sessionId: 'sess-1',
    saved: undefined as any,
    promptResult: {} as Record<string, unknown>,
    usage: {
      startedAt: NOW - 100_000,
      context: { window: 200_000, percent: 7, tokens: 14_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-23T12:00:00.000Z' },
        { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-27T00:00:00.000Z' },
        { kind: 'spend_limit', percentUsed: 3 },
      ],
      cost: { usd: 2.5 },
    } as any,
  }
  let seed = o.seed
  on('state.get', (_: any, e: any, next: any) => (seed !== undefined && e.key === 'snap' ? { value: { value: seed, version: 1 } } : next(e)))
  on('state.set', (_: any, e: any, next: any) => {
    if (e.key === 'snap') {
      seed = undefined
      w.saved = e.value
    }
    return next(e)
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => w.promptResult)
  for (const n of ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PermissionRequest', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop'])
    on(`classic.${n}`, () => ({}))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.root', () => ({ value: '/work/proj/' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.version', () => ({ value: { version: '9.9.9' } }))
  on('session.surfaces', () => ({ value: o.surfaces ?? [] }))
  on('session.usage', () => ({ value: w.usage }))
  on('http.fetch', (_: any, e: any) => {
    const entry: Sent = { path: e.init?.socketPath, body: JSON.parse(e.init?.body ?? 'null'), init: { ...e.init, url: e.url } }
    w.sent.push(entry)
    return o.fetch ? o.fetch(e, w.sent) : { value: { status: 200, ok: true, text: '{}' } }
  })
  return w
}

// What a test raises, as the engine does
const start = ($: any, isInteractive = true) => $.session.start({ cwd: '/work/proj', surface: isInteractive ? 'terminal' : null, isInteractive })
const prompt = ($: any, extra: object = {}) => $.classic.UserPromptSubmit({ prompt: 'hi', ...extra })
const tool = ($: any, extra: object = {}) => $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't1', ...extra })
const toolFail = ($: any, extra: object = {}) => $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: {}, tool_use_id: 't1', error: 'x', ...extra })
const perm = ($: any, extra: object = {}) => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, ...extra })
const stop = ($: any, extra: object = {}) => $.classic.Stop({ stop_hook_active: false, ...extra })
const stopFail = ($: any) => $.classic.StopFailure({ error: 'server_error' })
const subStart = ($: any, id: string) => $.classic.SubagentStart({ agent_id: id, agent_type: 'general' })
const subStop = ($: any, id: string) => $.classic.SubagentStop({ agent_id: id, agent_transcript_path: '', agent_type: 'general', stop_hook_active: false })
const turn = ($: any, extra: object = {}) =>
  $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer', ...extra })
const word = (line: string | null | undefined) => line?.split(' ')[0]
const last = (w: ReturnType<typeof wire>) => w.sent[w.sent.length - 1]?.body
// A deferred answer for a fetch that is held until the test releases it
const holder = () => {
  const waiting: ((v: unknown) => void)[] = []
  return {
    hook: () => new Promise(res => waiting.push(res)),
    release: (v: unknown) => waiting.splice(0).forEach(r => r(v)),
    count: () => waiting.length,
  }
}
const ok = { value: { status: 200, ok: true, text: '{}' } }

// ---------------------------------------------------------------- pure

test('pure: hashing, agent keys and candidates', () => {
  expect(fnv1a64('lead@team-x')).toBe('51b7d7b2747dec59')
  expect(fnv1a64('é@x')).toBe('f86173c6f231cab1')
  expect(agentKey('a1B2c3')).toBe('a1B2c3')
  expect(agentKey('a'.repeat(64))).toBe('a'.repeat(64))
  expect(agentKey('a'.repeat(65))).toBe(`h${fnv1a64('a'.repeat(65))}`)
  expect(agentKey('lead@team-x')).toBe('h51b7d7b2747dec59')
  expect(agentKey('')).toBe(`h${fnv1a64('')}`)
  expect(/^h[0-9a-f]{16}$/.test(agentKey('é@x'))).toBe(true)
  expect(candidateIds(undefined)).toEqual(['com.halfmarblellc.upmonitor'])
  expect(candidateIds('')).toEqual(['com.halfmarblellc.upmonitor'])
  expect(candidateIds('com.a.b, com.c-d ,bad id!,com.a.b,/x')).toEqual(['com.halfmarblellc.upmonitor', 'com.a.b', 'com.c-d'])
  expect(candidateIds('a,b,c,d,e,f')).toEqual(['com.halfmarblellc.upmonitor', 'a', 'b', 'c', 'd'])
  expect(candidateIds('x'.repeat(65))).toEqual(['com.halfmarblellc.upmonitor'])
  expect(candidateIds(7)).toEqual(['com.halfmarblellc.upmonitor'])
  expect(socketPath('/home/u', 'com.x')).toBe('/home/u/Library/Containers/com.x/Data/m.sock')
  expect(lastPart('/a/b/')).toBe('b')
  expect(lastPart('/')).toBe(null)
})

test('pure: state changes', () => {
  const s0 = emptySnap()
  expect(applyWord(s0, undefined, 'idle', 5)?.main).toBe('idle 5')
  expect(applyWord(s0, undefined, null, 5)).toBe(null)
  const s1 = applyWord(s0, undefined, 'busy', 5)!
  expect(applyWord(s1, undefined, 'busy', 9)).toBe(null)
  expect(applyWord(s1, undefined, 'waiting', 9)?.main).toBe('waiting 9')
  const s2 = applyWord(s1, 'ag1', 'busy', 6)!
  expect(s2.agents).toEqual({ ag1: 'busy 6' })
  expect(applyWord(s2, 'ag1', 'busy', 7)).toBe(null)
  expect(applyWord(s2, 'ag1', null, 7)?.agents).toEqual({})
  expect(applyWord(s2, 'nope', null, 7)).toBe(null)
  expect(applyWord(s1, 'lead@team-x', 'busy', 6)?.agents).toEqual({ h51b7d7b2747dec59: 'busy 6' })
  expect(s2.main).toBe('busy 5')
  const cleared = afterClear({ ...s2, title: 'T', effort: 'max', seq: 4, interactive: true }, 50)
  expect(cleared).toEqual({ seq: 4, main: 'idle 50', agents: {}, effort: 'max', title: null, interactive: true })
})

test('pure: agents sent: old busy dropped, 64 latest kept', () => {
  const now = 100_000
  expect(agentsToSend({ a: `busy ${now - AGENT_BUSY_MAX_AGE_S}` }, now)).toEqual({ a: `busy ${now - AGENT_BUSY_MAX_AGE_S}` })
  expect(agentsToSend({ a: `busy ${now - AGENT_BUSY_MAX_AGE_S - 1}` }, now)).toEqual({})
  expect(agentsToSend({ w: `waiting ${now - 9000}` }, now)).toEqual({ w: `waiting ${now - 9000}` })
  const many: Record<string, string> = {}
  for (let i = 0; i < 70; i++) many[`a${i}`] = `busy ${now - 100 + i}`
  const sent = agentsToSend(many, now)
  expect(Object.keys(sent).length).toBe(64)
  expect('a69' in sent).toBe(true)
  expect('a6' in sent).toBe(true)
  expect('a5' in sent).toBe(false)
})

test('pure: the record and the end message', () => {
  const base = {
    nowMs: 5_000_500,
    sessionId: 's',
    root: '/p/q/',
    model: 'm',
    version: 'v',
    title: null,
    effort: null,
    usage: { startedAt: 5_000_000, context: { window: 10 }, rateLimits: [] },
  }
  const r = buildRecord(base)
  expect(r.written_at).toBe(5000)
  expect(r.project).toBe('q')
  expect(r.model).toEqual({ id: 'm' })
  expect(r.context_window).toEqual({ used_percentage: null, context_window_size: 10, used_tokens: null })
  expect(r.cost).toEqual({ total_cost_usd: null, total_duration_ms: 500 })
  expect('rate_limits' in r).toBe(false)
  const r2 = buildRecord({ ...base, usage: { ...base.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }, { kind: 'x', percentUsed: 2 }] } })
  expect(r2.rate_limits).toEqual({ five_hour: { used_percentage: 1, resets_at: null } })
  expect(buildEnd(3, 'sid')).toEqual({ v: 1, kind: 'end', seq: 3, mod: '1.0.0', session_id: 'sid' })
})

// ---------------------------------------------------------------- the hooks and the sender

test('start: the first update has main null and the whole record', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  const s = w.sent[0]!
  expect(s.path).toBe(SOCK)
  expect(s.init.url).toBe('http://localhost/v1/session')
  expect(s.init.method).toBe('POST')
  expect(s.init.headers['content-type']).toBe('application/json')
  expect(Object.keys(s.body)).toEqual(['v', 'kind', 'seq', 'mod', 'interactive', 'record', 'state'])
  expect(s.body).toMatchObject({ v: 1, kind: 'update', seq: 1, mod: '1.0.0', interactive: true, state: { main: null, agents: {} } })
  expect(s.body.record).toEqual({
    v: 1,
    written_at: NOW / 1000,
    session_id: 'sess-1',
    session_name: null,
    project: 'proj',
    model: { id: 'claude-test' },
    effort: { level: null },
    context_window: { used_percentage: 7, context_window_size: 200_000, used_tokens: 14_000 },
    cost: { total_cost_usd: 2.5, total_duration_ms: 100_000 },
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: Date.parse('2026-10-23T12:00:00.000Z') / 1000 },
      seven_day: { used_percentage: 60, resets_at: Date.parse('2026-10-27T00:00:00.000Z') / 1000 },
    },
    version: '9.9.9',
  })
})

test('states: prompt busy, permission waiting, tool busy, stop idle', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  const seen: (string | undefined)[] = []
  for (const step of [() => prompt($), () => perm($), () => tool($), () => toolFail($), () => stop($), () => prompt($), () => stopFail($)]) {
    const n = w.sent.length
    await step()
    await w.clock.settle()
    seen.push(w.sent.length > n ? word(last(w).state.main) : 'no send')
  }
  // toolFail after tool: busy to busy, no change, no send
  expect(seen).toEqual(['busy', 'waiting', 'busy', 'no send', 'idle', 'busy', 'idle'])
  expect(w.sent.map(s => s.body.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

test('an Escape on a permission prompt gives only turn.complete (answer): main idle', async ($, on) => {
  const w = wire(on)
  await start($)
  await prompt($)
  await perm($)
  await w.clock.settle()
  expect(word(last(w).state.main)).toBe('waiting')
  await turn($, { reason: 'answer' })
  await w.clock.settle()
  expect(word(last(w).state.main)).toBe('idle')
})

for (const extra of [{ reason: 'answer' }, { reason: 'aborted', isAborted: true }, { reason: 'error' }]) {
  test(`a main turn.complete (${extra.reason}) makes main idle`, async ($, on) => {
    const w = wire(on)
    await prompt($)
    await w.clock.settle()
    expect(word(last(w).state.main)).toBe('busy')
    await turn($, extra)
    await w.clock.settle()
    expect(word(last(w).state.main)).toBe('idle')
  })
}

test('agents: start, permission, stop; a stopped agent gets no SubagentStop; main idle keeps a background agent', async ($, on) => {
  const w = wire(on)
  await start($)
  await subStart($, 'a1')
  await w.clock.settle()
  expect(Object.keys(last(w).state.agents)).toEqual(['a1'])
  expect(word(last(w).state.agents.a1)).toBe('busy')
  expect(last(w).state.main).toBe(null)
  await perm($, { agent_id: 'a1' })
  await w.clock.settle()
  expect(word(last(w).state.agents.a1)).toBe('waiting')
  expect(last(w).state.main).toBe(null)
  await subStop($, 'a1')
  await w.clock.settle()
  expect(last(w).state.agents).toEqual({})
  // stopped: SubagentStart, then turn.complete with its agentId and no SubagentStop
  await subStart($, 'a2')
  await w.clock.settle()
  expect(Object.keys(last(w).state.agents)).toEqual(['a2'])
  await turn($, { agentId: 'a2', reason: 'aborted', isAborted: true })
  await w.clock.settle()
  expect(last(w).state.agents).toEqual({})
  // an Escape in the main thread leaves a background agent running
  await subStart($, 'a3')
  await prompt($)
  await turn($, { reason: 'aborted', isAborted: true })
  await w.clock.settle()
  expect(word(last(w).state.main)).toBe('idle')
  expect(Object.keys(last(w).state.agents)).toEqual(['a3'])
  // a subagent's own tool event adds it, and a main-thread Stop with an agent id does not idle main
  await tool($, { agent_id: 'a4' })
  await w.clock.settle()
  expect(Object.keys(last(w).state.agents).sort()).toEqual(['a3', 'a4'])
  await stop($, { agent_id: 'a4' })
  await w.clock.settle()
  expect(word(last(w).state.main)).toBe('idle')
})

test('the name: the result sessionTitle before e.session_title; SessionStart gives one too', async ($, on) => {
  const w = wire(on)
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_title: 'Started' })
  await w.clock.settle()
  expect(last(w).record.session_name).toBe('Started')
  w.promptResult = { sessionTitle: 'From hook' }
  await prompt($, { session_title: 'Old' })
  await w.clock.settle()
  expect(last(w).record.session_name).toBe('From hook')
  w.promptResult = {}
  await prompt($, { session_title: 'Renamed' })
  await w.clock.settle()
  expect(last(w).record.session_name).toBe('Renamed')
  await prompt($, {})
  await w.clock.settle()
  expect(last(w).record.session_name).toBe('Renamed')
})

test('an agent seen only in a PostToolBatch adds none', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  const n = w.sent.length
  await $.classic.PostToolBatch({ tool_calls: [], agent_id: 'ghost' })
  await w.clock.settle()
  expect(w.sent.length).toBe(n)
  expect(last(w).state.agents).toEqual({})
})

test('an agent id outside [A-Za-z0-9]{1,64} is sent as h and 16 hex digits', async ($, on) => {
  const w = wire(on)
  await subStart($, 'lead@team-x')
  await subStart($, 'plain1')
  await w.clock.settle()
  expect(Object.keys(last(w).state.agents).sort()).toEqual(['h51b7d7b2747dec59', 'plain1'])
  await subStop($, 'lead@team-x')
  await w.clock.settle()
  expect(Object.keys(last(w).state.agents)).toEqual(['plain1'])
})

test('a busy agent 2 h 1 min old is dropped from the message', async ($, on) => {
  const w = wire(on)
  await start($)
  await subStart($, 'old')
  await w.clock.settle()
  await w.clock.advance(AGENT_BUSY_MAX_AGE_S * 1000)
  expect(Object.keys(last(w).state.agents)).toEqual(['old'])
  await w.clock.advance(61_000)
  expect(last(w).state.agents).toEqual({})
})

test('70 agents: the 64 latest are sent', async ($, on) => {
  const w = wire(on)
  await start($)
  for (let i = 0; i < 70; i++) {
    await subStart($, `ag${i}`)
    await w.clock.advance(1000)
  }
  await w.clock.settle()
  const agents = Object.keys(last(w).state.agents)
  expect(agents.length).toBe(64)
  expect(agents.includes('ag69')).toBe(true)
  expect(agents.includes('ag6')).toBe(true)
  expect(agents.includes('ag5')).toBe(false)
  expect(agents.includes('ag0')).toBe(false)
})

test('a send never answered: the next one starts 2 s later, the late answer is dropped', async ($, on) => {
  const h = holder()
  const w = wire(on, { fetch: () => h.hook() })
  await start($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  await prompt($)
  await w.clock.advance(1999)
  expect(w.sent.length).toBe(1)
  await w.clock.advance(1)
  expect(w.sent.length).toBe(2)
  expect(word(last(w).state.main)).toBe('busy')
  expect(last(w).seq).toBe(2)
  h.release(ok)
  await w.clock.settle()
  expect(w.sent.length).toBe(2)
})

test('coalescing: changes during a send are sent once more, as the latest snapshot', async ($, on) => {
  const h = holder()
  let first = true
  const w = wire(on, {
    fetch: () => {
      if (first) {
        first = false
        return h.hook()
      }
      return ok
    },
  })
  await start($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  await prompt($)
  await perm($)
  await tool($)
  await stop($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  h.release(ok)
  await w.clock.settle()
  expect(w.sent.length).toBe(2)
  expect(word(last(w).state.main)).toBe('idle')
  expect(last(w).seq).toBe(2)
})

test('heartbeat: a send every 10 s, seq rising', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  await w.clock.advance(9999)
  expect(w.sent.length).toBe(1)
  await w.clock.advance(1)
  expect(w.sent.length).toBe(2)
  await w.clock.advance(10_000)
  expect(w.sent.length).toBe(3)
  expect(w.sent.map(s => s.body.seq)).toEqual([1, 2, 3])
})

test('heartbeat starts at the first event when the mod was installed mid-session', async ($, on) => {
  const w = wire(on)
  await prompt($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  await w.clock.advance(10_000)
  expect(w.sent.length).toBe(2)
})

test('session.measure asks for a send', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  w.usage = { ...w.usage, context: { window: 200_000, percent: 8, tokens: 16_000 } }
  await $.session.measure({ context: w.usage.context, rateLimits: [], changed: [] })
  await w.clock.settle()
  expect(w.sent.length).toBe(2)
  expect(last(w).record.context_window.used_percentage).toBe(8)
})

// A plugin of the test's own, standing for the mod's two timer calls, so the clock's firing is checked apart from the
// mod: each timer's callback makes a fetch the test counts (the plugin is run in an environment of its own, so it
// cannot share a variable with the test)
const clockProbe = {
  name: 'clock-probe',
  register(on: any) {
    on('session.start', async ($: any, e: any, next: any) => {
      $.clock.after(2000, () => void $.http.fetch('http://clock-probe/after'))
      $.clock.every(10_000, () => void $.http.fetch('http://clock-probe/every'))
      return next(e)
    })
  },
}

test('the mocked clock fires $.clock.after at 2 s and $.clock.every at 10 s (positive control for the hold cases)', { plugins: [clockProbe] }, async ($, on) => {
  const w = wire(on)
  const count = (what: string) => w.sent.filter(s => s.init.url === `http://clock-probe/${what}`).length
  await start($)
  await w.clock.advance(1999)
  expect(count('after')).toBe(0)
  await w.clock.advance(1)
  expect(count('after')).toBe(1)
  await w.clock.advance(7999)
  expect(count('every')).toBe(0)
  await w.clock.advance(1)
  expect(count('every')).toBe(1)
  await w.clock.advance(10_000)
  expect(count('every')).toBe(2)
  expect(count('after')).toBe(1)
})

test('candidates: with no option only the release ID', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  expect(w.sent.map(s => s.path)).toEqual([SOCK])
})

test('candidates from the option', { options: { extraBundleIds: 'com.a.b, bad id!, com.c.d,com.e.f,com.g.h,com.i.j' } }, async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  const ids = w.sent.map(s => s.path.split('/')[5])
  expect(ids).toEqual(['com.halfmarblellc.upmonitor', 'com.a.b', 'com.c.d', 'com.e.f', 'com.g.h'])
  expect(new Set(w.sent.map(s => JSON.stringify(s.body))).size).toBe(1)
})

test('one candidate that never answers does not hold the others', { options: { extraBundleIds: 'com.a.b' } }, async ($, on) => {
  const h = holder()
  const w = wire(on, { fetch: e => (String(e.init.socketPath).includes('com.a.b') ? h.hook() : ok) })
  await start($)
  await w.clock.settle()
  expect(w.sent.map(s => s.path.split('/')[5])).toEqual(['com.halfmarblellc.upmonitor', 'com.a.b'])
  await prompt($)
  await w.clock.advance(1)
  expect(w.sent.length).toBe(2)
  await w.clock.advance(2000)
  expect(w.sent.length).toBe(4)
  expect(word(last(w).state.main)).toBe('busy')
})

test('a refused or failing send is caught and the next change sends again', async ($, on) => {
  let n = 0
  const w = wire(on, {
    fetch: () => {
      n += 1
      return n === 1 ? Promise.reject(new Error('connect ECONNREFUSED')) : ok
    },
  })
  await start($)
  await w.clock.settle()
  await prompt($)
  await w.clock.settle()
  expect(w.sent.length).toBe(2)
  expect(word(last(w).state.main)).toBe('busy')
})

test('no HOME: nothing is sent and no hook fails', async ($, on) => {
  const w = wire(on, { home: {} })
  await start($)
  await prompt($)
  await w.clock.settle()
  expect(w.sent.length).toBe(0)
})

test('interactive false: isInteractive false from session.start (a claude -p run)', async ($, on) => {
  const w = wire(on)
  await start($, false)
  await w.clock.settle()
  expect(last(w).interactive).toBe(false)
  await prompt($)
  await w.clock.settle()
  expect(last(w).interactive).toBe(false)
})

test('interactive true: isInteractive true from session.start, whatever the surfaces', async ($, on) => {
  const w = wire(on, { surfaces: [] })
  await start($, true)
  await w.clock.settle()
  expect(last(w).interactive).toBe(true)
})

test('interactive without session.start: from the surfaces', async ($, on) => {
  const w = wire(on, { surfaces: [{}] })
  await prompt($)
  await w.clock.settle()
  expect(last(w).interactive).toBe(true)
})

test('interactive without session.start and no surface: false', async ($, on) => {
  const w = wire(on, { surfaces: [] })
  await prompt($)
  await w.clock.settle()
  expect(last(w).interactive).toBe(false)
})

test('effort: the main thread sets it, an agent does not', async ($, on) => {
  const w = wire(on)
  await tool($, { agent_id: 'ag1', effort: { level: 'low' } })
  await w.clock.settle()
  expect(last(w).record.effort).toEqual({ level: null })
  await tool($, { effort: { level: 'max' } })
  await w.clock.settle()
  expect(last(w).record.effort).toEqual({ level: 'max' })
  await perm($, { effort: { level: 'high' } })
  await w.clock.settle()
  expect(last(w).record.effort).toEqual({ level: 'high' })
  await stop($, { effort: { level: 'medium' } })
  await w.clock.settle()
  expect(last(w).record.effort).toEqual({ level: 'medium' })
})

test('end: one end message with only its five keys, then no more sends', async ($, on) => {
  const w = wire(on)
  await start($)
  await prompt($)
  await w.clock.settle()
  const n = w.sent.length
  const r = await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await w.clock.settle()
  expect(r).toEqual({ sessionId: 'sess-1' })
  expect(w.sent.length).toBe(n + 1)
  expect(Object.keys(last(w))).toEqual(['v', 'kind', 'seq', 'mod', 'session_id'])
  expect(last(w)).toMatchObject({ kind: 'end', session_id: 'sess-1', seq: n + 1 })
  await prompt($)
  await w.clock.advance(60_000)
  expect(w.sent.length).toBe(n + 1)
})

for (const reason of ['clear', 'resume']) {
  test(`${reason}: end for the old id, the new id starts idle with no agents and no name`, async ($, on) => {
    const w = wire(on)
    await start($)
    await subStart($, 'ag1')
    w.promptResult = { sessionTitle: 'Old name' }
    await prompt($)
    await w.clock.settle()
    expect(last(w).record.session_name).toBe('Old name')
    await $.session.end({ reason: reason as any, sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await w.clock.settle()
    expect(last(w)).toMatchObject({ kind: 'end', session_id: 'sess-1' })
    w.sessionId = 'sess-2'
    w.promptResult = {}
    await $.classic.SessionStart({ source: reason as any })
    await w.clock.settle()
    expect(last(w).kind).toBe('update')
    expect(last(w).record.session_id).toBe('sess-2')
    expect(last(w).record.session_name).toBe(null)
    expect(word(last(w).state.main)).toBe('idle')
    expect(last(w).state.agents).toEqual({})
    const n = w.sent.length
    await w.clock.advance(10_000)
    expect(w.sent.length).toBe(n + 1)
  })
}

test('the snapshot kept in $.state carries on after a reload', async ($, on) => {
  const w = wire(on, {
    seed: { seq: 41, main: `busy ${NOW / 1000}`, agents: { a9: `busy ${NOW / 1000}` }, effort: 'high', title: 'Kept', interactive: true },
  })
  await tool($)
  await w.clock.advance(10_000)
  expect(w.sent.length).toBe(1)
  expect(last(w)).toMatchObject({ seq: 42, interactive: true })
  expect(last(w).record).toMatchObject({ session_name: 'Kept', effort: { level: 'high' } })
  expect(Object.keys(last(w).state.agents)).toEqual(['a9'])
  expect(w.saved.seq).toBe(42)
})

test('every hook returns what the hooks beneath returned', async ($, on) => {
  const w = wire(on)
  w.promptResult = { sessionTitle: 'X', additionalContext: ['c'] }
  expect(await prompt($)).toEqual({ sessionTitle: 'X', additionalContext: ['c'] })
  expect(await turn($, { answer: 'kept' })).toEqual({ text: 'kept' })
  expect(await start($)).toEqual({ cwd: '/work/proj' })
  expect(await perm($)).toEqual({})
})
