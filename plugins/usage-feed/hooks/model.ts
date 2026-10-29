// The pure part of usage-feed: events to a session's state, and state plus usage to the message the sender posts.
// Nothing here calls the engine, so claude plugin test checks it by plain calls.
import type { UsageFeedSnap } from '../types'

export const RELEASE_BUNDLE_ID = 'com.halfmarblellc.upmonitor'
// Keep equal to "version" in .claude-plugin/plugin.json
export const MOD_VERSION = '1.4.0'
export const WIRE_VERSION = 1
export const HEARTBEAT_MS = 10000
export const SEND_TIMEOUT_MS = 2000
// A busy subagent whose state is older than this is no longer sent
export const AGENT_BUSY_MAX_AGE_S = 7200
export const AGENTS_MAX = 64
export const EXTRA_IDS_MAX = 4
// Reading Terminal's tab bar, only while upMonitor asks
export const TABS_MS = 2000
export const TABS_SLOW_MS = 30000
export const TABS_READ_TIMEOUT_MS = 1500
export const TABS_WINDOWS_MAX = 16
export const TABS_TABS_MAX = 48
// n and f are cut to this many UTF-16 code units (JavaScript's string length)
export const TAB_TEXT_MAX = 80
export const ASK_TEXT_MAX_BYTES = 64
// Waiting for a click on this session's row in upMonitor's panel: the app holds a GET up to 25 s, so the fetch is raced
// against a little more; selecting the session's Terminal tab, and the one read of its tty
export const WAIT_RACE_MS = 28000
export const SELECT_TIMEOUT_MS = 3000
export const TTY_READ_TIMEOUT_MS = 1500
// The child's parent is the claude process: its TERM_PROGRAM and the tty it runs on, as "Apple_Terminal ttys007"
export const TTY_SCRIPT = ['/bin/sh', '-c', 'printf "%s %s\\n" "$TERM_PROGRAM" "$(ps -o tty= -p $PPID)"']
// The marketplace first (a plugin update alone does not fetch), then the plugin; each may take this long
export const UPDATE_TIMEOUT_MS = 120000
export const UPDATE_MARKETPLACE_ARGV = ['claude', 'plugin', 'marketplace', 'update', 'halfmarble', '--json']
export const UPDATE_PLUGIN_ARGV = ['claude', 'plugin', 'update', 'usage-feed@halfmarble', '--json']
export const VERSION_MAX_BYTES = 32
export const FAILURE_CODE_MAX_BYTES = 32
// A body with tabs over this is sent without them
export const BODY_TABS_MAX_BYTES = 16000
// Claude Code's status marks in a tab title, each followed by a space
export const TAB_MARKS = ['\u2733', '\u25d0', '\u25d1']
// Each window's tab titles joined by the unit separator, one window to a line; a window with no tab group (one tab)
// gives its own title
export const TABS_SCRIPT = [
  "set AppleScript's text item delimiters to (character id 31)",
  'set out to ""',
  'tell application "System Events" to tell process "Terminal"',
  '  repeat with w in windows',
  '    try',
  '      set ts to title of every radio button of tab group 1 of w',
  '      set out to out & (ts as text) & linefeed',
  '    on error',
  '      try',
  '        set out to out & (name of w) & linefeed',
  '      end try',
  '    end try',
  '  end repeat',
  'end tell',
  'return out',
  '',
].join('\n')

export type Word = 'busy' | 'waiting' | 'idle'

export const emptySnap = (): UsageFeedSnap => ({ seq: 0, main: null, agents: {}, effort: null, title: null, interactive: null, handoff: false })

// "<word> <epoch seconds>"
export const wordOf = (line: string | null | undefined): string | undefined => line?.split(' ')[0]
const epochOf = (line: string): number => {
  const n = Number(line.split(' ')[1])
  return Number.isFinite(n) ? n : 0
}

// The UTF-8 bytes of a string, without TextEncoder
const utf8 = (s: string): number[] => {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return out
}

