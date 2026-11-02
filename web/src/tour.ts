import { h, mount } from "./dom.ts";

// The guided tour: a few stops around the top bar, each lit up with a short
// card beside it, shown once after the first run (firstRun.ts queues it) and
// again whenever Settings › General is asked. It lives on document.body, so
// a page's redraw doesn't end it, and finds each stop afresh as it draws,
// since a redraw replaces the elements. A stop that isn't on screen (the nav
// on a narrow window, say) is passed over.

type Stop = { target?: string; title: string; text: string };

const STOPS: Stop[] = [
  {
    title: "A quick look around",
    text: "A few stops, under a minute. Leave whenever you like with Skip or Escape; it's in Settings if you want it again.",
  },
  {
    target: '.nav a[href="#/"]',
    title: "Apps",
    text: "Every app you watch, problems on top: whether it's up, whether your last push is live, and what's about to expire. Open one for its deploys, errors, traffic and checks.",
  },
  {
    target: '.nav a[href="#/status"]',
    title: "Status",
    text: "The status pages of the providers your apps run on, counting only the parts they actually use, and which of your apps an incident touches.",
  },
  {
    target: '.nav a[href="#/services"]',
    title: "Accounts",
    text: "Connect Cloudflare, GitHub, Vercel, Stripe and the rest once, each with a key you create. Keys stay on this computer, read-only wherever the provider allows.",
  },
  {
    target: ".notify-btn",
    title: "Notifications",
    text: "The bell counts what needs looking at right now, and lists what recovered in the last day.",
  },
  {
    target: '.nav a[href="#/settings"]',
    title: "Settings",
    text: "Desktop and phone alerts, start at login, AI assistants over MCP (they can ask, never see a key), and backups.",
  },
  {
    title: "That's the tour",
    text: "Start with an app: Add app on the Apps page takes its name and address, and Periskopos suggests what to watch. Nothing changes in your app.",
  },
];

const KEY = "periskopos-tour";

// After the first run: the tour starts on the next page that has a top bar.
export function queueTour() {
  try {
    localStorage.setItem(KEY, "pending");
  } catch {
    // not remembered: there's no tour this time, nothing else changes
  }
}

export function startQueuedTour() {
  let pending = false;
  try {
    pending = localStorage.getItem(KEY) === "pending";
  } catch {
    return;
  }
  if (pending) startTour();
}

let running: (() => void) | undefined;

export function startTour() {
  if (running) return;
  try {
    localStorage.setItem(KEY, "seen"); // seen once it starts: a reload mid-tour doesn't bring it back
  } catch {
    // shown now all the same
  }

  const spotlight = h("div", { class: "tour-spotlight", "aria-hidden": "true" });
  const card = h("div", { class: "tour-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title", "aria-describedby": "tour-text" });
  // The backdrop takes the clicks meant for the page underneath: the tour
  // ends only by its own buttons or Escape.
  const layer = h("div", { class: "tour" }, h("div", { class: "tour-backdrop" }), spotlight, card);
  const before = document.activeElement as HTMLElement | null;
  let index = 0;
  let frame = 0;

  const visible = (el: Element | null): el is HTMLElement => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const targetOf = (stop: Stop) => (stop.target ? document.querySelector(stop.target) : null);
  // The stops on screen now, so "2 of 5" counts what's shown.
  const shown = () => STOPS.filter((s) => !s.target || visible(targetOf(s)));

  function draw() {
    const stops = shown();
    index = Math.min(index, stops.length - 1);
    const stop = stops[index];
    const last = index === stops.length - 1;
    mount(
      card,
      h("p", { class: "label tour-step" }, `${index + 1} of ${stops.length}`),
      h("h2", { class: "tour-title", id: "tour-title" }, stop.title),
      h("p", { class: "tour-text", id: "tour-text" }, stop.text),
      h(
        "div",
        { class: "tour-actions" },
        !last && h("button", { type: "button", class: "btn btn--ghost tour-skip", onclick: () => end() }, "Skip"),
        index > 0 && h("button", { type: "button", class: "btn", onclick: () => move(-1) }, "Back"),
        h("button", { type: "button", class: "btn btn--primary tour-next", onclick: () => (last ? end() : move(1)) }, last ? "Done" : "Next"),
      ),
    );
    card.querySelector<HTMLElement>(".tour-next")?.focus();
    place();
  }

  // Lights the stop and sets the card under it (above it near the bottom),
  // kept inside the window; a stop with no target is centred, unlit.
  let lastPlaced = "";
  function place() {
    const stop = shown()[index];
    const target = stop && targetOf(stop);
    const r = target && visible(target) ? target.getBoundingClientRect() : null;
    const key = r ? `${r.left},${r.top},${r.width},${r.height}` : "none";
    const size = `${innerWidth}x${innerHeight}`;
    if (key + size === lastPlaced) return;
    lastPlaced = key + size;

    layer.classList.toggle("tour--centred", !r);
    if (!r) {
      spotlight.removeAttribute("style");
      card.removeAttribute("style");
      return;
    }
    const pad = 4;
    Object.assign(spotlight.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + 2 * pad}px`,
      height: `${r.height + 2 * pad}px`,
    });
    const gap = 12;
    const margin = 16;
    const w = card.offsetWidth;
    const ch = card.offsetHeight;
    const below = r.bottom + gap + ch <= innerHeight - margin;
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - margin));
    Object.assign(card.style, {
      left: `${left}px`,
      top: `${below ? r.bottom + gap : Math.max(margin, r.top - gap - ch)}px`,
    });
  }

  // Follows the stop as the page moves under it: a redraw, a resize, the
  // window's own layout settling.
  const follow = () => {
    place();
    frame = requestAnimationFrame(follow);
  };

  function move(by: number) {
    index = Math.max(0, index + by);
    draw();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      end();
    } else if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "Tab") {
      // Focus stays in the card while it's open.
      const controls = [...card.querySelectorAll<HTMLElement>("button")];
      const at = controls.indexOf(document.activeElement as HTMLElement);
      const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
      e.preventDefault();
      controls[next]?.focus();
    }
  }

  function end() {
    cancelAnimationFrame(frame);
    document.removeEventListener("keydown", onKey, true);
    layer.remove();
    running = undefined;
    if (before?.isConnected) before.focus();
  }

  running = end;
  document.addEventListener("keydown", onKey, true);
  document.body.append(layer);
  draw();
  frame = requestAnimationFrame(follow);
}
