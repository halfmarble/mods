// The state this mod keeps in $.state: one snapshot per session, which a reload of the mod keeps.
export type UsageFeedSnap = {
  // Counts the messages sent for this session, so a receiver can tell a late one from a newer one
  seq: number
  // The main thread's state as "<word> <epoch seconds>", or null until the mod has seen a main-thread event
  main: string | null
  // Each subagent's state in the same form, by its id (an id outside [A-Za-z0-9]{1,64} is kept as "h" and 16 hex digits)
  agents: Record<string, string>
  effort: string | null
  title: string | null
  // The session's isInteractive from session.start, null until the mod has seen it
  interactive: boolean | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-feed': { snap: UsageFeedSnap }
  }
}