// FNV-1a, 64 bits, as 16 hex digits
export const fnv1a64 = (s: string): string => {
  let h = 0xcbf29ce484222325n
  for (const b of utf8(s)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
  return h.toString(16).padStart(16, '0')
}

// An agent id the app takes as it is stays; any other (a teammate's "name@team") is sent as "h" and its hash
export const agentKey = (id: string): string => (/^[A-Za-z0-9]{1,64}$/.test(id) ? id : `h${fnv1a64(id)}`)

// The snapshot after one state change, or null when it changes nothing. word null removes an agent; for the main
// thread a null word changes nothing.
export const applyWord = (snap: UsageFeedSnap, agentId: string | undefined, word: Word | null, nowS: number): UsageFeedSnap | null => {
  const line = word === null ? null : `${word} ${nowS}`
  if (agentId === undefined || agentId === '') {
    if (line === null) return null
    // A new turn (busy) or a question (waiting) ends the handoff; idle leaves it as the Stop step set it
    const handoff = word === 'idle' ? (snap.handoff ?? false) : false
    const sameHandoff = (snap.handoff ?? false) === handoff
    if (wordOf(snap.main) === word) return sameHandoff ? null : { ...snap, handoff }
    return { ...snap, main: line, handoff }
  }
  const key = agentKey(agentId)
  const agents = { ...snap.agents }
  if (line === null) {
    if (!(key in agents)) return null
    delete agents[key]
  } else {
    if (wordOf(agents[key]) === word) return null
    agents[key] = line
  }
  return { ...snap, agents }
}

// The snapshot with the handoff flag set, or null when it already holds that value
export const applyHandoff = (snap: UsageFeedSnap, handoff: boolean): UsageFeedSnap | null => ((snap.handoff ?? false) === handoff ? null : { ...snap, handoff })

// A line that ends "with" and says start, session or fresh ("Start the next session in `~/work` with:")
const WITH_START = (line: string): boolean => /\bwith$/i.test(line) && /\b(?:start|session|fresh)/i.test(line)
// A line that names a new, fresh or next session, a start in a folder, or the prompt to start one ("Prompt for the next
// session:", "To start, open a new session in `~/work`:", "Starting prompt:")
const NAMES_SESSION =
  /\b(?:new|fresh|next)\b[^\n]*\bsession\b|\bsession\b[^\n]*\b(?:new|fresh|next)\b|\bstart\b[^\n]*\b(?:in|from)\s+[`~/]|\b(?:starting|suggested)\s+prompt\b|\bprompt\s+(?:for|to\s+start)\b|\bstart(?:ing)?\s+fresh\b/i
// Steps of a test in other tabs, and a command typed here, are not a handoff
const NOT_HANDOFF = /\bterminal tabs?\b|\bwithout\b[^\n]*\bsession\b/i

// A reply that hands off to a new session: a line ending in ":" right before a plain or text code block, the prompt to
// start it with, that is WITH_START or NAMES_SESSION and not NOT_HANDOFF. A block in another language ("Run it with:"
// before a bash block), or a line that names no new session ("It failed with:"), is not one.
export const isHandoff = (text: unknown): boolean => {
  if (typeof text !== 'string') return false
  const re = /^([^\n]*):[ \t]*\n(?:[ \t]*\n)*[ \t]*```(?:text|txt|plaintext)?[ \t]*\n/gim
  for (const m of text.matchAll(re)) {
    const line = m[1] ?? ''
    if (WITH_START(line) || (NAMES_SESSION.test(line) && !NOT_HANDOFF.test(line))) return true
  }
  return false
}

// The agents a message carries: no busy one older than two hours, and the 64 with the latest epochs
export const agentsToSend = (agents: Record<string, string>, nowS: number): Record<string, string> => {
  const live = Object.entries(agents).filter(([, line]) => !(wordOf(line) === 'busy' && nowS - epochOf(line) > AGENT_BUSY_MAX_AGE_S))
  live.sort((a, b) => epochOf(b[1]) - epochOf(a[1]) || (a[0] < b[0] ? -1 : 1))
  return Object.fromEntries(live.slice(0, AGENTS_MAX))
}

// The bundle IDs to feed: the release ID, then the valid ones of the option (comma-separated, four at most)
export const candidateIds = (extra: unknown): string[] => {
  const ids = [RELEASE_BUNDLE_ID]
  if (typeof extra !== 'string') return ids
  let n = 0
  for (const part of extra.split(',')) {
    const id = part.trim()
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(id) || ids.includes(id)) continue
    if (n >= EXTRA_IDS_MAX) break
    ids.push(id)
    n += 1
  }
  return ids
}

export const socketPath = (home: string, bundleId: string): string => `${home}/Library/Containers/${bundleId}/Data/m.sock`

export const lastPart = (path: string): string | null => path.split('/').filter(p => p !== '').pop() ?? null

