import type { Approval } from "../../shared/types.ts";
import { api } from "./api.ts";
import { h } from "./dom.ts";
import { errorBox, timeAgo, toast } from "./ui.ts";

// An agent's action waits for me (docs/AGENT-SAFETY.md §4.2). Every open
// Periskopos window asks, one request at a time; answering in one
// window closes the question in the others.

const EVERY_MS = 3000;
let open: { id: string; dialog: HTMLDialogElement } | undefined;
const answered = new Set<string>();
// Every request a dialog was opened for. A request is asked about once: if its
// dialog closed without an answer here (answered elsewhere, ran out of time), a
// stale list must not bring it back.
const shown = new Set<string>();
// The timer and a tab becoming visible both poll; one at a time, so two
// answers arriving together can't each open a dialog.
let polling = false;

async function poll() {
  if (document.hidden || polling) return;
  polling = true;
  try {
    await check();
  } finally {
    polling = false;
  }
}

async function check() {
  let approvals: Approval[];
  try {
    ({ approvals } = await api<{ approvals: Approval[] }>("GET", "/approvals"));
  } catch {
    return; // the page itself says when the server is down
  }
  if (open && !approvals.some((a) => a.id === open!.id)) {
    // Answered in another window, or it ran out of time.
    open.dialog.close();
    if (!answered.has(open.id)) toast("An agent's request was answered elsewhere or expired", "unknown");
    open = undefined;
  }
  const next = approvals.find((a) => !answered.has(a.id) && !shown.has(a.id));
  if (!open && next) ask(next);
}

// "1:42" left to answer.
const minSec = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function ask(a: Approval) {
  shown.add(a.id);
  const id = `approval-${a.id}`;
  const dialog = h("dialog", { class: "dialog", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-text` });
  const errors = h("div");
  let busy = false;
  // Polling pauses while the window is hidden, so the dialog can appear with
  // only seconds left: show the real time, and stop answers once it's up.
  const expiresAt = Date.parse(a.expiresAt);
  const left = () => (Number.isNaN(expiresAt) ? Infinity : expiresAt - Date.now());
  const expired = () => left() <= 0;
  const countdown = h("span");

  // allowForMinutes: approve, and let this assistant run this action
  // without asking for that long.
  const answer = async (approve: boolean, allowForMinutes?: number) => {
    if (busy || expired()) return;
    busy = true;
    errors.replaceChildren();
    for (const b of buttons) b.disabled = true;
    try {
      answered.add(a.id);
      await api("POST", `/approvals/${encodeURIComponent(a.id)}`, { approve, ...(allowForMinutes ? { allowForMinutes } : {}) });
      toast(
        !approve ? `Declined: ${a.label} on ${a.appName}` : allowForMinutes ? `Approved, and allowed for an hour: ${a.label} on ${a.appName}` : `Approved: ${a.label} on ${a.appName}`,
        approve ? "up" : "unknown",
      );
      dialog.close();
    } catch (err) {
      answered.delete(a.id);
      errors.replaceChildren(errorBox(err));
      for (const b of buttons) b.disabled = expired();
      busy = false;
    }
  };

  // Decline has the focus, so Enter never approves by accident; Escape declines.
  const declineBtn = h("button", { type: "button", class: "btn", autofocus: true, onclick: () => void answer(false) }, "Decline");
  const approveBtn = h("button", { type: "button", class: "btn btn--primary", onclick: () => void answer(true) }, "Approve");
  // Only an assistant with its own token can be let run it again unasked.
  const allowBtn = a.agentId ? h("button", { type: "button", class: "btn", title: `${a.agent} may run ${a.label} on ${a.appName} without asking for the next hour`, onclick: () => void answer(true, 60) }, "Approve, and allow for 1 hour") : null;
  const buttons = [declineBtn, approveBtn, ...(allowBtn ? [allowBtn] : [])];

  dialog.append(
    h(
      "div",
      { class: "form" },
      h("h2", { id: `${id}-title` }, `${a.agent} asks to run “${a.label}” on ${a.appName}`),
      h(
        "div",
        { id: `${id}-text`, class: "stack-sm" },
        h("p", { class: "secondary" }, `Done through ${a.service}. It changes the live app, and is recorded in the activity log.`),
        h("p", { class: "meta" }, "Asked ", timeAgo(a.requestedAt), ". ", countdown),
      ),
      errors,
      h("div", { class: "actions actions--end" }, declineBtn, allowBtn, approveBtn),
    ),
  );
  const tick = () => {
    const ms = left();
    if (ms === Infinity) countdown.textContent = "If you don't answer in time, nothing runs.";
    else if (ms > 0) countdown.textContent = `If you don't answer within ${minSec(ms)}, nothing runs.`;
    else {
      countdown.textContent = "Time's up: nothing runs.";
      for (const b of buttons) b.disabled = true;
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 1000);
  tick();

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    // Once time is up there's nothing to decline: Escape just closes it.
    if (expired()) dialog.close();
    else void answer(false);
  });
  dialog.addEventListener("close", () => {
    clearInterval(timer);
    dialog.remove();
    if (open?.id === a.id) open = undefined;
  });
  document.body.append(dialog);
  dialog.showModal();
  open = { id: a.id, dialog };
}

export function watchApprovals() {
  void poll();
  setInterval(() => void poll(), EVERY_MS);
  document.addEventListener("visibilitychange", () => void poll());
}
