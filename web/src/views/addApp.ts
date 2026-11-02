import type { App, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { checkbox, field, section, shell, submitting, toast } from "../ui.ts";

// Add app (IA: #/apps/new): name and URL, then on to the new app.
export function addAppView(root: Element, user: User, done: (app: App) => void) {
  const errors = h("div");
  const name = h("input", { name: "name", required: true, maxlength: 80, placeholder: "Star-Map", autocomplete: "off" });
  const form = submitting(
    h(
      "form",
      { class: "form" },
      field("Name", name),
      field("Public URL", h("input", { name: "url", type: "url", required: true, placeholder: "https://example.org", class: "mono" }), "Periskopos checks this address every few minutes. Nothing in the app changes."),
      field("Notes", h("textarea", { name: "notes", rows: 2, maxlength: 2000 }), "Optional."),
      checkbox("live", "Already live", "Untick if it isn't launched yet. Its site isn't checked, so it never shows as down or alerts you; tick it in the app's Settings at launch.", true),
      errors,
      h("div", { class: "actions" }, h("a", { class: "btn btn--ghost", href: "#/" }, "Cancel"), h("button", { type: "submit", class: "btn btn--primary" }, "Add app")),
    ),
    errors,
    async (data) => {
      const first = (await api<{ apps: App[] }>("GET", "/apps").catch(() => ({ apps: [{}] }))).apps.length === 0;
      const { app } = await api<{ app: App }>("POST", "/apps", { name: data.get("name"), url: data.get("url"), notes: data.get("notes"), live: data.get("live") === "on" });
      toast(`${app.name} added. Connect GitHub or your host in its Settings.`);
      // The first app: a test notification, so you know alerts reach you (and
      // the system asks to allow them now, not at the first outage).
      if (first) void api("POST", "/notifications/test", { first: true }).catch(() => undefined);
      done(app);
    },
    "Adding…",
  );
  mount(
    root,
    shell(
      user,
      "fleet",
      h(
        "div",
        { class: "narrow stack" },
        h("div", { class: "page-header" }, h("div", null, h("nav", { class: "crumb", "aria-label": "Back" }, h("a", { href: "#/" }, "← Apps")), h("h1", null, "Add an app"))),
        section("App", { body: [form] }),
      ),
    ),
  );
  name.focus();
}
