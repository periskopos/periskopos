import type { DatabaseSync } from "node:sqlite";
import { ACCOUNTS, connectionLabel } from "../shared/catalog.ts";
import type { App, Service, ServiceType, Settings, SetupPlanView } from "../shared/types.ts";
import { transaction } from "./db.ts";
import { badRequest } from "./errors.ts";
import { SERVICE_TYPES, integrations } from "./integrations/index.ts";
import { updateSettings } from "./settings.ts";
import * as store from "./store.ts";
import type { NewConnection } from "./store.ts";
import { httpUrl, requiredText, text } from "./validate.ts";

// Settings → Data → Import: the file "Export my setup" makes, read back in.
//
// A file can come from anywhere, so everything in it goes through the same
// checks as adding it by hand, and it only ever adds. An app already here stays
// as it is, apart from connections it can now have through an account. Keys
// aren't in the file, so accounts are added by hand; nothing here runs an action.

const MAX_APPS = 500;
const MAX_CONNECTIONS = 100;

// The only settings a file may change, and only when asked. Left out: AI
// assistants (a file must never let them in), where alerts go (it could send
// them to someone else), watching (it could stop it), how long checks are kept
// (it could delete history) and pauses (they're about a moment, and this
// computer's apps).
const SETTINGS_FROM_A_FILE = {
  notificationsEnabled: "Notify me",
  incidentAlarm: "Alarm on a provider's incident",
  alertOutages: "Alerts: outages",
  alertDeploys: "Alerts: deploys",
  alertAccounts: "Alerts: accounts",
  alertProviders: "Alerts: providers",
  alertWarnings: "Alerts: warnings",
  defaultCheckIntervalMin: "Check new apps every (minutes)",
} as const;
type SettingFromAFile = keyof typeof SETTINGS_FROM_A_FILE;

