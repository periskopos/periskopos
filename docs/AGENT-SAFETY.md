# Periskopos as a safe layer for agents

| | |
|---|---|
| **Status** | Phase 1 built, 2026-10-17; app-only access and Claude's switch added the same day. Phase 2 (an assistant each: own tokens, scopes, rules, grants, audit log, kill switch) built 2026-10-28 |
| **Question** | Can Periskopos be the way agents (Claude and others) reach your apps' services, safely? |
| **Answer** | Yes. It already has the right shape; phase 1 below turns it from a guardrail into a boundary for the threats that matter on one PC. |

---

## 1. Why it fits

The recommended pattern for giving an agent access to production is a
**broker**: something that holds the credentials, offers the agent a few
narrow, intent-level tools, asks a human before anything changes, and
records everything. Periskopos was already most of that:

- **Keys never reach the agent.** The MCP server is a thin client of the
  local server; no tool returns a key or token.
- **Narrow tools.** "Redeploy Star-Map", not "here is Render's API". The
  agent can't add, edit or delete apps or services.
- **Writes are off by default**, per service ("Allow actions").
- **Dangerous actions are screen-only**: the app's name must be typed.
- **An audit log** records every action and who started it.

## 2. Where it fell short (before phase 1)

Agents run as the same Windows user on the same PC, often with a shell. As
built through M8:

1. **Keys in the workspace.** `.env.local` sat in the project folder, so an
   agent working in this repo could read it and call Render or Supabase
   directly, skipping every rule.
2. **One all-powerful token on disk.** `data/token` gave full API access,
   the same as the UI: toggle "Allow actions", generate protocol secrets,
   delete apps.
3. **The caller named itself.** An action request carried
   `source: "ui" | "mcp"`; the "dangerous actions only on screen" rule
   trusted it. A raw request with the token and `source: "ui"` got past it.
4. **Approval lived in the agent's client.** The only "are you sure?" for
   `run_action` was Claude Code's permission prompt. Auto mode, an allow
   list, or another MCP client removes it; the server never asked.
5. **No per-agent identity or scope.**
6. **Upstream keys broader than needed** (Supabase's token can't be made
   read-only).

## 3. Threat model

What "safe" means here, from most to least likely:

| | Threat | Covered after phase 1? |
|---|---|---|
| **A** | An agent uses only the MCP tools, but is wrong or prompt-injected and asks for the wrong action | **Yes**: every agent action waits for your approval on screen |
| **B** | An agent wanders through files it can read (a repo, `data/`) and uses what it finds | **Yes**: no provider key is in a project folder; the only token on disk can read and *ask*, not act |
| **C** | An agent deliberately attacks Periskopos from a shell running as your user | **Mostly.** The easy ways are shut: the page carries no key and is served only to the app's window, so `curl` gets nothing; the session key is never on disk, on a command line or in an environment. What's left needs real effort: reading the app's memory, or reading the provider keys file in your profile and calling the providers directly. On one Windows account nothing is fully sealed; only a separate OS user would close that |
| **D** | Something on the network | Already covered: listens on 127.0.0.1 only, checks Host and Origin (DNS rebinding, other sites in your browser) |

The honest summary: **a boundary against agents that misbehave, not against
an attacker who already owns your account.**

## 4. The plan

### Phase 1 (built now)

**4.1 Two keys, only the app opens Periskopos, and the server decides
who is calling.**

- **The app's session key**: the desktop app makes a fresh one each time it
  starts, writes it to the server's stdin (never the command line or the
  environment, which other programs can read), and gives it to its own
  window as an HttpOnly, in-memory cookie that page scripts can't read.
  Full access. Nothing else ever gets it: the page doesn't carry it, and a
  request without it (a browser, `curl`) gets only a "opens only in its
  desktop app" page. A server started any other way (`npm start`) makes a
  key nobody has, so its page and API stay shut.
- **Agent token**: the `token` file in the data folder, used by the MCP
  server, whichever AI assistant runs it (Claude, Cursor, VS Code…). **Off
  until you switch it on**: Settings → AI assistants → "Let AI assistants use
  Periskopos". While off, it gets a 403 that says where the switch is,
  and switching it off withdraws any approval an assistant is waiting on.
  The assistant's own name (MCP's clientInfo) is passed along and shown in
  the approval and the History; it's a label, not proof: the token decides
  what it may do. While on, it may:
  - `GET` anything under `/api` (reads; nothing there returns a key).
    That includes checking an app now (`/status?refresh=1`, what Check now
    does: it reads the providers and records the result, nothing more) and
    the end of a failed CI job's log from GitHub (`failure-log`), where
    GitHub has already masked the repository's secrets as `***`;
  - `POST /api/apps/<slug>/actions/<id>`, which **asks** for an action.

  Everything else (switching "Allow actions", generating protocol secrets,
  adding or deleting anything, settings, approving) is refused with 403.
- The action's `source` (`ui` or `mcp`) comes from the token, never from the
  request body. The activity log can be trusted.

