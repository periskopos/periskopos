import { mainSite } from "../../../shared/catalog.ts";
import { duration } from "../../../shared/format.ts";
import type { App, AppMetric, AppStatus, NotificationItem, NotificationsView, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { STATE_LABEL, STATE_RANK, formatPct, formatUptime, hostOf, shortSha } from "../format.ts";
import type { ShownState } from "../format.ts";
import { attentionCount, attentionSection } from "./attention.ts";
import type { ProviderStatus } from "../../../shared/types.ts";
import { providersRead, summarize } from "../../../shared/fleet.ts";
import { PUSH, appIcon, busyButton, errorBox, lamp, refreshNotifications, shell, status, timeAgo } from "../ui.ts";

const REFRESH_MS = 60_000;

// List or cards: remembered on this computer, list the first time.
type Layout = "list" | "cards";
const LAYOUT_KEY = "periskopos-apps-layout";
function savedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "cards" ? "cards" : "list";
  } catch {
    return "list";
  }
}

// Apps (IA: Fleet): the summary first, then every app, problems on top: as a
// table of aligned rows, or as cards.
export function fleetView(root: Element, user: User): () => void {
  let apps: App[] | undefined;
  let statuses = new Map<string, AppStatus>();
  let error: unknown;
  let lastLoaded: string | undefined;
  let providers: ProviderStatus[] = [];
  let attention: NotificationItem[] | undefined; // until it's read, the header claims nothing
  let accountsRead = false;
  let providersOk = false;

  const headline = h("div", { class: "summary" });
  const sub = h("p", { class: "meta" });
  const strip = h("div", { class: "stack-sm" });
  const board = h("div");
  const checkNow = busyButton("Check now", "Checking…", () => load(true));
  let layout = savedLayout();
  const layoutButton = (value: Layout, text: string) =>
    h("button", { type: "button", class: "segment", "aria-pressed": String(layout === value), onclick: () => setLayout(value) }, text);
  const layoutSwitch = h("div", { class: "segmented", role: "group", "aria-label": "Show apps as" });
  const drawSwitch = () => mount(layoutSwitch, layoutButton("list", "List"), layoutButton("cards", "Cards"));
  function setLayout(value: Layout) {
    layout = value;
    try {
      localStorage.setItem(LAYOUT_KEY, value);
    } catch {
      // not remembered: still switches now
    }
    drawSwitch();
    draw();
    // The board cross-fades into the new layout (styles/motion.css).
    board.classList.remove("board-switching");
    void board.offsetWidth; // restarts the animation on a quick switch back
    board.classList.add("board-switching");
  }
  drawSwitch();

  mount(
    root,
    shell(
      user,
      "fleet",
      h(
        "div",
        { class: "page-header" },
        h("div", null, headline, sub),
        h("div", { class: "actions" }, layoutSwitch, checkNow, h("a", { class: "btn btn--primary", href: "#/apps/new" }, "Add app")),
      ),
      strip,
      board,
    ),
  );

  const stateOf = (app: App): ShownState => statuses.get(app.slug)?.state ?? "checking";

  function draw() {
    mount(strip, attentionSection(attention ?? [], providers));
    if (error) {
      // What was loaded last is old news: the header doesn't go on saying it.
      mount(headline, lamp("unknown", { large: true }), h("h1", null, "Can't read your apps' status"));
      mount(sub, lastLoaded && ["Last updated ", timeAgo(lastLoaded)]);
      return mount(board, errorBox(error));
    }
    if (!apps) {
      mount(headline, h("h1", null, "Apps"));
      return mount(board, h("p", { class: "meta" }, "Loading…"));
    }
    if (apps.length === 0) {
      mount(headline, h("h1", null, "Apps"));
      sub.textContent = "";
      return mount(
        board,
        h(
          "div",
          { class: "section empty-hero" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }),
          h("h2", null, "Nothing to watch yet"),
          h("p", null, "Add an app with its name and public URL. Periskopos starts checking it straight away; nothing in the app changes."),
          h("a", { class: "btn btn--primary", href: "#/apps/new" }, "Add your first app"),
        ),
      );
    }

    const all = apps.map((a) => statuses.get(a.slug)).filter((s): s is AppStatus => Boolean(s));
    const { state, text } = summarize(all);
    const everyoneChecked = all.length === apps.length;
    mount(
      headline,
      lamp(everyoneChecked ? state : "checking", { large: true }),
      h("h1", null, !everyoneChecked ? "Checking your apps…" : text === "All normal" ? "All systems normal" : text),
    );
    mount(
      sub,
      `${apps.length} app${apps.length === 1 ? "" : "s"}`,
      // Only when they were really read: not a failed read, or a key never tested.
      attention && attentionCount(attention, providers) === 0 && accountsRead && providersOk && " · accounts and providers fine",
      lastLoaded && [" · updated ", timeAgo(lastLoaded)],
    );

    const sorted = [...apps].sort(
      (a, b) => STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] || a.name.localeCompare(b.name),
    );
    if (layout === "cards") {
      return mount(board, h("ul", { class: "app-cards", "aria-label": "Your apps, problems first" }, sorted.map((app) => card(app, statuses.get(app.slug)))));
    }
    // A column no app has anything for (no host connected anywhere, no app
    // reporting numbers) isn't drawn: the board stays a glance.
    const columns: Columns = {
      push: sorted.some((a) => statuses.get(a.slug)?.deploy !== undefined),
      numbers: sorted.some((a) => Boolean(statuses.get(a.slug)?.metrics?.length)),
    };
    mount(
      board,
      h(
        "div",
        { class: "section" },
        h(
          "table",
          { class: "board" },
          h("caption", { class: "visually-hidden" }, "Your apps, problems first"),
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "App"),
              h("th", { scope: "col", class: "col-state" }, "State"),
              h("th", { scope: "col", class: "col-response num-col" }, "Response"),
              h("th", { scope: "col", class: "col-uptime num-col" }, "Uptime 30 days"),
              columns.push && h("th", { scope: "col", class: "col-push" }, "Last push"),
              columns.numbers && h("th", { scope: "col", class: "col-numbers" }, "Numbers"),
              h("th", { scope: "col", class: "col-checked num-col" }, "Checked"),
            ),
          ),
          h("tbody", null, sorted.map((app) => row(app, statuses.get(app.slug), columns))),
        ),
      ),
    );
  }

  async function load(refresh = false) {
    try {
      ({ apps } = await api<{ apps: App[] }>("GET", "/apps"));
      error = undefined;
      draw();
      const { statuses: list } = await api<{ statuses: AppStatus[] }>("GET", `/status${refresh ? "?refresh=1" : ""}`);
      statuses = new Map(list.map((s) => [s.slug, s]));
      lastLoaded = new Date().toISOString();
      // The checks just recorded: the bell follows at once.
      void refreshNotifications(true);
      const read = await api<{ providers: ProviderStatus[] }>("GET", "/providers").then(
        (r) => r.providers,
        () => undefined, // a status page being unreachable must never break a screen
      );
      providers = read ?? [];
      providersOk = read !== undefined && providersRead(read);
      // The bell's list, for the strip above the board. Failing to read it
      // keeps what was there: it must never break the page.
      const view = await api<NotificationsView>("GET", "/notifications").catch(() => undefined);
      if (view) attention = view.now;
      accountsRead = view?.accountsRead === true;
    } catch (err) {
      error = err;
    }
    draw();
  }

  void load();
  const reload = setInterval(() => void load(), REFRESH_MS);
  const retick = setInterval(draw, 15_000); // keeps "… ago" honest
  return () => {
    clearInterval(reload);
    clearInterval(retick);
  };
}

