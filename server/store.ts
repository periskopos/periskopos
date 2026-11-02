import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { App, Connection, Service, ServiceType, User } from "../shared/types.ts";
import { keylessChecks, transaction } from "./db.ts";

// Every query about apps takes the owner's id (FR-U2): there is no
// "all apps" query.

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("base64url")}`;
const now = () => new Date().toISOString();

type UserRow = { id: string; name: string; email: string | null; created_at: string };
type AppRow = {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  url: string;
  icon_at: string | null; // when its favicon was fetched, if it has one
  notes: string | null;
  live: number;
  check_interval_min: number;
  protocol_endpoint: string | null;
  protocol_secret_ref: string | null;
};
type ConnectionRow = {
  id: string;
  app_id: string;
  type: string;
  service_id: string | null;
  resource: string;
  settings: string | null;
};

const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  ...(r.email ? { email: r.email } : {}),
  createdAt: r.created_at,
});

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  appId: r.app_id,
  type: r.type,
  ...(r.service_id ? { serviceId: r.service_id } : {}),
  resource: r.resource,
  ...(r.settings ? { settings: JSON.parse(r.settings) } : {}),
});

const toApp = (r: AppRow, connections: Connection[]): App => ({
  id: r.id,
  slug: r.slug,
  ownerId: r.owner_id,
  name: r.name,
  url: r.url,
  // Versioned, so a new icon isn't hidden by the window's cache of the old.
  ...(r.icon_at ? { icon: `/api/apps/${encodeURIComponent(r.slug)}/icon?v=${Date.parse(r.icon_at)}` } : {}),
  ...(r.notes ? { notes: r.notes } : {}),
  live: r.live === 1,
  checkIntervalMin: r.check_interval_min,
  ...(r.protocol_endpoint && r.protocol_secret_ref
    ? { protocol: { endpoint: r.protocol_endpoint, secretRef: r.protocol_secret_ref } }
    : {}),
  connections,
});

// ── Users ───────────────────────────────────────────────────────────────

// v1 has exactly one user (FR-U1).
export function getLocalUser(db: DatabaseSync): User | undefined {
  const row = db.prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get() as
    | UserRow
    | undefined;
  return row && toUser(row);
}

export function createUser(db: DatabaseSync, name: string): User {
  const user: User = { id: newId("u"), name, createdAt: now() };
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run(
    user.id,
    user.name,
    user.createdAt,
  );
  return user;
}

// ── Apps ────────────────────────────────────────────────────────────────

function connectionsOf(db: DatabaseSync, appIds: string[]): Map<string, Connection[]> {
  const byApp = new Map<string, Connection[]>(appIds.map((id) => [id, []]));
  if (appIds.length === 0) return byApp;
  const rows = db
    .prepare(
      `SELECT * FROM connections WHERE app_id IN (${appIds.map(() => "?").join(",")})
       ORDER BY rowid`,
    )
    .all(...appIds) as ConnectionRow[];
  for (const r of rows) byApp.get(r.app_id)!.push(toConnection(r));
  return byApp;
}

// An app with its favicon's date, when it has one for the URL it has now:
// an icon from before the URL was edited isn't this site's.
const SELECT_APP = `SELECT apps.*,
  (SELECT fetched_at FROM app_icons i WHERE i.app_id = apps.id AND i.page_url = apps.url AND i.data IS NOT NULL) AS icon_at
  FROM apps`;

export function listApps(db: DatabaseSync, ownerId: string): App[] {
  const rows = db
    .prepare(`${SELECT_APP} WHERE owner_id = ? ORDER BY name COLLATE NOCASE`)
    .all(ownerId) as AppRow[];
  const conns = connectionsOf(db, rows.map((r) => r.id));
  return rows.map((r) => toApp(r, conns.get(r.id)!));
}

export function getApp(db: DatabaseSync, ownerId: string, slug: string): App | undefined {
  const row = db
    .prepare(`${SELECT_APP} WHERE owner_id = ? AND slug = ?`)
    .get(ownerId, slug) as AppRow | undefined;
  return row && toApp(row, connectionsOf(db, [row.id]).get(row.id)!);
}

// The app as it is now, by its id (its slug changes with its name).
export function getAppById(db: DatabaseSync, id: string): App | undefined {
  const row = db.prepare(`${SELECT_APP} WHERE apps.id = ?`).get(id) as AppRow | undefined;
  return row && toApp(row, connectionsOf(db, [row.id]).get(row.id)!);
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "app";
}

function freeSlug(db: DatabaseSync, ownerId: string, base: string): string {
  const taken = db.prepare("SELECT 1 FROM apps WHERE owner_id = ? AND slug = ?");
  let slug = base;
  for (let n = 2; taken.get(ownerId, slug); n++) slug = `${base}-${n}`;
  return slug;
}

export type NewApp = { name: string; url: string; notes?: string; live?: boolean };

// A new app gets a `site` check for its URL straight away (FR-A1).
export function createApp(db: DatabaseSync, ownerId: string, input: NewApp): App {
  const id = newId("a");
  const slug = freeSlug(db, ownerId, slugify(input.name));
  transaction(db, () => {
    db.prepare(
      `INSERT INTO apps (id, owner_id, slug, name, url, notes, live, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ownerId, slug, input.name, input.url, input.notes ?? null, input.live === false ? 0 : 1, now());
    for (const check of keylessChecks(input.url)) insertConnection(db, id, check);
  });
  return getApp(db, ownerId, slug)!;
}

