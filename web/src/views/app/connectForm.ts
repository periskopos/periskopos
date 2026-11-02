import { ACCOUNTS, CONNECTIONS, connectionLabel } from "../../../../shared/catalog.ts";
import { hostnameOf, onDomain } from "../../../../shared/format.ts";
import type { Connection, Resource, ServiceView } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { h } from "../../dom.ts";
import { errorBox, field, submitting } from "../../ui.ts";

// ── Connect a service to this app (FR-A2, FR-A3) ────────────────────────

export function connectServiceForm(slug: string, services: ServiceView[], connected: Connection[], done: () => void, appUrl?: string) {
  const appHost = appUrl ? hostnameOf(appUrl) : "";
  // What an account can be connected as: a Cloudflare account holds Workers
  // and Pages projects (deploys) and domains (traffic, cache).
  const kindsOf = (s: ServiceView) =>
    ACCOUNTS[s.type].offers
      .map((type) => ({ type, label: CONNECTIONS[type]?.offer?.connectAs ?? connectionLabel({ type }) }))
      .filter((k) => !connected.some((c) => c.serviceId === s.id && c.type === k.type));
  const usable = services.filter((s) => kindsOf(s).length > 0);
  if (services.length === 0) {
    return h("p", { class: "meta" }, "No accounts yet. ", h("a", { href: "#/services/new" }, "Connect GitHub or your host"), " once, then come back.");
  }
  if (usable.length === 0) {
    return h("p", { class: "meta" }, "Every account you have is connected. ", h("a", { href: "#/services/new" }, "Connect another"), ".");
  }

  const errors = h("div");
  const extra = h("div", { class: "form" });
  const service = h(
    "select",
    { name: "serviceId" },
    h("option", { value: "" }, "Choose an account…"),
    usable.map((s) => h("option", { value: s.id }, `${s.name} · ${ACCOUNTS[s.type].label}`)),
  );
  const resource = h("select", { name: "resource", disabled: true }, h("option", { value: "" }, "Choose an account first"));
  let resources: Resource[] = [];
  // Only shown when the account can be connected as more than one kind.
  const kind = h("select", { name: "kind" });
  const kindField = field("Connect it as", kind);
  kindField.hidden = true;
  const chosenKind = () => kind.value || usable.find((x) => x.id === service.value)?.type || "";
  // The domain the app's URL is on, when the list has it.
  let suggested: string | undefined;

  // An account can hold dozens of repositories: past ten, a filter box
  // narrows the list as you type.
  const FILTER_FROM = 10;
  const filter = h("input", { type: "search", placeholder: "Type to filter…", "aria-label": "Filter the list", autocomplete: "off", class: "mono" });
  const filterField = field("Filter", filter);
  filterField.hidden = true;

  const showOptions = () => {
    const q = filter.value.trim().toLowerCase();
    const chosen = resource.value;
    const shown = resources.filter((r) => !q || `${r.label} ${r.detail ?? ""}`.toLowerCase().includes(q));
    resource.replaceChildren(
      h("option", { value: "" }, resources.length === 0 ? "Nothing found in this account" : shown.length === 0 ? "Nothing matches" : `Choose… (${shown.length})`),
      ...shown.map((r) => {
        const detail = [r.detail, r.id === suggested ? "this app's domain" : undefined].filter(Boolean).join(" · ");
        return h("option", { value: r.id }, detail ? `${r.label} — ${detail}` : r.label);
      }),
    );
    resource.disabled = shown.length === 0;
    if (shown.some((r) => r.id === chosen)) resource.value = chosen;
    else if (chosen) resource.dispatchEvent(new Event("change")); // the choice filtered away
  };
  filter.addEventListener("input", showOptions);

  // Only the latest choice's list is shown: switching account or kind while
  // one is loading must not fill the list with the previous one's.
  let asked = 0;
  const loadResources = async () => {
    const mine = ++asked;
    extra.replaceChildren();
    errors.replaceChildren();
    filter.value = "";
    filterField.hidden = true;
    resource.replaceChildren(h("option", { value: "" }, "Loading…"));
    resource.disabled = true;
    const s = usable.find((x) => x.id === service.value);
    if (!s) return;
    const type = chosenKind();
    try {
      const answer = await api<{ resources: Resource[] }>("GET", `/services/${s.id}/resources${type !== s.type ? `?type=${encodeURIComponent(type)}` : ""}`);
      if (mine !== asked) return;
      resources = answer.resources;
      // A domain the app lives on is picked already: the usual choice.
      suggested =
        type === "cloudflare-zone" && appHost
          ? resources.filter((r) => onDomain(appHost, r.id)).sort((a, b) => b.id.length - a.id.length)[0]?.id
          : undefined;
      showOptions();
      if (suggested) resource.value = suggested;
      filterField.hidden = resources.length <= FILTER_FROM;
    } catch (err) {
      if (mine !== asked) return;
      resource.replaceChildren(h("option", { value: "" }, "—"));
      errors.replaceChildren(errorBox(err));
    }
  };

  service.addEventListener("change", () => {
    const s = usable.find((x) => x.id === service.value);
    const kinds = s ? kindsOf(s) : [];
    kind.replaceChildren(...kinds.map((k) => h("option", { value: k.type }, k.label)));
    kindField.hidden = kinds.length < 2;
    void loadResources();
  });
  kind.addEventListener("change", () => void loadResources());

  resource.addEventListener("change", () => {
    extra.replaceChildren();
    const s = usable.find((x) => x.id === service.value);
    const r = resources.find((x) => x.id === resource.value);
    if (s?.type === "openai" && r) {
      extra.append(
        field(
          "Monthly budget (USD)",
          h("input", { name: "budgetUsd", inputmode: "decimal", placeholder: "150", class: "mono" }),
          "An alert when this month's spend passes it. Leave empty to only see the spend.",
        ),
      );
    }
    if ((s?.type === "github" || s?.type === "gitlab") && r) {
      extra.append(
        field("Branch that deploys", h("input", { name: "branch", value: String(r.settings?.branch ?? "main"), required: true, class: "mono" })),
        field(
          "Folders that deploy this app",
          h("input", { name: "paths", placeholder: "apps/star-map, packages", class: "mono" }),
          "Comma-separated. Leave empty if the whole repository is this app.",
        ),
      );
    }
  });

  return submitting(
    h(
      "form",
      { class: "form" },
      h("div", { class: "form-row" }, field("Account", service), kindField, field("What in it", resource)),
      filterField,
      extra,
      errors,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn--primary" }, "Connect")),
    ),
    errors,
    async (data) => {
      const s = usable.find((x) => x.id === data.get("serviceId"));
      const r = resources.find((x) => x.id === data.get("resource"));
      if (!s || !r) throw new Error("Choose an account and what in it");
      const type = chosenKind();
      await api("POST", `/apps/${encodeURIComponent(slug)}/connections`, {
        type,
        serviceId: s.id,
        resource: r.id,
        settings:
          s.type === "github" || s.type === "gitlab"
            ? { ...(s.type === "gitlab" ? r.settings : {}), branch: data.get("branch"), paths: String(data.get("paths") ?? "") }
            : s.type === "openai"
            ? { ...r.settings, ...(String(data.get("budgetUsd") ?? "").trim() ? { budgetUsd: String(data.get("budgetUsd")).trim() } : {}) }
            : type === "cloudflare-zone"
              ? { ...r.settings, host: appHost } // DNS and the certificate are checked for the app's own name
              : r.settings,
      });
      done();
    },
    "Connecting…",
  );
}
