import { expect, mock, test } from 'claude-code/testing'
import {
  AGENT_BUSY_MAX_AGE_S,
  afterClear,
  agentKey,
  agentsToSend,
  applyWord,
  buildEnd,
  buildRecord,
  buildUpdate,
  candidateIds,
  classifyExit,
  classifyReject,
  emptySnap,
  fnv1a64,
  lastPart,
  nextTabs,
  marketplaceFailure,
  parseReply,
  parseTitle,
  parseTtyLine,
  parseWaitReply,
  selectScript,
  parseUpdateJson,
  parseWindows,
  slowAfter,
  socketPath,
  tabsKey,
  updateRejectCode,
  updateText,
  TABS_SCRIPT,
  TTY_SCRIPT,
  WAIT_RACE_MS,
  UPDATE_MARKETPLACE_ARGV,
  UPDATE_PLUGIN_ARGV,
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
  // The answer to each $.process.run (osascript); a throw stands for a rejected run. Default: exit 0, no window.
  run?: (e: any, runs: any[]) => unknown
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
    runs: [] as any[],
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
  on('process.run', (_: any, e: any) => {
    w.runs.push(e)
    return o.run ? o.run(e, w.runs) : { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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
  expect(buildEnd(3, 'sid')).toEqual({ v: 1, kind: 'end', seq: 3, mod: '1.3.0', session_id: 'sid' })
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
  expect(Object.keys(s.body)).toEqual(['v', 'kind', 'seq', 'mod', 'reads_tabs', 'can_update', 'interactive', 'record', 'state'])
  expect(s.body).toMatchObject({ v: 1, kind: 'update', seq: 1, mod: '1.3.0', interactive: true, state: { main: null, agents: {} } })
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

// ---------------------------------------------------------------- Terminal's tab bar (every title here is made up)

const US = '\x1f'
const t1 = '~/work/alpha — ✳ alpha:fix_parser — claude'
const t2 = '~/work/beta — ◐ beta:write_tests — claude'
const t3 = '/srv/gamma — ◑ gamma:release_notes — claude'
const asks = { value: { status: 200, ok: true, text: '{"tabs":true}' } }
const out = (...windows: string[][]) => windows.map(w => w.join(US) + '\n').join('')
const runOk = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const runFail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const TABS = { windows: [[{ n: 'alpha:fix_parser', f: 'alpha' }, { n: 'beta:write_tests', f: 'beta' }]] }

test('tabs pure: a title to n and f, for tabs of a tab group, with and without the window size', () => {
  expect(parseTitle(t1)).toEqual({ n: 'alpha:fix_parser', f: 'alpha' })
  expect(parseTitle(t2)).toEqual({ n: 'beta:write_tests', f: 'beta' })
  expect(parseTitle(t3)).toEqual({ n: 'gamma:release_notes', f: 'gamma' })
  expect(parseTitle('~/work/alpha — ✳ alpha:fix_parser — claude — 80×24')).toEqual({ n: 'alpha:fix_parser', f: 'alpha' })
})

test('tabs pure: a one-tab window starts with the folder name and ends with its size', () => {
  expect(parseTitle('alpha — ✳ alpha:fix_parser — 80×24')).toEqual({ n: 'alpha:fix_parser', f: 'alpha' })
  expect(parseTitle('alpha — ✳ alpha:fix_parser')).toEqual({ n: 'alpha:fix_parser', f: 'alpha' })
})

test('tabs pure: no mark, a mark outside the set, a mark with no space after it, and a mark in the first segment are not Claude Code tabs', () => {
  expect(parseTitle('~/work/alpha — zsh — 80×24')).toBe(null)
  expect(parseTitle('~/work/alpha — ✶ alpha:x — claude')).toBe(null)
  expect(parseTitle('~/work/alpha — ✳alpha:x — claude')).toBe(null)
  expect(parseTitle('✳ alpha:x — claude')).toBe(null)
  expect(parseTitle('')).toBe(null)
})

test('tabs pure: a session with no name shows "Claude Code" and is sent as that', () => {
  expect(parseTitle('~/work/alpha — ✳ Claude Code — claude')).toEqual({ n: 'Claude Code', f: 'alpha' })
})

test('tabs pure: a name is the segment after the mark, so one holding " — " stops at it; the name is trimmed', () => {
  expect(parseTitle('~/work/alpha — ✳ alpha:a — b — claude')).toEqual({ n: 'alpha:a', f: 'alpha' })
  expect(parseTitle('~/work/alpha — ✳   alpha:spaced   — claude')).toEqual({ n: 'alpha:spaced', f: 'alpha' })
})

test('tabs pure: f is the last part of a ~/ or / folder, the segment when it has no slash, else absent', () => {
  expect(parseTitle('~ — ✳ n1 — claude')).toEqual({ n: 'n1', f: '~' })
  expect(parseTitle('/ — ✳ n1 — claude')).toEqual({ n: 'n1' })
  expect(parseTitle('/srv/deep/dir/gamma — ✳ n1 — claude')).toEqual({ n: 'n1', f: 'gamma' })
  expect(parseTitle('alpha — ✳ n1 — claude')).toEqual({ n: 'n1', f: 'alpha' })
  expect(parseTitle('work/alpha — ✳ n1 — claude')).toEqual({ n: 'n1' })
})

test('tabs pure: n and f of 100 units are cut to 80', () => {
  const long = 'x'.repeat(100)
  const tab = parseTitle(`~/work/${long} — ✳ ${long} — claude`)!
  expect(tab.n).toBe('x'.repeat(80))
  expect(tab.f).toBe('x'.repeat(80))
  expect(parseTitle(`a — ✳ ${'é'.repeat(100)}`)!.n.length).toBe(80)
})

test('tabs pure: the cut never splits a surrogate pair, so the update stays valid JSON', () => {
  const split = parseTitle(`~/work/${'x'.repeat(79)}😀y — ✳ ${'x'.repeat(79)}😀y — claude`)!
  expect(split.n).toBe('x'.repeat(79))
  expect(split.f).toBe('x'.repeat(79))
  expect(JSON.stringify(split)).not.toContain('\\ud')
  const whole = parseTitle(`a — ✳ ${'x'.repeat(78)}😀y`)!
  expect(whole.n).toBe(`${'x'.repeat(78)}😀`)
})

test('tabs pure: the read to windows, one line a window, titles split by the unit separator', () => {
  expect(parseWindows(out([t1, t2], [t3]))).toEqual([
    [{ n: 'alpha:fix_parser', f: 'alpha' }, { n: 'beta:write_tests', f: 'beta' }],
    [{ n: 'gamma:release_notes', f: 'gamma' }],
  ])
  expect(parseWindows(out([t1, '~/work/alpha — zsh — 80×24', t2], ['~/x — zsh'], [t3]))).toEqual([
    [{ n: 'alpha:fix_parser', f: 'alpha' }, { n: 'beta:write_tests', f: 'beta' }],
    [{ n: 'gamma:release_notes', f: 'gamma' }],
  ])
  expect(parseWindows('')).toEqual([])
})

test('tabs pure: 17 windows give 16, and 49 tabs give 48', () => {
  const w17 = Array.from({ length: 17 }, (_, i) => [`~/work/w${i} — ✳ w${i}:n — claude`])
  const r17 = parseWindows(out(...w17))
  expect(r17.length).toBe(16)
  expect(r17[15]![0]!.n).toBe('w15:n')
  const row = (k: number) => Array.from({ length: 7 }, (_, i) => `~/work/a — ✳ a${k}_${i} — claude`)
  const r49 = parseWindows(out(row(0), row(1), row(2), row(3), row(4), row(5), row(6)))
  expect(r49.reduce((a, w) => a + w.length, 0)).toBe(48)
  expect(r49.length).toBe(7)
  expect(r49[6]!.length).toBe(6)
})

test('tabs pure: a refusal text of each kind, anything else an error', () => {
  expect(classifyExit('execution error: osascript is not allowed assistive access. (-25211)')).toEqual({ kind: 'refused', word: 'accessibility' })
  expect(classifyExit('execution error: Not authorized to send Apple events to System Events. (-1743)')).toEqual({ kind: 'refused', word: 'automation' })
  expect(classifyExit('syntax error (-2740)')).toEqual({ kind: 'error' })
  expect(classifyExit('')).toEqual({ kind: 'error' })
})

test('tabs pure: a rejected run is a timeout by its message or by taking the whole time, else an error', () => {
  expect(classifyReject('Error: process.run timed out after 1500 ms', 10)).toEqual({ kind: 'timeout' })
  expect(classifyReject('Error: killed', 1500)).toEqual({ kind: 'timeout' })
  expect(classifyReject('aborted: still running after 1500ms', 10)).toEqual({ kind: 'timeout' })
  expect(classifyReject('Error: spawn ENOENT', 3)).toEqual({ kind: 'error' })
})

test('tabs pure: the reading after each outcome', () => {
  const ok = (...w: string[][]) => ({ kind: 'ok' as const, stdout: out(...w) })
  // the first read, a window with no Claude Code tab: windows []
  expect(nextTabs(null, ok(['~/x — zsh']), 100)).toEqual({ read_at: 100, windows: [] })
  // no window at all before any reading: windows []
  expect(nextTabs(null, { kind: 'ok', stdout: '' }, 100)).toEqual({ read_at: 100, windows: [] })
  const good = nextTabs(null, ok([t1]), 101)!
  expect(good).toEqual({ read_at: 101, windows: [[{ n: 'alpha:fix_parser', f: 'alpha' }]] })
  // no window after a good reading: it stays as it was
  expect(nextTabs(good, { kind: 'ok', stdout: '' }, 150)).toEqual(good)
  // a timeout after a good reading: the same windows and read_at, stalled; a good read clears it
  const stalled = nextTabs(good, { kind: 'timeout' }, 160)!
  expect(stalled).toEqual({ ...good, stalled: 'timeout' })
  expect(nextTabs(stalled, { kind: 'ok', stdout: '' }, 170)).toEqual(good)
  expect(nextTabs(stalled, ok([t2]), 170)).toEqual({ read_at: 170, windows: [[{ n: 'beta:write_tests', f: 'beta' }]] })
  // before any reading: failed
  expect(nextTabs(null, { kind: 'timeout' }, 100)).toEqual({ read_at: 100, failed: 'timeout' })
  expect(nextTabs(null, { kind: 'error' }, 100)).toEqual({ read_at: 100, failed: 'error' })
  // an error after a good reading keeps it, with no stall
  expect(nextTabs(good, { kind: 'error' }, 160)).toEqual(good)
  // a refusal replaces the windows; a good read after it brings them back
  const refused = nextTabs(good, { kind: 'refused', word: 'accessibility' }, 160)!
  expect(refused).toEqual({ read_at: 160, refused: 'accessibility' })
  expect(nextTabs(refused, ok([t1]), 170)).toEqual({ read_at: 170, windows: [[{ n: 'alpha:fix_parser', f: 'alpha' }]] })
  expect(nextTabs(refused, { kind: 'ok', stdout: '' }, 170)).toEqual({ read_at: 170, windows: [] })
  // read_at alone is no change
  expect(tabsKey({ ...good, read_at: 999 })).toBe(tabsKey(good))
  expect(tabsKey(stalled)).not.toBe(tabsKey(good))
})

test('tabs pure: the cadence is slow after a refusal or a timeout until a read succeeds', () => {
  expect(slowAfter({ kind: 'refused', word: 'automation' }, false)).toBe(true)
  expect(slowAfter({ kind: 'timeout' }, false)).toBe(true)
  expect(slowAfter({ kind: 'ok', stdout: '' }, true)).toBe(false)
  expect(slowAfter({ kind: 'error' }, true)).toBe(true)
  expect(slowAfter({ kind: 'error' }, false)).toBe(false)
})

test('tabs pure: the reply is a JSON object whose tabs is true, in at most 64 bytes', () => {
  const tabs = (t: unknown) => parseReply(t).tabs
  expect(tabs('{"tabs":true}')).toBe(true)
  expect(tabs(' { "tabs" : true } ')).toBe(true)
  expect(tabs('{}')).toBe(false)
  expect(tabs('{"tabs":1}')).toBe(false)
  expect(tabs('{"tabs":"true"}')).toBe(false)
  expect(tabs('[{"tabs":true}]')).toBe(false)
  expect(tabs('true')).toBe(false)
  expect(tabs('not json')).toBe(false)
  expect(tabs('')).toBe(false)
  expect(tabs(undefined)).toBe(false)
  expect(tabs(`{"tabs":true,"x":"${'y'.repeat(60)}"}`)).toBe(false)
})

const TOKEN = '0123456789abcdef'
const TOKEN2 = 'fedcba9876543210'

test('update pure: the reply carries a token of 16 lowercase hex digits, with or without tabs', () => {
  expect(parseReply('{}')).toEqual({ tabs: false, wait: false, update: null })
  expect(parseReply('{"tabs":true}')).toEqual({ tabs: true, wait: false, update: null })
  expect(parseReply(`{"update":"${TOKEN}"}`)).toEqual({ tabs: false, wait: false, update: TOKEN })
  expect(parseReply(`{"tabs":true,"update":"${TOKEN}"}`)).toEqual({ tabs: true, wait: false, update: TOKEN })
  for (const bad of ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '0123456789abcdeg', '', ' 0123456789abcdef'])
    expect(parseReply(`{"update":"${bad}"}`).update).toBe(null)
  expect(parseReply('{"update":1234567890123456}').update).toBe(null)
  expect(parseReply('{"update":null}').update).toBe(null)
  expect(parseReply('["update"]').update).toBe(null)
  // 65 bytes: refused whole, the token with it
  const long = `{"update":"${TOKEN}","x":"${'y'.repeat(29)}"}`
  expect(long.length).toBe(65)
  expect(parseReply(long)).toEqual({ tabs: false, wait: false, update: null })
  expect(parseReply(long.replace('y', '')).update).toBe(TOKEN)
})

// What the CLI prints with --json (shortened), one line each
const J_UP_TO_DATE =
  '{"command":"update","outcome":"ok","plugin":"usage-feed@halfmarble","pluginId":"usage-feed@halfmarble","scope":"user","message":"usage-feed is already at the latest version (0.3.0).","updateOutcome":"up_to_date","oldVersion":"0.3.0","newVersion":"0.3.0"}'
const J_MARKETPLACE =
  '{"command":"marketplace-update","outcome":"ok","marketplace":"halfmarble","message":"Refreshing marketplace cache (timeout: 120s)\u2026\nSuccessfully updated marketplace: halfmarble"}'
const J_UPDATED =
  '{"command":"update","outcome":"ok","plugin":"usage-feed@halfmarble","pluginId":"usage-feed@halfmarble","scope":"user","message":"Plugin \\"usage-feed\\" updated from 0.3.0 to 0.4.0 for scope user. Restart to apply changes.","updateOutcome":"updated","oldVersion":"0.3.0","newVersion":"0.4.0"}'
const J_NOT_FOUND =
  '{"command":"update","outcome":"failed","plugin":"nope@halfmarble","pluginId":"nope@halfmarble","message":"Plugin \\"nope\\" not found","failureCode":"not_found"}'
const FAIL_LINE = '\u2718 Failed to update plugin "nope@halfmarble": Plugin "nope" not found'

test('update pure: the update command\'s --json line gives the outcome and the bounded fields', () => {
  expect(parseUpdateJson(J_UPDATED + '\n', 0)).toEqual({ outcome: 'updated', old_version: '0.3.0', new_version: '0.4.0' })
  expect(parseUpdateJson(J_UP_TO_DATE + '\n', 0)).toEqual({ outcome: 'up_to_date', old_version: '0.3.0', new_version: '0.3.0' })
  // a plain line after the JSON, as the CLI prints on a failure
  expect(parseUpdateJson(J_NOT_FOUND + '\n' + FAIL_LINE + '\n', 1)).toEqual({ outcome: 'failed', failure_code: 'not_found' })
  // the last JSON line of the right command wins
  expect(parseUpdateJson(J_MARKETPLACE + '\n' + J_UPDATED + '\n', 0).outcome).toBe('updated')
  expect(parseUpdateJson(J_UPDATED + '\n' + J_MARKETPLACE + '\n', 0).outcome).toBe('updated')
  // bad versions and codes are left out, whatever the CLI said
  const odd = JSON.stringify({ command: 'update', outcome: 'ok', updateOutcome: 'updated', oldVersion: '1.0', newVersion: '1.2.3-beta' })
  expect(parseUpdateJson(odd, 0)).toEqual({ outcome: 'updated' })
  const longVer = JSON.stringify({ command: 'update', outcome: 'ok', updateOutcome: 'updated', newVersion: `${'1'.repeat(40)}.0.0` })
  expect(parseUpdateJson(longVer, 0)).toEqual({ outcome: 'updated' })
  const badCode = (c: unknown) => JSON.stringify({ command: 'update', outcome: 'failed', failureCode: c })
  expect(parseUpdateJson(badCode('Not Found/../x'), 1)).toEqual({ outcome: 'failed', failure_code: 'failed' })
  expect(parseUpdateJson(badCode('a'.repeat(33)), 1)).toEqual({ outcome: 'failed', failure_code: 'failed' })
  expect(parseUpdateJson(badCode(7), 1)).toEqual({ outcome: 'failed', failure_code: 'failed' })
  const unread = { outcome: 'failed', failure_code: 'unreadable' }
  expect(parseUpdateJson('', 0)).toEqual(unread)
  expect(parseUpdateJson('garbage\n{not json\n', 0)).toEqual(unread)
  expect(parseUpdateJson(J_MARKETPLACE, 0)).toEqual(unread)
  expect(parseUpdateJson('[1]', 0)).toEqual(unread)
  expect(parseUpdateJson(J_UPDATED, 1)).toEqual(unread)
  expect(parseUpdateJson(JSON.stringify({ command: 'update', outcome: 'ok', updateOutcome: 'other' }), 0)).toEqual(unread)
})

test('update pure: the marketplace command failing gives marketplace_ and its code', () => {
  expect(marketplaceFailure(J_MARKETPLACE + '\n', 0)).toBe(null)
  const nf = JSON.stringify({ command: 'marketplace-update', outcome: 'failed', failureCode: 'not_found', message: "Marketplace 'halfmarble' not found" })
  expect(marketplaceFailure(nf + '\n', 1)).toBe('marketplace_not_found')
  expect(marketplaceFailure(JSON.stringify({ command: 'marketplace-update', outcome: 'failed' }), 1)).toBe('marketplace_failed')
  // exit status other than 0 with nothing readable
  expect(marketplaceFailure('', 1)).toBe('marketplace_failed')
  expect(marketplaceFailure('plain text', 2)).toBe('marketplace_failed')
  // exit 0 with nothing readable goes on to the plugin command
  expect(marketplaceFailure('', 0)).toBe(null)
  // the prefix and the code together stay within 32 bytes; a code over 32 is no code
  const failed = (c: string) => JSON.stringify({ command: 'marketplace-update', outcome: 'failed', failureCode: c })
  expect(marketplaceFailure(failed('x'.repeat(30)), 1)).toBe(`marketplace_${'x'.repeat(20)}`)
  expect(marketplaceFailure(failed('x'.repeat(33)), 1)).toBe('marketplace_failed')
  expect(UPDATE_MARKETPLACE_ARGV).toEqual(['claude', 'plugin', 'marketplace', 'update', 'halfmarble', '--json'])
  expect(UPDATE_PLUGIN_ARGV).toEqual(['claude', 'plugin', 'update', 'usage-feed@halfmarble', '--json'])
})

test('update pure: a rejected run is a timeout or not started', () => {
  expect(updateRejectCode('Error: process.run timed out after 120000 ms', 10)).toBe('timeout')
  expect(updateRejectCode('spawn ENOENT', 120_000)).toBe('timeout')
  expect(updateRejectCode('spawn ENOENT', 5)).toBe('not_started')
})

test('update pure: every update says can_update; update_result is carried when there is one, and survives dropped tabs', () => {
  const snap = { ...emptySnap(), seq: 1 }
  const rec = buildRecord({ nowMs: NOW, sessionId: 's', root: '/r/x', model: 'm', version: 'v', usage: { startedAt: NOW, context: { window: 1 }, rateLimits: [] }, title: null, effort: null })
  expect(buildUpdate(snap, true, rec, 1)).toMatchObject({ can_update: true })
  expect(buildUpdate(snap, true, rec, 1)).not.toHaveProperty('update_result')
  const r = { token: TOKEN, outcome: 'updated' as const, old_version: '1.2.0', new_version: '1.2.1' }
  const u = buildUpdate(snap, true, rec, 1, true, null, r)
  expect(u).toMatchObject({ can_update: true, reads_tabs: true, update_result: r })
  const big = buildUpdate(snap, true, rec, 1, true, { read_at: 5, windows: Array.from({ length: 16 }, () => Array.from({ length: 3 }, () => ({ n: '字'.repeat(80), f: '字'.repeat(80) }))) }, r)
  const t = updateText(big)
  expect(t.droppedTabs).toBe(true)
  expect(JSON.parse(t.text)).toMatchObject({ can_update: true, update_result: r })
})

test('tabs pure: reads_tabs and tabs in the update; tabs past 16,000 bytes are dropped, 3-byte units counted as bytes', () => {
  const snap = { ...emptySnap(), seq: 1 }
  const rec = buildRecord({ nowMs: NOW, sessionId: 's', root: '/r/x', model: 'm', version: 'v', usage: { startedAt: NOW, context: { window: 1 }, rateLimits: [] }, title: null, effort: null })
  expect(buildUpdate(snap, true, rec, 1)).not.toHaveProperty('reads_tabs')
  expect(buildUpdate(snap, true, rec, 1)).not.toHaveProperty('tabs')
  const small = buildUpdate(snap, true, rec, 1, true, { read_at: 5, ...TABS })
  expect(small).toMatchObject({ mod: '1.3.0', reads_tabs: true, tabs: { read_at: 5, ...TABS } })
  expect(updateText(small)).toEqual({ text: JSON.stringify(small), droppedTabs: false })
  const big = buildUpdate(snap, true, rec, 1, true, {
    read_at: 5,
    windows: Array.from({ length: 16 }, () => Array.from({ length: 3 }, () => ({ n: '字'.repeat(80), f: '字'.repeat(80) }))),
  })
  const r = updateText(big)
  expect(r.droppedTabs).toBe(true)
  expect(JSON.parse(r.text)).not.toHaveProperty('tabs')
  expect(JSON.parse(r.text)).toMatchObject({ reads_tabs: true, kind: 'update' })
})

test('tabs pure: TABS_SCRIPT joins titles by the unit separator and falls back to the window name', () => {
  expect(TABS_SCRIPT).toContain('character id 31')
  expect(TABS_SCRIPT).toContain('title of every radio button of tab group 1 of w')
  expect(TABS_SCRIPT).toContain('name of w')
  expect(TABS_SCRIPT.endsWith('return out\n')).toBe(true)
})

test('tabs: every update says reads_tabs; a reply of {} starts no read and adds no tabs', async ($, on) => {
  const w = wire(on)
  await start($)
  await w.clock.settle()
  await w.clock.advance(30_000)
  expect(w.sent.length).toBeGreaterThan(1)
  for (const s of w.sent) {
    expect(s.body.reads_tabs).toBe(true)
    expect(s.body).not.toHaveProperty('tabs')
  }
  expect(w.runs.length).toBe(0)
})

test('tabs: a 200 with {"tabs":true} starts the read every 2 s by osascript, and the next update carries the windows', async ($, on) => {
  const w = wire(on, { fetch: () => asks, run: () => runOk(out([t1, t2])) })
  await start($)
  await w.clock.settle()
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]!.body).not.toHaveProperty('tabs')
  expect(w.runs.length).toBe(0)
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(1)
  expect(w.runs[0].argv).toEqual(['/usr/bin/osascript', '-e', TABS_SCRIPT])
  expect(w.runs[0].init.timeoutMs).toBe(1500)
  // the first reading is a change: sent at once, without waiting for the heartbeat
  expect(w.sent.length).toBe(2)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, ...TABS })
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(2)
  // the same windows are no change; the heartbeat carries them
  expect(w.sent.length).toBe(2)
  await w.clock.advance(6000)
  expect(w.runs.length).toBe(5)
  expect(w.sent.length).toBe(3)
  expect(last(w).tabs.windows).toEqual(TABS.windows)
  expect(last(w).tabs.read_at).toBeGreaterThanOrEqual(NOW / 1000 + 8)
})

