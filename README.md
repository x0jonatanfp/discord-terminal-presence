# discord-terminal-presence

[Español](README.es.md) | **English**

Discord Rich Presence for the tmux pane you are attached to on a remote Linux host. A small watcher runs on Windows, where Discord's local IPC pipe lives, and keeps your Discord card in sync with the active tmux pane: which coding agent is running and in which workspace. It never publishes conversation text.

## The problem it solves

When you work over SSH from Windows inside tmux, Discord only knows that some application is running. With several terminal tabs and several agents (Claude, Codex, OpenCode, Freebuff) it is impossible to tell at a glance which one is busy. This project reads tmux metadata and the last lines of the active pane on the remote host, classifies the pane as working or idle, and publishes only an agent name, a workspace name and a state line.

The architecture has two parts:

- **Watcher (Windows).** Node.js process with no dependencies. Keeps one persistent SSH connection per set of open tabs, talks to Discord over the local named pipe, and maintains the Rich Presence activity.
- **Probe (remote host).** `probe/state.mjs` reads tmux, `/proc`, `ps` and `git`, and prints one JSON line whenever the pane state changes. It installs nothing and writes no files on the host.

## Requirements

- Windows 10 or 11 with **Node.js 22 or newer** and **Discord Desktop** installed and running.
- A Linux host reachable over SSH with **key-based, non-interactive authentication** (the watcher uses `BatchMode=yes`; there are no password prompts).
- On the host: `tmux` with at least one attached client, `node` (the probe runs under it), `git` and `ps`. The default binary paths are `/usr/bin/tmux`, `/usr/bin/ps` and `/usr/bin/git`; they can be changed in `infrastructure/probe-adapters.mjs` if your distribution uses other paths.
- A copy of this repository on the host. The probe imports `application/read-panel-state.mjs` and `infrastructure/probe-adapters.mjs`, so the whole tree must be present, not just `probe/`.
- No npm dependencies and no build step.

All hosts, users and paths in this repository are placeholders (`your-server.example`, `example_user`, `/opt/discord-terminal-presence`). Replace them with your own values.

## Installation

1. Copy the repository to the Windows machine, for example `C:\Users\<you>\tools\discord-terminal-presence`.
2. Copy the same tree to a stable path on the Linux host, for example `/opt/discord-terminal-presence`.
3. Create the local configuration:

   ```powershell
   Copy-Item config.example.json config.json
   ```

4. Edit `config.json` and set at least `applicationId`, `ssh.host`, `ssh.port`, `ssh.user` and `probe.scriptPath`.
5. Check that the SSH command works from a Windows terminal without prompting:

   ```powershell
   ssh -p 22 example_user@your-server.example "tmux list-clients"
   ```

6. Try the probe once, without Discord:

   ```powershell
   node src/index.mjs --once
   ```

`--once` prints the probe JSON, including `{"ok":true,"idle":true}` when there are no tmux clients. It exits with code 2 when the configuration is missing or invalid, and with code 1 when the SSH query fails.

## Creating the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application. Its name is what Discord shows as “Playing …”; this project was designed around the name **`Terminal`**.
2. Copy the **Application ID** into `applicationId`. It is public and is not a secret; never put tokens or passwords in the configuration.
3. Optionally, under **Rich Presence → Art Assets**, upload a large image with key `terminal` and small images for the agents you use: `claude`, `freebuff`, `opencode`, `codex`. Asset keys are case-sensitive. The code only references keys; it never downloads or generates images.

`assets` is optional. Leave it out for the first run and add it once the images are uploaded:

```json
"assets": {
  "largeImage": "terminal",
  "largeText": "Terminal",
  "agents": { "claude": "claude", "freebuff": "freebuff", "opencode": "opencode", "codex": "codex" }
}
```

## Configuration

`config.json` is ignored by git. Every value except `applicationId` and `ssh.*` is optional.

