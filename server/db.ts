import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Each entry moves the schema up one version (PRAGMA user_version).
// Never edit a shipped migration; add a new one.
const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE apps (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL REFERENCES users(id),
    slug                TEXT NOT NULL,
    name                TEXT NOT NULL,
    url                 TEXT NOT NULL,
    icon                TEXT,
    notes               TEXT,
    check_interval_min  INTEGER NOT NULL DEFAULT 5,
    protocol_endpoint   TEXT,
    protocol_secret_ref TEXT,
    created_at          TEXT NOT NULL,
    UNIQUE (owner_id, slug)
  );

  CREATE TABLE connections (
    id          TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    service_id  TEXT,
    resource    TEXT NOT NULL,
    settings    TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX connections_app ON connections(app_id);
  `,
  // M2: the watcher's history.
  `
  CREATE TABLE checks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    connection_id  TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    at             TEXT NOT NULL,
    state          TEXT NOT NULL,
    ms             INTEGER,
    http_status    INTEGER,
    detail         TEXT
  );
  CREATE INDEX checks_connection ON checks(connection_id, id);
  CREATE INDEX checks_app_at ON checks(app_id, at);

  CREATE TABLE incidents (
    id             TEXT PRIMARY KEY,
    app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    connection_id  TEXT REFERENCES connections(id) ON DELETE CASCADE,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    reason         TEXT NOT NULL
  );
  CREATE INDEX incidents_app ON incidents(app_id, started_at);

  -- When the watcher was running: gaps between periods are "not watched".
  CREATE TABLE watch_periods (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL
  );

  CREATE TABLE daily_summaries (
    app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    day             TEXT NOT NULL,
    uptime_pct      REAL,
    watched_min     INTEGER NOT NULL,
    incidents       INTEGER NOT NULL,
    avg_ms          INTEGER,
    max_ms          INTEGER,
    deploys         INTEGER NOT NULL DEFAULT 0,
    failed_deploys  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, day)
  );

  CREATE TABLE settings (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,
  // M3: services (my accounts), and incidents that aren't outages.
  `
  CREATE TABLE services (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    secret_ref  TEXT,
    can_write   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  -- outage (counts against uptime), deploy, ci
  ALTER TABLE incidents ADD COLUMN kind TEXT NOT NULL DEFAULT 'outage';
  ALTER TABLE checks ADD COLUMN summary TEXT;
  `,
  // M4: provider status pages, and SSL + domain checks for existing apps.
  (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE provider_status (
        provider     TEXT PRIMARY KEY,
        checked_at   TEXT NOT NULL,
        indicator    TEXT NOT NULL,
        description  TEXT NOT NULL,
        incidents    TEXT NOT NULL DEFAULT '[]'
      );
    `);
    const apps = db.prepare("SELECT id, url FROM apps").all() as { id: string; url: string }[];
    const has = db.prepare("SELECT 1 FROM connections WHERE app_id = ? AND type = ?");
    const add = db.prepare(
      "INSERT INTO connections (id, app_id, type, resource, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const app of apps) {
      for (const conn of keylessChecks(app.url).filter((c) => c.type !== "site")) {
        if (!has.get(app.id, conn.type)) {
          add.run(`c_${randomBytes(8).toString("base64url")}`, app.id, conn.type, conn.resource, new Date().toISOString());
        }
      }
    }
  },
  // M5: what was done through the actions API, from the UI or from Claude.
  `
  CREATE TABLE activity (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    at         TEXT NOT NULL,
    action_id  TEXT NOT NULL,
    label      TEXT NOT NULL,
    source     TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    message    TEXT NOT NULL
  );
  CREATE INDEX activity_app ON activity(app_id, at);
  `,
  // An app can be registered before it's launched.
  "ALTER TABLE apps ADD COLUMN live INTEGER NOT NULL DEFAULT 1",
  // What the last Test of a service's key found (JSON), so the list says
  // whether the key works, not only whether there is one.
  "ALTER TABLE services ADD COLUMN last_test TEXT",
  // Which AI assistant ran an action (MCP's clientInfo), for the history.
  "ALTER TABLE activity ADD COLUMN agent TEXT",
  // Each app's favicon, fetched from its site (server/icons.ts). No data:
  // looked, and found none.
  `
  CREATE TABLE app_icons (
    app_id      TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    page_url    TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    type        TEXT,
    data        BLOB
  );
  `,
  // Where to see more about a check's result (JSON { url, label }): the
  // failed build, say.
  "ALTER TABLE checks ADD COLUMN link TEXT",
  // An account on its provider's paid plan (no free limit to watch), and
  // how much of the free plan's limit it last used (JSON).
  `
  ALTER TABLE services ADD COLUMN paid_plan INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE services ADD COLUMN plan_usage TEXT;
  `,
  // An incident I marked as a false alarm: the app was fine, the check
  // wasn't (PRD §12, no false "down" notifications).
  "ALTER TABLE incidents ADD COLUMN false_alarm INTEGER NOT NULL DEFAULT 0",
  // AI assistants, one each (server/agents/agents.ts): the hash of its token, what
  // it may see and do, a rule per action, grants for a while; and every
  // request an assistant makes.
  `
  CREATE TABLE agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT,
    apps          TEXT NOT NULL DEFAULT '"all"',
    access        TEXT NOT NULL DEFAULT 'ask',
    rules         TEXT NOT NULL DEFAULT '{}',
    grants        TEXT NOT NULL DEFAULT '[]',
    legacy        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE agent_audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id  TEXT NOT NULL,
    at        TEXT NOT NULL,
    client    TEXT,
    method    TEXT NOT NULL,
    path      TEXT NOT NULL,
    app_slug  TEXT,
    outcome   TEXT NOT NULL,
    status    INTEGER NOT NULL,
    detail    TEXT
  );
  CREATE INDEX agent_audit_at ON agent_audit (at);
  `,
  // The no-token connection is the usual one now: "This PC", not "Shared token".
  "UPDATE agents SET name = 'This PC' WHERE legacy = 1 AND name = 'Shared token'",
  // Configuration checks (server/audits/audit.ts): what each source found wrong
  // around an app, kept so a finding is recognised the next day and
  // ignoring it sticks; and when each app was last checked, with what
  // couldn't be.
  `
  CREATE TABLE findings (
    app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    id             TEXT NOT NULL,
    source         TEXT NOT NULL,
    connection_id  TEXT,
    key            TEXT NOT NULL,
    severity       TEXT NOT NULL,
    title          TEXT NOT NULL,
    why            TEXT NOT NULL,
    fix            TEXT NOT NULL,
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    ignored        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, id)
  );
  CREATE TABLE audits (
    app_id      TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    checked_at  TEXT NOT NULL,
    notes       TEXT NOT NULL DEFAULT '[]'
  );
  `,
];

// The checks an app gets from its URL alone (FR-A1): the site itself, its
// certificate if it's https, and its domain if it has a real one.
export function keylessChecks(url: string): { type: "site" | "ssl" | "domain"; resource: string }[] {
  const out: { type: "site" | "ssl" | "domain"; resource: string }[] = [{ type: "site", resource: url }];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  const host = u.hostname;
  const isIp = /^[\d.]+$/.test(host) || host.includes(":");
  const isLocal =
    host === "localhost" || !host.includes(".") || [".localhost", ".test", ".invalid", ".example", ".local"].some((s) => host.endsWith(s));
  if (u.protocol === "https:") out.push({ type: "ssl", resource: u.port ? `${host}:${u.port}` : host });
  if (!isIp && !isLocal) out.push({ type: "domain", resource: host });
  return out;
}

export const SCHEMA_VERSION = MIGRATIONS.length;

// A database that can't be opened or brought up to date: a damaged file, a
// file that isn't one, or a backup made by a newer Periskopos. Starting
// stops here and says which, rather than running on an empty registry.
export class DatabaseError extends Error {}

export function openDb(file: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  } catch (err) {
    throw new DatabaseError(`Couldn't open the database ${file}: ${(err as Error).message}`);
  }
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err instanceof DatabaseError ? err : new DatabaseError(`Couldn't bring the database ${file} up to date: ${(err as Error).message}`);
  }
  return db;
}

function migrate(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) {
    throw new DatabaseError(
      `The database is from a newer Periskopos (schema ${row.user_version}; this version knows up to ${MIGRATIONS.length}). Update Periskopos, or restore an older backup.`,
    );
  }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    try {
      transaction(db, () => {
        const step = MIGRATIONS[v];
        if (typeof step === "string") db.exec(step);
        else step(db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } catch (err) {
      throw new DatabaseError(`Updating the database to schema ${v + 1} failed (nothing was changed by that step): ${(err as Error).message}`);
    }
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