test('tabs: a change of windows is sent at once', async ($, on) => {
  let reading = out([t1])
  const w = wire(on, { fetch: () => asks, run: () => runOk(reading) })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(w.sent.length).toBe(2)
  expect(last(w).tabs.windows).toEqual([[{ n: 'alpha:fix_parser', f: 'alpha' }]])
  reading = out([t2, t1])
  await w.clock.advance(2000)
  expect(w.sent.length).toBe(3)
  expect(last(w).tabs.windows).toEqual([[{ n: 'beta:write_tests', f: 'beta' }, { n: 'alpha:fix_parser', f: 'alpha' }]])
})

for (const [what, reply] of [
  ['a body that is not JSON', { value: { status: 200, ok: true, text: 'tabs' } }],
  ['tabs not true', { value: { status: 200, ok: true, text: '{"tabs":"yes"}' } }],
  ['a status other than 200', { value: { status: 204, ok: true, text: '{"tabs":true}' } }],
  ['a refusal', { value: { status: 500, ok: false, text: '{"tabs":true}' } }],
] as const) {
  test(`tabs: a reply with ${what} asks nothing`, async ($, on) => {
    const w = wire(on, { fetch: () => reply, run: () => runOk(out([t1])) })
    await start($)
    await w.clock.settle()
    await w.clock.advance(6000)
    expect(w.runs.length).toBe(0)
    expect(last(w)).not.toHaveProperty('tabs')
  })
}

