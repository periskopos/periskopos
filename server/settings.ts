import type { DatabaseSync } from "node:sqlite";
import type { DeliveryChannel, DeliveryFailure, HeldAlert, Settings } from "../shared/types.ts";
import { HELD_KEPT } from "./alerts/rules.ts";

export const DEFAULT_SETTINGS: Settings = {
  watcherEnabled: true,
  defaultCheckIntervalMin: 5,
  checksKeptDays: 30,
  notificationsEnabled: true,
  incidentAlarm: false,
  alertOutages: true,
  alertDeploys: true,
  alertAccounts: true,
  alertProviders: true,
  alertWarnings: true,
  alertsPausedUntil: "",
  appPauses: {},
  // Off until I switch it on (docs/AGENT-SAFETY.md §4.1).
  agentAccess: false,
  phoneChannel: "off",
  ntfyServer: "https://ntfy.sh",
  telegramChatId: "",
  emailFrom: "",
  emailTo: "",
};

// A row that isn't JSON (a damaged file, a hand edit) reads as nothing, not as an error that
// stops every check.
function readJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function getSettings(db: DatabaseSync, userId: string): Settings {
  const rows = db.prepare("SELECT key, value FROM settings WHERE user_id = ?").all(userId) as {
    key: string;
    value: string;
  }[];
  const stored: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.key, readJson(r.value)]));
  // Each value is kept only if it has the default's type; the PATCH route
  // checks the values themselves (a channel name, an address).
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) out[key] = stored[key];
  }
  return out as Settings;
}

// Back to how Periskopos starts, for what "Restore default settings" covers. Left
// alone: where phone alerts go (addresses and channel are a set-up, not a taste),
// and how long checks are kept (going back could delete history).
const KEPT_ON_RESET: (keyof Settings)[] = ["phoneChannel", "ntfyServer", "telegramChatId", "emailFrom", "emailTo", "checksKeptDays"];

export function resetSettings(db: DatabaseSync, userId: string): Settings {
  const remove = db.prepare("DELETE FROM settings WHERE user_id = ? AND key = ?");
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!KEPT_ON_RESET.includes(key)) remove.run(userId, key);
  }
  return getSettings(db, userId);
}

export function updateSettings(db: DatabaseSync, userId: string, patch: Partial<Settings>): Settings {
  const upsert = db.prepare(
    `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  );
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof patch[key] === typeof DEFAULT_SETTINGS[key]) upsert.run(userId, key, JSON.stringify(patch[key]));
  }
  return getSettings(db, userId);
}

// Alerts a pause held back, oldest first. Kept with the settings but not one of
// them, like the delivery failures below. A long pause keeps only the latest.
const HELD_KEY = "heldAlerts";

export function heldAlerts(db: DatabaseSync, userId: string): HeldAlert[] {
  const row = db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, HELD_KEY) as { value: string } | undefined;
  const held = row ? readJson(row.value) : [];
  return Array.isArray(held) ? (held as HeldAlert[]) : [];
}

export function setHeldAlerts(db: DatabaseSync, userId: string, held: HeldAlert[]) {
  db.prepare(
    `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(userId, HELD_KEY, JSON.stringify(held.slice(-HELD_KEPT)));
}

// An app deleted or no longer live: what was held about it has nothing left to say.
export function dropHeldAlerts(db: DatabaseSync, userId: string, appId: string) {
  const held = heldAlerts(db, userId);
  const rest = held.filter((a) => a.appId !== appId);
  if (rest.length !== held.length) setHeldAlerts(db, userId, rest);
}

// The last alert that couldn't reach me, by channel, until one does. Kept with
// the settings but not one of them: nothing in Settings can set it.
const DELIVERY_KEY = "deliveryFailure:";

export function setDeliveryFailure(db: DatabaseSync, userId: string, channel: DeliveryChannel, failure?: { message: string; at: string }) {
  const key = `${DELIVERY_KEY}${channel}`;
  if (!failure) {
    db.prepare("DELETE FROM settings WHERE user_id = ? AND key = ?").run(userId, key);
    return;
  }
  db.prepare(
    `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(userId, key, JSON.stringify(failure));
}

export function deliveryFailures(db: DatabaseSync, userId: string): DeliveryFailure[] {
  const rows = db.prepare("SELECT key, value FROM settings WHERE user_id = ? AND key LIKE ?").all(userId, `${DELIVERY_KEY}%`) as { key: string; value: string }[];
  return rows.map((r) => ({ channel: r.key.slice(DELIVERY_KEY.length) as DeliveryChannel, ...(JSON.parse(r.value) as { message: string; at: string }) }));
}
