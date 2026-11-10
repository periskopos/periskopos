import { providersRead, summarize } from "../../../shared/fleet.ts";
import type { App, AppStatus, NotificationsView, ProviderStatus, User, WatcherLog } from "../../../shared/types.ts";
import { growthSince, seenNow } from "../../../shared/valley/growth.ts";
import { valleyPlan } from "../../../shared/valley/plan.ts";
import { checksLately, tripsFor, valleyStats } from "../../../shared/valley/trips.ts";
import type { Trip } from "../../../shared/valley/trips.ts";
import { buildWorld, overallLine, placeApps, worldAt, worldStage } from "../../../shared/world.ts";
import type { World, WorldStage } from "../../../shared/world.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { STATE_LABEL } from "../format.ts";
import { errorBox, lamp, shell, timeAgo } from "../ui.ts";
import { plotDetail, statsRow, tripDetail, tripTitle, utilityDetail } from "./world/details.ts";
import { createFeed } from "./world/feed.ts";
import { briefFigures, figuresCalm, hudParts, watchHudRoom } from "./world/hudRoom.ts";
import { createLabels } from "./world/labels.ts";
import { lastCheckSaid } from "./world/looks.ts";
import { createLegend, createLookKey, createStepper, STAGE_NEWS } from "./world/legend.ts";
import { createReplay, moment } from "./world/replay.ts";
import { createWorldSettings } from "./world/settings.ts";
import { ZOOM_STEP } from "./world/scene/zoomFeel.ts";
import { savedPlaces, savedSeen, savedSky, savePlaces, saveSeen, saveSky, servicePlacesFrom, stageIsNews, withServicePlaces } from "./world/saved.ts";
import type { Selection, Standing, WorldScene } from "./world/scene/types.ts";
import { createClouds } from "./world/clouds.ts";
import { savedLooked, saveLooked, sinceYouLooked } from "./world/sinceLooked.ts";
import { createTour } from "./world/tour.ts";
import { knownRequests, refreshRequests } from "./world/traffic.ts";
import { createWatcherPanel } from "./world/watcherPanel.ts";

// The World page: your own valley, the same data as the Apps page drawn as a place. See
// docs/WORLD.md. This file wires the parts together and owns the data. The picture is
// loaded only when this page opens, and only says what shared/world.ts says.

const REFRESH_MS = 60_000;
const LOG_REFRESH_MS = 20_000; // the vans are the watcher's log, so it's read more often
const RETICK_MS = 15_000; // keeps "… ago" and "read lately" honest
const FIRST_READ_WAIT_MS = 1500; // a slow status read: draw the apps in their fog meanwhile
const CHECK_PANEL_KEPT_MS = 5 * 60_000;

