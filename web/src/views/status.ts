import { hourStyle } from "../prefs.ts";
import type { ProviderPart, ProviderPartState, ProviderStatus, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { busyButton, errorBox, figure, lamp, shell } from "../ui.ts";
import type { LampState } from "../ui.ts";
import { incidentCard, incidentRow, maintenanceRows, touches, usedParts } from "./events.ts";
import { isDegraded, isNotable, providerLamp, providerStatusLine } from "./providers.ts";
import { serviceLogo } from "./services.ts";

// Status (FR-I3): every provider my apps run on, in one place. For each,
// the parts my apps use and their state now, what's wrong (what touches my
// apps first), what's planned, and which apps it affects. Accounts no app
// uses are listed below, briefly.

const PART: Record<ProviderPartState, { lamp: LampState; text: string }> = {
  operational: { lamp: "up", text: "Operational" },
  degraded: { lamp: "attention", text: "Degraded" },
  partial: { lamp: "attention", text: "Partial outage" },
  major: { lamp: "down", text: "Major outage" },
  maintenance: { lamp: "info", text: "Maintenance" },
  unknown: { lamp: "unknown", text: "Unknown" },
};

// The provider's verdict, for my apps only: its overall state is shown
// beside it, labelled, since trouble elsewhere doesn't touch them.
function verdict(p: ProviderStatus): { lamp: LampState; text: string } {
  if (p.relevantIndicator === "unknown") return { lamp: "unknown", text: "Not checked yet" };
  if (isDegraded(p)) return { lamp: providerLamp(p), text: "Affects your apps" };
  if (p.relevantIndicator === "maintenance") return { lamp: "info", text: "Maintenance on your parts" };
  return { lamp: "up", text: "No impact on your apps" };
}

export function statusView(root: Element, user: User) {
  const body = h("div", null, h("p", { class: "meta" }, "Loading…"));
  const summary = h("p", { class: "meta" }, "The status pages of the providers your apps run on.");
  const refresh = busyButton("Check now", "Checking…", () => load(true));

  mount(
    root,
    shell(
      user,
      "status",
      h("div", { class: "page-header" }, h("div", null, h("h1", null, "Status"), summary), h("div", { class: "actions" }, refresh)),
      body,
    ),
  );

  async function load(force = false) {
    try {
      const { providers } = await api<{ providers: ProviderStatus[] }>("GET", `/providers${force ? "?refresh=1" : ""}`);
      draw(providers);
    } catch (err) {
      mount(body, errorBox(err));
    }
  }

  function draw(providers: ProviderStatus[]) {
    const used = providers.filter((p) => p.apps.length > 0);
    const unused = providers.filter((p) => p.apps.length === 0);
    const troubled = used.filter(isDegraded);
    summary.replaceChildren(
      used.length === 0
        ? "No app uses a provider with a status page yet."
        : troubled.length > 0
          ? `${troubled.map((p) => p.label).join(", ")} ${troubled.length === 1 ? "reports" : "report"} trouble in parts your apps use.`
          : `Every provider your apps use is operational${used.some(isNotable) ? ", with maintenance under way" : ""}.`,
    );
    mount(
      body,
      providers.length === 0
        ? h(
            "div",
            { class: "section empty-hero" },
            h("h2", null, "No providers yet"),
            h("p", null, "Connect an account (Cloudflare, GitHub, Render, Supabase…) and its status page shows here, filtered to the parts your apps use."),
            h("a", { class: "btn btn--primary", href: "#/services/new" }, "Connect an account"),
          )
        : h(
            "div",
            { class: "stack" },
            // Trouble first, then the rest in the order the accounts were added.
            used.length > 0 && h("ul", { class: "account-list" }, [...used].sort((a, b) => Number(isDegraded(b)) - Number(isDegraded(a))).map(card)),
            unused.length > 0 &&
              h(
                "section",
                { class: "accounts", "aria-labelledby": "s-unused" },
                h("h2", { class: "label", id: "s-unused" }, "Not used by any app"),
                h("ul", { class: "account-list" }, unused.map(brief)),
              ),
          ),
    );
  }

  void load();
}

// A provider my apps use: its verdict for them and its overall state (head),
// three numbers to read at a glance (the parts they use, incidents affecting
// them, maintenance), what's wrong in full, the rest folded away, and the
// apps it serves (foot).
function card(p: ProviderStatus) {
  const v = verdict(p);
  const parts = p.parts ?? [];
  const trouble = parts.filter((x) => x.state !== "operational");
  const affecting = p.incidents.filter((i) => i.affectsYou);
  const elsewhere = p.incidents.filter((i) => !i.affectsYou);
  const planned = p.maintenance ?? [];
  const used = usedParts(p);
  const plannedMine = planned.filter((m) => touches(m, used));
  const next = planned.find((m) => m.scheduledFor)?.scheduledFor;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const more = [
    parts.length > 0 && plural(parts.length, "part"),
    elsewhere.length > 0 && `${plural(elsewhere.length, "incident")} elsewhere`,
    planned.length > 0 && plural(planned.length, "maintenance window"),
  ].filter(Boolean);

  return h(
    "li",
    { class: "account-card status-card", "aria-labelledby": `prov-${p.id}` },
    h(
      "div",
      { class: "account-head" },
      serviceLogo(p.id as Parameters<typeof serviceLogo>[0]),
      h("div", { class: "account-title" }, h("h3", { class: "account-name", id: `prov-${p.id}` }, p.label), h("span", { class: "overall" }, h("span", { class: "meta" }, "Overall: "), providerStatusLine(p))),
      h("span", { class: `health-pill health-pill--${v.lamp}` }, lamp(v.lamp), v.text),
    ),
    h(
      "div",
      { class: "figures figures--three status-strip" },
      figure(
        "Parts you use",
        parts.length ? h("span", { class: "mono" }, `${parts.length - trouble.length}/${parts.length}`) : "—",
        parts.length === 0 ? "none listed" : trouble.length ? h("span", { class: "reason reason--attention" }, `${trouble.length} not operational`) : "all operational",
        parts.length === 0,
      ),
      figure(
        "Incidents affecting you",
        h("span", { class: affecting.length ? "reason reason--attention" : "" }, String(affecting.length)),
        elsewhere.length ? `${elsewhere.length} elsewhere, not affecting you` : "none elsewhere",
      ),
      figure(
        "Maintenance",
        String(planned.length),
        planned.length ? (next ? `next ${new Date(next).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", ...hourStyle() })}` : "under way") : "none planned",
        planned.length === 0,
      ),
    ),
    (trouble.length > 0 || affecting.length > 0 || plannedMine.length > 0) &&
      h(
        "div",
        { class: "status-body" },
        affecting.length > 0 && h("div", { class: "stack-sm" }, h("h4", { class: "label" }, "Affecting your apps"), h("ul", { class: "incident-cards" }, affecting.map((i) => incidentCard(i, used)))),
        trouble.length > 0 && h("div", { class: "stack-sm" }, h("h4", { class: "label" }, "Parts in trouble"), h("ul", { class: "parts" }, trouble.map(partTile))),
        plannedMine.length > 0 && h("div", { class: "stack-sm" }, h("h4", { class: "label" }, "Maintenance on parts you use"), maintenanceRows(plannedMine, used)),
      ),
    more.length > 0 &&
      h(
        "details",
        { class: "status-more" },
        h("summary", null, `More: ${more.join(" · ")}`),
        h(
          "div",
          { class: "status-body" },
          parts.length > 0 && h("div", { class: "stack-sm" }, h("h4", { class: "label" }, "Every part your apps use"), h("ul", { class: "parts parts--compact" }, parts.map(partTile))),
          elsewhere.length > 0 && h("div", { class: "stack-sm" }, h("h4", { class: "label" }, "Incidents elsewhere"), h("ul", { class: "event-list" }, elsewhere.map(incidentRow))),
          planned.length > 0 && h("div", { class: "stack-sm" }, h("h4", { class: "label" }, "All maintenance"), maintenanceRows(planned, used)),
        ),
      ),
    h(
      "div",
      { class: "account-foot status-foot" },
      h("span", { class: "label" }, "Used by"),
      h("div", { class: "chips" }, p.apps.map((a) => h("a", { class: "chip", href: `#/apps/${encodeURIComponent(a.slug)}` }, a.name))),
    ),
  );
}

function partTile(part: ProviderPart) {
  const s = PART[part.state];
  return h(
    "li",
    { class: `part part--${s.lamp}` },
    lamp(s.lamp, { label: s.text }),
    h("span", { class: "part-name" }, part.name),
    h("span", { class: "meta" }, part.where?.length ? `${s.text} · ${part.where.join(", ")}` : s.text),
  );
}

// An account no app uses: its state in a line.
function brief(p: ProviderStatus) {
  return h(
    "li",
    { class: "account-card status-brief", "aria-labelledby": `prov-${p.id}` },
    h("div", { class: "account-head" }, serviceLogo(p.id as Parameters<typeof serviceLogo>[0]), h("div", { class: "account-title" }, h("h3", { class: "account-name", id: `prov-${p.id}` }, p.label), providerStatusLine(p))),
  );
}