test('tabs: two candidates, one asking: the read starts', { options: { extraBundleIds: 'com.a.b' } }, async ($, on) => {
  const w = wire(on, { fetch: e => (String(e.init.socketPath).includes('com.a.b') ? asks : ok), run: () => runOk(out([t1])) })
  await start($)
  await w.clock.settle()
  expect(w.sent.length).toBe(2)
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(1)
  expect(w.sent[w.sent.length - 1]!.body.tabs.windows).toEqual([[{ n: 'alpha:fix_parser', f: 'alpha' }]])
})

test('tabs: when a send gets no ask the read stops and the reading is forgotten', async ($, on) => {
  let asking = true
  const w = wire(on, { fetch: () => (asking ? asks : ok), run: () => runOk(out([t1])) })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(1)
  expect(last(w)).toHaveProperty('tabs')
  asking = false
  await w.clock.advance(8000)
  // the heartbeat at 10 s was the send that got {}
  const n = w.runs.length
  expect(last(w)).toHaveProperty('tabs')
  await w.clock.advance(10_000)
  expect(w.runs.length).toBe(n)
  expect(last(w)).not.toHaveProperty('tabs')
  expect(last(w).reads_tabs).toBe(true)
})

test('tabs: an app gone (a send that fails) turns the ask off', async ($, on) => {
  let gone = false
  const w = wire(on, {
    fetch: () => {
      if (gone) throw new Error('ECONNREFUSED')
      return asks
    },
    run: () => runOk(out([t1])),
  })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  const n = w.runs.length
  gone = true
  await w.clock.advance(10_000)
  const m = w.runs.length
  await w.clock.advance(10_000)
  expect(w.runs.length).toBe(m)
  expect(m).toBeGreaterThanOrEqual(n)
})

