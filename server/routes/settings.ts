import { statSync } from "node:fs";
import { bodyLimit } from "hono/body-limit";
import path from "node:path";
import { CHECKS_KEPT_CHOICES } from "../../shared/settings-choices.ts";
import { DATA_DIR, VERSION } from "../config.ts";
import { parseWorldPerf } from "../../shared/world-perf.ts";
import { diagnostics, recordWorldPerf } from "../diagnostics.ts";
import { SUMMARIES_KEPT_DAYS } from "../history.ts";
import { HttpError, badRequest } from "../errors.ts";
import { pauseProblem } from "../alerts/rules.ts";
import { PHONE_SECRETS, findTelegramChat, phoneSecretsSet, sendToPhone } from "../alerts/phone.ts";
import type { PhoneSecret } from "../alerts/phone.ts";
import { envFile, pastedKey, writeSecret } from "../keys/secrets.ts";
import { getSettings, heldAlerts, resetSettings, setDeliveryFailure, updateSettings } from "../settings.ts";
import { applyImport, planImport, settingsForAFile } from "../setup-import.ts";
import { startupStatus } from "../startup.ts";
import * as store from "../store.ts";
import { httpUrl, text } from "../validate.ts";
import { seesApp } from "../agents/agents.ts";
import { jsonBody, pasted, router } from "./context.ts";
import type { RouteDeps } from "./context.ts";

const databaseBytes = (): number | undefined => {
  try {
    return statSync(path.join(DATA_DIR, "periskopos.db")).size;
  } catch {
    return undefined;
  }
};

// The backups folder is beside the data folder, so an assistant isn't told it.
const backupsFor = <B extends { dir: string }>(role: string, status: B) => {
  if (role === "ui") return status;
  const { dir: _dir, ...told } = status;
  return told;
};

// Settings: watching, notifications, AI assistants, phone alerts, backups.
// A setup file is at most 5 MB (the screen checks that too): the server doesn't take more.
const setupFileLimit = bodyLimit({
  maxSize: 6 * 1024 * 1024,
  onError: () => {
    throw new HttpError(413, "That file is too big to be a setup file");
  },
});