export type UsageIn = {
  startedAt: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

export type RecordIn = {
  nowMs: number
  sessionId: string
  root: string
  model: string
  version: string
  usage: UsageIn
  title: string | null
  effort: string | null
}

// the v1 record, in the fields the app reads
export const buildRecord = (r: RecordIn) => {
  const limits: Record<string, { used_percentage: number; resets_at: number | null }> = {}
  for (const l of r.usage.rateLimits) {
    if (l.kind !== 'five_hour' && l.kind !== 'seven_day') continue
    const at = l.resetsAt === undefined ? Number.NaN : Date.parse(l.resetsAt)
    limits[l.kind] = { used_percentage: l.percentUsed, resets_at: Number.isFinite(at) ? Math.floor(at / 1000) : null }
  }
  return {
    v: WIRE_VERSION,
    written_at: Math.floor(r.nowMs / 1000),
    session_id: r.sessionId,
    session_name: r.title,
    project: lastPart(r.root),
    model: { id: r.model },
    effort: { level: r.effort },
    context_window: {
      used_percentage: r.usage.context.percent ?? null,
      context_window_size: r.usage.context.window,
      used_tokens: r.usage.context.tokens ?? null,
    },
    cost: { total_cost_usd: r.usage.cost?.usd ?? null, total_duration_ms: r.nowMs - r.usage.startedAt },
    ...(Object.keys(limits).length > 0 ? { rate_limits: limits } : {}),
    version: r.version,
  }
}

// readsTabs: this mod can be asked to read Terminal's tab bar (true in every update). tabs: the reader's latest reading,
// none for a non-reader. can_update: this mod can run an update when upMonitor sends a token (every update). updateResult:
// the outcome of the run that token started, kept in every update after it.
export const buildUpdate = (
  snap: UsageFeedSnap,
  interactive: boolean,
  record: ReturnType<typeof buildRecord>,
  nowS: number,
  readsTabs = false,
  tabs: Tabs | null = null,
  updateResult: UpdateResult | null = null,
) => ({
  v: WIRE_VERSION,
  kind: 'update' as const,
  seq: snap.seq,
  mod: MOD_VERSION,
  ...(readsTabs ? { reads_tabs: true as const } : {}),
  can_update: true as const,
  interactive,
  record,
  state: { main: snap.main, agents: agentsToSend(snap.agents, nowS), ...(snap.handoff === true ? { handoff: true as const } : {}) },
  ...(tabs !== null ? { tabs } : {}),
  ...(updateResult !== null ? { update_result: updateResult } : {}),
})

// The text to post: without tabs, and counted by the caller, when it would pass 16,000 bytes with them
export const updateText = (u: ReturnType<typeof buildUpdate>): { text: string; droppedTabs: boolean } => {
  const text = JSON.stringify(u)
  if (u.tabs === undefined || utf8(text).length <= BODY_TABS_MAX_BYTES) return { text, droppedTabs: false }
  const { tabs: _t, ...rest } = u
  return { text: JSON.stringify(rest), droppedTabs: true }
}

export const buildEnd = (seq: number, sessionId: string) => ({ v: WIRE_VERSION, kind: 'end' as const, seq, mod: MOD_VERSION, session_id: sessionId })

// The session's snapshot after /clear or a resume: the same process under a new id, main idle, no agents, no name
export const afterClear = (snap: UsageFeedSnap, nowS: number): UsageFeedSnap => ({ ...snap, main: `idle ${nowS}`, agents: {}, title: null, handoff: false })

// ---------------------------------------------------------------- Terminal's tab bar

export type Tab = { n: string; f?: string }
export type Tabs = {
  read_at: number
  windows?: Tab[][]
  refused?: 'accessibility' | 'automation'
  failed?: 'timeout' | 'error'
  stalled?: 'timeout'
}
export type ReadOutcome = { kind: 'ok'; stdout: string } | { kind: 'refused'; word: 'accessibility' | 'automation' } | { kind: 'timeout' } | { kind: 'error' }

// Cut to TAB_TEXT_MAX UTF-16 units, never through the middle of a surrogate pair: a lone half would be sent as "\ud83d",
// which the app's JSON parser refuses, and with it the whole update
const cutUnits = (s: string): string => {
  if (s.length <= TAB_TEXT_MAX) return s
  const last = s.charCodeAt(TAB_TEXT_MAX - 1)
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? TAB_TEXT_MAX - 1 : TAB_TEXT_MAX)
}