// What an export carries of the settings: only what a file may set back, so a copy pasted
// into a report or sent to someone holds no address, chat id or pause.
export function settingsForAFile(settings: Settings): Pick<Settings, SettingFromAFile> {
  return Object.fromEntries((Object.keys(SETTINGS_FROM_A_FILE) as SettingFromAFile[]).map((key) => [key, settings[key]])) as Pick<Settings, SettingFromAFile>;
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

// What one line of the file's connections came to.
type Read =
  | { kind: "ready"; label: string; input: NewConnection }
  | { kind: "waiting"; label: string; input: NewConnection } // needs an account this computer doesn't have
  | { kind: "unread"; type: string; label: string; why: string };

type NewAppPlan = {
  name: string;
  url: string;
  notes?: string;
  live: boolean;
  checkIntervalMin?: number;
  listsConnections: boolean;
  reads: Read[];
  endpoint: boolean;
};

export type SetupWork = {
  plan: SetupPlanView;
  add: NewAppPlan[];
  connect: { app: App; input: NewConnection }[];
  settingsPatch: Partial<Settings>;
};

const sameUrl = (url: string) => {
  try {
    return new URL(url).href.replace(/\/+$/, "");
  } catch {
    return url;
  }
};

function serviceFor(services: Service[], type: ServiceType, wanted: unknown): Service | undefined {
  const ofType = services.filter((s) => s.type === type);
  // The one it used by name; or, with only one of that kind here, that one.
  return ofType.find((s) => s.name === wanted) ?? (ofType.length === 1 ? ofType[0] : undefined);
}

function readConnection(raw: unknown, services: Service[]): Read {
  if (!isObject(raw) || typeof raw.type !== "string") return { kind: "unread", type: "", label: "A connection", why: "It doesn't say what it is" };
  const type = raw.type.slice(0, 40);
  // Own keys only: "constructor" or "toString" must not pass as a type.
  const integration = Object.hasOwn(integrations, type) ? integrations[type] : undefined;
  if (!integration) return { kind: "unread", type, label: type, why: "This version doesn't know this kind of connection" };
  try {
    const parsed = integration.parse({ resource: raw.resource, settings: raw.settings });
    const label = connectionLabel({ type, ...(parsed.settings ? { settings: parsed.settings } : {}) });
    const input: NewConnection = { type, resource: parsed.resource, ...(parsed.settings ? { settings: parsed.settings } : {}) };
    if (!integration.needsService) return { kind: "ready", label, input };
    const service = integration.serviceType ? serviceFor(services, integration.serviceType, raw.account) : undefined;
    // What a key would be used on, and which key: a file chooses the first.
    const what = `${label} ${input.resource}`;
    return service ? { kind: "ready", label: `${what} (through ${service.name})`, input: { ...input, serviceId: service.id } } : { kind: "waiting", label: what, input };
  } catch (err) {
    return { kind: "unread", type, label: connectionLabel({ type }), why: (err as Error).message };
  }
}

// One of these is on the app already, through whichever account: not twice.
const alreadyHas = (app: App, input: NewConnection) =>
  app.connections.some((c) => store.sameConnection({ ...app, connections: [c] }, { ...input, ...(c.serviceId ? { serviceId: c.serviceId } : { serviceId: undefined }) }));

function plannedSettings(raw: unknown, current: Settings): SetupPlanView["settings"] {
  if (!isObject(raw)) return [];
  return (Object.keys(SETTINGS_FROM_A_FILE) as SettingFromAFile[]).flatMap((key) => {
    const to = raw[key];
    const fine = key === "defaultCheckIntervalMin" ? store.CHECK_INTERVALS_MIN.includes(to as number) : typeof to === "boolean";
    return fine && to !== current[key] ? [{ key, label: SETTINGS_FROM_A_FILE[key], from: current[key], to: to as boolean | number }] : [];
  });
}

// What the file would do, changing nothing. A file that isn't a setup file is
// refused outright; a bad line in a good one is reported and the rest goes on.
export function planImport(db: DatabaseSync, ownerId: string, settings: Settings, file: unknown): SetupWork {
  if (!isObject(file) || typeof file.periskopos !== "string" || !Array.isArray(file.apps)) throw badRequest("This isn't a setup file from Periskopos: use the one Export my setup makes");
  if (file.apps.length > MAX_APPS) throw badRequest(`This file lists more than ${MAX_APPS} apps`);

  const apps = store.listApps(db, ownerId);
  const services = store.listServices(db, ownerId);
  const here = new Map<string, App[]>();
  for (const a of apps) here.set(sameUrl(a.url), [...(here.get(sameUrl(a.url)) ?? []), a]);
  // Which of mine a line means. Two apps can share a URL, so a name decides
  // when there's more than one on either side.
  const inFile = new Map<string, number>();
  for (const raw of file.apps) if (isObject(raw) && typeof raw.url === "string") inFile.set(sameUrl(raw.url), (inFile.get(sameUrl(raw.url)) ?? 0) + 1);
  const mineFor = (name: string, url: string): App | "unclear" | undefined => {
    const mine = here.get(sameUrl(url)) ?? [];
    const named = mine.find((a) => a.name === name);
    if (named || mine.length === 0) return named;
    if ((inFile.get(sameUrl(url)) ?? 0) > 1) return undefined;
    return mine.length === 1 ? mine[0] : "unclear";
  };

  const plan: SetupPlanView = {
    ...(typeof file.exportedAt === "string" && !Number.isNaN(Date.parse(file.exportedAt)) ? { exportedAt: file.exportedAt } : {}),
    version: file.periskopos.slice(0, 40),
    newApps: [],
    existing: [],
    refused: [],
    accounts: [],
    settings: plannedSettings(file.settings, settings),
  };
  const add: NewAppPlan[] = [];
  const connect: SetupWork["connect"] = [];

  for (const raw of file.apps) {
    const shownName = isObject(raw) && typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : "An app";
    try {
      if (!isObject(raw)) throw badRequest("It isn't an app");
      const name = requiredText(raw.name, "Name", 80);
      const url = httpUrl(raw.url, "URL");
      const list: unknown[] = Array.isArray(raw.connections) ? raw.connections : [];
      if (list.length > MAX_CONNECTIONS) throw badRequest(`It lists more than ${MAX_CONNECTIONS} connections`);
      const reads = list.map((c) => readConnection(c, services));

      const current = mineFor(name, url);
      if (current === "unclear") throw badRequest("You have several apps at this address, and none has this name");
      if (current) {
        // Only what an account brings: a check removed by hand stays removed.
        const missing = reads.filter((r): r is Exclude<Read, { kind: "unread" }> => r.kind !== "unread" && Object.hasOwn(integrations, r.input.type) && integrations[r.input.type]!.needsService && !alreadyHas(current, r.input));
        const ready = missing.filter((r) => r.kind === "ready");
        for (const r of ready) connect.push({ app: current, input: r.input });
        plan.existing.push({ name: current.name, connections: ready.map((r) => r.label), waiting: missing.filter((r) => r.kind === "waiting").map((r) => r.label) });
        continue;
      }

      const interval = store.CHECK_INTERVALS_MIN.includes(raw.checkIntervalMin as number) ? (raw.checkIntervalMin as number) : undefined;
      const notes = text(raw.notes, "Notes", { max: 2000, optional: true });
      const endpoint = typeof raw.endpoint === "string" && raw.endpoint !== "";
      add.push({ name, url, ...(notes ? { notes } : {}), live: raw.live !== false, checkIntervalMin: interval ?? settings.defaultCheckIntervalMin, listsConnections: Array.isArray(raw.connections), reads, endpoint });
      plan.newApps.push({
        name,
        url,
        connections: reads.filter((r) => r.kind === "ready").map((r) => r.label),
        waiting: reads.filter((r) => r.kind === "waiting").map((r) => r.label),
        unread: reads.flatMap((r) => (r.kind === "unread" ? [`${r.label}: ${r.why}`] : [])),
        endpoint,
      });
    } catch (err) {
      plan.refused.push({ name: shownName, why: (err as Error).message });
    }
  }

  // Accounts can't come over: their keys aren't in the file.
  const seen = new Set<string>();
  for (const raw of Array.isArray(file.accounts) ? file.accounts : []) {
    if (!isObject(raw) || typeof raw.type !== "string" || typeof raw.name !== "string" || !Object.hasOwn(SERVICE_TYPES, raw.type)) continue;
    const type = raw.type as ServiceType;
    const name = raw.name.slice(0, 60);
    const id = `${type}\n${name}`;
    if (seen.has(id) || services.some((s) => s.type === type && s.name === name)) continue;
    seen.add(id);
    plan.accounts.push({ type, label: ACCOUNTS[type].label, name });
  }

  const settingsPatch = Object.fromEntries(plan.settings.map((s) => [s.key, s.to])) as Partial<Settings>;
  return { plan, add, connect, settingsPatch };
}

// A new app starts with its keyless checks. The file says which of them it
// kept and how they were set up, so a check removed by hand stays removed.
function addApp(db: DatabaseSync, ownerId: string, planned: NewAppPlan): App {
  const app = store.createApp(db, ownerId, {
    name: planned.name,
    url: planned.url,
    ...(planned.notes ? { notes: planned.notes } : {}),
    live: planned.live,
    ...(planned.checkIntervalMin ? { checkIntervalMin: planned.checkIntervalMin } : {}),
  });
  const inputs = planned.reads.flatMap((r) => (r.kind === "ready" ? [r.input] : []));
  for (const input of inputs) {
    const made = app.connections.find((c) => c.type === input.type && c.resource === input.resource);
    if (!made) store.addConnection(db, app, input);
    else if (input.settings && Object.keys(input.settings).length > 0) store.updateConnectionSettings(db, app, made.id, input.settings);
  }
  if (planned.listsConnections) {
    // A line it couldn't read isn't a check removed by hand.
    const unreadTypes = new Set(planned.reads.flatMap((r) => (r.kind === "unread" ? [r.type] : [])));
    for (const made of app.connections) {
      if (made.type !== "site" && !unreadTypes.has(made.type) && !inputs.some((i) => i.type === made.type && i.resource === made.resource)) store.deleteConnection(db, app, made.id);
    }
  }
  return store.getAppById(db, app.id) ?? app;
}

// Carries out a plan. `useSettings` is the person's choice on screen.
// All of it or none: a failure half way leaves nothing behind.
export function applyImport(db: DatabaseSync, ownerId: string, work: SetupWork, useSettings: boolean): App[] {
  return transaction(db, () => {
    const added = work.add.map((planned) => addApp(db, ownerId, planned));
    for (const { app, input } of work.connect) store.addConnection(db, app, input);
    if (useSettings && Object.keys(work.settingsPatch).length > 0) updateSettings(db, ownerId, work.settingsPatch);
    return added;
  });
}
