import type { DatabaseSync } from "node:sqlite";
import type { DeliveryChannel, DeliveryFailure, Settings } from "../shared/types.ts";

export const DEFAULT_SETTINGS: Settings = {
  watcherEnabled: true,
  notificationsEnabled: true,
  incidentAlarm: false,
  // Off until I switch it on (docs/AGENT-SAFETY.md §4.1).
  agentAccess: false,
  phoneChannel: "off",
  ntfyServer: "https://ntfy.sh",
  telegramChatId: "",
  emailFrom: "",
  emailTo: "",
};

export function getSettings(db: DatabaseSync, userId: string): Settings {
  const rows = db.prepare("SELECT key, value FROM settings WHERE user_id = ?").all(userId) as {
    key: string;
    value: string;
  }[];
  const stored: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  // Each value is kept only if it has the default's type; the PATCH route
  // checks the values themselves (a channel name, an address).
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) out[key] = stored[key];
  }
  return out as Settings;
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
