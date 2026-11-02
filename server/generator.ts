import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { App, GeneratedProtocol } from "../shared/types.ts";
import { ROOT } from "./config.ts";
import { badRequest } from "./errors.ts";
import { protocolSecretRef } from "./protocol.ts";
import { writeSecret } from "./keys/secrets.ts";

// The protocol code generator (PRD §7.7). It writes a secret into .env.local
// and hands back the endpoint code and the commands to deploy it. It never
// writes into another app's repository: the files are shown to be copied.
// The templates in templates/<runtime>/ are the reference implementation of
// the protocol; they change when the protocol does.

const RUNTIMES = {
  "supabase-edge": { label: "Supabase Edge Function", dir: "supabase-edge", file: "supabase/functions/periskopos/index.ts" },
} as const;

export type RuntimeId = keyof typeof RUNTIMES;
export const RUNTIME_LABELS = Object.fromEntries(Object.entries(RUNTIMES).map(([id, r]) => [id, r.label]));
export const CAPABILITIES = ["metrics", "actions"] as const;

// The app's name goes into a string and a comment: neither can be broken out of.
const forString = (s: string) => JSON.stringify(s);
const forComment = (s: string) => s.replace(/[\r\n]+/g, " ").replaceAll(String.fromCharCode(0x2028), " ").replaceAll(String.fromCharCode(0x2029), " ").slice(0, 100);

export function renderTemplate(runtime: RuntimeId, { appName, capabilities }: { appName: string; capabilities: string[] }): string {
  const template = readFileSync(path.join(ROOT, "templates", RUNTIMES[runtime].dir, "index.ts"), "utf8");
  return template
    .replace("__APP_NAME_COMMENT__", () => forComment(appName))
    .replace('"__APP_NAME__"', () => forString(appName))
    // The placeholder is a valid JSON list, so the raw template is a valid file.
    .replace('["__CAPABILITIES__"]', () => JSON.stringify(capabilities));
}

export function generateProtocol(app: App, input: { runtime?: unknown; capabilities?: unknown }): GeneratedProtocol {
  const runtime = String(input.runtime ?? "supabase-edge") as RuntimeId;
  // Own keys only: "toString" or "constructor" are not runtimes.
  if (!Object.hasOwn(RUNTIMES, runtime)) throw badRequest(`Unknown runtime "${runtime}"`);
  const wanted = Array.isArray(input.capabilities) ? input.capabilities : ["metrics"];
  const capabilities = CAPABILITIES.filter((c) => wanted.includes(c));
  if (capabilities.length === 0) throw badRequest("Choose at least one capability");

  // A new secret each time: generating again rotates it (the endpoint must
  // be redeployed with it).
  const secret = randomBytes(32).toString("base64url");
  const secretRef = protocolSecretRef(app.slug);
  // Everything that can fail comes first and the secret is written last, so
  // a failure never replaces the app's secret with one nobody has seen.
  const files = [{ path: RUNTIMES[runtime].file, content: renderTemplate(runtime, { appName: app.name, capabilities: [...capabilities] }) }];
  writeSecret(secretRef, secret);

  const ref = app.connections.find((c) => c.type === "supabase")?.resource ?? "<project-ref>";
  const known = !ref.startsWith("<");
  return {
    runtime,
    secretRef,
    secret,
    files,
    commands: [
      `supabase secrets set PERISKOPOS_SECRET=${secret} --project-ref ${ref}`,
      `supabase functions deploy periskopos --no-verify-jwt --project-ref ${ref}`,
    ],
    ...(known ? { endpointHint: `https://${ref}.supabase.co/functions/v1/periskopos` } : {}),
  };
}
