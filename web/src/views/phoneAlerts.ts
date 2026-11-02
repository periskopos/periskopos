import type { Settings } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h } from "../dom.ts";
import { busyButton, errorBox, ext, field, lamp, section, submitting, toast } from "../ui.ts";

// Settings → Phone alerts (the landscape notes §5.1): the same notifications,
// also on my phone. Each channel's steps are spelled out; the secret parts
// are pasted once and saved in the keys file, never shown again.

export type PhoneSecrets = { ntfyTopic: boolean; ntfyToken: boolean; telegramToken: boolean; resendKey: boolean };

const CHANNELS: { value: Settings["phoneChannel"]; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ntfy", label: "ntfy (free phone app)" },
  { value: "telegram", label: "Telegram" },
  { value: "email", label: "Email (through Resend)" },
];

// A long random topic: on ntfy.sh, anyone who knows a topic can read it.
const randomTopic = () => `periskopos-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20)}`;

export function phoneAlertsSection(
  settings: Settings,
  secrets: PhoneSecrets,
  save: (patch: Partial<Settings>) => Promise<void>,
  reload: () => Promise<void>,
) {
  const result = h("div");
  const saved = (yes: boolean) => h("span", { class: "key-line" }, lamp(yes ? "up" : "none"), h("span", { class: "meta" }, yes ? "Saved on this computer" : "Not set yet"));

  // Pastes one secret into the keys file.
  const secretForm = (name: keyof PhoneSecrets, label: string, hint: string, opts: { placeholder?: string; fill?: () => string } = {}) => {
    const errors = h("div");
    const input = h("input", { name: "value", type: "password", autocomplete: "off", spellcheck: false, class: "mono", placeholder: opts.placeholder ?? "Paste here" });
    const form = submitting(
      h(
        "form",
        { class: "form-row" },
        field(label, input, hint),
        h(
          "div",
          { class: "actions" },
          opts.fill && h("button", { type: "button", class: "btn btn--sm", onclick: () => ((input.type = "text"), (input.value = opts.fill!())) }, "Make one up"),
          h("button", { type: "submit", class: "btn btn--sm btn--primary" }, "Save"),
        ),
      ),
      errors,
      async (data) => {
        await api("POST", "/settings/phone/secret", { name, value: data.get("value") });
        toast("Saved");
        await reload();
      },
    );
    return h("div", { class: "stack-sm" }, form, errors, saved(secrets[name]));
  };

  const textSetting = (key: "ntfyServer" | "emailFrom" | "emailTo", label: string, hint: string, placeholder: string) => {
    const input = h("input", { value: settings[key], placeholder, autocomplete: "off", spellcheck: false });
    return h(
      "div",
      { class: "form-row" },
      field(label, input, hint),
      h("div", { class: "actions" }, busyButton("Save", "Saving…", () => save({ [key]: input.value.trim() }), "btn btn--sm")),
    );
  };

  const steps = (items: (string | Node)[][]) => h("ol", { class: "steps" }, items.map((parts) => h("li", null, ...parts)));

  let channelBody: Node | null = null;
  if (settings.phoneChannel === "ntfy") {
    channelBody = h(
      "div",
      { class: "stack-sm" },
      steps([
        ["Install the ntfy app on your phone (", ext("https://ntfy.sh", "ntfy.sh"), ", for Android and iPhone)."],
        ["Choose a topic below (Make one up gives a long random one) and Save it."],
        ["In the app, subscribe to that same topic. Then Send a test."],
      ]),
      secretForm("ntfyTopic", "Topic", "Anyone who knows the topic can read your alerts, so keep it long and random. It's saved in the keys file, not shown again.", { placeholder: "periskopos-…", fill: randomTopic }),
      h(
        "details",
        { class: "advanced" },
        h("summary", null, "Advanced: your own ntfy server, or a protected topic"),
        textSetting("ntfyServer", "Server", "Leave as https://ntfy.sh unless you run your own.", "https://ntfy.sh"),
        secretForm("ntfyToken", "Access token", "Only for a topic that needs logging in."),
      ),
    );
  } else if (settings.phoneChannel === "telegram") {
    const chat = h("div");
    channelBody = h(
      "div",
      { class: "stack-sm" },
      steps([
        ["In Telegram, open ", ext("https://t.me/BotFather", "@BotFather"), ", send /newbot and follow its two questions. It gives you a token."],
        ["Paste the token below and Save."],
        ["Open your new bot in Telegram and send it any message, then choose Find my chat. Then Send a test."],
      ]),
      secretForm("telegramToken", "Bot token", "Saved in the keys file, not shown again.", { placeholder: "123456:ABC…" }),
      h(
        "div",
        { class: "actions" },
        busyButton("Find my chat", "Looking…", async () => {
          const r = await api<{ ok: boolean; message: string }>("POST", "/settings/phone/telegram-chat");
          chat.replaceChildren(h("div", { class: `notice ${r.ok ? "notice--ok" : "notice--error"}` }, lamp(r.ok ? "up" : "down"), r.message));
          if (r.ok) await reload();
        }),
        settings.telegramChatId && h("span", { class: "meta" }, `Sending to chat ${settings.telegramChatId}`),
      ),
      chat,
    );
  } else if (settings.phoneChannel === "email") {
    channelBody = h(
      "div",
      { class: "stack-sm" },
      steps([
        ["In ", ext("https://resend.com/api-keys", "Resend → API Keys"), ", create a key with Sending access, and paste it below."],
        ["From: an address on a domain you've verified in Resend, e.g. Periskopos <alerts@example.org>."],
        ["To: where you want the alerts. Then Send a test."],
      ]),
      secretForm("resendKey", "Resend API key", "Saved in the keys file, not shown again.", { placeholder: "re_…" }),
      textSetting("emailFrom", "From", "On a domain verified in Resend.", "Periskopos <alerts@your-domain.com>"),
      textSetting("emailTo", "To", "Your address.", "you@example.com"),
    );
  }

  const channel = h(
    "select",
    { name: "phoneChannel", onchange: (e: Event) => void save({ phoneChannel: (e.target as HTMLSelectElement).value as Settings["phoneChannel"] }) },
    CHANNELS.map((c) => h("option", { value: c.value, selected: c.value === settings.phoneChannel }, c.label)),
  );

  return section("Phone alerts", {
    body: [
      h("p", { class: "secondary" }, "The same alerts as the desktop notifications (an app going down and coming back, failed deploys and CI, expiries, provider incidents, an AI assistant asking to act), also sent to your phone. Only the alert's text leaves this computer. They follow Notify me above, and only go out while Periskopos is running."),
      field("Send them with", channel),
      channelBody,
      settings.phoneChannel !== "off" &&
        h(
          "div",
          { class: "actions" },
          busyButton("Send a test", "Sending…", async () => {
            try {
              const r = await api<{ ok: boolean; message: string }>("POST", "/settings/phone/test");
              result.replaceChildren(h("div", { class: `notice ${r.ok ? "notice--ok" : "notice--error"}` }, lamp(r.ok ? "up" : "down"), r.message));
            } catch (err) {
              result.replaceChildren(errorBox(err));
            }
          }),
        ),
      result,
    ],
  });
}