| Key | Required | Default | Description |
| --- | --- | --- | --- |
| `applicationId` | yes | — | Discord Application ID (public). |
| `pollIntervalMs` | no | `2000` | Minimum wait between session checks, in milliseconds. Values below 2000 are raised to 2000 with a warning. Presence updates arrive through the SSH stream; this only bounds how often the session registry is checked. |
| `ssh.binary` | no | `ssh.exe` | SSH client executable on Windows. |
| `ssh.host` | yes | — | Hostname or IP of the Linux host. |
| `ssh.port` | yes | — | SSH port, 1–65535. |
| `ssh.user` | yes | — | Remote user. |
| `probe.node` | no | `node` | Node.js executable on the host. |
| `probe.scriptPath` | no | `~/Development/extensions/discord-terminal-presence/probe/state.mjs` | Absolute path to the probe on the host. |
| `assets.largeImage` | no | — | Key of the large Rich Presence image. |
| `assets.largeText` | no | `Terminal` | Tooltip of the large image. |
| `assets.agents.<agent>` | no | — | Small image key for `claude`, `freebuff`, `opencode` or `codex`. |
| `logDir` | no | `%LOCALAPPDATA%\discord-terminal-presence` | Directory for `watcher.log`. |
| `sessionsDir` | no | `%LOCALAPPDATA%\discord-terminal-presence\sessions` | Directory for the per-tab session records. `%LOCALAPPDATA%` is expanded. |

Example:

```json
{
  "applicationId": "YOUR_DISCORD_APPLICATION_ID",
  "pollIntervalMs": 2000,
  "ssh": {
    "binary": "ssh.exe",
    "host": "your-server.example",
    "port": 22,
    "user": "example_user"
  },
  "probe": {
    "node": "/usr/bin/node",
    "scriptPath": "/opt/discord-terminal-presence/probe/state.mjs"
  }
}
```

## Usage

Start the watcher directly only for debugging; without a registered terminal session it exits on the first cycle. The normal entry point is the Windows Terminal wrapper described below.

```powershell
node src/index.mjs --once      # one probe query, no Discord
node src/index.mjs --verbose   # normal watcher, log lines also on stdout
```

Supported flags:

| Flag | Purpose |
| --- | --- |
| `--once` | Query the probe once, print JSON and exit. Does not connect to Discord. |
| `--verbose` | Write log lines to stdout as well as to the log file. |
| `--sessions-dir <dir>` | Override the session directory for this run. |
| `--claim-lock-pid <pid>` | Internal: used by the wrapper when it hands the lock to the watcher. |

The card has two lines: `<Agent> · <workspace>` (for example `Claude · my-project`) and `💻 Working..` or `💤 Idle`. The elapsed time comes from the tmux session creation time. A heartbeat re-sends the same activity every 60 seconds.

## Starting with Windows Terminal

The watcher only lives while at least one tab of a dedicated Windows Terminal profile is open. No Startup folder entry or logon autostart is used.

1. Set `sessionsDir` in `config.json` or keep the default `%LOCALAPPDATA%\discord-terminal-presence\sessions`.
2. In Windows Terminal, duplicate the SSH profile you already use, keep its icon, and give the copy a new GUID and the name **`presence`** (or any name you like; this is just an example).
3. Set the duplicate's `commandline` to:

   ```text
   "C:\Program Files\nodejs\node.exe" "C:\Users\<you>\tools\discord-terminal-presence\windows\terminal-session.mjs"
   ```

4. Put the new GUID in `defaultProfile` if you want this profile to open by default. Leave the original SSH profile untouched.

How it behaves:

- The first tab registers its PID, claims a startup lock and spawns a single hidden watcher. The watcher takes over the lock and opens the presence.
- Every tab opens its own interactive SSH session with a unique `PRESENCE_ID`; additional tabs reuse the existing watcher.
- When the last tab closes, the watcher sees an empty session registry on its next cycle (at most about 2 seconds), clears the activity and exits.
- If a tab dies abruptly, its record is discarded once the PID no longer exists.

`windows/start-hidden.vbs` is an optional helper that starts `src/index.mjs` without a console window when `node.exe` is not in `%ProgramFiles%\nodejs`; set `NODE_EXE` to override the executable. It is not needed by the Windows Terminal profile.

## What it sees and what it does not

The probe reads:

- `tmux list-clients`: session name, client PID, last activity and focus flag.
- `tmux display-message` for the active pane: pane id, session, window, command, title, current directory, pane PID and session creation time.
- `tmux capture-pane -p -S -12`: the last 12 lines of the active pane, with ANSI escape sequences removed.
- `/proc/<pid>/environ` only to match the tab's `PRESENCE_ID`.
- `ps --ppid` to identify agent processes started from a shell.
- `git rev-parse --show-toplevel` and `git branch --show-current` in the pane directory.

The watcher publishes to Discord:

- `<Agent> · <workspace>` (agent label and repository or directory name).
- `💻 Working..` or `💤 Idle`.
- A start timestamp based on the tmux session.
- Optional image asset keys configured in `assets`.

It never publishes pane text, titles, prompts, commands, tool names, file paths, branch names, PIDs, the SSH host or user, or `PRESENCE_ID` values. Logs and session files stay on the Windows machine.

## Known limitations and false positives

- **Heuristic activity detection.** The classifier looks for words such as `thinking`, `working`, `starting`, `connecting`, `initializing`, `loading`, `preparing`, `queued`, `waiting`, `generating` or `processing`, for `esc to interrupt`, and for braille spinner characters in the last 12 lines or in the pane title. The same words in unrelated TUI text can produce a false `💻 Working..`; conversely, a finished task can remain `Idle` until the pane changes.
- **`Worked for` / `Cooked for` cut-off.** Activity before the last such line is ignored, so a completed task is not reported as working.
- **Only the active pane.** Splits and background panes are not inspected. With several tabs, the probe prefers a tab that is working, then the focused tab, then the most recently active one.
- **Focus detection** uses tmux `client_flags`; enable `focus-events on` in tmux for reliable results. Without focus information it falls back to activity time.
- **One watcher per session directory.** A stale lock with a live PID prevents a second watcher from starting; this is intentional.
- **Windows and Discord Desktop only.** The watcher uses Discord's Windows named pipe. The tests run on Linux or Windows and do not need Discord, SSH or tmux.
- **Discord rate limits** may coalesce rapid updates; the 60-second heartbeat keeps the card fresh.
- **No remote daemon.** If the SSH connection drops, the probe exits and the watcher retries; after three consecutive failures it stops the stream and reports `💤 Idle`.

## Logs and troubleshooting

By default the log is `%LOCALAPPDATA%\discord-terminal-presence\watcher.log` and rotates to `watcher.log.1` at 1 MB. `watcher.lock` lives in the parent directory of `sessions`, and each tab writes `<pid>.json`.

- **Discord closed / pipe not found:** open Discord Desktop. The watcher logs each connection state change and retries on the next cycle.
- **SSH down or key not authorised:** run `node src/index.mjs --once` and check network, port, user and key. SSH errors appear in the log.
- **No tmux clients in the current tab:** the card shows only `💤 Idle`. When the last tab closes, the activity is cleared and the watcher exits.
- **`Discord IPC ERROR`:** read the code and message in the log. Asset errors usually mean the key does not exist under Art Assets.
- **Activity does not change:** the watcher keeps the stream open and updates when the pane state changes. At least one live `<pid>.json` session file must exist.
- **Restart:** close all `presence` tabs, wait a few seconds and reopen the profile. Do not delete a lock file whose PID is alive.

## Development and tests

The project is plain ESM with no dependencies and no build step.

```bash
npm test        # or: node --test
```

The suite uses `node:test` with injected fakes for tmux, `ps`, `git`, Discord and SSH, so it runs on Linux or Windows without Discord, tmux or a remote host. All tests must pass; the current suite has 72 tests.

Layout:

```text
application/    panel state orchestration (agent, workspace, working state)
domain/         tmux parsing and the Working/Idle classifier
infrastructure/ adapters for tmux, ps, git and /proc
probe/          remote entry point (one-shot and --watch)
src/            watcher, Discord IPC, config, logger, session registry
windows/        Windows Terminal wrapper and optional hidden launcher
test/           node:test suite
```

## License

MIT. See [LICENSE](LICENSE).
