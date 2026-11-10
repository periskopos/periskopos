import type { App, DeployState, NotificationsView, User } from "../../shared/types.ts";
import { api, ApiError } from "./api.ts";
import { h } from "./dom.ts";
import { buildNotificationsButton } from "./notificationsButton.ts";
import { updateButton } from "./updateButton.ts";
import { reportButton } from "./reportButton.ts";
import { windowControls } from "./windowControls.ts";
import type { Child } from "./dom.ts";
import { STATE_LABEL, ago, exactTime } from "./format.ts";
import type { ShownState } from "./format.ts";

// ── Status: a lamp (shape + colour) and a word ──────────────────────────

// up · down · attention · info (in progress) · checking · unknown · none
export type LampState = ShownState | "info";

export function lamp(state: LampState, { large = false, label }: { large?: boolean; label?: string } = {}) {
  return h("span", {
    class: `lamp lamp--${state}${large ? " lamp--lg" : ""}`,
    ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
  });
}

// The app's own favicon, fetched by the server; until it has one (or if it
// won't load), the first letter of the app's name.
export function appIcon(app: Pick<App, "name" | "icon">, { large = false }: { large?: boolean } = {}) {
  const cls = `app-icon${large ? " app-icon--lg" : ""}`;
  const letter = () => h("span", { class: `${cls} app-icon--letter`, "aria-hidden": "true" }, [...app.name.trim()][0]?.toUpperCase() ?? "");
  if (!app.icon) return letter();
  const img = h("img", { class: cls, src: app.icon, alt: "", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(letter()), { once: true });
  return img;
}

export function status(state: LampState, { text, ms, large }: { text?: string; ms?: number; large?: boolean } = {}) {
  const word = text ?? (state === "info" ? "In progress" : STATE_LABEL[state]);
  return h(
    "span",
    { class: `status status--${state}` },
    lamp(state, { large }),
    word,
    state === "up" && ms !== undefined && h("span", { class: "status-ms" }, `${ms} ms`),
  );
}

// ── Times: relative, with the exact time on hover ───────────────────────

export function timeAgo(iso: string, prefix = "") {
  return h("time", { datetime: iso, title: exactTime(iso) }, `${prefix}${ago(iso)}`);
}

// ── Links out ───────────────────────────────────────────────────────────

export function ext(href: string | undefined, ...children: Child[]) {
  if (!href) return h("span", null, ...children);
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, ...children, h("span", { "aria-hidden": "true" }, " ↗"));
}

// ── Layout pieces ───────────────────────────────────────────────────────