test('tabs: one read in flight at most, a tick during a read is skipped', async ($, on) => {
  const h = holder()
  const w = wire(on, { fetch: () => asks, run: () => h.hook() })
  await start($)
  await w.clock.settle()
  await w.clock.advance(10_000)
  expect(w.runs.length).toBe(1)
  h.release(runOk(out([t1])))
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(2)
})

test('tabs: Accessibility refused: refused "accessibility", then one read every 30 s until a read succeeds', async ($, on) => {
  let fail = true
  const w = wire(on, {
    fetch: () => asks,
    run: () => (fail ? runFail('execution error: osascript is not allowed assistive access. (-25211)') : runOk(out([t1]))),
  })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(1)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, refused: 'accessibility' })
  await w.clock.advance(28_000)
  expect(w.runs.length).toBe(1)
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(2)
  await w.clock.advance(28_000)
  expect(w.runs.length).toBe(2)
  fail = false
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(3)
  expect(last(w).tabs.windows).toEqual([[{ n: 'alpha:fix_parser', f: 'alpha' }]])
  expect(last(w).tabs).not.toHaveProperty('refused')
  // the cadence is back to 2 s
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(4)
})

test('tabs: Apple Events refused: refused "automation"', async ($, on) => {
  const w = wire(on, { fetch: () => asks, run: () => runFail('execution error: Not authorized to send Apple events to System Events. (-1743)') })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, refused: 'automation' })
})

