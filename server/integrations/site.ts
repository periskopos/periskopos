import { SLOW_CHECKS_DEFAULT, SLOW_CHECKS_RANGE, SLOW_MS_RANGE } from "../../shared/catalog.ts";
import { duration } from "../../shared/format.ts";
import type { CheckResult, Connection } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { httpUrl, text } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration } from "./types.ts";
import { APP_USER_AGENT } from "../config.ts";

const TIMEOUT_MS = 10_000;
// A page is read this far for the expected content, and no further: a
// marker past the first megabytes is not what a status check is for.
const MAX_BODY_BYTES = 2_000_000;

// A field of a JSON health endpoint: "ok", "checks.db", or "status=healthy".
const JSON_FIELD = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*(=.{1,100})?$/;

export const site: Integration = {
  ...described("site"),
  needsLiveApp: true,

  notice(event, app, reason, downForMs) {
    return event === "down"
      ? { title: `${app} is down`, body: reason }
      : { title: `${app} is back up`, body: `It was down for ${duration(downForMs)}.` };
  },

  // Every setting is optional; one that's set must make sense, so a typo
  // is said at once rather than read as "off".
  parse({ resource, settings }) {
    const s = (settings ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const expect = s.expectStatus;
    if (typeof expect === "number" && Number.isInteger(expect) && expect >= 100 && expect < 600) out.expectStatus = expect;

    const label = text(s.label, "Name", { max: 40, optional: true });
    if (label) out.label = label;
    const expectText = text(s.expectText, "Text the page must contain", { max: 200, optional: true });
    if (expectText) out.expectText = expectText;
    const expectJson = text(s.expectJson, "JSON field", { max: 200, optional: true });
    if (expectJson) {
      if (!JSON_FIELD.test(expectJson)) throw badRequest("JSON field must be a field name like ok, checks.db or status=healthy");
      out.expectJson = expectJson;
    }

    const slowMs = whole(s.slowMs, "Slow after (ms)", SLOW_MS_RANGE);
    if (slowMs !== undefined) {
      out.slowMs = slowMs;
      out.slowChecks = whole(s.slowChecks, "Checks in a row", SLOW_CHECKS_RANGE) ?? SLOW_CHECKS_DEFAULT;
    }
    return { resource: httpUrl(resource, "URL"), ...(Object.keys(out).length ? { settings: out } : {}) };
  },

  slowness(conn) {
    const overMs = conn.settings?.slowMs;
    if (typeof overMs !== "number") return undefined;
    const checks = conn.settings?.slowChecks;
    return { overMs, checks: typeof checks === "number" ? checks : SLOW_CHECKS_DEFAULT };
  },

  async check(conn): Promise<CheckResult> {
    const started = performance.now();
    const at = new Date().toISOString();
    try {
      const res = await fetch(conn.resource, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": `${APP_USER_AGENT} (status check)` },
      });
      const ms = Math.round(performance.now() - started);
      const expect = conn.settings?.expectStatus;
      const ok = typeof expect === "number" ? res.status === expect : res.ok;
      if (!ok) {
        await res.body?.cancel();
        // The site answered, and refused this check: a firewall or a rate limit
        // says nothing about whether it's up for its visitors.
        if (res.status === 403 || res.status === 429) {
          return { state: "unknown", at, ms, httpStatus: res.status, detail: `Answered HTTP ${res.status}: it may be blocking this check, so it can't tell whether the site is up` };
        }
        return { state: "down", at, ms, httpStatus: res.status, detail: `Answered HTTP ${res.status}` };
      }
      const wrong = await contentProblem(conn, res);
      if (wrong) return { state: "down", at, ms, httpStatus: res.status, detail: wrong };
      const slow = site.slowness!(conn);
      const elsewhere = redirectedElsewhere(conn, res);
      const notes = [
        slow && ms > slow.overMs ? `Slow: ${ms} ms, over ${slow.overMs} ms` : undefined,
        elsewhere ? `Answered from ${elsewhere}, so this only shows that host is up. Change the address, or set text the page must contain` : undefined,
      ].filter(Boolean);
      return {
        state: "up",
        at,
        ms,
        httpStatus: res.status,
        ...(notes.length ? { summary: notes.join(" · ") } : {}),
      };
    } catch (err) {
      return { state: "down", at, detail: describe(err) };
    }
  },
};

function whole(value: unknown, field: string, [min, max]: readonly [number, number]): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}

// The other host a check ended up on, when it did: a login provider, a parking
// page, a Wi-Fi sign-in page. That answer is a fact about that host, so it's
// said; it isn't called down, as plenty of sites redirect on purpose. Not when
// the page's content is checked (it was the right page), and www, or another
// name under the same address, is the same site.
function redirectedElsewhere(conn: Connection, res: Response): string | undefined {
  if (typeof conn.settings?.expectText === "string" || typeof conn.settings?.expectJson === "string") return undefined;
  try {
    const bare = (url: string) => new URL(url).hostname.replace(/^www\./, "");
    const [asked, answered] = [bare(conn.resource), bare(res.url)];
    return asked === answered || answered.endsWith(`.${asked}`) || asked.endsWith(`.${answered}`) ? undefined : answered;
  } catch {
    return undefined; // no final address to compare (a test's stand-in response)
  }
}

// What's wrong with a page that answered fine: it lacks the text it should
// have (an error page, an empty app shell), or its health field says no.
async function contentProblem(conn: Connection, res: Response): Promise<string | undefined> {
  const wantText = conn.settings?.expectText;
  const wantJson = conn.settings?.expectJson;
  if (typeof wantText !== "string" && typeof wantJson !== "string") {
    await res.body?.cancel();
    return undefined;
  }
  const body = await readBody(res);
  if (typeof wantText === "string" && !body.toLowerCase().includes(wantText.toLowerCase())) {
    return `The page doesn't contain “${wantText}”`;
  }
  if (typeof wantJson === "string") return jsonProblem(body, wantJson);
  return undefined;
}

async function readBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= MAX_BODY_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return out + decoder.decode();
}

// "ok" must be there and not false or null; "status=healthy" must be that
// value, compared as text so "true" and true, "1" and 1 are the same.
export function jsonProblem(body: string, want: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return "Didn't answer JSON";
  }
  const eq = want.indexOf("=");
  const path = eq === -1 ? want : want.slice(0, eq);
  const expected = eq === -1 ? undefined : want.slice(eq + 1);
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return `The answer has no “${path}”`;
    value = (value as Record<string, unknown>)[key];
  }
  if (expected !== undefined) {
    const shown = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    return shown === expected ? undefined : `“${path}” is ${shown.slice(0, 60)}, not ${expected}`;
  }
  return value === false || value === null ? `“${path}” is ${value}` : undefined;
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError") return `No answer within ${TIMEOUT_MS / 1000} s`;
  switch (e.cause?.code) {
    case "ENOTFOUND":
      return "Domain not found (DNS)";
    case "ECONNREFUSED":
      return "Connection refused";
    case "ECONNRESET":
      return "Connection reset";
    case "CERT_HAS_EXPIRED":
      return "SSL certificate has expired";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "SSL certificate doesn't match the domain";
  }
  return e.cause?.code ?? e.message ?? "Request failed";
}