export function section(
  title: string,
  { action, body, list, foot, danger }: { action?: Child; body?: Child[]; list?: Child; foot?: Child; danger?: boolean },
) {
  const id = `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return h(
    "section",
    { class: `section${danger ? " is-danger" : ""}`, "aria-labelledby": id },
    h("div", { class: "section-head" }, h("h2", { class: "label", id }, title), action),
    list,
    body && body.some(Boolean) && h("div", { class: "section-body" }, body),
    foot && h("div", { class: "section-foot" }, foot),
  );
}

export function figure(label: string, value: Child, note?: Child, muted = false) {
  return h(
    "div",
    { class: "figure" },
    h("span", { class: "label" }, label),
    h("span", { class: `figure-value${muted ? " is-muted" : ""}` }, value),
    note ? h("span", { class: "figure-note truncate" }, note) : h("span", { class: "figure-note" }, " "),
  );
}

export function empty(text: Child) {
  return h("p", { class: "empty" }, text);
}

export function errorBox(err: unknown) {
  return h(
    "div",
    { class: "notice notice--error", role: "alert" },
    lamp("down"),
    h("span", null, (err as Error)?.message ?? String(err)),
  );
}

export function field(label: string, input: HTMLElement, hint?: Child) {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    input,
    hint && h("span", { class: "field-hint" }, hint),
  );
}

export function checkbox(name: string, label: string, hint: string, checked = false, onchange?: (on: boolean) => void, disabled = false) {
  return h(
    "label",
    { class: "check" },
    h("input", {
      type: "checkbox",
      name,
      checked,
      disabled,
      ...(onchange ? { onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) } : {}),
    }),
    h("span", null, h("span", { class: "field-label" }, label), h("span", { class: "field-hint" }, hint)),
  );
}

// Runs a form submit: the button says what's happening, errors land in `slot`.
export function submitting(
  form: HTMLFormElement,
  slot: HTMLElement,
  action: (data: FormData) => Promise<void>,
  busyText = "Saving…",
) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const label = button?.textContent;
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = busyText;
    }
    slot.replaceChildren();
    try {
      await action(new FormData(form));
    } catch (err) {
      slot.replaceChildren(errorBox(err));
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        // The action may have relabelled the button for what comes next.
        if (button.textContent === busyText) button.textContent = label ?? "";
      }
    }
  });
  return form;
}

// A button that shows `busyText` while `action` runs.
export function busyButton(text: string, busyText: string, action: () => Promise<void>, cls = "btn") {
  const button = h("button", { type: "button", class: cls }, text);
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = busyText;
    try {
      await action();
    } catch (err) {
      // An action that doesn't say what went wrong itself still gets heard.
      toast(err instanceof Error ? err.message : String(err), "down");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = text;
    }
  });
  return button;
}

export function go(hash: string, rerender: () => void) {
  if (location.hash === hash) rerender();
  else location.hash = hash;
}

// ── Toasts ──────────────────────────────────────────────────────────────

// The live region exists before any toast, so screen readers announce the
// first one too.
const toastRegion = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
document.body.append(toastRegion);

export function toast(message: string, state: LampState = "up") {
  const el = h("div", { class: "toast" }, lamp(state), message);
  toastRegion.append(el);
  setTimeout(() => el.remove(), 4000);
}

// "Is my last push live?" in a lamp and a word, for the Fleet and the App.
export const PUSH: Record<DeployState["state"], { lamp: LampState; text: string }> = {
  live: { lamp: "up", text: "Live" },
  deploying: { lamp: "info", text: "Deploying" },
  "not-deployed": { lamp: "attention", text: "Not live" },
  unknown: { lamp: "unknown", text: "Unknown" },
};

// ── Notifications, in the top bar on every page ───────────────────────

const notifications = buildNotificationsButton();
let notifyTimer: ReturnType<typeof setInterval> | undefined;
let lastRefresh = 0;
let trailingRefresh: ReturnType<typeof setTimeout> | undefined;
const REFRESH_GAP_MS = 4_000;

// Asks what needs looking at. Called on every page, so the bell never lags
// behind a change (adding an app, a connection); pages changed in quick
// succession don't each ask: one is deferred to just after the gap, so the
// last change is always reflected, never dropped. It only reads what's
// recorded: it never makes a check run.
export async function refreshNotifications(force = false) {
  const wait = REFRESH_GAP_MS - (Date.now() - lastRefresh);
  if (!force && wait > 0) {
    trailingRefresh ??= setTimeout(() => {
      trailingRefresh = undefined;
      void refreshNotifications(true);
    }, wait);
    return;
  }
  lastRefresh = Date.now();
  try {
    notifications.show(await api<NotificationsView>("GET", "/notifications"));
  } catch (err) {
    notifications.fail(err instanceof ApiError && err.status === 0 ? "Server not reachable" : "Notifications unavailable");
  }
}

export type Section = "fleet" | "status" | "services" | "settings" | null;

export function shell(user: User | null, active: Section, ...content: Child[]) {
  if (user) {
    void refreshNotifications();
    notifyTimer ??= setInterval(() => void refreshNotifications(true), 60_000);
  }
  const link = (href: string, text: string, key: Section) =>
    h("a", { href, ...(active === key ? { "aria-current": "page" } : {}) }, text);
  return [
    h(
      "header",
      { class: "topbar" },
      h("a", { class: "brand", href: "#/", "aria-label": "Periskopos, Apps" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", { class: "brand-name" }, "Periskopos")),
      h("span", { class: "tag version-tag", title: `Periskopos version ${__APP_VERSION__}` }, `v${__APP_VERSION__}`),
      user &&
        h(
          "nav",
          { class: "nav", "aria-label": "Main" },
          link("#/", "Apps", "fleet"),
          link("#/status", "Status", "status"),
          link("#/services", "Accounts", "services"),
          link("#/settings", "Settings", "settings"),
        ),
      user && notifications.root,
      updateButton(), // the desktop app only: its version and updates
      user && reportButton(),
      windowControls(), // only in the desktop app's frameless window
    ),
    h("main", { class: active === "settings" || active === null ? "page" : "page page--wide", id: "main" }, content),
  ];
}
