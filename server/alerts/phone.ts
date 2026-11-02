import type { DatabaseSync } from "node:sqlite";
import type { Settings } from "../../shared/types.ts";
import type { Notice, Notifier } from "./notify.ts";
import { readSecret } from "../keys/secrets.ts";
import { getSettings } from "../settings.ts";
import * as store from "../store.ts";

// Phone alerts (the landscape notes §5.1): the same notifications the desktop
// shows, also sent to my phone, so I hear about trouble away from the PC.
// Only the alert's text leaves the PC. The secret parts (an ntfy topic is a
// password: anyone who knows it can read it) live in the keys file like
// every other key; the rest in Settings.
//
// - ntfy: the free ntfy app on the phone, subscribed to a topic only I know.
// - Telegram: a bot I create with @BotFather, writing to my chat with it.
// - Email: through Resend, from a domain I've verified there.

export type PhoneChannel = Settings["phoneChannel"];

export const PHONE_SECRETS = {
  ntfyTopic: "PERISKOPOS_NTFY_TOPIC",
  ntfyToken: "PERISKOPOS_NTFY_TOKEN", // only for a protected topic or my own ntfy server
  telegramToken: "PERISKOPOS_TELEGRAM_BOT_TOKEN",
  resendKey: "PERISKOPOS_RESEND_API_KEY",
} as const;
export type PhoneSecret = keyof typeof PHONE_SECRETS;

export const phoneSecretsSet = (): Record<PhoneSecret, boolean> =>
  Object.fromEntries(Object.entries(PHONE_SECRETS).map(([k, v]) => [k, Boolean(readSecret(v))])) as Record<PhoneSecret, boolean>;

const TIMEOUT_MS = 10_000;

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function failure(res: Response, service: string): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 200);
  let why = text;
  try {
    const j = JSON.parse(text) as { error?: string; message?: string; description?: string };
    why = j.description ?? j.message ?? j.error ?? text;
  } catch {
    // not JSON: the text itself
  }
  return new Error(`${service} answered HTTP ${res.status}${why ? `: ${why}` : ""}`);
}

// Sends one alert through the chosen channel; throws with a plain reason
// (what's missing, or what the service said) when it can't.
export async function sendToPhone(s: Settings, notice: Pick<Notice, "title" | "body">): Promise<void> {
  if (s.phoneChannel === "ntfy") {
    const topic = readSecret(PHONE_SECRETS.ntfyTopic);
    if (!topic) throw new Error("Choose an ntfy topic first");
    const token = readSecret(PHONE_SECRETS.ntfyToken);
    // JSON publishing: titles with any characters, unlike the Title header.
    const res = await post(s.ntfyServer.replace(/\/+$/, ""), { topic, title: notice.title, message: notice.body || notice.title, tags: ["satellite"] }, token ? { authorization: `Bearer ${token}` } : {});
    if (!res.ok) throw await failure(res, "ntfy");
    return;
  }
  if (s.phoneChannel === "telegram") {
    const token = readSecret(PHONE_SECRETS.telegramToken);
    if (!token) throw new Error("Paste your Telegram bot's token first");
    if (!s.telegramChatId) throw new Error("Find your chat first: send your bot a message, then choose Find my chat");
    const res = await post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: s.telegramChatId, text: notice.body ? `${notice.title}\n${notice.body}` : notice.title });
    if (!res.ok) throw await failure(res, "Telegram");
    return;
  }
  if (s.phoneChannel === "email") {
    const key = readSecret(PHONE_SECRETS.resendKey);
    if (!key) throw new Error("Paste your Resend API key first");
    if (!s.emailFrom || !s.emailTo) throw new Error("Fill in who it's from and who it goes to");
    const res = await post("https://api.resend.com/emails", { from: s.emailFrom, to: [s.emailTo], subject: notice.title, text: notice.body || notice.title }, { authorization: `Bearer ${key}` });
    if (!res.ok) throw await failure(res, "Resend");
    return;
  }
  throw new Error("Phone alerts are off");
}

// The chat with my Telegram bot: the newest message someone sent it, which
// after I've written to it is me. undefined when nobody has yet.
export async function findTelegramChat(): Promise<{ id: string; name: string } | undefined> {
  const token = readSecret(PHONE_SECRETS.telegramToken);
  if (!token) throw new Error("Paste your Telegram bot's token first");
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw await failure(res, "Telegram");
  type Update = { message?: { chat?: { id?: number; first_name?: string; username?: string; title?: string } } };
  const { result = [] } = (await res.json()) as { result?: Update[] };
  const chat = [...result].reverse().find((u) => u.message?.chat?.id !== undefined)?.message?.chat;
  if (!chat?.id) return undefined;
  return { id: String(chat.id), name: chat.title ?? chat.first_name ?? chat.username ?? String(chat.id) };
}

// The desktop notifier, plus the phone when phone alerts are on. The phone
// never holds up or breaks the desktop notification: a failure is logged.
export function withPhone(local: Notifier, db: DatabaseSync): Notifier {
  return {
    async notify(notice) {
      const user = store.getLocalUser(db);
      const s = user && getSettings(db, user.id);
      if (s) {
        // sendToPhone does nothing when phone alerts are off.
        void sendToPhone(s, notice).catch((err: unknown) => console.error(`Couldn't send the phone alert: ${(err as Error).message}`));
      }
      await local.notify(notice);
    },
  };
}
