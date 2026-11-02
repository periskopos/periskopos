import { SLOW_CHECKS_DEFAULT, SLOW_CHECKS_RANGE, connectionLabel, mainSite } from "../../../../shared/catalog.ts";
import type { App, Connection, ServiceView } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { h, safeHref } from "../../dom.ts";
import { hostOf } from "../../format.ts";
import { checkbox, ext, field, section, submitting, toast } from "../../ui.ts";
import { protocolSection } from "../protocolParts.ts";
import { connectServiceForm } from "./connectForm.ts";
import { SETTINGS_PARTS } from "./page.ts";
import type { AppPage, SettingsPart } from "./page.ts";

const INTERVALS_MIN = [1, 2, 5, 10, 15, 30, 60];
const SLOW_IN_A_ROW = Array.from({ length: SLOW_CHECKS_RANGE[1] - SLOW_CHECKS_RANGE[0] + 1 }, (_, i) => SLOW_CHECKS_RANGE[0] + i);

// Settings, in three parts from a side menu: General (the app's details,
// its links, and deleting it last), Connections (what it's connected to,
// and its status checks) and Protocol (its own endpoint).
export function settingsTab(page: AppPage, a: App) {
  const part = page.settingsPart;
  const href = (key: SettingsPart) => (key === "general" ? `${page.base}/settings` : `${page.base}/settings/${key}`);
  return [
    h(
      "div",
      { class: "settings-layout" },
      h(
        "nav",
        { class: "side-menu", "aria-label": "Settings sections" },
        SETTINGS_PARTS.map((p) => h("a", { href: href(p.key), ...(p.key === part ? { "aria-current": "page" } : {}) }, p.label)),
      ),
      h("div", { class: "stack settings-content" }, ...(part === "connections" ? connectionsPart(page, a) : part === "protocol" ? [protocolSection(a, page.protocol, page.protocolState, () => void page.afterSubmit())] : generalPart(page, a))),
    ),
  ];
}

function generalPart(page: AppPage, a: App) {
  const links = a.connections.filter((c) => c.type === "link");
  return [
    section("Details", { body: [editForm(page, a)] }),

    section("Links", {
      list: links.length
        ? h(
            "ul",
            { class: "list" },
            links.map((l) =>
              h(
                "li",
                { class: "item" },
                h("div", { class: "item-main" }, ext(safeHref(l.resource), String(l.settings?.label ?? hostOf(l.resource))), h("span", { class: "meta mono truncate" }, hostOf(l.resource))),
                h("div", { class: "item-end" }, h("button", { type: "button", class: "btn btn--sm btn--danger", onclick: () => removeConnection(page, l) }, "Remove")),
              ),
            ),
          )
        : undefined,
      body: [addLinkForm(page)],
    }),

    section("Delete app", {
      danger: true,
      body: [
        h("p", { class: "secondary" }, "Removes the app, its connections and its history from Periskopos. The app itself isn't touched."),
        h("div", null, h("button", { type: "button", class: "btn btn--danger", onclick: () => removeApp(page, a) }, `Delete ${a.name}`)),
      ],
    }),
  ];
}

function connectionsPart(page: AppPage, a: App) {
  // Status checks, the app's own and any extra URLs, have their own section.
  const conns = a.connections.filter((c) => c.type !== "link" && c.type !== "site");
  const main = mainSite(a);
  const sites = [...(main ? [main] : []), ...a.connections.filter((c) => c.type === "site" && c !== main)];
  return [
    section("Connections", {
      list: h(
        "ul",
        { class: "list" },
        conns.map((c) =>
          h(
            "li",
            { class: "item" },
            h("div", { class: "item-main" }, h("span", { class: "item-title" }, connectionLabel(c)), h("span", { class: "meta mono truncate" }, connectionWhat(c, page.services)), c.type === "domain" && domainDate(page, c)),
            h("div", { class: "item-end" }, h("button", { type: "button", class: "btn btn--sm btn--danger", onclick: () => removeConnection(page, c) }, "Remove")),
          ),
        ),
      ),
      body: [
        h("h3", { class: "label" }, "Connect to an account"),
        connectServiceForm(page.slug, page.services, a.connections, () => {
          toast("Connected");
          void page.afterSubmit();
        }, a.url),
      ],
    }),

    section("Status checks", {
      list: h("ul", { class: "list" }, sites.map((c) => siteItem(page, a, c, c === main))),
      body: [h("h3", { class: "label" }, "Check another URL"), addSiteForm(page)],
    }),
  ];
}

