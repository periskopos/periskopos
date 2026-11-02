import type { User } from "../../shared/types.ts";
import "./tokens.css";
// In cascade order: responsive.css adjusts the others, so it comes last.
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/fleet.css";
import "./styles/app.css";
import "./styles/accounts.css";
import "./styles/panels.css";
import "./styles/motion.css";
import "./styles/responsive.css";
import { api, ApiError } from "./api.ts";
import { watchApprovals } from "./approvals.ts";
import { initDesktopShell } from "./desktop.ts";
import { h, mount } from "./dom.ts";
import { startQueuedTour } from "./tour.ts";
import { errorBox, go, lamp, shell } from "./ui.ts";
import { addAppView } from "./views/addApp.ts";
import { appView } from "./views/appPage.ts";
import type { AppTab } from "./views/appPage.ts";
import { APP_TABS, SETTINGS_PARTS } from "./views/app/page.ts";
import { statusView } from "./views/status.ts";
import { fleetView } from "./views/fleet.ts";
import { firstRunView } from "./views/firstRun.ts";
import { connectServiceView, servicesView } from "./views/services.ts";
import { settingsTabOf, settingsView } from "./views/settings.ts";

const root = document.getElementById("app")!;
let cleanup: (() => void) | void;
// Counts route changes. route() waits for /me before drawing, so a second hash
// change (a clicked notification during start-up, say) can arrive meanwhile;
// only the latest one may draw, or two views would run at once and the first
// one's timers would never be stopped.
let generation = 0;

// Hash routes:
// #/  #/apps/new  #/apps/<slug>[/deploys|/traffic|/actions|/history|/settings[/connections|/protocol]]  #/status  #/services[/new]
// #/settings[/notifications|/assistants|/data]
async function route() {
  const mine = ++generation;
  cleanup?.();
  cleanup = undefined;
  const [section, id, sub, part] = location.hash.replace(/^#\/?/, "").split("/");
  window.scrollTo(0, 0);

  try {
    const { user } = await api<{ user: User | null }>("GET", "/me");
    if (mine !== generation) return; // a newer route() draws instead
    // A new page starts clean: what mount() keeps across a redraw (focus,
    // open disclosures, unsaved text) belongs to the page it was on.
    root.replaceChildren();
    cleanup = show(user, section, id, sub, part);
    if (user) startQueuedTour(); // once, over the first page after the first run
  } catch (err) {
    if (mine !== generation) return;
    mount(root, shell(null, null, unreachable(err)));
  }
}

// Draws the view for a route; returns its cleanup, if it has one.
function show(user: User | null, section: string | undefined, id: string | undefined, sub: string | undefined, part?: string): (() => void) | void {
  if (!user) return firstRunView(root, () => go("#/apps/new", route));

  if (section === "settings") return settingsView(root, user, settingsTabOf(id));
  if (section === "status") return statusView(root, user);
  if (section === "services" && id === "new") return connectServiceView(root, user, () => go("#/services", route));
  if (section === "services") return servicesView(root, user);
  if (section === "apps" && id === "new") {
    return addAppView(root, user, (app) => go(`#/apps/${encodeURIComponent(app.slug)}`, route));
  }
  if (section === "apps" && id) {
    const tab: AppTab = APP_TABS.find((t) => t === sub) ?? "overview";
    const settingsPart = SETTINGS_PARTS.find((p) => p.key === part)?.key ?? "general";
    return appView(root, user, decodeURIComponent(id), tab, () => go("#/", route), settingsPart);
  }
  return fleetView(root, user);
}

// The server isn't answering: say so, and what to run.
function unreachable(err: unknown) {
  if (!(err instanceof ApiError) || err.status !== 0) return errorBox(err);
  return h(
    "div",
    { class: "narrow welcome stack-lg" },
    h(
      "div",
      { class: "notice notice--error", role: "alert" },
      lamp("down"),
      h(
        "div",
        null,
        h("strong", null, "Periskopos's server isn't running."),
        h("p", null, "Start it in the periskopos folder with ", h("code", null, "npm run dev"), ", then reload this page."),
      ),
    ),
  );
}

window.addEventListener("hashchange", route);
initDesktopShell(); // a no-op in a browser tab
route();
watchApprovals();