test('tabs: a timeout before any reading is failed "timeout", then the slow cadence', async ($, on) => {
  const w = wire(on, {
    fetch: () => asks,
    run: () => ({ deny: 'process.run timed out after 1500 ms' }),
  })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, failed: 'timeout' })
  await w.clock.advance(28_000)
  expect(w.runs.length).toBe(1)
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(2)
})

test('tabs: another failure is failed "error" and keeps the 2 s cadence', async ($, on) => {
  const w = wire(on, {
    fetch: () => asks,
    run: () => ({ deny: 'spawn ENOENT' }),
  })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, failed: 'error' })
  await w.clock.advance(4000)
  expect(w.runs.length).toBe(3)
})

test('tabs: a timeout after a good reading sends stalled beside the kept windows; the next good read removes it', async ($, on) => {
  let mode: 'ok' | 'timeout' = 'ok'
  const w = wire(on, {
    fetch: () => asks,
    run: () => {
      if (mode === 'timeout') return { deny: 'timed out' }
      return runOk(out([t1, t2]))
    },
  })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, ...TABS })
  mode = 'timeout'
  await w.clock.advance(2000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, ...TABS, stalled: 'timeout' })
  mode = 'ok'
  // slow cadence after the timeout: the next read is 30 s after the timed-out one
  await w.clock.advance(28_000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 2, ...TABS, stalled: 'timeout' })
  await w.clock.advance(2000)
  expect(last(w).tabs).toEqual({ read_at: NOW / 1000 + 34, ...TABS })
})