export function worldView(root: Element, user: User, focusOn?: string): () => void {
  let apps: App[] | undefined;
  let statuses = new Map<string, AppStatus>();
  let providers: ProviderStatus[] = [];
  let error: unknown;
  let retrying = false; // "Try again" pressed, and the read not back yet
  let noticeSaid = "";
  let lastLoaded: string | undefined;
  let selection: Selection = null;
  let hovered: Selection = null;
  let world: World | undefined;
  let liveWorld: World | undefined; // what's true now, whatever's being shown
  let scene: WorldScene | null = null;
  let left = false;
  // Reads can overlap (the minute's reload, Try again, a slow server): only the newest is used,
  // so a late, older answer never writes over a newer one or says it failed after all.
  let loads = 0;
  let logReads = 0;
  let pendingFocus = focusOn;
  let notifications: NotificationsView | undefined;
  let sky = savedSky();
  let seen = savedSeen();
  let jumping = false; // entering or leaving a replay: the view moved, nothing happened
  let settled = false; // the first full read is in, or has taken long enough
  let tripsNow: Trip[] = [];
  let redrawingList = false;
  let noPicture = false; // this window can't draw it: the page still works without
  const tripsSeen = new Map<string, Trip>(); // a panel stays readable after its van has gone home

  const headline = h("div", { class: "summary" });
  const sub = h("p", { class: "meta" });
  const notice = h("div", { class: "world-notice" });
  const tryAgain = h("button", { type: "button", class: "btn", onclick: () => {
    if (retrying) return;
    retrying = true;
    draw();
    void load();
  } }, "Try again");
  const replayNote = h("div", { class: "world-notice" }); // not redrawn with the rest: it's about the last try at a replay
  const graphics = h("div", { class: "world-notice" });
  const stage = h("div", { class: "world-stage", tabindex: "0", role: "group", "aria-label": "Map of your apps. Arrow keys move it, plus and minus zoom, zero fits it, Escape closes the panel or leaves a replay." });
  const labelLayer = h("div", { class: "world-labels" });
  const detail = h("aside", { class: "world-card world-detail", "aria-live": "polite", hidden: true });
  const list = h("ul", { class: "visually-hidden", "aria-label": "Your apps" });
  const empty = h("div", { class: "world-empty" });
  const replayBar = h("div", { class: "world-card world-replay", hidden: true });
  const settings = createWorldSettings({
    sky,
    onSky(next) {
      sky = next;
      saveSky(next);
      scene?.setSky(next);
    },
  });
  const replayStart = h("button", { type: "button", class: "btn", title: "The last day, from the record", onclick: () => void replay.start() }, "Replay");
  const tourButton = h("button", { type: "button", class: "btn", title: "Go round your apps, one at a time", onclick: () => tour.toggle() }, "Tour");
  // Any touch ends the tour, except on its own button, which then has its say.
  const touched = (event: Event) => {
    if (!(event.target instanceof Node && tourButton.contains(event.target))) tour.end();
  };
  const feedCard = h("div", { class: "world-card world-feed", hidden: true, "aria-live": "polite" });
  const stageNews = h("div", { class: "world-card world-stage-news", role: "status", hidden: true });
  // What happened while you were away: worked out once, from how things stood at the last look.
  const sinceCard = h("div", { class: "world-card world-stage-news world-since", role: "status", hidden: true });
  const lookedBefore = savedLooked();
  let sinceDone = false;
  let stageNow: WorldStage | null = null;
  const step = createStepper({ goTo: (place) => goTo(place), current: () => selection });
  const legendCard = createLegend({ step, stage: () => stageNow });
  const legend = legendCard.el;
  const lookKey = createLookKey({ step });
  // At the end of its range a zoom button says so. aria-disabled, not disabled: focus stays on it.
  const zoomIn: HTMLElement = h("button", { type: "button", class: "btn", "aria-label": "Zoom in", title: "Zoom in (+)", onclick: () => scene?.zoomBy(ZOOM_STEP) }, "+");
  const zoomOut = h("button", { type: "button", class: "btn", "aria-label": "Zoom out", title: "Zoom out (−)", onclick: () => scene?.zoomBy(1 / ZOOM_STEP) }, "−");
  let zoomSaid = "";
  const showZoomRoom = () => {
    const room = scene?.zoomRoom() ?? { nearer: true, farther: true };
    const said = `${room.nearer}${room.farther}`;
    if (said === zoomSaid) return; // every frame: touched only when it changes
    zoomSaid = said;
    zoomIn.setAttribute("aria-disabled", String(!room.nearer));
    zoomIn.title = room.nearer ? "Zoom in (+)" : "As near as it goes";
    zoomOut.setAttribute("aria-disabled", String(!room.farther));
    zoomOut.title = room.farther ? "Zoom out (−)" : "As far out as it goes";
  };
  const stats = h("div", { class: "world-card world-stats", hidden: true });
  let statsSaid = "";
  let overallState = "checking"; // the title's light: the figures step back only when it's "up"
  // The figures in a line, under the title, for a window too narrow for their card.
  const brief = h("p", { class: "meta world-brief", hidden: true });
  const mapControls = h(
    "div",
    { class: "world-zoom", role: "group", "aria-label": "Move round the map" },
    tourButton,
    replayStart,
    zoomIn,
    zoomOut,
    h("button", { type: "button", class: "btn", "aria-label": "Turn the map", title: "Turn the map (Q and E)", onclick: () => scene?.turn(1) }, "Turn"),
    h("button", { type: "button", class: "btn", title: "Fit the whole map (0)", onclick: () => scene?.resetView() }, "Fit"),
    settings.root,
  );

  const isPointedAt = (kind: string, id: string) => (selection?.kind === kind && selection.id === id) || (hovered?.kind === kind && hovered.id === id);
  const closeButton = () => h("button", { type: "button", class: "world-close", "aria-label": "Close", onclick: () => choose(null) }, "×");

  // What it's about may be off the screen: the map goes to it as the panel opens.
  const goTo = (target: { kind: Standing; id: string }) => {
    choose(target);
    scene?.focusOn(target.kind, target.id);
  };
  const feed = createFeed({ card: feedCard, goTo });
  const labels = createLabels({ layer: labelLayer, stage, world: () => world, scene: () => scene, pointedAt: isPointedAt, changedUntil: feed.changedUntil, choose });
  const watcher = createWatcherPanel({ world: () => liveWorld ?? world, scene: () => scene, isOpen: () => selection?.kind === "tower", isReplay: () => replay.at() !== null, choose, closeButton });
  const replay = createReplay({
    bar: replayBar,
    button: replayStart,
    apps: () => apps,
    left: () => left,
    onError: (err) => mount(replayNote, errorBox(err)),
    onChange(jump) {
      mount(replayNote);
      jumping = jump;
      draw();
      keepKeys();
    },
  });

  const tour = createTour({
    button: tourButton,
    plots: () => world?.plots ?? [],
    visit(slug) {
      hovered = { kind: "app", id: slug };
      labels.invalidate();
      scene?.focusOn("app", slug);
    },
    ended() {
      hovered = null;
      labels.invalidate();
    },
    stopped: () => scene?.resetView(),
  });

  // Comes down onto the map as the cloud thins.
  const clouds = createClouds(sky, () => scene?.descend());

  const top = h("div", { class: "world-top" }, h("div", { class: "world-card world-title" }, h("div", null, h("div", { class: "world-eyebrow" }, `${user.name}'s valley`), headline, sub, brief), h("a", { class: "btn", href: "#/" }, "Back to Apps")), stats, h("div", { class: "world-notes" }, notice, replayNote, graphics, stageNews, sinceCard));
  const hud = h(
    "div",
    { class: "world-root", onkeydown: onKey, onpointerdown: touched, onwheel: touched },
    stage,
    labelLayer,
    top,
    // The list before the panel: moving along it opens the panel, and the next stop is in it.
    list,
    detail,
    h("div", { class: "world-corner" }, feedCard, h("div", { class: "world-corner-row" }, legend, lookKey.el)),
    mapControls,
    replayBar,
    empty,
    clouds.el,
  );
  mount(root, shell(user, "fleet", hud));
  const stopWatchingRoom = watchHudRoom(hud, top, mapControls);

  // A name on the map is still the map to a wheel.
  labelLayer.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stage.querySelector("canvas")?.dispatchEvent(new WheelEvent("wheel", event));
    },
    { passive: false },
  );

  // Whatever had the focus has gone: without this, the map's keys go with it.
  function keepKeys() {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest("[hidden]")) stage.focus({ preventScroll: true });
  }

  function onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement && event.key !== "Escape") return; // the slider and the settings have their own keys
    if (event.target instanceof Element && event.target.closest(".world-detail, .world-legend") && event.key !== "Escape") return; // those scroll, and move between their links
    if (event.key === "Escape" && settings.isOpen()) return; // that closes them, and only them
    const STEP = 60;
    const moves: Record<string, [number, number]> = { ArrowLeft: [STEP, 0], ArrowRight: [-STEP, 0], ArrowUp: [0, STEP], ArrowDown: [0, -STEP] };
    const move = moves[event.key];
    touched(event);
    if (move) scene?.nudge(move[0], move[1]);
    else if (event.key === "+" || event.key === "=") scene?.zoomBy(ZOOM_STEP);
    else if (event.key === "-") scene?.zoomBy(1 / ZOOM_STEP);
    else if (event.key === "0") scene?.resetView();
    else if (event.key === "q" || event.key === "Q") scene?.turn(-1);
    else if (event.key === "e" || event.key === "E") scene?.turn(1);
    else if (event.key === "Escape") {
      // What the focus is in goes first, then the panel, then the legend.
      const inLegend = event.target instanceof Node && legend.contains(event.target);
      if (legend.open && (inLegend || !selection)) {
        legend.open = false;
        if (inLegend) legend.querySelector<HTMLElement>(":scope > summary")?.focus();
      } else if (selection) choose(null);
      else if (replay.at() !== null) replay.end(); // last of all: back to now
      else return;
    } else return;
    event.preventDefault();
  }

  // ── The panel beside it ───────────────────────────────────────────────

  function choose(next: Selection) {
    selection = next;
    if (next?.kind === "tower") void readLog();
    scene?.select(next);
    labels.invalidate();
    drawDetail(true);
    labels.place();
    if (!next) keepKeys(); // the panel, and whatever in it had the focus, has gone
  }

  // Read out when something's been chosen, not every time it's redrawn.
  function drawDetail(speak = false) {
    detail.setAttribute("aria-live", speak ? "polite" : "off");
    const replayAt = replay.at();
    const plot = selection?.kind === "app" ? world?.plots.find((p) => p.slug === selection?.id) : undefined;
    const app = plot && apps?.find((a) => a.slug === plot.slug);
    const utility = selection?.kind === "provider" ? world?.utilities.find((u) => u.id === selection?.id) : undefined;
    const trip = selection?.kind === "trip" ? tripsSeen.get(selection.id) : undefined;
    const onTower = selection?.kind === "tower";
    // What it was about has gone from the map, so the map stops making room for it.
    if (world && ((selection?.kind === "app" && !plot) || (selection?.kind === "provider" && !utility))) {
      selection = null;
      scene?.select(null);
      labels.invalidate();
    }
    detail.hidden = !app && !utility && !onTower && !trip;
    if (onTower) {
      mount(detail, watcher.detail());
      watcher.drawRadar();
    } else if (plot && app) mount(detail, plotDetail(plot, app, error ? undefined : statuses.get(plot.slug), providers, replayAt, closeButton()));
    else if (utility) mount(detail, utilityDetail(utility, closeButton()));
    else if (trip) mount(detail, tripDetail(trip, statuses.get(trip.slug), closeButton()));
    else mount(detail);
  }

  function tryFocus() {
    if (!pendingFocus || (!scene && !noPicture) || !world || !settled) return;
    const plot = world.plots.find((p) => p.slug === pendingFocus);
    if (!plot) {
      if (apps) pendingFocus = undefined; // no such app: the whole map instead
      return;
    }
    pendingFocus = undefined;
    choose({ kind: "app", id: plot.slug });
    scene?.focusOn("app", plot.slug);
  }

  // What's really grown since this was last seen. Not in a replay, or while the view's only
  // jumping, or before there's a picture to show it in: it's still news afterwards.
  const known = (w: World | undefined) => Boolean(w) && !w?.failed && !w?.plots.some((p) => p.state === "checking");

  function growthNow(now: World) {
    // Hidden, nothing animates: what grew meanwhile waits to be seen, not used up unseen.
    if (!settled || !scene || replay.at() !== null || jumping || document.hidden) return undefined;
    if (!known(now)) return undefined; // not read: nothing's known to have grown
    const stage = worldStage(now.plots.length);
    const grown = growthSince(seen, now.plots);
    seen = seenNow(seen, now.plots, stage);
    saveSeen(seen);
    return grown;
  }

  // The land growing is said once, the first time this viewer sees it after it happens.
  function noteStage(count: number) {
    const now = worldStage(count);
    stageNow = now;
    if (!stageIsNews(now)) return;
    const [title, text] = STAGE_NEWS[now];
    stageNews.hidden = false;
    mount(stageNews, h("div", null, h("strong", null, title), h("div", { class: "meta" }, text)), h("button", { type: "button", class: "world-close", "aria-label": "Close", onclick: () => {
      stageNews.hidden = true;
      keepKeys();
    } }, "×"));
  }

  // ── What's on the road ────────────────────────────────────────────────

  function sendTrips() {
    if (!world || !settled) return;
    const now = Date.now();
    tripsNow = tripsFor({ world, plan: valleyPlan(world), checks: watcher.checks(), now });
    const current = new Set(tripsNow.map((t) => t.id));
    for (const trip of tripsNow) tripsSeen.set(trip.id, trip);
    // A check stays readable for a while. A deploy or traffic is only true while it goes on.
    const open = selection?.kind === "trip" ? selection.id : null;
    for (const [id, trip] of tripsSeen) {
      if (current.has(id) || id === open) continue;
      if (trip.facts.kind !== "check" || now - Date.parse(trip.facts.at) > CHECK_PANEL_KEPT_MS) tripsSeen.delete(id);
    }
    if (open && !current.has(open) && tripsSeen.get(open)?.facts.kind !== "check") choose(null);
    scene?.setTrips(tripsNow);
    // Figures for what's been read, or none: "0 of 5 running" would be a claim.
    const unread = world.failed || world.plots.some((p) => p.state === "checking");
    stats.hidden = world.plots.length === 0 || replay.at() !== null || unread;
    brief.hidden = stats.hidden;
    if (stats.hidden) return;
    const figures = valleyStats(world, statuses, tripsNow, checksLately({ world, checks: watcher.checks(), now }));
    const lastCheck = lastCheckSaid({ world, checks: watcher.checks(), read: watcher.read(), off: watcher.off(), now });
    const calm = figuresCalm(figures, overallState);
    const said = JSON.stringify([figures, lastCheck, calm]);
    if (said === statsSaid) return; // redrawn often: a figure being pointed at stays put
    statsSaid = said;
    stats.classList.toggle("world-stats--calm", calm);
    mount(stats, statsRow(figures, lastCheck, goTo));
    mount(brief, briefFigures(figures, lastCheck));
  }

  async function readLog() {
    const mine = ++logReads;
    let log: WatcherLog | undefined;
    try {
      log = await api<WatcherLog>("GET", "/watcher/log");
    } catch {
      log = undefined; // no vans for what can't be read
    }
    if (left || mine !== logReads) return;
    const wasOff = watcher.off();
    const wasStopped = watcher.stopped();
    watcher.setLog(log);
    if (watcher.off() !== wasOff || watcher.stopped() !== wasStopped) draw(); // the dish stops, whatever the apps still say
    else sendTrips();
  }

  // ── The data ──────────────────────────────────────────────────────────

  function draw() {
    const replayAt = replay.at();
    if (replayAt !== null) {
      mount(headline, lamp("unknown", { large: true }), h("h1", null, `Replay: ${moment(replayAt)}`));
      mount(sub, "From the incident record. Not how things are now.");
      mount(notice);
      noticeSaid = "";
    } else if (error) {
      // What was loaded last is old news: the world doesn't go on saying it.
      mount(headline, lamp("unknown", { large: true }), h("h1", null, "Can't read your apps' status"));
      mount(sub, lastLoaded && ["Last updated ", timeAgo(lastLoaded)]);
      // A way out that doesn't mean leaving: try now, or know it will by itself. Put up again
      // only when what went wrong changes, so the button keeps its focus through the redraws.
      mount(tryAgain, retrying ? "Trying…" : "Try again");
      tryAgain.setAttribute("aria-busy", String(retrying));
      const said = String(error instanceof Error ? error.message : error);
      if (said !== noticeSaid) {
        noticeSaid = said;
        mount(notice, errorBox(error), h("div", { class: "world-retry" }, tryAgain, h("span", { class: "meta" }, "It tries again by itself every minute.")));
      }
    } else {
      noticeSaid = "";
      mount(notice);
      if (!apps) {
        mount(headline, h("h1", null, "World"));
        mount(sub, "Loading…");
      } else {
        const all = apps.map((a) => statuses.get(a.slug)).filter((s): s is AppStatus => Boolean(s));
        const { state, text } = overallLine(summarize(all), providers, Date.now());
        const everyoneChecked = all.length === apps.length;
        overallState = everyoneChecked ? state : "checking";
        mount(headline, lamp(everyoneChecked ? state : "checking", { large: true }), h("h1", null, !everyoneChecked ? "Checking your apps…" : text));
        mount(sub, `${apps.length} app${apps.length === 1 ? "" : "s"}`, !providersRead(providers) && " · providers not read lately", lastLoaded && [" · updated ", timeAgo(lastLoaded)]);
      }
    }
    const parts = hudParts({ appCount: apps?.length, picture: !noPicture, replaying: replayAt !== null });
    mapControls.hidden = !parts.controls;
    legend.hidden = !parts.legend;
    if (!parts.legend) legend.open = false;
    replayStart.hidden = !parts.walks;
    tourButton.hidden = !parts.walks;
    if (!apps) return;
    // Only the dish, watching nothing: say what would change that.
    mount(empty, apps.length === 0 && !error ? h("div", { class: "world-card world-empty-card" }, h("p", null, "Nothing to watch yet."), h("a", { class: "btn btn--primary", href: "#/apps/new" }, "Add your first app")) : null);
    const saved = savedPlaces();
    const places = placeApps(apps.map((a) => a.slug), saved);
    const servicePlaces = servicePlacesFrom(saved, providers.filter((p) => p.apps.length > 0).map((p) => p.id));
    savePlaces(withServicePlaces(places, servicePlaces));
    const before = liveWorld;
    const live = buildWorld({ apps, statuses, providers, readFailed: Boolean(error), checksOff: watcher.off(), watcherStopped: watcher.stopped(), places, servicePlaces, requests: knownRequests(apps), now: Date.now() });
    noteStage(apps.length);
    feed.note(liveWorld, live);
    liveWorld = live;
    const histories = replay.histories();
    world = replayAt !== null && histories ? worldAt(live, histories, replayAt) : live;
    lookKey.draw(parts.key ? world : null);
    legendCard.draw(parts.key ? world : null);
    stage.classList.toggle("is-past", replayAt !== null);
    labels.invalidate();
    // Not before there's something worth building: the land is built for what's on it.
    // A read finishing, or failing, isn't anything happening to the apps, nor is the one after it.
    if (settled) scene?.update(world, !jumping && Boolean(before) && known(before) && known(live), growthNow(live));
    jumping = false;
    sendTrips();
    labels.place();
    feed.draw(world, notifications, replayAt !== null);
    noteSince(live);
    tryFocus();
    // Each link has an id, so focus stays on it when what it says changes ("Checking" to "Up").
    redrawingList = true; // putting focus back on a link here isn't someone choosing it
    mount(list, [
      ...world.plots.map((plot) => h("li", null, h("a", { id: `world-list-app-${plot.slug}`, href: `#/apps/${encodeURIComponent(plot.slug)}`, onfocus: () => chooseFromList({ kind: "app", id: plot.slug }) }, `${plot.name}: ${STATE_LABEL[plot.state]}`))),
      h("li", null, h("a", { id: "world-list-watcher", href: "#/settings", onfocus: () => chooseFromList({ kind: "tower", id: "watcher" }) }, `The watcher: ${replayAt !== null ? "no record of it then" : world.watching ? "checking your apps" : world.stopped ? "not checking" : "not known yet"}`)),
      ...world.utilities.map((u) => h("li", null, h("a", { id: `world-list-provider-${u.id}`, href: "#/status", onfocus: () => chooseFromList({ kind: "provider", id: u.id }) }, `${u.label}: ${u.look === "ok" ? "fine" : u.look === "trouble" ? "having trouble" : u.look === "maintenance" ? "maintenance" : u.look === "past" ? "no record" : "not read lately"}`))),
    ]);
    redrawingList = false;
    drawDetail();
  }

  // Said once, when everything it rests on has been read: the apps, how each is, and the bell's
  // record of what went wrong and right. Not in a replay, which is about then.
  function noteSince(live: World) {
    if (sinceDone || !settled || error || !notifications || replay.at() !== null || !known(live)) return;
    sinceDone = true;
    const said = sinceYouLooked({ looked: lookedBefore, now: Date.now(), notifications, plots: live.plots });
    if (!said) return;
    const shut = () => {
      sinceCard.hidden = true;
      keepKeys();
    };
    const rows = said.rows.map((row) => {
      const body = [lamp(row.state === "new" ? "info" : row.state), h("span", null, h("strong", null, row.name), " ", row.text)];
      const slug = row.slug;
      const onMap = slug !== null && live.plots.some((p) => p.slug === slug);
      return h("li", null, onMap ? h("button", { type: "button", class: "world-since-row", onclick: () => goTo({ kind: "app", id: slug }) }, body) : h("span", { class: "world-since-row" }, body));
    });
    sinceCard.hidden = false;
    mount(
      sinceCard,
      h("div", { class: "world-since-body" }, h("strong", null, said.title), h("ul", { class: "world-since-rows" }, rows), said.more > 0 && h("p", { class: "meta" }, `and ${said.more} more`)),
      h("button", { type: "button", class: "world-close", "aria-label": "Close", onclick: shut }, "×"),
    );
  }

  function chooseFromList(next: Selection) {
    if (!redrawingList) choose(next);
  }

  async function load() {
    const mine = ++loads;
    const stale = () => left || mine !== loads;
    try {
      const read0 = await api<{ apps: App[] }>("GET", "/apps");
      if (stale()) return;
      apps = read0.apps;
      draw();
      // A status page being unreachable must never break a screen: what was read stays,
      // and ages into "not read lately".
      const [read, nextProviders, nextNotifications] = await Promise.all([
        api<{ statuses: AppStatus[] }>("GET", "/status"),
        api<{ providers: ProviderStatus[] }>("GET", "/providers").then((r) => r.providers, () => providers),
        api<NotificationsView>("GET", "/notifications").catch(() => notifications),
      ]);
      if (stale()) return;
      statuses = new Map(read.statuses.map((s) => [s.slug, s]));
      providers = nextProviders;
      notifications = nextNotifications;
      lastLoaded = new Date().toISOString();
      error = undefined;
      if (apps) saveLooked({ at: Date.now(), apps: apps.map((a) => a.slug) });
    } catch (err) {
      if (stale()) return;
      error = err;
    }
    retrying = false;
    settled = true;
    draw();
    if (apps && !error) {
      void readLog();
      if ((await refreshRequests(apps)) && !stale()) draw();
    }
  }

  // The picture comes in its own file, so the rest of the app never loads it.
  const noScene = (err: unknown) => {
    if (left) return;
    mount(graphics, errorBox(err));
    noMap();
  };
  void clouds.painted().then(() => import("./world/scene/index.ts")).then(
    ({ createWorldScene }) => {
      if (left) return;
      try {
        startScene(createWorldScene);
      } catch (err) {
        // Half built is no map at all: the page says so, rather than controls that do nothing.
        scene?.destroy();
        scene = null;
        noScene(err);
      }
    },
    noScene,
  );

  function startScene(createWorldScene: typeof import("./world/scene/index.ts").createWorldScene) {
    scene = createWorldScene(stage, {
      onSelect: choose,
      onHover(next) {
        if (tour.running()) return;
        hovered = next;
        stage.title = next?.kind === "trip" ? tripTitleOf(next.id) : "";
        labels.invalidate();
        labels.place();
      },
      onFrame() {
        labels.place();
        watcher.drawRadar();
        showZoomRoom();
        if (settled && (world || error)) clouds.pictured();
      },
      // What the side panel covers on a wide window, so the valley sits beside it.
      reservedRight: () => (selection && stage.clientWidth > 900 ? 340 : 0),
      sky,
      onGraphics(lost) {
        mount(graphics, lost && h("div", { class: "notice notice--error" }, h("span", null, "The map's graphics stopped, and it's trying to get them back. ", h("a", { href: "#/" }, "The Apps page"), " still shows everything.")));
      },
    });
    if (!scene) {
      mount(graphics, h("div", { class: "notice notice--error" }, h("span", null, "This window can't draw 3D graphics, so there's no map here. ", h("a", { href: "#/" }, "The Apps page"), " shows everything.")));
      noMap();
      return;
    }
    // Coming in late: what's grown meanwhile is still news, and the first look isn't announced.
    if (world && settled) {
      scene.update(world, false, liveWorld && growthNow(liveWorld));
      sendTrips();
    }
    tryFocus();
  }

  // No map: nothing to move round, and the panel is what's left of an app's place on it.
  function noMap() {
    noPicture = true;
    clouds.noPicture();
    draw();
    tryFocus();
  }

  function tripTitleOf(id: string) {
    const trip = tripsSeen.get(id);
    return trip ? tripTitle(trip) : "";
  }

  drawDetail();
  draw();
  void load();
  const patience = setTimeout(() => {
    settled = true;
    if (!left) draw();
  }, FIRST_READ_WAIT_MS);
  const reload = setInterval(() => void load(), REFRESH_MS);
  const retick = setInterval(draw, RETICK_MS);
  const relog = setInterval(() => {
    if (replay.at() === null) void readLog();
  }, LOG_REFRESH_MS);
  return () => {
    left = true;
    stopWatchingRoom();
    clearTimeout(patience);
    clouds.destroy();
    clearInterval(reload);
    clearInterval(retick);
    clearInterval(relog);
    tour.destroy();
    settings.destroy();
    legendCard.destroy();
    replay.stop();
    scene?.destroy();
  };
}