**4.2 The server asks you before an agent acts.**

- An agent's action request is checked first (the action exists, its
  service allows actions, it isn't marked dangerous). Then it **waits**.
- Periskopos sends a desktop notification ("Cursor asks to run
  Redeploy on Star-Map", naming whichever assistant asked) and every open Periskopos window shows an
  approval dialog naming the app and the action, with **Approve** and
  **Decline**.
- Approve: the action runs and the agent gets the result. Decline, or no
  answer within 2 minutes: nothing runs, the agent is told, and the
  attempt is recorded in the app's activity.
- This holds whichever agent is calling and however its client is
  configured, including Claude Code's auto mode.
- Dangerous actions stay screen-only (typing the app's name).

**4.3 Keys out of the project folder.**

- `.env.local` now lives in your per-user app folder, the same place the
  installed desktop app already keeps it:
  - Windows: `%APPDATA%\Periskopos\.env.local`
  - macOS: `~/Library/Application Support/Periskopos/.env.local`
  - Linux: `~/.config/Periskopos/.env.local`
- On first start with the new code, an existing `.env.local` in the project
  folder is **moved** there (not copied), and the server says so in its
  output. `PERISKOPOS_ENV_FILE` still overrides the location.
- So the checkout and the installed app now share one set of keys.
- Since 0.3.5 the installed app keeps the file encrypted (AES-256-GCM,
  `server/keys/sealed-keys.ts`) with a random key locked by Electron's
  safeStorage (`desktop/keys-key.ts`), handed to the server on stdin after
  the session key. A copied file shows no keys; a program running as me
  can still ask the system to unlock the key, so threat C is unchanged.
  A checkout's `npm start` gets no key: it reads a plain file, so it needs
  its own (`PERISKOPOS_ENV_FILE`).

### Phase 2 (built 2026-10-28): an assistant each

Settings → AI assistants, implemented in `server/agents/agents.ts`:

- **An assistant per tool, each with its own token.** **Add assistant**
  makes a token (`gca_…`), shown once, as a ready `claude mcp add` command
  and as JSON for other tools; the MCP server takes it from
  `PERISKOPOS_AGENT_TOKEN`. Only its SHA-256 hash is stored. **Revoke** stops it at
  once and withdraws whatever it's waiting on. The `token` file in
  the data folder, which the MCP server reads when it isn't given one, is
  the assistant "This PC": listed before its first request, so its limits
  can be set first, and **Turn off** refuses it until it's turned back on.
  It's how most setups connect; a token of its own is for a tool that needs
  different limits.
- **Connection.** The top of the tab: the kill switch, whether the MCP
  server can start (in the install, `node` 24+ on PATH), the no-token setup
  for Claude Code and as JSON, and who made the last request.
- **Scope.** Per assistant: *all apps*, or only some. An app outside its
  scope doesn't exist as far as it can tell (404 by name, left out of
  `/apps`, `/status`, `/services`, `/providers`), and anything not listed for
  it is refused. **Access**: *only read*, or *read and ask for actions*.
- **A rule per action**: *Ask me* (the default), *Allow without asking*, or
  *Never*. A dangerous action can't be set to Allow; it still needs the
  screen.
- **Grants.** The approval dialog has **Approve, and allow for 1 hour**
  (for an assistant with its own token): that action runs unasked until
  then, and the assistant's card lists it with **End now**. A grant wins
  over a rule while it lasts.
- **The audit log.** Every request an assistant makes (reads included):
  when, which assistant and which tool it said it was, the path, and what
  came of it (read, refused, approved, declined, expired, allowed by rule,
  allowed by grant, refused by rule). Kept 90 days; **Activity** on the tab,
  filterable by assistant, exportable as CSV (formula-looking cells kept as
  text) or JSON.
- **Kill switch.** Turning access off (Settings, or **Cut off AI
  assistants** in the tray) shuts every assistant out at once and withdraws
  what they're waiting on.
- Assistants can't reach any of this: `/api/agents` is screen-only, like
  approvals and settings.

### Later

- **Dry-run** for actions that have a meaningful preview.
- **Narrower upstream keys** wherever the provider allows it (Cloudflare
  and GitHub fine-grained tokens per need).

### Deliberately not doing

- **Windows Credential Manager / Keychain for keys.** Any process running as
  your user can read them back, so it adds little over a file outside the
  workspace (threat C either way).
- **Rate limits.** Every action asks unless a rule or a grant you set says
  otherwise, and those are per action and revocable; limits would add
  little yet.
- **Exposing Periskopos beyond localhost** (cloud agents). That changes
  the threat model entirely (real authentication, TLS, OAuth for MCP). Not
  until there's a concrete need.

## 5. How to check it

- `npm run check`: tests cover the agent token's limits, `source` coming
  from the token, approval (approve, decline, expire) and the key file's
  move.
- By hand: ask Claude to redeploy an app; a notification and a dialog
  appear; Decline, and Claude reports that nothing ran; the History tab
  shows the declined attempt.