test('tabs: a read with no window keeps the last reading', async ($, on) => {
  let reading = out([t1, t2])
  const w = wire(on, { fetch: () => asks, run: () => runOk(reading) })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  const n = w.sent.length
  reading = ''
  await w.clock.advance(2000)
  expect(w.sent.length).toBe(n)
  await w.clock.advance(6000)
  expect(last(w).tabs.windows).toEqual(TABS.windows)
})

test('tabs: a body that would pass 16,000 bytes is sent without tabs', async ($, on) => {
  const name = '字'.repeat(80)
  const titles = Array.from({ length: 16 }, (_, i) => [0, 1, 2].map(j => `~/work/${name} — ✳ ${name} — claude`))
  const w = wire(on, { fetch: () => asks, run: () => runOk(out(...titles)) })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(1)
  expect(w.sent.length).toBe(2)
  expect(last(w)).not.toHaveProperty('tabs')
  expect(last(w).reads_tabs).toBe(true)
})

test('tabs: session.end stops the reader', async ($, on) => {
  const w = wire(on, { fetch: () => asks, run: () => runOk(out([t1])) })
  await start($)
  await w.clock.settle()
  await w.clock.advance(2000)
  expect(w.runs.length).toBe(1)
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' })
  await w.clock.settle()
  await w.clock.advance(10_000)
  expect(w.runs.length).toBe(1)
})

test('tabs: nothing of a title is written to $.state', async ($, on) => {
  const w = wire(on, { fetch: () => asks, run: () => runOk(out([t1])) })
  await start($)
  await w.clock.settle()
  await w.clock.advance(4000)
  expect(JSON.stringify(w.saved)).not.toContain('fix_parser')
})

// ---------------------------------------------------------------- the update upMonitor asks for

