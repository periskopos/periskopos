import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, PORT, ROOT, installedAppDataDir } from "../server/config.ts";

// The MCP server is a thin client of the local server (PRD §7.9): one
// source of truth, and it never reads a provider key itself. It needs only
// a token: its own assistant's (PERISKOPOS_AGENT_TOKEN, from Settings → AI
// assistants → Add assistant), or the shared one Periskopos wrote to its
// data folder. Either can read and ask for actions, nothing more
// (docs/AGENT-SAFETY.md).

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class PeriskoposError extends Error {}

// Where to look for the agent token when PERISKOPOS_DATA_DIR doesn't say: the
// installed app's data folder first (it's what normally runs), then this
// folder's (`npm run dev`). The one the running Periskopos accepts wins.
export function tokenFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.PERISKOPOS_DATA_DIR) return [DATA_DIR];
  return [...new Set([installedAppDataDir(), path.join(ROOT, "data")])];
}

export class PeriskoposClient {
  #baseUrl: string;
  #tokens: string[];
  #fetch: Fetch;
  #client: string | undefined;
  #own: boolean; // its own assistant's token (PERISKOPOS_AGENT_TOKEN), not the shared one

  // `token`: one, or several to try in turn (the first the server accepts
  // is kept).
  constructor({ baseUrl, token, fetchFn = fetch, own = false }: { baseUrl: string; token: string | string[]; fetchFn?: Fetch; own?: boolean }) {
    this.#baseUrl = baseUrl;
    this.#own = own;
    this.#tokens = Array.isArray(token) ? [...token] : [token];
    this.#fetch = fetchFn;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PeriskoposClient {
    const own = env.PERISKOPOS_AGENT_TOKEN?.trim();
    if (own) return new PeriskoposClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: own, own: true });
    const folders = tokenFolders(env);
    const tokens = folders.flatMap((dir) => {
      try {
        const token = readFileSync(path.join(dir, "token"), "utf8").trim();
        return token ? [token] : [];
      } catch {
        return [];
      }
    });
    if (tokens.length === 0) {
      throw new PeriskoposError(
        `Periskopos hasn't been started yet: there's no agent token in ${folders.join(" or ")}. Open the Periskopos app once.`,
      );
    }
    return new PeriskoposClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: tokens });
  }

  // Which AI assistant is on the other end (from MCP's clientInfo), so
  // Periskopos can say who asks and record who ran what.
  setClient(name: string | undefined) {
    this.#client = name;
  }

  async get<T>(apiPath: string): Promise<T> {
    return this.#send<T>("GET", apiPath);
  }

  // `timeoutMs`: an action waits for me to approve it on screen.
  // `signal`: the agent cancelled its call; hanging up tells the server to
  // stop asking me, so approving can't run it behind the agent's back.
  async post<T>(apiPath: string, body: unknown, { timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.#send<T>("POST", apiPath, body, timeoutMs, signal);
  }

  async #send<T>(method: string, apiPath: string, body?: unknown, timeoutMs = 60_000, cancel?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      // A refused token is refused before anything is done, so the next one
      // can be tried with the same request; the one that works is kept.
      for (;;) {
        const token = this.#tokens[0]!;
        res = await this.#fetch(`${this.#baseUrl}/api${apiPath}`, {
          method,
          headers: {
            "x-periskopos-token": token,
            ...(this.#client ? { "x-periskopos-client": this.#client } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout,
        });
        if (res.status !== 401) break;
        // Requests made at the same time: another may already have moved on
        // from this token, so try the current one rather than drop another.
        if (this.#tokens[0] !== token) continue;
        if (this.#tokens.length === 1) break;
        this.#tokens.shift();
      }
    } catch {
      // Not the same as "not running": the request got there, and a POST may
      // have done its work without our hearing back.
      if (timeout.aborted) {
        throw new PeriskoposError(
          method === "POST"
            ? "Periskopos gave no answer in time; the action may still have run. Check get_app (its recent actions) before retrying."
            : "Periskopos gave no answer in time. Try again in a moment.",
        );
      }
      if (cancel?.aborted) throw new PeriskoposError("The call was cancelled. Periskopos stops waiting for approval, so nothing is run.");
      throw new PeriskoposError(
        "Periskopos isn't running. Open the Periskopos app (it can start at login: tray menu → Start at login).",
      );
    }
    if (res.status === 401) {
      throw new PeriskoposError(
        this.#own
          ? "Periskopos rejected this assistant's token (PERISKOPOS_AGENT_TOKEN): it was revoked, or belongs to another Periskopos. Add the assistant again in Periskopos → Settings → AI assistants."
          : "Periskopos rejected the agent token. It may be running with a different data folder (PERISKOPOS_DATA_DIR) than this MCP server.",
      );
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new PeriskoposError(data.error ?? `Periskopos answered HTTP ${res.status}`);
    return data as T;
  }
}