// A domain whose expiry can't be looked up: enter the date once (FR-I5).
// A looked-up date always wins over this one. Saved by saveDomainDates.
function domainDate(page: AppPage, c: Connection) {
  const check = page.status?.checks[c.id];
  const entered = typeof c.settings?.expiresOn === "string" ? c.settings.expiresOn : "";
  if (check?.state !== "unknown" && !entered) return null;
  const input = h("input", { type: "date", name: "expiresOn", value: entered, "aria-label": "Domain expiry date" });
  return h(
    "form",
    // The submit handler saves to this row's own connection.
    { class: "inline-date", "data-connection": c.id },
    h("span", { class: entered ? "meta" : "reason reason--attention" }, entered ? "Expires on (entered by hand)" : "Can't be looked up. Expires on"),
    input,
    h("button", { type: "submit", class: "btn btn--sm" }, "Save"),
  );
}

// One listener for every domain's date form, however often the page redraws.
export function saveDomainDates(page: AppPage, body: HTMLElement) {
  body.addEventListener("submit", async (e) => {
    const form = e.target as HTMLFormElement;
    if (!form.classList.contains("inline-date")) return;
    e.preventDefault();
    const conn = page.app?.connections.find((x) => x.id === form.dataset.connection && x.type === "domain");
    if (!conn || form.dataset.busy) return; // one save at a time
    form.dataset.busy = "1";
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) button.disabled = true;
    try {
      await api("PATCH", `${page.apiBase}/connections/${encodeURIComponent(conn.id)}`, { expiresOn: new FormData(form).get("expiresOn") });
      toast("Expiry date saved");
      await page.afterSubmit();
    } catch (err) {
      toast((err as Error).message, "down");
    } finally {
      delete form.dataset.busy;
      if (button) button.disabled = false;
    }
  });
}

// One status check: where it points, what it expects, and its settings to
// open: text the page must contain, a JSON health field, and how slow is
// too slow. The app's own follows its URL; an extra one can be removed.
function siteItem(page: AppPage, a: App, c: Connection, isMain: boolean) {
  const s = c.settings ?? {};
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  const expects = [
    s.expectText && `contains “${s.expectText}”`,
    s.expectJson && `JSON ${s.expectJson}`,
    typeof s.slowMs === "number" && `slow over ${s.slowMs} ms × ${str(s.slowChecks) || SLOW_CHECKS_DEFAULT}`,
  ].filter(Boolean);
  const name = isMain ? "the status check" : `the ${connectionLabel(c)} check`;
  const errors = h("div");
  const form = submitting(
    h(
      "form",
      { class: "form check-settings" },
      h(
        "div",
        { class: "form-grid" },
        field("Page must contain", h("input", { name: "expectText", maxlength: 200, value: str(s.expectText), placeholder: "Sign in" }), "Any case. If it's missing, the check fails: an error page or an empty app shell can answer 200."),
        field("JSON field", h("input", { name: "expectJson", maxlength: 200, value: str(s.expectJson), placeholder: "ok, or status=healthy" }), "For a health endpoint: the field must be there and not false, or equal what follows =."),
        field("Slow after (ms)", h("input", { name: "slowMs", type: "number", min: 100, max: 9000, step: 50, value: str(s.slowMs), placeholder: "Off" }), "Blank is off. Slower than this for several checks in a row needs attention, and you're told."),
        field(
          "Checks in a row",
          h("select", { name: "slowChecks" }, SLOW_IN_A_ROW.map((n) => h("option", { value: n, selected: n === (typeof s.slowChecks === "number" ? s.slowChecks : SLOW_CHECKS_DEFAULT) }, String(n)))),
        ),
      ),
      errors,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn--sm", "aria-label": `Save ${name}` }, "Save")),
    ),
    errors,
    async (data) => {
      await api("PATCH", `${page.apiBase}/connections/${encodeURIComponent(c.id)}`, {
        expectText: data.get("expectText"),
        expectJson: data.get("expectJson"),
        slowMs: data.get("slowMs"),
        slowChecks: data.get("slowChecks"),
      });
      toast("Status check saved");
      await page.afterSubmit();
    },
  );
  return h(
    "li",
    { class: "item item--stack", "data-connection": c.id },
    h(
      "div",
      { class: "item-row" },
      h("div", { class: "item-main" }, h("span", { class: "item-title" }, connectionLabel(c)), h("span", { class: "meta mono truncate" }, hostOf(c.resource)), h("span", { class: "meta" }, expects.length ? `Expects: ${expects.join(" · ")}` : "Any answer that isn't an error")),
      isMain
        ? h("span", { class: "item-end meta" }, "follows the app's URL")
        : h("div", { class: "item-end" }, h("button", { type: "button", class: "btn btn--sm btn--danger", "aria-label": `Remove ${name}`, onclick: () => removeConnection(page, c) }, "Remove")),
    ),
    h("details", { class: "disclosure" }, h("summary", null, `What ${isMain ? a.name : connectionLabel(c)} must answer`), form),
  );
}