export type AppPatch = { name?: string; url?: string; notes?: string | null; live?: boolean; checkIntervalMin?: number };

export const CHECK_INTERVALS_MIN = [1, 2, 5, 10, 15, 30, 60];

export function updateApp(db: DatabaseSync, app: App, patch: AppPatch): App {
  transaction(db, () => {
    db.prepare(
      "UPDATE apps SET name = ?, url = ?, notes = ?, live = ?, check_interval_min = ? WHERE id = ?",
    ).run(
      patch.name ?? app.name,
      patch.url ?? app.url,
      patch.notes === undefined ? (app.notes ?? null) : patch.notes,
      (patch.live ?? app.live) ? 1 : 0,
      patch.checkIntervalMin ?? app.checkIntervalMin,
      app.id,
    );
    // The URL's own checks follow it: the site, its certificate, its domain.
    if (patch.url && patch.url !== app.url) {
      const before = keylessChecks(app.url);
      const after = keylessChecks(patch.url);
      for (const type of ["site", "ssl", "domain"] as const) {
        const old = before.find((c) => c.type === type);
        const next = after.find((c) => c.type === type);
        if (old && next) {
          // What was wrong with the old host isn't wrong with the new one:
          // its open problems end here, quietly (no notification), and the
          // new host is judged on its own checks.
          if (old.resource !== next.resource) {
            db.prepare(
              `UPDATE incidents SET ended_at = ? WHERE ended_at IS NULL AND connection_id IN
                 (SELECT id FROM connections WHERE app_id = ? AND type = ? AND resource = ?)`,
            ).run(now(), app.id, type, old.resource);
          }
          db.prepare("UPDATE connections SET resource = ? WHERE app_id = ? AND type = ? AND resource = ?").run(next.resource, app.id, type, old.resource);
        } else if (old && !next) {
          db.prepare("DELETE FROM connections WHERE app_id = ? AND type = ? AND resource = ?").run(app.id, type, old.resource);
        } else if (!old && next) {
          insertConnection(db, app.id, next);
        }
      }
    }
  });
  return getApp(db, app.ownerId, app.slug)!;
}

// The app's protocol endpoint (PRD §10.5); null removes it. The secret is
// only ever a variable name here: its value lives in .env.local.
export function setProtocol(db: DatabaseSync, app: App, protocol: { endpoint: string; secretRef: string } | null) {
  db.prepare("UPDATE apps SET protocol_endpoint = ?, protocol_secret_ref = ? WHERE id = ?").run(
    protocol?.endpoint ?? null,
    protocol?.secretRef ?? null,
    app.id,
  );
}

export function deleteApp(db: DatabaseSync, app: App): void {
  db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
}

// The app's favicon (server/icons.ts). Stored without data: looked, and
// found none.
export type StoredIcon = { pageUrl: string; fetchedAt: string; type?: string; data?: Uint8Array };