// A tab's title to the session name and folder it shows; null when it is not a Claude Code tab. A last segment that is
// a window's size ("80×24") goes first; segments are split on " — ". The name is what follows a status mark in the
// first segment after the first that starts with one. The folder is the last part of the first segment when it is a
// path, or that segment when it has no "/".
export const parseTitle = (title: string): Tab | null => {
  let segs = title.split(' \u2014 ')
  if (segs.length > 1 && /^\d+\u00d7\d+$/.test(segs[segs.length - 1])) segs = segs.slice(0, -1)
  const i = segs.findIndex((s, k) => k > 0 && TAB_MARKS.some(m => s.startsWith(`${m} `)))
  if (i < 0) return null
  const n = cutUnits(segs[i].slice(2).trim())
  const s0 = segs[0]
  const f = s0.startsWith('~') || s0.startsWith('/') ? s0.split('/').pop() : !s0.includes('/') ? s0 : undefined
  return f !== undefined && f !== '' ? { n, f: cutUnits(f) } : { n }
}

// The read's stdout to windows: a window with no Claude Code tab is left out; at most 16 windows and 48 tabs
export const parseWindows = (stdout: string): Tab[][] => {
  const windows: Tab[][] = []
  let count = 0
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    if (windows.length >= TABS_WINDOWS_MAX || count >= TABS_TABS_MAX) break
    const tabs: Tab[] = []
    for (const t of line.split('\u001f')) {
      if (count + tabs.length >= TABS_TABS_MAX) break
      const tab = parseTitle(t)
      if (tab !== null) tabs.push(tab)
    }
    if (tabs.length > 0) {
      windows.push(tabs)
      count += tabs.length
    }
  }
  return windows
}

// A run that ended with an exit status other than 0
export const classifyExit = (stderr: string): ReadOutcome => {
  if (/-25211|assistive access/i.test(stderr)) return { kind: 'refused', word: 'accessibility' }
  if (/-1743|Not authorized to send Apple events/i.test(stderr)) return { kind: 'refused', word: 'automation' }
  return { kind: 'error' }
}

// A run the engine rejected: a timeout when the message says so or the call took the whole time allowed
export const classifyReject = (message: string, elapsedMs: number): ReadOutcome =>
  /time(d)?[ -]?out|still running after/i.test(message) || elapsedMs >= TABS_READ_TIMEOUT_MS ? { kind: 'timeout' } : { kind: 'error' }

// A read with no window at all (Terminal off the current Space, or none open) writes no line
const hasWindow = (stdout: string): boolean => stdout.split('\n').some(l => l !== '')

// The reader's tabs after one read; prev is null before any
export const nextTabs = (prev: Tabs | null, o: ReadOutcome, nowS: number): Tabs | null => {
  const good = prev?.windows !== undefined
  switch (o.kind) {
    case 'ok': {
      if (hasWindow(o.stdout)) return { read_at: nowS, windows: parseWindows(o.stdout) }
      // no window: the last reading stays, a stall gone
      if (good && prev !== null) {
        const { stalled: _s, ...rest } = prev
        return rest
      }
      return { read_at: nowS, windows: [] }
    }
    case 'refused':
      return { read_at: nowS, refused: o.word }
    case 'timeout':
      return good && prev !== null ? { ...prev, stalled: 'timeout' } : { read_at: nowS, failed: 'timeout' }
    case 'error':
      return good ? prev : { read_at: nowS, failed: 'error' }
  }
}

// What makes the reader send at once: the windows, the refusal, the failure or the stall changed (read_at does not)
export const tabsKey = (t: Tabs | null): string => (t === null ? '' : JSON.stringify([t.windows, t.refused, t.failed, t.stalled]))

// The cadence after a read: slow after a refusal or a timeout until a read succeeds; an error leaves it as it was
export const slowAfter = (o: ReadOutcome, wasSlow: boolean): boolean => (o.kind === 'ok' ? false : o.kind === 'error' ? wasSlow : true)

// An app's reply body: a JSON object, at most 64 bytes of text used. tabs: its "tabs" is true. update: its "update" is
// a token, 16 lowercase hex digits; any other value is no token.
// wait: its "wait" is true, so a GET /v1/wait may follow.
export type Reply = { tabs: boolean; wait: boolean; update: string | null }
export const parseReply = (text: unknown): Reply => {
  const none: Reply = { tabs: false, wait: false, update: null }
  if (typeof text !== 'string' || utf8(text).length > ASK_TEXT_MAX_BYTES) return none
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return none
    const o = v as { tabs?: unknown; wait?: unknown; update?: unknown }
    return { tabs: o.tabs === true, wait: o.wait === true, update: typeof o.update === 'string' && /^[0-9a-f]{16}$/.test(o.update) ? o.update : null }
  } catch {
    return none
  }
}

