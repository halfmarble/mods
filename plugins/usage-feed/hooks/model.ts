// The pure part of usage-feed: events to a session's state, and state plus usage to the message the sender posts.
// Nothing here calls the engine, so claude plugin test checks it by plain calls.
import type { UsageFeedSnap } from '../types'

export const RELEASE_BUNDLE_ID = 'com.halfmarblellc.upmonitor'
// Keep equal to "version" in .claude-plugin/plugin.json
export const MOD_VERSION = '1.0.0'
export const WIRE_VERSION = 1
export const HEARTBEAT_MS = 10000
export const SEND_TIMEOUT_MS = 2000
// A busy subagent whose state is older than this is no longer sent
export const AGENT_BUSY_MAX_AGE_S = 7200
export const AGENTS_MAX = 64
export const EXTRA_IDS_MAX = 4

export type Word = 'busy' | 'waiting' | 'idle'

export const emptySnap = (): UsageFeedSnap => ({ seq: 0, main: null, agents: {}, effort: null, title: null, interactive: null })

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
    if (line === null || wordOf(snap.main) === word) return null
    return { ...snap, main: line }
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

export const buildUpdate = (snap: UsageFeedSnap, interactive: boolean, record: ReturnType<typeof buildRecord>, nowS: number) => ({
  v: WIRE_VERSION,
  kind: 'update' as const,
  seq: snap.seq,
  mod: MOD_VERSION,
  interactive,
  record,
  state: { main: snap.main, agents: agentsToSend(snap.agents, nowS) },
})

export const buildEnd = (seq: number, sessionId: string) => ({ v: WIRE_VERSION, kind: 'end' as const, seq, mod: MOD_VERSION, session_id: sessionId })

// The session's snapshot after /clear or a resume: the same process under a new id, main idle, no agents, no name
export const afterClear = (snap: UsageFeedSnap, nowS: number): UsageFeedSnap => ({ ...snap, main: `idle ${nowS}`, agents: {}, title: null })
