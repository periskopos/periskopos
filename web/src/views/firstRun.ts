import type { User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { queueTour } from "../tour.ts";
import { field, section, shell, submitting } from "../ui.ts";

// First run (FR-U1): who are you, then the tour (tour.ts) over adding a
// first app.
export function firstRunView(root: Element, done: () => void) {
  const errors = h("div");
  const name = h("input", { name: "name", required: true, maxlength: 80, autocomplete: "off" });
  const form = submitting(
    h(
      "form",
      { class: "form" },
      field("What should I call you?", name),
      errors,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn--primary" }, "Continue")),
    ),
    errors,
    async (data) => {
      await api<{ user: User }>("POST", "/setup", { name: data.get("name") });
      queueTour();
      done();
    },
    "Setting up…",
  );
  mount(
    root,
    shell(
      null,
      null,
      h(
        "div",
        { class: "narrow welcome stack" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }),
        h("h1", null, "Welcome to Periskopos"),
        h("p", { class: "secondary" }, "One quiet place to watch every app you run in production: whether it's up, what's live, and what changed. It runs only on this computer."),
        section("Get started", { body: [form] }),
      ),
    ),
  );
  name.focus();
}
