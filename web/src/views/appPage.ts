import { hasDetails } from "../../../shared/catalog.ts";
import type {
  ActionResult,
  ActivityEntry,
  App,
  AppPause,
  AppHistory,
  AppStatus,
  ConfigReport,
  ConnectionDetails,
  ProtocolView,
  ServiceView,
  Suggestion,
  User,
} from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { busyButton, errorBox, shell, toast } from "../ui.ts";
import { openActionDialog } from "./actionsParts.ts";
import type { ActionsList } from "./actionsParts.ts";
import { banner, header, tabs } from "./app/header.ts";
import { pauseBanners, pauseControl } from "./app/pauseButton.ts";
import { history } from "./app/history.ts";
import { overview } from "./app/overview.ts";
import type { AppPage, AppTab, SettingsPart } from "./app/page.ts";
import { saveDomainDates, settingsTab } from "./app/settings.ts";
import { configTab } from "./app/config.ts";
import { actionsTab, deploysTab, trafficTab } from "./app/tabs.ts";
import { loadProviders, providerBanners } from "./providers.ts";

export type { AppTab };


// The page redraws as fresh data arrives. While I'm filling in a form it
// holds off, so nothing I've typed is wiped: until I submit, or two
// minutes after my last keystroke.
const EDIT_GRACE_MS = 120_000;

// App (IA: App → Overview · History · Settings). One header for all tabs;
// monitoring on Overview and History, configuration on Settings. This
// module loads and keeps the page's data; each tab draws from it
// (views/app).
// The tabs drawn from what connections show of themselves.
const SHOWS_DETAILS = new Set<AppTab>(["overview", "deploys", "traffic"]);