export function settingsRoutes({ db, approvals, notifier, port, backups, icons }: RouteDeps) {
  const r = router();

  // Settings → About → Copy diagnostics: plain text, redacted, for a bug report.
  r.get("/diagnostics", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text(diagnostics(db));
  });

  // How the World is running, from the page, for the diagnostics above. Kept in memory here.
  r.post("/diagnostics/world", async (c) => {
    const perf = parseWorldPerf(await jsonBody(c));
    if (!perf) throw badRequest("That isn't a report of how the World ran");
    recordWorldPerf(perf);
    return c.body(null, 204);
  });

  r.get("/settings", async (c) => {
    const settings = getSettings(db, c.var.user.id);
    // An assistant limited to some apps is told only about the pauses of those.
    if (c.var.role !== "ui") settings.appPauses = Object.fromEntries(Object.entries(settings.appPauses).filter(([id]) => seesApp(c.var.agentCtx, id)));
    return c.json({
      settings,
      // How many alerts a pause is holding back.
      heldAlerts: heldAlerts(db, c.var.user.id).length,
      // Which phone-alert keys are in the keys file: yes or no, never the values.
      phoneSecrets: phoneSecretsSet(),
      startup: await startupStatus(),
      // When the database was last copied, and where the copies are.
      ...(backups ? { backups: backupsFor(c.var.role, backups.status()) } : {}),
      // Where the keys and the data are is for me: an assistant runs as the
      // same user and could open them, so it isn't told.
      about: c.var.role === "ui" ? { dataDir: DATA_DIR, keysFile: envFile(), version: VERSION, summariesKeptDays: SUMMARIES_KEPT_DAYS, dbBytes: databaseBytes() } : { version: VERSION },
    });
  });

  r.patch("/settings", async (c) => {
    const body = await jsonBody(c);
    for (const key of ["watcherEnabled", "notificationsEnabled", "incidentAlarm", "agentAccess", "alertOutages", "alertDeploys", "alertAccounts", "alertProviders", "alertWarnings"]) {
      if (body[key] !== undefined && typeof body[key] !== "boolean") throw badRequest(`${key} must be true or false`);
    }
    if (body.defaultCheckIntervalMin !== undefined && !store.CHECK_INTERVALS_MIN.includes(body.defaultCheckIntervalMin as number)) {
      throw badRequest(`Check interval must be one of ${store.CHECK_INTERVALS_MIN.join(", ")} minutes`);
    }
    if (body.checksKeptDays !== undefined && !CHECKS_KEPT_CHOICES.includes(body.checksKeptDays as number)) {
      throw badRequest(`Checks can be kept for ${CHECKS_KEPT_CHOICES.join(", ")} days`);
    }
    // A pause is for a set time, and only of my own apps.
    const pauseWrong = (until: unknown) => {
      const problem = pauseProblem(until, Date.now());
      if (problem) throw badRequest(problem);
    };
    if (body.alertsPausedUntil !== undefined) pauseWrong(body.alertsPausedUntil);
    if (body.appPauses !== undefined) {
      if (typeof body.appPauses !== "object" || body.appPauses === null || Array.isArray(body.appPauses)) throw badRequest("appPauses must say when each app's pause ends");
      const mine = new Set(store.listApps(db, c.var.user.id).map((a) => a.id));
      const now = Date.now();
      const running = Object.entries(body.appPauses as Record<string, unknown>).filter(([id, until]) => {
        if (!mine.has(id)) throw badRequest("No such app");
        // One that's already over comes back with the rest of the list: it's just dropped.
        return typeof until === "string" && Date.parse(until) > now ? (pauseWrong(until), true) : false;
      });
      body.appPauses = Object.fromEntries(running);
    }
    // Phone alerts: a known channel, an https server, plain addresses.
    if (body.phoneChannel !== undefined && !["off", "ntfy", "telegram", "email"].includes(body.phoneChannel as string)) {
      throw badRequest("phoneChannel must be off, ntfy, telegram or email");
    }
    if (body.ntfyServer !== undefined) body.ntfyServer = httpUrl(body.ntfyServer, "ntfy server").replace(/\/+$/, "");
    if (body.telegramChatId !== undefined && (typeof body.telegramChatId !== "string" || (body.telegramChatId !== "" && !/^-?\d{1,20}$/.test(body.telegramChatId)))) {
      throw badRequest("A Telegram chat id is a number");
    }
    for (const key of ["emailFrom", "emailTo"]) {
      if (body[key] === undefined || body[key] === "") continue;
      const v = text(body[key], key === "emailFrom" ? "From" : "To", { max: 200 });
      // "Periskopos <alerts@example.org>" or just the address
      if (!/^([^<>@\s][^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v ?? "")) throw badRequest(`That ${key === "emailFrom" ? "sender" : "recipient"} doesn't look like an email address`);
      body[key] = v;
    }
    const settings = updateSettings(db, c.var.user.id, body);
    // Shutting Claude out also ends whatever it's waiting on.
    if (!settings.agentAccess) approvals.cancelAll();
    return c.json({ settings });
  });

  // A phone-alert key (an ntfy topic, a bot token, an API key), pasted on
  // screen and saved straight into the keys file; never sent back.
  r.post("/settings/phone/secret", async (c) => {
    const body = await jsonBody(c);
    const name = String(body.name);
    if (!Object.hasOwn(PHONE_SECRETS, name)) throw badRequest("Unknown phone-alert key");
    const value = pasted(() => pastedKey(body.value));
    if (name === "ntfyTopic" && !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
      throw badRequest("An ntfy topic is 8 to 64 letters, digits, - or _ (a long random one: anyone who knows it can read your alerts)");
    }
    writeSecret(PHONE_SECRETS[name as PhoneSecret], value);
    c.header("Cache-Control", "no-store");
    return c.json({ phoneSecrets: phoneSecretsSet() });
  });

  // Sends a test through the chosen channel, saying exactly what went wrong.
  r.post("/settings/phone/test", async (c) => {
    try {
      await sendToPhone(getSettings(db, c.var.user.id), {
        title: "Periskopos",
        body: "Phone alerts work. This is how you'll hear when an app goes down.",
      });
      return c.json({ ok: true, message: "Sent. It should arrive in a moment." });
    } catch (err) {
      return c.json({ ok: false, message: (err as Error).message });
    }
  });

  // The chat to send Telegram alerts to: the newest one that wrote to the
  // bot, which is me once I've sent it a message. Saved when found.
  r.post("/settings/phone/telegram-chat", async (c) => {
    try {
      const chat = await findTelegramChat();
      if (!chat) return c.json({ ok: false, message: "Nobody has written to your bot yet. Open it in Telegram, send it any message, then try again." });
      updateSettings(db, c.var.user.id, { telegramChatId: chat.id });
      return c.json({ ok: true, message: `Found your chat with ${chat.name}.`, settings: getSettings(db, c.var.user.id) });
    } catch (err) {
      return c.json({ ok: false, message: (err as Error).message });
    }
  });

  // A copy of the database now, beside the daily ones (the UI only:
  // security.ts lets an agent read, not this).
  // Every app of mine at the interval new ones get.
  r.post("/settings/apply-interval", (c) => {
    const minutes = getSettings(db, c.var.user.id).defaultCheckIntervalMin;
    return c.json({ count: store.setAllCheckIntervals(db, c.var.user.id, minutes), minutes });
  });

  // Back to how Periskopos starts. AI assistants go back to off, which also
  // ends whatever they're waiting on.
  r.post("/settings/reset", (c) => {
    const settings = resetSettings(db, c.var.user.id);
    if (!settings.agentAccess) approvals.cancelAll();
    return c.json({ settings });
  });

  // What's set up, to keep or read: never a key (those stay in the keys file)
  // and no history. On screen only: an assistant limited to some apps would
  // otherwise read them all here.
  r.get("/settings/export", (c) => {
    if (c.var.role !== "ui") throw new HttpError(403, "Exporting is done on screen in Periskopos");
    const id = c.var.user.id;
    const services = store.listServices(db, id);
    const accountName = (serviceId?: string) => services.find((s) => s.id === serviceId)?.name;
    return c.json({
      periskopos: VERSION,
      exportedAt: new Date().toISOString(),
      apps: store.listApps(db, id).map((a) => ({
        name: a.name,
        url: a.url,
        ...(a.notes ? { notes: a.notes } : {}),
        live: a.live,
        checkIntervalMin: a.checkIntervalMin,
        ...(a.protocol ? { endpoint: a.protocol.endpoint } : {}),
        connections: a.connections.map((conn) => {
          const account = accountName(conn.serviceId);
          return { type: conn.type, resource: conn.resource, ...(conn.settings ? { settings: conn.settings } : {}), ...(account ? { account } : {}) };
        }),
      })),
      accounts: services.map((s) => ({ type: s.type, name: s.name })),
      settings: settingsForAFile(getSettings(db, id)),
    });
  });

  // A file from the export, read back in. On screen only, as above; the preview
  // changes nothing, and the import does what the preview said.
  const onScreenOnly = (role: string) => {
    if (role !== "ui") throw new HttpError(403, "Importing is done on screen in Periskopos");
  };
  r.post("/settings/import/preview", setupFileLimit, async (c) => {
    onScreenOnly(c.var.role);
    const body = await jsonBody(c);
    return c.json({ plan: planImport(db, c.var.user.id, getSettings(db, c.var.user.id), body.setup).plan });
  });
  r.post("/settings/import", setupFileLimit, async (c) => {
    onScreenOnly(c.var.role);
    const body = await jsonBody(c);
    const work = planImport(db, c.var.user.id, getSettings(db, c.var.user.id), body.setup);
    const added = applyImport(db, c.var.user.id, work, body.useSettings === true);
    for (const app of added) void icons?.refresh(app).catch((err) => console.error(`Icon refresh failed: ${(err as Error).message}`));
    return c.json({ added: added.length, connected: work.connect.length, plan: work.plan });
  });

  r.post("/settings/backup", (c) => {
    if (!backups) throw new HttpError(404, "Backups aren't set up in this run");
    try {
      backups.backUpNow();
    } catch (err) {
      throw new HttpError(500, `The backup couldn't be made: ${(err as Error).message}`);
    }
    return c.json({ backups: backups.status() });
  });

  // The desktop app shows notifications itself, so only it knows whether the
  // OS took one: { message } when it refused, nothing when it was shown.
  r.post("/notifications/delivery", async (c) => {
    const { message } = (await c.req.json().catch(() => ({}))) as { message?: unknown };
    setDeliveryFailure(db, c.var.user.id, "desktop", typeof message === "string" ? { message: message.slice(0, 200), at: new Date().toISOString() } : undefined);
    return c.json({ ok: true });
  });

  // { alarm: true }: the alarm a provider's incident sounds, to hear it.
  r.post("/notifications/test", async (c) => {
    const asked = (await c.req.json().catch(() => ({}))) as { alarm?: unknown; first?: unknown };
    const alarm = asked.alarm === true;
    try {
      await notifier.notify({
        title: "Periskopos",
        body: alarm
          ? "This is the alarm a provider's incident sounds when it affects your apps. Dismiss it to stop it."
          : asked.first === true
          ? "You're set up: this is how Periskopos tells you when an app goes down, a deploy fails or something's about to expire."
          : "Notifications work. This is what you'll see when an app goes down.",
        url: `http://localhost:${port}/#/settings/notifications`,
        ...(alarm ? { alarm } : {}),
      });
    } catch (err) {
      throw new HttpError(502, `The notification couldn't be shown: ${(err as Error).message}`);
    }
    return c.json({ ok: true });
  });

  return r;
}
