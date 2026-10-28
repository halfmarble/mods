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
(`~/Library/Containers/com.halfmarblellc.upmonitor/Data/m.sock`). Nothing it sends leaves your Mac and nothing is written to
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
- whether the mod can read Terminal's tab titles (`reads_tabs`, below) and whether it can run an update (`can_update`, in
  Updates, below);
- the mod's version, the message format's version, a sequence number and the time the message was made.

It sends no prompt text, no tool input, no transcript and no file contents. When a session ends it sends one message
saying so.

### Terminal's tab titles

Only while upMonitor asks for it, the mod reads the titles of Terminal's tabs, so that upMonitor can list your sessions
in the order of Terminal's tab bar. upMonitor asks only when its box "Sessions in Terminal's tab order" (in its Claude
Code Setup window, off by default) is on, and then of one session at a time: the one whose tab opened first. It asks in
the reply to the mod's own update, `{"tabs":true}`; every other reply is `{}`, and a session that is not asked reads
nothing. Every update says `"reads_tabs": true`, so that upMonitor knows which sessions can be asked.

While asked, the mod runs `/usr/bin/osascript` about every 2 seconds, with a 1.5 second limit, one run at a time, and
asks System Events for the title of each tab of each Terminal window. When upMonitor stops asking, the reading stops and
is forgotten.

From each title the mod keeps only two things, and sends only those: `n`, the session name the title shows, and `f`, the
last part of the folder the title shows (the title's first part whole when it holds no `/`, as in a one-tab window).
A tab whose title does not show Claude Code's status mark is not sent at all.
For example, these titles:

```
~/work/alpha — ✳ alpha:fix_parser — claude
~/work/beta — ◐ beta:write_tests — claude
~/work/alpha — zsh — 80×24
```

are sent, in the asked session's updates, as:

```
"tabs": {"read_at": 1792700000, "windows": [[{"n": "alpha:fix_parser", "f": "alpha"}, {"n": "beta:write_tests", "f": "beta"}]]}
```

`read_at` is the time of the read, in seconds; `windows` lists each window's tabs, left to right. The third title is not
a Claude Code tab and is not sent. Names and folder names are cut to 80 UTF-16 code units (an emoji counts two), never
through the middle of a character's pair of units, and at most 16 windows and 48 tabs
are sent; an update that would pass 16,000 bytes with the tabs goes without them. A read that finds no Terminal window
on the current desktop keeps the last reading.

When a read fails, `tabs` says so instead of windows, and the next reads come every 30 seconds until one works:

```
"tabs": {"read_at": 1792700000, "refused": "accessibility"}
"tabs": {"read_at": 1792700000, "refused": "automation"}
"tabs": {"read_at": 1792700000, "failed": "timeout"}
"tabs": {"read_at": 1792700000, "windows": [[{"n": "alpha:fix_parser", "f": "alpha"}]], "stalled": "timeout"}
```

`accessibility` means Terminal's switch is off in System Settings > Privacy & Security > Device Control and Data Access;
`automation` means Terminal may not control System Events; `failed` is a read that timed out or could not run, sent only
before any read has worked (`error` is the other word); `stalled` is sent beside the last good windows while reads time
out, as when another app's permission prompt for System Events is open.

What it needs: Terminal's switch in Device Control and Data Access, and, the first time, the answer Allow to macOS's
question whether Terminal may control System Events. Without them the sessions are listed in the order their tabs were
opened and nothing else changes. A title is never logged, never written to disk and never sent whole; the reading is kept
in the session's memory only, and, like everything the mod sends, it goes only to upMonitor on your Mac.

### A click on a session's row

When upMonitor's reply to a session's update says `"wait":true`, that session's mod keeps one `GET /v1/wait` open to
upMonitor, which answers `{}` after about 25 seconds (the mod then asks again) or `{"select":true}` when you click that
session's row in upMonitor's panel. On `{"select":true}` the mod brings that session's Terminal tab to the front. A
refusal, an error, no answer, or an empty answer within a second of asking (upMonitor holding too many waits) ends the
waiting until a later reply says `"wait":true` again, and never sooner than 10 seconds after.

It works only in Terminal. Once, on the first send that needs it, the mod runs

```
/bin/sh -c 'printf "%s %s\n" "$TERM_PROGRAM" "$(ps -o tty= -p $PPID)"'
```

with a 1.5 second limit: the parent of that shell is the Claude Code process, so this gives the program it runs in and
its tty. Only when the program is exactly `Apple_Terminal` and the tty is `ttys` and one to four digits is the tty kept,
in the session's memory; otherwise the mod never waits. On a click it runs `/usr/bin/osascript` with a script that tells
Terminal to bring forward the window whose tab has that tty and to activate (3 second limit):

```
tell application "Terminal"
  repeat with w in windows
    if tty of tab 1 of w is "/dev/ttys007" then
      set index of w to 1
      activate
      return "ok"
    end if
  end repeat
  return "none"
end tell
```

The tty is the only input of the script, and only after the check above. The result is dropped; no title or tty is
logged, stored or sent. The first run may make macOS ask whether Terminal's child may control Terminal.

## Updates

upMonitor can tell you that a newer usage-feed exists and ask whether to update it. Only when you answer Update, upMonitor
sends one session at a time, at most three, a token (16 hex digits) in the reply to that session's own update, and that session's mod runs two
commands, one after the other, each with a 120 second limit:

```
claude plugin marketplace update halfmarble --json
claude plugin update usage-feed@halfmarble --json
```

The second runs only if the first did not fail. The commands fetch from the `halfmarble` marketplace (GitHub) and
change your Claude Code plugin files the way running them yourself does: the first refreshes the `halfmarble` marketplace's
copy if Claude Code knows that marketplace, the second changes only the installed usage-feed.
The mod runs them at most once per token and never two at once, outside the hooks, so a slow update delays no event and
no message. It needs the mod to be installed from the `halfmarble` marketplace (the install above); a copy from another
marketplace, or `claude` not on your PATH, ends as a failure, reported as below, and that plugin is not changed.

Of the commands' output the mod keeps only a result and sends it, in every update until the session ends, as
`update_result`:

```
"update_result": {"token": "0123456789abcdef", "outcome": "updated", "old_version": "1.2.0", "new_version": "1.2.1"}
```

`outcome` is `updated`, `up_to_date` or `failed`. The versions (`1.2.3` form, at most 32 bytes) come with the first two;
`failure_code` (lowercase letters and `_`, at most 32 bytes) comes with `failed`: the update command's own code, such as
`not_found`, or `marketplace_` and the marketplace command's code, `unreadable` for output the mod could not read,
`timeout` for a command past its limit, `not_started` for one that could not run. A field that does not fit these forms
is left out. No other text of the output is stored, sent or logged. A session that already runs keeps its old version
until you restart it; the update takes effect in new sessions and after a restart.

The mod only observes: it passes every event on as it received it and never answers a permission or changes a prompt.
It reads and writes no file itself, and calls only `$.session`, `$.http`, `$.clock`, `$.state`, `$.env` and, for the tab
titles, the update and the click above, `$.process.run`.

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
