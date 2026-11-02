// What the server and the desktop app tell each other. The desktop app runs
// the server as a child process and shares two things with it, both plain
// text, so neither side needs the other's code at runtime: notifications
// (a line on the server's output) and whether the app starts at login (a
// small file in the data folder). Types and pure functions only.

// alarm: a provider's incident in a part my apps use, when I've asked for
// an alarm: it sounds until I dismiss it.
export type DesktopNotice = { title: string; body: string; url?: string; alarm?: true };

export const xmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

// A Windows toast. An alarm stays on screen and loops Windows' alarm sound
// until it's dismissed (Windows keeps a toast an alarm only with a button,
// so it has one: Dismiss). `launch`: what clicking it opens, if anything.
export function toastXml({ title, body, alarm }: DesktopNotice, launch?: string): string {
  const opens = launch ? ` activationType="protocol" launch="${xmlEscape(launch)}"` : "";
  const text = `<visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual>`;
  if (!alarm) return `<toast${opens}>${text}</toast>`;
  return (
    `<toast scenario="alarm"${opens}>${text}` +
    `<audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true"/>` +
    `<actions><action activationType="system" arguments="dismiss" content=""/></actions></toast>`
  );
}

// A run from a checkout (npm run dev) watches its own registry beside the
// installed app, so its notifications say where they're from: the same
// app failing shows twice, and only one is the real watch.
export function noticeForRun(notice: DesktopNotice, isPackaged: boolean): DesktopNotice {
  return isPackaged ? notice : { ...notice, title: `Dev · ${notice.title}` };
}

// One notification per line on the server's output, after this marker.
export const NOTICE_PREFIX = "@periskopos-notice ";

export function noticeLine(notice: DesktopNotice): string {
  return `${NOTICE_PREFIX}${JSON.stringify(notice)}`;
}

// A line that isn't a notification, or is a malformed one, gives undefined:
// the app must never act on anything but exactly this shape.
export function parseNoticeLine(line: string): DesktopNotice | undefined {
  if (!line.startsWith(NOTICE_PREFIX)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(NOTICE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { title, body, url, alarm } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string" || title === "") return undefined;
  if (url !== undefined && typeof url !== "string") return undefined;
  if (alarm !== undefined && alarm !== true) return undefined;
  return { title: title.slice(0, 200), body: body.slice(0, 1000), ...(url ? { url } : {}), ...(alarm ? { alarm } : {}) };
}

// Why the server can't start (its database won't open, say), as one line on
// its output just before it exits, so the app's dialog can say so and not
// only that it stopped.
export const FATAL_PREFIX = "@periskopos-fatal ";

export const fatalLine = (message: string): string => `${FATAL_PREFIX}${JSON.stringify({ message })}`;

export function parseFatalLine(line: string): string | undefined {
  if (!line.startsWith(FATAL_PREFIX)) return undefined;
  try {
    const { message } = JSON.parse(line.slice(FATAL_PREFIX.length)) as { message?: unknown };
    return typeof message === "string" && message !== "" ? message.slice(0, 2000) : undefined;
  } catch {
    return undefined;
  }
}

// Written by the app whenever "start at login" changes, read by the server
// to show it on the Settings page.
export const LOGIN_ITEM_FILE = "login-item.json";

export const loginItemJson = (enabled: boolean): string => `${JSON.stringify({ enabled })}\n`;

export function parseLoginItem(text: string): boolean {
  try {
    return (JSON.parse(text) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

// ── Updates, as the app's window shows them ─────────────────────────────

// Where the updater stands (desktop/updater.ts). The tray and the window's
// update button both show it.
export type UpdateState =
  | { kind: "idle"; checkedAt?: string; problem?: string } // checkedAt: the last check that found nothing new
  | { kind: "checking" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string; from?: "local" } // downloaded (or built on this computer); installs on restart
  | { kind: "available"; version: string } // a Mac: download it by hand
  | { kind: "unavailable"; reason: string }; // not the installed app

export type UpdateAction = "check" | "install" | "download";

// What the shell tells the window: the version running, and the updater.
export type UpdateSnapshot = { version: string; state: UpdateState };

// The update panel's words. `attention` puts a dot on the button: there's
// something to do.
export type UpdateView = {
  status: string;
  detail?: string;
  checkedAt?: string; // shown as "checked 12 min ago" by the page
  action?: { kind: UpdateAction; label: string };
  busy: boolean;
  attention: boolean;
};

export function updateView({ state }: UpdateSnapshot): UpdateView {
  const check = { kind: "check" as const, label: "Check now" };
  switch (state.kind) {
    case "idle":
      if (state.problem) return { status: "Couldn't check for updates", detail: state.problem, action: check, busy: false, attention: false };
      return state.checkedAt
        ? { status: "Up to date", checkedAt: state.checkedAt, action: check, busy: false, attention: false }
        : { status: "Not checked yet", detail: "It checks soon after starting, and every 6 hours.", action: check, busy: false, attention: false };
    case "checking":
      return { status: "Checking for updates…", busy: true, attention: false };
    case "downloading":
      return { status: `Downloading ${state.version}…`, detail: "You'll be told when it's ready.", busy: true, attention: false };
    case "ready":
      return { status: `${state.version} is ready`, detail: state.from === "local" ? "A build on this computer. It installs when you restart." : "It installs when you restart, or when you quit.", action: { kind: "install", label: "Restart to update" }, busy: false, attention: true };
    case "available":
      return { status: `${state.version} is available`, detail: "Download it, then drag it into Applications.", action: { kind: "download", label: `Download ${state.version}` }, busy: false, attention: true };
    case "unavailable":
      return { status: "Updates are off here", detail: state.reason, busy: false, attention: false };
  }
}

// What the window may ask the shell to do about updates; anything else is ignored.
export const isUpdateAction = (value: unknown): value is UpdateAction => value === "check" || value === "install" || value === "download";