export function getAppIcon(db: DatabaseSync, appId: string): StoredIcon | undefined {
  const row = db.prepare("SELECT page_url, fetched_at, type, data FROM app_icons WHERE app_id = ?").get(appId) as
    | { page_url: string; fetched_at: string; type: string | null; data: Uint8Array | null }
    | undefined;
  if (!row) return undefined;
  return {
    pageUrl: row.page_url,
    fetchedAt: row.fetched_at,
    ...(row.type && row.data ? { type: row.type, data: row.data } : {}),
  };
}

export function setAppIcon(db: DatabaseSync, appId: string, icon: StoredIcon): void {
  db.prepare(
    `INSERT INTO app_icons (app_id, page_url, fetched_at, type, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET page_url = excluded.page_url, fetched_at = excluded.fetched_at,
       type = excluded.type, data = excluded.data`,
  ).run(appId, icon.pageUrl, icon.fetchedAt, icon.type ?? null, icon.data ?? null);
}

// ── Connections ─────────────────────────────────────────────────────────

export type NewConnection = {
  type: string;
  resource: string;
  serviceId?: string;
  settings?: Record<string, unknown>;
};

function insertConnection(db: DatabaseSync, appId: string, input: NewConnection): Connection {
  const conn: Connection = {
    id: newId("c"),
    appId,
    type: input.type,
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    resource: input.resource,
    ...(input.settings ? { settings: input.settings } : {}),
  };
  db.prepare(
    `INSERT INTO connections (id, app_id, type, service_id, resource, settings, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conn.id,
    appId,
    conn.type,
    conn.serviceId ?? null,
    conn.resource,
    conn.settings ? JSON.stringify(conn.settings) : null,
    now(),
  );
  return conn;
}

export function updateConnectionSettings(db: DatabaseSync, app: App, connectionId: string, settings: Record<string, unknown>): boolean {
  const result = db
    .prepare("UPDATE connections SET settings = ? WHERE id = ? AND app_id = ?")
    .run(Object.keys(settings).length ? JSON.stringify(settings) : null, connectionId, app.id);
  return Number(result.changes) > 0;
}

// The connection an app already has for the same thing: the same kind,
// account and resource. Other settings (a branch, a label) don't make it a
// second one; only another set of folders of one repository does (a
// monorepo's apps).
export function sameConnection(app: App, input: NewConnection): Connection | undefined {
  const folders = (s?: Record<string, unknown>) => (Array.isArray(s?.paths) ? (s.paths as string[]).map(String).sort().join("\n") : "");
  return app.connections.find(
    (c) => c.type === input.type && c.resource === input.resource && (c.serviceId ?? null) === (input.serviceId ?? null) && folders(c.settings) === folders(input.settings),
  );
}

// The same thing twice (a double click, two tabs) is one connection: the
// second add gets the first one back, so its check isn't listed, and run,
// twice. The connect route refuses it outright; this is the last guard.
export function addConnection(db: DatabaseSync, app: App, input: NewConnection): Connection {
  const current = getAppById(db, app.id) ?? app;
  return sameConnection(current, input) ?? insertConnection(db, app.id, input);
}

// ── Services (my accounts) ──────────────────────────────────────────────

type ServiceRow = {
  id: string;
  owner_id: string;
  type: ServiceType;
  name: string;
  secret_ref: string | null;
  can_write: number;
  last_test: string | null;
  paid_plan?: number;
  plan_usage?: string | null;
};

function lastTestOf(json: string | null): Service["lastTest"] {
  if (!json) return undefined;
  try {
    const t = JSON.parse(json) as Service["lastTest"];
    return t && typeof t.ok === "boolean" && typeof t.message === "string" && typeof t.at === "string" && (t.expiresAt === undefined || typeof t.expiresAt === "string")
      ? t
      : undefined;
  } catch {
    return undefined;
  }
}

function planUsageOf(json: string | null | undefined): Service["planUsage"] {
  if (!json) return undefined;
  try {
    const u = JSON.parse(json) as NonNullable<Service["planUsage"]>;
    if (typeof u?.at !== "string") return undefined;
    if ("error" in u) return typeof u.error === "string" ? u : undefined;
    return Array.isArray(u.meters) && u.meters.every((m) => typeof m.label === "string" && typeof m.used === "number" && typeof m.limit === "number" && typeof m.resetsAt === "string") ? u : undefined;
  } catch {
    return undefined;
  }
}

const toService = (r: ServiceRow): Service => ({
  id: r.id,
  ownerId: r.owner_id,
  type: r.type,
  name: r.name,
  ...(r.secret_ref ? { secretRef: r.secret_ref } : {}),
  canWrite: r.can_write === 1,
  ...(lastTestOf(r.last_test) ? { lastTest: lastTestOf(r.last_test)! } : {}),
  ...(r.paid_plan === 1 ? { paidPlan: true as const } : {}),
  ...(planUsageOf(r.plan_usage) ? { planUsage: planUsageOf(r.plan_usage)! } : {}),
});

// On the paid plan: nothing to watch, so the last reading goes too.
export function setServicePaidPlan(db: DatabaseSync, service: Service, paid: boolean) {
  db.prepare("UPDATE services SET paid_plan = ?, plan_usage = NULL WHERE id = ?").run(paid ? 1 : 0, service.id);
}

export function setServicePlanUsage(db: DatabaseSync, service: Service, usage: Service["planUsage"]) {
  db.prepare("UPDATE services SET plan_usage = ? WHERE id = ?").run(usage ? JSON.stringify(usage) : null, service.id);
}

// What Test found; undefined forgets it (the key changed, so it no longer says anything).
export function setServiceLastTest(db: DatabaseSync, service: Service, result: Service["lastTest"]) {
  db.prepare("UPDATE services SET last_test = ? WHERE id = ?").run(result ? JSON.stringify(result) : null, service.id);
}

export function listServices(db: DatabaseSync, ownerId: string): Service[] {
  const rows = db
    .prepare("SELECT * FROM services WHERE owner_id = ? ORDER BY type, name COLLATE NOCASE")
    .all(ownerId) as ServiceRow[];
  return rows.map(toService);
}

export function getService(db: DatabaseSync, ownerId: string, id: string): Service | undefined {
  const row = db.prepare("SELECT * FROM services WHERE owner_id = ? AND id = ?").get(ownerId, id) as
    | ServiceRow
    | undefined;
  return row && toService(row);
}

export type NewService = { type: ServiceType; name: string; secretRef?: string; canWrite: boolean };

export function createService(db: DatabaseSync, ownerId: string, input: NewService): Service {
  const id = newId("s");
  db.prepare(
    "INSERT INTO services (id, owner_id, type, name, secret_ref, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, ownerId, input.type, input.name, input.secretRef ?? null, input.canWrite ? 1 : 0, now());
  return getService(db, ownerId, id)!;
}

// Where its key now lives: a pasted GitHub token replaces the gh login.
export function setServiceSecretRef(db: DatabaseSync, service: Service, secretRef: string) {
  db.prepare("UPDATE services SET secret_ref = ? WHERE id = ?").run(secretRef, service.id);
}

export function setServiceCanWrite(db: DatabaseSync, service: Service, canWrite: boolean) {
  db.prepare("UPDATE services SET can_write = ? WHERE id = ?").run(canWrite ? 1 : 0, service.id);
}

// Apps with a connection to each of the user's services.
export function serviceUsage(db: DatabaseSync, ownerId: string): Map<string, { slug: string; name: string }[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT c.service_id, a.slug, a.name FROM connections c JOIN apps a ON a.id = c.app_id
       WHERE a.owner_id = ? AND c.service_id IS NOT NULL ORDER BY a.name COLLATE NOCASE`,
    )
    .all(ownerId) as { service_id: string; slug: string; name: string }[];
  const out = new Map<string, { slug: string; name: string }[]>();
  for (const r of rows) out.set(r.service_id, [...(out.get(r.service_id) ?? []), { slug: r.slug, name: r.name }]);
  return out;
}

// Removes the service and every connection that used it (FR-S4).
export function deleteService(db: DatabaseSync, service: Service) {
  transaction(db, () => {
    db.prepare("DELETE FROM connections WHERE service_id = ?").run(service.id);
    db.prepare("DELETE FROM services WHERE id = ?").run(service.id);
  });
}

export function deleteConnection(db: DatabaseSync, app: App, connectionId: string): boolean {
  const result = db
    .prepare("DELETE FROM connections WHERE id = ? AND app_id = ?")
    .run(connectionId, app.id);
  return Number(result.changes) > 0;
}
