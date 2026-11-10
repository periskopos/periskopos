import { h } from "./dom.ts";
import { toast } from "./ui.ts";
import { sendWorldPerf } from "./views/world/perf.ts";

// The title bar's bug: copies the diagnostics (redacted, server/diagnostics.ts) and
// opens the bug form, the same as Help → Report an issue. Nothing is sent by itself:
// the person sees the form and everything pasted into it before submitting.

export const BUG_FORM_URL = "https://github.com/periskopos/periskopos/issues/new?template=bug_report.yml";

// Copy first: a window that's lost focus to the form can't write to the clipboard.
export async function reportIssue(open: (url: string) => void = (url) => void window.open(url, "_blank", "noopener")): Promise<void> {
  let copied = false;
  try {
    await sendWorldPerf(); // so the report's World numbers are up to this moment
    const report = await fetchDiagnostics();
    await navigator.clipboard.writeText(report);
    copied = true;
  } catch {
    // The form opens all the same, and the toast says where they can be had.
  }
  open(BUG_FORM_URL);
  if (copied) toast("Diagnostics copied: paste them into the report's Diagnostics box");
  else toast("Couldn't copy the diagnostics: Settings → About has them", "down");
}

async function fetchDiagnostics(): Promise<string> {
  const res = await fetch("/api/diagnostics", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export function reportButton(): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      class: "update-btn report-btn",
      title: "Report an issue",
      "aria-label": "Report an issue",
      onclick: () => void reportIssue(),
    },
    bugIcon(),
  );
}

function bugIcon(): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "15");
  el.setAttribute("height", "15");
  el.setAttribute("fill", "none");
  el.setAttribute("aria-hidden", "true");
  const parts = [
    "M5 6.5 C5 4.8 6.3 3.5 8 3.5 C9.7 3.5 11 4.8 11 6.5 V10 C11 11.7 9.7 13.5 8 13.5 C6.3 13.5 5 11.7 5 10 Z", // the body
    "M5.8 3.9 4.5 2.2",
    "M10.2 3.9 11.5 2.2",
    "M5 6.5 2.5 5.5",
    "M11 6.5 13.5 5.5",
    "M5 9 H2.2",
    "M11 9 H13.8",
    "M5.3 11.5 2.8 13",
    "M10.7 11.5 13.2 13",
  ];
  for (const d of parts) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.1");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    el.append(path);
  }
  return el;
}