// "128 accounts · 341 saved indexes"
const numbers = (metrics: AppMetric[], n: number) =>
  metrics
    .slice(0, n)
    .map((m) => `${typeof m.value === "number" ? m.value.toLocaleString() : m.value} ${m.label.toLowerCase()}`)
    .join(" · ");

// What a row and a card both show about one app.
function factsOf(app: App, s: AppStatus | undefined) {
  const state: ShownState = s?.state ?? "checking";
  const site = mainSite(app);
  const check = site && s?.checks[site.id];
  // The check that says whether the app is up, when there is one: a certificate
  // checked just now says nothing about a site last checked hours ago.
  const latest = check ?? (s ? Object.values(s.checks).sort((a, b) => b.at.localeCompare(a.at))[0] : undefined);

  // A problem replaces the URL with what's wrong.
  const incident = s?.incident;
  const reason = incident
    ? h(
        "span",
        { class: `reason reason--${incident.kind === "outage" ? "down" : "attention"}` },
        // Not "down for 5 days" when nothing has looked for hours: only what's known.
        incident.kind !== "outage" ? incident.reason : s?.staleSince ? [timeAgo(s.staleSince, "Last seen down "), ` · ${incident.reason}`] : `Down ${duration(Date.now() - Date.parse(incident.startedAt))} · ${incident.reason}`,
      )
    : check && check.state === "down"
      ? h("span", { class: "reason reason--down" }, check.detail ?? "Not responding")
      : check?.state === "unknown" && check.detail
        ? h("span", { class: "meta" }, check.detail)
        : s?.staleSince
        ? h("span", { class: "meta" }, timeAgo(s.staleSince, "Last checked "))
        : h("span", { class: "app-url" }, hostOf(app.url));

  const push = s?.deploy;
  const commit = push && (push.state === "live" ? push.live : push.latest);
  const pushed = push
    ? h("span", { class: "status" }, lamp(PUSH[push.state].lamp), PUSH[push.state].text, commit && h("span", { class: "hash" }, shortSha(commit.sha)))
    : undefined;
  // No figure from hours ago beside a state that says there's no recent data.
  const response = check?.ms !== undefined && check.state === "up" && state !== "stale" ? `${check.ms} ms` : undefined;
  const uptime = s?.uptime30d !== undefined ? formatUptime(s.uptime30d, s.uptimeWatchedMs) : undefined;
  return { state, check, latest, reason, pushed, response, uptime };
}