// ---------------------------------------------------------------- the click on a session's row

// The answer to GET /v1/wait: {"select":true} after a click on this session's row, {} when the app's hold ran out; any
// other text, or one over 64 bytes, is bad
export const parseWaitReply = (text: unknown): 'select' | 'none' | 'bad' => {
  if (typeof text !== 'string' || utf8(text).length > ASK_TEXT_MAX_BYTES) return 'bad'
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'bad'
    const keys = Object.keys(v)
    if (keys.length === 0) return 'none'
    return keys.length === 1 && (v as { select?: unknown }).select === true ? 'select' : 'bad'
  } catch {
    return 'bad'
  }
}

// TTY_SCRIPT's output: the tty's device path, only when the program is exactly Apple_Terminal and the tty is ttys and
// 1 to 4 digits, so that what goes into the select script is digits only
export const parseTtyLine = (stdout: unknown): string | null => {
  if (typeof stdout !== 'string') return null
  const m = /^(\S+) (ttys\d{1,4})\s*$/.exec(stdout)
  return m !== null && m[1] === 'Apple_Terminal' ? `/dev/${m[2]}` : null
}

// Terminal lists each native tab as a window of one tab; bring the window whose tab has this tty to the front. The tty is
// a parseTtyLine result: the only input of the script. The argv after /usr/bin/osascript.
export const selectScript = (tty: string): string[] => [
  '-e', 'tell application "Terminal"',
  '-e', 'repeat with w in windows',
  '-e', `if tty of tab 1 of w is "${tty}" then`,
  '-e', 'set index of w to 1',
  '-e', 'activate',
  '-e', 'return "ok"',
  '-e', 'end if',
  '-e', 'end repeat',
  '-e', 'return "none"',
  '-e', 'end tell',
]

// ---------------------------------------------------------------- the update upMonitor asks for

export type UpdateResult = {
  token: string
  outcome: 'updated' | 'up_to_date' | 'failed'
  old_version?: string
  new_version?: string
  failure_code?: string
}

const isVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= VERSION_MAX_BYTES && /^\d+\.\d+\.\d+$/.test(v)
const isCode = (v: unknown): v is string => typeof v === 'string' && v.length <= FAILURE_CODE_MAX_BYTES && /^[a-z_]+$/.test(v)

// The last line of a command's stdout that is a JSON object for that command; the CLI may print a plain line after it
const lastJson = (stdout: string, command: string): Record<string, unknown> | null => {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v: unknown = JSON.parse(lines[i])
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { command?: unknown }).command === command) return v as Record<string, unknown>
    } catch {
      // not a JSON line
    }
  }
  return null
}

// What `claude plugin update --json` said; nothing else of its output is kept
export const parseUpdateJson = (stdout: string, exitCode: number): Omit<UpdateResult, 'token'> => {
  const j = lastJson(stdout, 'update')
  if (j === null) return { outcome: 'failed', failure_code: 'unreadable' }
  if (j.outcome === 'failed') return { outcome: 'failed', failure_code: isCode(j.failureCode) ? j.failureCode : 'failed' }
  if (j.outcome !== 'ok' || exitCode !== 0 || (j.updateOutcome !== 'updated' && j.updateOutcome !== 'up_to_date')) return { outcome: 'failed', failure_code: 'unreadable' }
  return {
    outcome: j.updateOutcome,
    ...(isVersion(j.oldVersion) ? { old_version: j.oldVersion } : {}),
    ...(isVersion(j.newVersion) ? { new_version: j.newVersion } : {}),
  }
}

// The failure code of `claude plugin marketplace update --json`, or null when it worked. An install from another
// marketplace has no "halfmarble" to update and ends here, with the CLI's own code after the prefix.
export const marketplaceFailure = (stdout: string, exitCode: number): string | null => {
  const j = lastJson(stdout, 'marketplace-update')
  if (j?.outcome !== 'failed' && exitCode === 0) return null
  const code = j?.failureCode
  return `marketplace_${isCode(code) ? code : 'failed'}`.slice(0, FAILURE_CODE_MAX_BYTES)
}

// A run the engine rejected: a timeout when the message says so or the call took the whole time allowed, else it did
// not start
export const updateRejectCode = (message: string, elapsedMs: number): 'timeout' | 'not_started' =>
  /time(d)?[ -]?out|still running after/i.test(message) || elapsedMs >= UPDATE_TIMEOUT_MS ? 'timeout' : 'not_started'
