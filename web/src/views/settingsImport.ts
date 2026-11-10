import type { SetupPlanView } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { dayTime } from "../format.ts";
import { inputRow } from "../settingRows.ts";
import { busyButton, checkbox, errorBox, section, toast } from "../ui.ts";

// Settings → Data → Import: read an exported setup, say exactly what it would
// do, and only then do it. Nothing changes until the button is pressed.

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const value = (v: boolean | number) => (v === true ? "on" : v === false ? "off" : String(v));

const group = (title: string, items: (string | Node)[]) =>
  items.length > 0 && h("div", { class: "stack-sm" }, h("h3", { class: "label" }, title), h("ul", { class: "import-list" }, items.map((x) => h("li", { class: "meta" }, x))));

function appLine(app: SetupPlanView["newApps"][number]) {
  const notes = [
    app.connections.length > 0 && app.connections.join(", "),
    app.waiting.length > 0 && `needs an account for ${app.waiting.join(", ")}`,
    app.endpoint && "its own endpoint needs connecting again",
    ...app.unread.map((why) => `left out: ${why}`),
  ].filter(Boolean);
  return `${app.name} (${notes.join(" · ") || "no checks"})`;
}

function planView(plan: SetupPlanView) {
  const gaining = plan.existing.filter((a) => a.connections.length > 0);
  const stillWaiting = plan.existing.filter((a) => a.waiting.length > 0);
  const untouched = plan.existing.filter((a) => a.connections.length === 0);
  return [
    group("Apps to add", plan.newApps.map(appLine)),
    group("Connections to add to apps you already have", gaining.map((a) => `${a.name} (${a.connections.join(", ")})`)),
    group("Accounts to add yourself", plan.accounts.map((a) => `${a.label}: ${a.name}`)),
    (plan.accounts.length > 0 || plan.newApps.some((a) => a.waiting.length > 0) || stillWaiting.length > 0) &&
      h("p", { class: "meta" }, "Keys aren't in the file. Add these accounts in Accounts, then import the same file again: their connections join the apps then."),
    group("Waiting for an account", stillWaiting.map((a) => `${a.name} (${a.waiting.join(", ")})`)),
    group("Already here, left as they are", untouched.map((a) => a.name)),
    group("Can't be added", plan.refused.map((r) => `${r.name}: ${r.why}`)),
  ];
}

export function importSection(onImported: () => Promise<void>) {
  const slot = h("div", { class: "stack-sm" });
  const picker = h("input", { type: "file", name: "setupFile", accept: ".json,application/json" }) as HTMLInputElement;

  const reset = () => {
    picker.value = "";
    slot.replaceChildren();
  };

  const showPlan = (setup: unknown, plan: SetupPlanView) => {
    const useSettings = checkbox("useSettings", "Also use the file's settings", "Only the ones listed here. AI assistants, where alerts go, watching and how long checks are kept never come from a file.");
    const changes = plan.settings.length > 0;
    const work = plan.newApps.length + plan.existing.reduce((n, a) => n + a.connections.length, 0);
    const label = [plan.newApps.length > 0 && `Add ${plural(plan.newApps.length, "app")}`, plan.newApps.length === 0 && work > 0 && `Add ${plural(work, "connection")}`].find(Boolean) || "Use these settings";
    mount(
      slot,
      h("p", { class: "secondary" }, plan.exportedAt ? `A setup exported ${dayTime(plan.exportedAt)}.` : "A setup from Periskopos.", " This is what it would do. Nothing has changed yet."),
      ...planView(plan),
      changes && h("div", { class: "stack-sm" }, h("h3", { class: "label" }, "Settings that differ"), h("ul", { class: "import-list" }, plan.settings.map((s) => h("li", { class: "meta" }, `${s.label}: ${value(s.from)} here, ${value(s.to)} in the file`))), useSettings),
      work === 0 && !changes && plan.accounts.length === 0 && h("p", { class: "meta" }, "There's nothing in it to add."),
      h(
        "div",
        { class: "actions" },
        (work > 0 || changes) &&
          busyButton(label, "Adding…", async () => {
            const wantSettings = slot.querySelector<HTMLInputElement>("input[name=useSettings]")?.checked === true;
            if (work === 0 && !wantSettings) {
              toast("Tick the settings to use them first", "down");
              return;
            }
            try {
              const answer = await api<{ added: number; connected: number }>("POST", "/settings/import", { setup, useSettings: wantSettings });
              reset();
              const added = [answer.added > 0 && `${plural(answer.added, "app")} added`, answer.connected > 0 && `${plural(answer.connected, "connection")} added`].filter(Boolean).join(", ");
              toast(added || (wantSettings ? "Settings used" : "Nothing new to add"));
              await onImported();
            } catch (err) {
              // The same file can be chosen again.
              picker.value = "";
              mount(slot, errorBox(err));
            }
          }, "btn btn--primary"),
        h("button", { type: "button", class: "btn", onclick: reset }, "Cancel"),
      ),
    );
  };

  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        if (file.size > MAX_FILE_BYTES) throw new Error("This file is too big to be a setup file");
        let setup: unknown;
        try {
          setup = JSON.parse(await file.text());
        } catch {
          throw new Error("This isn't a setup file from Periskopos: it can't be read as one");
        }
        const { plan } = await api<{ plan: SetupPlanView }>("POST", "/settings/import/preview", { setup });
        showPlan(setup, plan);
      } catch (err) {
        picker.value = "";
        mount(slot, errorBox(err));
      }
    })();
  });

  return section("Import", {
    body: [
      inputRow("Setup file", "Read a file from Export my setup, to bring your apps and their checks to this computer. It only adds: apps you already have keep what they have, and can only gain connections through your accounts. You see what it would do first.", picker),
      slot,
    ],
  });
}