const none = () => h("span", { class: "meta" }, "—");

// One card: the app and its state on top, what's wrong (or where it lives),
// then its figures. The name's link covers the whole card.
function card(app: App, s: AppStatus | undefined) {
  const f = factsOf(app, s);
  const figure = (label: string, value: Node | string | undefined) =>
    h("div", { class: "card-figure" }, h("dt", { class: "label" }, label), h("dd", { class: "mono" }, value ?? none()));
  return h(
    "li",
    { class: `app-card app-card--${f.state}` },
    h(
      "div",
      { class: "app-card-head" },
      // The state is on the right already: the app's own icon leads.
      appIcon(app),
      h("a", { class: "row-link", href: `#/apps/${encodeURIComponent(app.slug)}` }, app.name),
      h("span", { class: "app-card-state" }, status(f.state)),
    ),
    h("div", { class: "truncate" }, f.reason),
    h(
      "dl",
      { class: "card-figures" },
      figure("Response", f.response),
      figure("Uptime 30 days", f.uptime),
      figure("Last push", f.pushed),
      figure("Checked", f.latest ? timeAgo(f.latest.at) : undefined),
    ),
    s?.metrics?.length ? h("p", { class: "numbers truncate meta", title: numbers(s.metrics, 3) }, numbers(s.metrics, 3)) : null,
  );
}

// Which optional columns the board draws: every row draws the same ones.
type Columns = { push: boolean; numbers: boolean };

function row(app: App, s: AppStatus | undefined, columns: Columns) {
  const { state, check, latest, reason, pushed, response, uptime } = factsOf(app, s);

  return h(
    "tr",
    null,
    h(
      "td",
      null,
      h(
        "div",
        { class: "app-cell" },
        lamp(state, { label: `${app.name}: ${STATE_LABEL[state]}` }),
        h(
          "div",
          null,
          h("span", { class: "app-name" }, appIcon(app), h("a", { class: "row-link", href: `#/apps/${encodeURIComponent(app.slug)}` }, app.name)),
          h("div", { class: "truncate" }, reason),
          // Phones hide the figure columns; the glance keeps them here.
          state === "up" &&
            h(
              "div",
              { class: "row-figures", "aria-hidden": "true" },
              [check?.ms !== undefined && `${check.ms} ms`, s?.uptime30d !== undefined && `${formatPct(s.uptime30d)} up`, s?.metrics?.length && numbers(s.metrics, 2)].filter(Boolean).join(" · "),
            ),
        ),
      ),
    ),
    h("td", { class: "col-state" }, status(state)),
    h("td", { class: "col-response num-col mono" }, response ?? none()),
    h("td", { class: "col-uptime num-col mono" }, uptime ?? none()),
    columns.push && h("td", { class: pushed ? "col-push" : "col-push is-empty" }, pushed ?? none()),
    // What the app reports about itself (the first three numbers).
    columns.numbers &&
      h(
        "td",
        { class: s?.metrics?.length ? "col-numbers" : "col-numbers is-empty" },
        s?.metrics?.length ? h("span", { class: "truncate numbers", title: numbers(s.metrics, 3) }, numbers(s.metrics, 3)) : none(),
      ),
    h("td", { class: "col-checked num-col meta" }, latest ? timeAgo(latest.at) : "—"),
  );
}