export function appView(root: Element, user: User, slug: string, tab: AppTab, gone: () => void, settingsPart: SettingsPart = "general"): () => void {
  const apiBase = `/apps/${encodeURIComponent(slug)}`;
  let failure: unknown;
  let alive = true;
  let fastUntil = 0; // after an action, refresh often for a while (a deploy takes minutes)
  let firstCheckAsked = false;

  const page: AppPage = {
    slug,
    tab,
    settingsPart,
    base: `#/apps/${encodeURIComponent(slug)}`,
    apiBase,
    services: [],
    details: new Map(),
    providers: [],
    protocolState: {},
    activity: [],
    trafficRange: "week",
    searchRange: "week",
    gapsOpen: false,
    draw: () => draw(),
    drawPause: () => drawPause(),
    pauseEdits: 0,
    afterSubmit: () => {
      lastEdit = 0;
      return load();
    },
    // Asks first; runs only on a confirmed yes; shows what happened.
    openAction: (action) => {
      if (!page.app) return;
      openActionDialog(page.app, action, async (confirmName) => {
        const result = await api<ActionResult & { label: string }>("POST", `${apiBase}/actions/${encodeURIComponent(action.id)}`, {
          confirmed: true,
          ...(confirmName ? { confirmName } : {}),
        });
        page.outcome = result;
        fastUntil = result.ok ? Date.now() + 5 * 60_000 : 0;
        toast(`${result.label}: ${result.ok ? "done" : "didn't go through"}`, result.ok ? "up" : "attention");
        // The dialog closes now, so the toast is seen; the page catches up behind it.
        void load(true);
      });
    },
    // One click on "Get more from this app": connect the plain match (or
    // the one picked from a few), then show what it brought.
    connectSuggested: async (sg: Suggestion) => {
      if (!sg.match) return;
      try {
        await api("POST", `${apiBase}/connections`, { type: sg.kind, serviceId: sg.serviceId, resource: sg.match.resource, settings: sg.match.settings });
        toast(`Connected ${sg.match.label}`);
        page.suggestions = page.suggestions?.filter((x) => x.serviceId !== sg.serviceId || x.kind !== sg.kind);
        await load(true);
      } catch (err) {
        toast((err as Error).message, "down");
      }
    },
    gone,
  };

  const body = h("div", { class: "page-body" });
  mount(root, shell(user, "fleet", body));

  let lastEdit = 0;
  const noteEdit = (e: Event) => {
    if ((e.target as Element | null)?.closest("form")) lastEdit = Date.now();
  };
  body.addEventListener("input", noteEdit);
  body.addEventListener("change", noteEdit);
  const editing = () => Date.now() - lastEdit < EDIT_GRACE_MS;
  saveDomainDates(page, body);

  // Made once, so its "Checking…" state survives the redraws it causes.
  // load() never throws (it shows its own errors), so it says whether the
  // check went through: "Checked just now" only when it did.
  const checkNow = busyButton("Check now", "Checking…", async () => {
    if (await load(true)) toast("Checked just now");
    else if (alive) toast("Couldn't check: see the message on the page", "down");
  });

  const pause = pauseControl(page);
  // Its own slot: a form being edited holds back the page's redraws, and this
  // has to say what just happened all the same.
  const pauseSlot = h("div", { class: "pause-slot" });
  const drawPause = () => mount(pauseSlot, ...pauseBanners(page));

  // Resolves true when everything the page needs arrived, false when
  // something failed (the page then shows why). Never throws.
  async function load(refresh = false): Promise<boolean> {
    try {
      ({ app: page.app } = await api<{ app: App }>("GET", apiBase));
      if (!alive) return false;
      failure = undefined;
      draw();
      const pauseEdits = page.pauseEdits;
      // Each part is caught on its own, so one failing request keeps what the
      // others brought (and what the last load had) instead of blanking the
      // page; the first failure is shown above the content.
      let partFailure: unknown;
      const part = <T>(p: Promise<T>) =>
        p.catch((err: unknown) => {
          partFailure ??= err;
          return undefined;
        });
      const [statusAnswer, historyAnswer, servicesAnswer, providers, protocolAnswer, actionsAnswer, activityAnswer, configAnswer, pauseAnswer] = await Promise.all([
        part(api<{ status: AppStatus }>("GET", `${apiBase}/status${refresh ? "?refresh=1" : ""}`)),
        part(api<{ history: AppHistory }>("GET", `${apiBase}/history`)),
        part(api<{ services: ServiceView[] }>("GET", "/services")),
        loadProviders(),
        part(api<{ protocol: ProtocolView }>("GET", `${apiBase}/protocol`)),
        // The actions panel is optional: if it can't load, the page still does.
        api<ActionsList>("GET", `${apiBase}/actions`).catch(() => undefined),
        api<{ activity: ActivityEntry[] }>("GET", `${apiBase}/activity`).catch(() => undefined),
        // The tab's count comes with every tab; its own tab says why it failed.
        api<{ report: ConfigReport }>("GET", `${apiBase}/config`).catch((err: unknown) => err as Error),
        api<AppPause>("GET", `${apiBase}/pause`).catch(() => undefined),
      ]);
      page.status = statusAnswer?.status ?? page.status;
      page.hist = historyAnswer?.history ?? page.hist;
      page.services = servicesAnswer?.services ?? page.services;
      page.providers = providers;
      page.protocol = protocolAnswer?.protocol ?? page.protocol;
      page.actions = actionsAnswer;
      if (pauseEdits === page.pauseEdits) page.pause = pauseAnswer ?? page.pause;
      page.activity = activityAnswer?.activity ?? page.activity;
      page.config = configAnswer instanceof Error ? (page.config instanceof Error || !page.config ? configAnswer : page.config) : configAnswer.report;
      // Never checked yet (a new app): check now rather than "within a few
      // minutes", once per visit to the tab.
      if (tab === "config" && !firstCheckAsked && page.config && !(page.config instanceof Error) && !page.config.checkedAt) {
        firstCheckAsked = true;
        void api<{ report: ConfigReport }>("POST", `${apiBase}/config/check`).then(
          (r) => {
            page.config = r.report;
            if (alive) draw();
          },
          () => undefined,
        );
      }
      failure = partFailure;
      if (!alive) return false;
      draw();
      if (!SHOWS_DETAILS.has(tab)) return partFailure === undefined;
      await loadDetailsAndSuggestions(page.app);
      if (alive) draw();
      return partFailure === undefined;
    } catch (err) {
      failure = err;
      if (alive) draw();
      return false;
    }
  }

  // What each connection shows of itself (deploys, commits, traffic), for
  // the tabs that show it, and what the accounts could still add.
  async function loadDetailsAndSuggestions(current: App) {
    await Promise.all([
      ...current.connections
        .filter((c) => hasDetails(c.type))
        .map(async (c) => {
          try {
            const { details } = await api<{ details: ConnectionDetails }>("GET", `${apiBase}/connections/${encodeURIComponent(c.id)}/details`);
            page.details.set(c.id, details);
          } catch (err) {
            page.details.set(c.id, err as Error);
          }
        }),
      api<{ suggestions: Suggestion[] }>("GET", `${apiBase}/suggestions`).then(
        (r) => {
          page.suggestions = r.suggestions;
        },
        () => {
          page.suggestions = undefined; // nothing to offer is better than an error here
        },
      ),
    ]);
  }

  function draw() {
    if (failure && !page.app) return mount(body, errorBox(failure));
    drawPause();
    if (!page.app || editing()) return;
    const a = page.app;
    mount(
      body,
      header(page, a, checkNow, pause.root),
      tabs(page, a),
      banner(page),
      pauseSlot,
      ...providerBanners(page.providers, slug),
      failure ? errorBox(failure) : null,
      ...tabBody(a),
    );
  }

  function tabBody(a: App) {
    switch (tab) {
      case "overview":
        return overview(page, a);
      case "deploys":
        return deploysTab(page, a);
      case "traffic":
        return trafficTab(page, a);
      case "config":
        return configTab(page);
      case "actions":
        return actionsTab(page);
      case "history":
        return history(page);
      case "settings":
        return settingsTab(page, a);
    }
  }

  void load();
  const reload = setInterval(() => void load(), 60_000);
  const fast = setInterval(() => {
    if (Date.now() < fastUntil) void load();
  }, 10_000);
  return () => {
    alive = false;
    pause.destroy();
    clearInterval(reload);
    clearInterval(fast);
  };
}