function addSiteForm(page: AppPage) {
  const errors = h("div");
  return submitting(
    h(
      "form",
      { class: "form" },
      h(
        "div",
        { class: "form-row" },
        field("Name", h("input", { name: "label", maxlength: 40, placeholder: "API health" })),
        field("URL", h("input", { name: "url", type: "url", required: true, placeholder: "https://api.…/health" })),
        h("button", { type: "submit", class: "btn" }, "Add URL"),
      ),
      h("p", { class: "field-hint" }, "Checked like the app's own URL, with its own result: an API's health endpoint, a second page."),
      errors,
    ),
    errors,
    async (data) => {
      await api("POST", `${page.apiBase}/connections`, { type: "site", resource: data.get("url"), settings: { label: data.get("label") } });
      toast("URL added");
      await page.afterSubmit();
    },
    "Adding…",
  );
}

function addLinkForm(page: AppPage) {
  const errors = h("div");
  return submitting(
    h(
      "form",
      { class: "form" },
      h(
        "div",
        { class: "form-row" },
        field("Label", h("input", { name: "label", required: true, maxlength: 40, placeholder: "Supabase" })),
        field("URL", h("input", { name: "url", type: "url", required: true, placeholder: "https://…" })),
        h("button", { type: "submit", class: "btn" }, "Add link"),
      ),
      errors,
    ),
    errors,
    async (data) => {
      await api("POST", `${page.apiBase}/connections`, { type: "link", resource: data.get("url"), settings: { label: data.get("label") } });
      toast("Link added");
      await page.afterSubmit();
    },
    "Adding…",
  );
}

function editForm(page: AppPage, a: App) {
  const errors = h("div");
  return submitting(
    h(
      "form",
      { class: "form" },
      h("div", { class: "form-row" }, field("Name", h("input", { name: "name", required: true, maxlength: 80, value: a.name })), field("Public URL", h("input", { name: "url", type: "url", required: true, value: a.url }))),
      field("Notes", h("textarea", { name: "notes", rows: 3, maxlength: 2000, value: a.notes ?? "" })),
      checkbox("live", "Live in production", "Untick while it isn't launched yet: its site isn't checked, so it never shows as down or alerts you. Tick it at launch and checking starts at once.", a.live),
      field(
        "Check every",
        h("select", { name: "checkIntervalMin" }, INTERVALS_MIN.map((n) => h("option", { value: n, selected: n === a.checkIntervalMin }, n === 1 ? "1 minute" : `${n} minutes`))),
        "While something is failing it's checked every minute, whatever this says.",
      ),
      errors,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn--primary" }, "Save")),
    ),
    errors,
    async (data) => {
      ({ app: page.app } = await api<{ app: App }>("PATCH", page.apiBase, {
        name: data.get("name"),
        url: data.get("url"),
        notes: data.get("notes"),
        live: data.get("live") === "on",
        checkIntervalMin: Number(data.get("checkIntervalMin")),
      }));
      toast("Saved");
      await page.afterSubmit();
    },
  );
}

async function removeConnection(page: AppPage, conn: Connection) {
  const what = conn.type === "link" ? `the link “${conn.settings?.label}”` : `the ${connectionLabel(conn)} connection and its history`;
  if (!confirm(`Remove ${what} from ${page.app?.name}?`)) return;
  try {
    await api("DELETE", `${page.apiBase}/connections/${encodeURIComponent(conn.id)}`);
    toast("Removed");
    await page.afterSubmit();
  } catch (err) {
    toast((err as Error).message, "down");
  }
}

async function removeApp(page: AppPage, a: App) {
  if (!confirm(`Delete ${a.name} from Periskopos? Its history goes too.`)) return;
  try {
    await api("DELETE", page.apiBase);
    toast(`${a.name} deleted`);
    page.gone();
  } catch (err) {
    toast((err as Error).message, "down");
  }
}

// What a connection points at, in a line: its name, branch and folders, and
// the account it reads through.
function connectionWhat(c: Connection, services: ServiceView[]) {
  if (c.type === "site") return hostOf(c.resource);
  const service = c.serviceId ? services.find((s) => s.id === c.serviceId) : undefined;
  const paths = (c.settings?.paths as string[] | undefined)?.filter(Boolean) ?? [];
  return [String(c.settings?.name ?? c.resource), c.settings?.branch && `branch ${c.settings.branch}`, paths.length && paths.join(", "), service && `via ${service.name}`]
    .filter(Boolean)
    .join(" · ");
}