const tokenReply = (t: string, tabs = false) => ({ value: { status: 200, ok: true, text: JSON.stringify(tabs ? { tabs: true, update: t } : { update: t }) } })
const updateRuns = (w: ReturnType<typeof wire>) => w.runs.filter(r => r.argv[0] === 'claude')
const cliOk = (stdout: string) => runOk(stdout + '\n')

// The two commands answered as the CLI does, each by its argv
const cli = (e: any) => (e.argv[2] === 'marketplace' ? cliOk(J_MARKETPLACE) : cliOk(J_UPDATED))

test('update: a 200 with a token runs the marketplace update, then the plugin update, once; both with --json and 120 s', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: cli })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).map(r => r.argv)).toEqual([UPDATE_MARKETPLACE_ARGV, UPDATE_PLUGIN_ARGV])
  expect(updateRuns(w).map(r => r.init.timeoutMs)).toEqual([120000, 120000])
  // the result is a change: sent at once, with the token the app gave
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'updated', old_version: '0.3.0', new_version: '0.4.0' })
  expect(last(w).can_update).toBe(true)
  // the same token again, on later replies: nothing runs, and the result stays in each message
  await w.clock.advance(30_000)
  expect(updateRuns(w).length).toBe(2)
  expect(last(w).update_result.token).toBe(TOKEN)
  expect(w.sent.length).toBeGreaterThan(2)
})

test('update: a token beside tabs starts both the update and the read', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN, true), run: e => (e.argv[0] === 'claude' ? cli(e) : runOk(out([t1]))) })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(2)
  await w.clock.advance(2000)
  expect(w.runs.some(r => r.argv[0] === '/usr/bin/osascript')).toBe(true)
})

test('update: a reply without a token, or with a bad one, runs nothing and adds no result', async ($, on) => {
  let text = '{}'
  const w = wire(on, { fetch: () => ({ value: { status: 200, ok: true, text } }), run: cli })
  await start($)
  await w.clock.settle()
  text = '{"update":"ABCDEF0123456789"}'
  await w.clock.advance(10_000)
  expect(w.runs.length).toBe(0)
  for (const s of w.sent) expect(s.body).not.toHaveProperty('update_result')
})

test('update: a token in a reply that is not a 200 runs nothing', async ($, on) => {
  const w = wire(on, { fetch: () => ({ value: { status: 500, ok: false, text: `{"update":"${TOKEN}"}` } }), run: cli })
  await start($)
  await w.clock.settle()
  expect(w.runs.length).toBe(0)
})

test('update: a new token while the first is running runs nothing; after it ends, the new token runs', async ($, on) => {
  let token = TOKEN
  const h = holder()
  const w = wire(on, { fetch: () => tokenReply(token), run: e => (e.argv[2] === 'marketplace' ? h.hook() : cliOk(J_UPDATED)) })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(1)
  token = TOKEN2
  await w.clock.advance(10_000)
  expect(updateRuns(w).length).toBe(1)
  h.release(cliOk(J_MARKETPLACE))
  await w.clock.settle()
  // the first token's result went out, and the reply to it carried the second token, which now runs
  expect(w.sent.some(s => s.body.update_result?.token === TOKEN)).toBe(true)
  expect(updateRuns(w).length).toBe(3)
  h.release(cliOk(J_MARKETPLACE))
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(4)
  expect(last(w).update_result.token).toBe(TOKEN2)
})

test('update: the marketplace command failing skips the plugin command', async ($, on) => {
  const nf = JSON.stringify({ command: 'marketplace-update', outcome: 'failed', failureCode: 'not_found' })
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: () => ({ value: { exitCode: 1, stdout: nf + '\n', stderr: 'x', isStdoutTruncated: false, isStderrTruncated: false } }) })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).map(r => r.argv)).toEqual([UPDATE_MARKETPLACE_ARGV])
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'failed', failure_code: 'marketplace_not_found' })
})

test('update: the plugin command failing is failed with its code', async ($, on) => {
  const w = wire(on, {
    fetch: () => tokenReply(TOKEN),
    run: e => (e.argv[2] === 'marketplace' ? cliOk(J_MARKETPLACE) : runFail(FAIL_LINE)),
  })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(2)
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'failed', failure_code: 'unreadable' })
})

test('update: an up-to-date answer is sent as up_to_date', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: e => (e.argv[2] === 'marketplace' ? cliOk(J_MARKETPLACE) : cliOk(J_UP_TO_DATE)) })
  await start($)
  await w.clock.settle()
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'up_to_date', old_version: '0.3.0', new_version: '0.3.0' })
})

test('update: a rejected run is timeout, or not_started when it never began', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: () => ({ deny: 'process.run timed out after 120000 ms' }) })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(1)
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'failed', failure_code: 'timeout' })
})

test('update: a command that cannot start is not_started', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: () => ({ deny: 'spawn claude ENOENT' }) })
  await start($)
  await w.clock.settle()
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'failed', failure_code: 'not_started' })
})

test('update: the plugin command rejected after the marketplace worked is timeout', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: e => (e.argv[2] === 'marketplace' ? cliOk(J_MARKETPLACE) : { deny: 'timed out' }) })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(2)
  expect(last(w).update_result).toEqual({ token: TOKEN, outcome: 'failed', failure_code: 'timeout' })
})

