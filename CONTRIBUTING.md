# Contributing to Periskopos

Thanks for wanting to help. Periskopos is a desktop app (Electron) around
a local TypeScript server (Hono, `node:sqlite`) and a plain-DOM web UI. It's
pure TypeScript with no build step for the server: Node 24 runs `.ts` files
directly.

## Getting started

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` opens the desktop app from your checkout and rebuilds the UI
when its files change (View → Reload to see it). A change to the server or
the desktop shell needs the app quit and `npm run dev` run again. It runs
beside an installed copy: on port 4101 (the installed one is on 4100;
`PERISKOPOS_PORT` overrides either), with its own profile folder and the registry in
the checkout's `data/`. Set `PERISKOPOS_DATA_DIR` to try things against another
folder. `npm start` runs a bare server, which only assistants and tests use.

Before opening a pull request:

```bash
npm run check
```

That's the type check, every test (`node --test`), and the web build. A pull
request should keep it green and add tests for what it changes. CI runs the
same on Windows and Linux.

Tests never call a real provider: each integration's test fakes its API (see
any `test/*.test.ts`). Use the made-up apps Star-Map and Moon-Base, on the
reserved domains `example.org` and `example.net` (or anything under
`example.com`), in tests and docs, never a real app, domain or key.

## How the project is laid out

| Folder | What's in it |
|---|---|
| `server/` | The local server (Hono, `node:sqlite`): the registry, the watcher, checks, notifications, the API |
| `server/keys/` | Where provider keys are read, written and encrypted (`.env.local`), and the daily key test |
| `server/agents/` | AI assistants: their tokens, what they may do, and the approvals on screen ([docs/AGENT-SAFETY.md](docs/AGENT-SAFETY.md)) |
| `server/alerts/` | Desktop and phone notifications, and the notifications list |
| `server/audits/` | Configuration checks: storing what each source finds, and the site and DNS checks |
| `server/integrations/` | One file per provider, registered in `index.ts` |
| `shared/` | Types and the account catalogue, used by the server and the UI |
| `web/` | The UI: plain DOM and CSS, built with Vite |
| `desktop/` | The Electron shell: window, tray, menu, updates |
| `mcp/` | The MCP server for AI assistants, a thin client of the running app |
| `templates/` | The protocol endpoint Periskopos generates for apps |
| `test/` | `node --test` tests, one file per area |
| `docs/` | The agent safety and release docs. The user guide and provider setup are on [periskopos.com/docs](https://periskopos.com/docs/) |

## Tools

Everything the project needs comes from `npm install`, locally, with nothing
installed system-wide:

| | Used for |
|---|---|
| Node 24+ | runs the TypeScript directly (no build step for the server) |
| `typescript`, `vite` | type-checking and the UI build |
| `hono`, `@hono/node-server` | the local server |
| `@modelcontextprotocol/sdk`, `zod` | the MCP server |
| `electron`, `electron-builder` | the desktop app and its installers (Electron's own Node runs the TypeScript) |
| `deno` | runs and type-checks the generated endpoint the way Supabase's Edge runtime does (in the tests) |
| `@fontsource-variable/geist`, `-mono` | the UI's fonts, bundled by Vite (not shipped as packages) |

All are on their latest release. The one deliberate exception is
`@types/node`, kept on 24 to match the Node the project runs on: the newer
typings would let the type-check accept APIs that don't exist in Node 24.

## One language

The project is pure TypeScript: no JavaScript source, no explicit `any`, no
`@ts-ignore`, and a strict compiler. A test (`test/purity.test.ts`) fails if
any of that slips back in. CSS and HTML are the only other languages.

## What's welcome

- **New hosts and providers.** Each integration lives in
  `server/integrations/` and is registered in `server/integrations/index.ts`;
  `shared/catalog.ts` describes the account (its key, its status page). Look
  at an existing one of the same kind (a host like `cloudflare.ts`, a source
  like `github.ts`) and its tests in `test/`.
- **Bug fixes**, with a test that fails before the fix.
- **Docs** that make setting it up easier.

### Adding a provider

The type checker catches most of a missed step (every map below is keyed by
the union it belongs to), but not all of them:

1. `shared/types.ts`: add the account to `ServiceType`, and the connection
   to `SuggestionKind` if Periskopos should suggest it.
2. `shared/catalog.ts`: the connection in `CONNECTIONS` (label, incident
   kind, role, what it shows) and the account in `ACCOUNTS` (its key, the
   permissions, the setup steps, its status page).
3. `server/integrations/<provider>.ts`: start from `described(type)` and add
   the hooks it needs (`check`, `details`, `listResources`, `testService`…),
   each with a timeout, through `server/http.ts`.
4. `server/integrations/index.ts`: register it in `integrations` and, for an
   account, in `SERVICE_TYPES`.
5. `web/src/logos/<type>.svg` and its colour in `web/src/styles/accounts.css`.
6. Only if connecting it asks for more than the resource (a branch, a
   budget): a field in `web/src/views/app/connectForm.ts`.
7. `test/<provider>.test.ts`, faking its API; and its page on the website's
   [Providers](https://periskopos.com/docs/accounts/providers/) docs.

For anything bigger (a new screen, a change to how agents are allowed to
act, a new runtime for the protocol generator) open an issue first, so we
can agree on the shape before you spend time on it.

## Ground rules

- **Keys never leave the user's PC.** Nothing may send a provider key, a
  token or an app's data anywhere but the provider it belongs to.
- **Agents ask, people decide.** Anything an AI assistant can trigger goes
  through the approval flow in [docs/AGENT-SAFETY.md](docs/AGENT-SAFETY.md).
  Don't add a way around it.
- **Read-only by default.** A new integration reads; an action that changes
  something is opt-in per account ("Allow actions") and always confirmed.
- **Match the code around it:** its naming, its comments (short, saying
  why), and its plain-DOM UI helpers in `web/src/ui.ts`.

## Licence

Periskopos is under the [Apache License 2.0](LICENSE): free to use, change,
self-host and build on, commercially too, as long as you keep the copyright
and licence notices (and [NOTICE](NOTICE)) and mark the files you changed. It
doesn't grant use of the name or logo. By contributing, you agree your
contribution is under the same licence, including its patent grant.
