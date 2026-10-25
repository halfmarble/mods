# usage-feed

A Claude Code mod that tells upMonitor (the paid macOS menu-bar app) how much of your Claude Code plan you have used
and what each of your running sessions is doing. upMonitor shows the 5-hour and weekly limits and one bar per session,
and a session's state: busy, ask (it waits for your answer), idle, or handoff (idle, and past 250,000 tokens of
context or 16 hours: time for a new session).

## Install

In a Claude Code session in a terminal:

```
/plugin install usage-feed --marketplace halfmarble/mods
```

From a shell:

```
claude plugin install usage-feed --marketplace halfmarble/mods
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `halfmarble/mods`, then
Add plugin.

If the install says that 1 userConfig option is not yet set, that is `extraBundleIds` (Options, below): it is empty
by default and can be left so.

New sessions send from their start; a session that is already running starts after `/reload-plugins`. To remove the
mod: `claude plugin uninstall usage-feed@halfmarble`.

The mod does not run when Claude Code starts with `--safe-mode` or when its settings turn off all hooks.

## What it sends

Only to upMonitor, on your Mac, through a Unix socket inside upMonitor's own folder
(`~/Library/Containers/com.halfmarblellc.upmonitor/Data/m.sock`). Nothing leaves your Mac and nothing is written to
disk. When upMonitor is not running the mod's attempt is refused at once and costs next to nothing.

For each session, about every 10 seconds and at each change:

- the session id, its name (which Claude Code may make from your first prompt), and the last part of its project
  folder (not the full path);
- the model id, the effort level, the context window use (tokens, window, percent), the cost so far and the time since
  the session started;
- the plan's 5-hour and weekly usage and when each resets;
- Claude Code's version;
- the session's state (busy, waiting, idle) and that of each subagent, by the subagent's id (an id that is not
  1 to 64 letters and digits is sent as a hash), each with the second it began;
- whether the session is interactive (a `claude -p` run is not);
- the mod's version, the message format's version, a sequence number and the time the message was made.

It sends no prompt text, no tool input, no transcript and no file contents. When a session ends it sends one message
saying so.

The mod only observes: it passes every event on as it received it and never answers a permission or changes a prompt.
It reads and writes no file, and calls only `$.session`, `$.http`, `$.clock`, `$.state` and `$.env`.

## Options

`extraBundleIds`: a comma-separated list of other upMonitor builds' bundle IDs to feed as well, four at most, each made
of letters, digits, dots and dashes. Empty by default; the release app's ID is always fed. Set it at install:

```
claude plugin install usage-feed --marketplace halfmarble/mods --config extraBundleIds=com.example.build
```

## Development

`claude plugin validate --profile directory .` and `claude plugin test .` run in this folder. The pure part is
`hooks/model.ts`; `hooks/register.ts` holds the hooks and the sender.

## License

MIT, Copyright (c) 2026 Halfmarble LLC.