test('update: a message is not delayed while the runs hang, and the late result is sent after', async ($, on) => {
  const h = holder()
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: () => h.hook() })
  await start($)
  await w.clock.settle()
  expect(updateRuns(w).length).toBe(1)
  // the session's events and the heartbeat still send, without a result
  const n = w.sent.length
  await prompt($)
  await w.clock.settle()
  expect(w.sent.length).toBe(n + 1)
  expect(word(last(w).state.main)).toBe('busy')
  await w.clock.advance(10_000)
  expect(w.sent.length).toBeGreaterThan(n + 1)
  for (const s of w.sent) expect(s.body).not.toHaveProperty('update_result')
  expect(updateRuns(w).length).toBe(1)
  h.release(cliOk(J_MARKETPLACE))
  await w.clock.settle()
  h.release(cliOk(J_UPDATED))
  await w.clock.settle()
  expect(last(w).update_result.outcome).toBe('updated')
})

test('update: nothing of the commands\' output is sent beyond the bounded fields', async ($, on) => {
  const w = wire(on, { fetch: () => tokenReply(TOKEN), run: cli })
  await start($)
  await w.clock.settle()
  expect(Object.keys(last(w).update_result).sort()).toEqual(['new_version', 'old_version', 'outcome', 'token'])
  expect(JSON.stringify(w.sent)).not.toContain('Restart to apply')
  expect(JSON.stringify(w.saved)).not.toContain('update_result')
})

test('update: after session.end no update starts', async ($, on) => {
  let sessionOver = false
  const w = wire(on, { fetch: () => (sessionOver ? tokenReply(TOKEN) : ok), run: cli })
  await start($)
  await w.clock.settle()
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' })
  sessionOver = true
  await w.clock.advance(20_000)
  expect(updateRuns(w).length).toBe(0)
})

test('wait pure: the reply says wait true only as the boolean, and the longest reply fits 64 bytes', () => {
  expect(parseReply('{"wait":true}')).toEqual({ tabs: false, wait: true, update: null })
  expect(parseReply('{"wait":false}').wait).toBe(false)
  expect(parseReply('{"tabs":true}').wait).toBe(false)
  expect(parseReply('{"wait":1}').wait).toBe(false)
  expect(parseReply('{"wait":"true"}').wait).toBe(false)
  const longest = `{"tabs":true,"wait":true,"update":"${TOKEN}"}`
  expect(longest.length).toBe(53)
  expect(parseReply(longest)).toEqual({ tabs: true, wait: true, update: TOKEN })
})

test('wait pure: the answer to a GET is select, none or bad', () => {
  expect(parseWaitReply('{"select":true}')).toBe('select')
  expect(parseWaitReply(' { "select" : true } ')).toBe('select')
  expect(parseWaitReply('{}')).toBe('none')
  expect(parseWaitReply('{"select":false}')).toBe('bad')
  expect(parseWaitReply('{"select":1}')).toBe('bad')
  expect(parseWaitReply('{"select":true,"x":1}')).toBe('bad')
  expect(parseWaitReply('{"x":1}')).toBe('bad')
  expect(parseWaitReply('[]')).toBe('bad')
  expect(parseWaitReply('not json')).toBe('bad')
  expect(parseWaitReply('')).toBe('bad')
  expect(parseWaitReply(undefined)).toBe('bad')
  expect(parseWaitReply(`{"select":true,"x":"${'y'.repeat(60)}"}`)).toBe('bad')
})

test('wait pure: the tty comes only from Apple_Terminal and ttys with 1 to 4 digits', () => {
  expect(parseTtyLine('Apple_Terminal ttys012\n')).toBe('/dev/ttys012')
  expect(parseTtyLine('Apple_Terminal ttys7')).toBe('/dev/ttys7')
  expect(parseTtyLine('Apple_Terminal ttys0123\n')).toBe('/dev/ttys0123')
  expect(parseTtyLine('Apple_Terminal ??\n')).toBe(null)
  expect(parseTtyLine('Apple_Terminal \n')).toBe(null)
  expect(parseTtyLine('')).toBe(null)
  expect(parseTtyLine('Apple_Terminal ttys1; rm\n')).toBe(null)
  expect(parseTtyLine('Apple_Terminal ttys12345\n')).toBe(null)
  expect(parseTtyLine('Apple_Terminal ttys\n')).toBe(null)
  expect(parseTtyLine('Apple_Terminal ttys1" & do shell script "x\n')).toBe(null)
  expect(parseTtyLine('iTerm.app ttys012\n')).toBe(null)
  expect(parseTtyLine(' ttys012\n')).toBe(null)
  expect(parseTtyLine('Apple_Terminal2 ttys012\n')).toBe(null)
  expect(parseTtyLine('Apple_Terminal ttys012\nx')).toBe(null)
  expect(parseTtyLine(undefined)).toBe(null)
})

test('wait pure: the select script holds the tty once and no other input', () => {
  const argv = selectScript('/dev/ttys012')
  expect(argv.filter((_, i) => i % 2 === 0).every(x => x === '-e')).toBe(true)
  const lines = argv.filter((_, i) => i % 2 === 1)
  expect(lines.filter(l => l.includes('/dev/ttys012')).length).toBe(1)
  expect(lines).toEqual([
    'tell application "Terminal"',
    'repeat with w in windows',
    'if tty of tab 1 of w is "/dev/ttys012" then',
    'set index of w to 1',
    'activate',
    'return "ok"',
    'end if',
    'end repeat',
    'return "none"',
    'end tell',
  ])
  expect(selectScript('/dev/ttys7').join('\n')).not.toContain('ttys012')
})

test('wait pure: the constants', () => {
  expect(WAIT_RACE_MS).toBe(28000)
  expect(TTY_SCRIPT[0]).toBe('/bin/sh')
  expect(TTY_SCRIPT[2]).toContain('ps -o tty= -p $PPID')
})
