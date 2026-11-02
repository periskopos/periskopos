import type { App, GeneratedProtocol, ProtocolView } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h } from "../dom.ts";
import { hostOf } from "../format.ts";
import { checkbox, errorBox, field, lamp, section, submitting, timeAgo, toast } from "../ui.ts";

// The app protocol on screen (PRD §7.6, §7.7): what an app reports about
// itself, and the flow that adds the protocol to an app.

// ── On the Overview: the app's own numbers ──────────────────────────────

export function metricsSection(view: ProtocolView, settingsHref: string) {
  const items = view.metrics?.items ?? [];
  const body = [
    items.length > 0 &&
      h(
        "div",
        { class: "metrics" },
        items.map((m) =>
          h("div", { class: "metric" }, h("span", { class: "label" }, m.label), h("span", { class: "figure-value" }, typeof m.value === "number" ? m.value.toLocaleString() : m.value), m.hint ? h("span", { class: "figure-note" }, m.hint) : h("span", { class: "figure-note" }, " ")),
        ),
      ),
    view.metrics && items.length === 0 && h("p", { class: "secondary" }, "The app answered, but reports no numbers yet. Fill in getMetrics() in its endpoint."),
    view.error && errorBox(new Error(view.error)),
    ...(view.problems ?? []).map((p) => errorBox(new Error(p))),
    ...(view.extras ?? []).map((x) => h("div", { class: "stack-sm" }, h("span", { class: "label" }, x.name), h("pre", { class: "code-body" }, x.json))),
  ];
  return section("Reported by the app", {
    action: h("a", { href: settingsHref }, "Protocol"),
    body,
    foot: view.checkedAt ? h("span", { class: "meta" }, "read ", timeAgo(view.checkedAt), view.metrics?.at ? [" · app's clock ", timeAgo(view.metrics.at)] : "") : undefined,
  });
}

// ── On Settings: add, check, rotate, remove ─────────────────────────────

const CAPABILITY_HELP: Record<string, [string, string]> = {
  metrics: ["Metrics", "Numbers shown on Apps and the app page, like accounts or orders. Counts only."],
  actions: ["Actions", "Buttons Periskopos, or an AI assistant after you approve, may press, like “purge cache”."],
};

export function copyButton(text: string, label = "Copy") {
  const button = h("button", { type: "button", class: "btn btn--sm" }, label);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      toast("Couldn't copy: select the text and copy it", "attention");
    }
  });
  return button;
}

function downloadButton(name: string, content: string) {
  const button = h("button", { type: "button", class: "btn btn--sm" }, "Download");
  button.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return button;
}

export function codeBlock(title: string, content: string, ...buttons: HTMLElement[]) {
  return h(
    "div",
    { class: "code" },
    h("div", { class: "code-head" }, h("code", { class: "mono" }, title), h("div", { class: "actions" }, buttons)),
    h("pre", { class: "code-body", tabindex: 0 }, content),
  );
}

export type ProtocolState = { generated?: GeneratedProtocol };

export function protocolSection(app: App, view: ProtocolView | undefined, state: ProtocolState, changed: () => void) {
  if (!view) return section("App protocol", { body: [h("p", { class: "meta" }, "Loading…")] });

  const generate = () =>
    section("Add the protocol", {
      body: [
        h("p", { class: "secondary" }, "Lets the app report its own numbers and offer its own buttons. Periskopos writes the endpoint code and a secret key; you put the code in the app and deploy it. Nothing is written into the app's repository for you."),
        generatorForm(app, state, changed),
      ],
    });

  if (!view.configured) {
    return state.generated ? generatedSteps(app, state, changed) : generate();
  }

  const m = view.manifest;
  return [
    section("App protocol", {
      action: h("span", { class: "key-line" }, lamp(view.error ? "attention" : "up"), view.error ? "Not answering" : "Connected"),
      body: [
        h(
          "dl",
          { class: "facts" },
          h("dt", { class: "label" }, "Endpoint"),
          h("dd", { class: "mono meta" }, view.endpoint ? hostOf(view.endpoint) : ""),
          m && [h("dt", { class: "label" }, "App"), h("dd", null, `${m.app.name}${m.app.version ? ` ${m.app.version}` : ""}`)],
          m && [h("dt", { class: "label" }, "Protocol"), h("dd", null, `version ${m.protocol}`)],
          m && [h("dt", { class: "label" }, "Offers"), h("dd", null, m.capabilities.length ? h("span", { class: "chips" }, m.capabilities.map((c) => h("span", { class: "tag" }, c))) : "nothing yet")],
          h("dt", { class: "label" }, "Secret"),
          h("dd", { class: "meta" }, view.secretState === "set" ? ["found in .env.local as ", h("code", null, view.secretRef ?? "")] : "missing from .env.local"),
        ),
        view.error && errorBox(new Error(view.error)),
        ...(view.problems ?? []).map((p) => errorBox(new Error(p))),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn", onclick: changed }, "Check again"),
          h("button", { type: "button", class: "btn btn--danger", onclick: () => removeProtocol(app, changed) }, "Remove protocol"),
        ),
      ],
    }),
    state.generated ? generatedSteps(app, state, changed) : section("Rotate the secret", { body: [h("p", { class: "secondary" }, "Generating a new secret stops the current endpoint from answering until you redeploy it with the new one."), generatorForm(app, state, changed, "Generate a new secret", m?.capabilities ?? ["metrics"])] }),
  ];
}

async function removeProtocol(app: App, changed: () => void) {
  if (!confirm(`Stop reading ${app.name}'s endpoint? The endpoint itself and its secret in .env.local are left as they are.`)) return;
  try {
    await api("DELETE", `/apps/${encodeURIComponent(app.slug)}/protocol`);
    toast("Protocol removed");
    changed();
  } catch (err) {
    toast((err as Error).message, "down");
  }
}

function generatorForm(app: App, state: ProtocolState, changed: () => void, button = "Generate code", defaults: string[] = ["metrics"]) {
  const errors = h("div");
  return submitting(
    h(
      "form",
      { class: "form" },
      field("Where it runs", h("select", { name: "runtime" }, h("option", { value: "supabase-edge" }, "Supabase Edge Function")), "More runtimes (Node, Cloudflare) come when an app needs them."),
      h("div", { class: "stack-sm" }, h("span", { class: "field-label" }, "What it offers"), ...Object.entries(CAPABILITY_HELP).map(([key, [label, hint]]) => checkbox(key, label, hint, defaults.includes(key)))),
      errors,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn--primary" }, button)),
    ),
    errors,
    async (data) => {
      const capabilities = ["metrics", "actions"].filter((c) => data.get(c) === "on");
      const { generated } = await api<{ generated: GeneratedProtocol }>("POST", `/apps/${encodeURIComponent(app.slug)}/protocol/generate`, { runtime: data.get("runtime"), capabilities });
      state.generated = generated;
      changed();
    },
    "Generating…",
  );
}

// What the generator made: the file, the commands, and the test.
function generatedSteps(app: App, state: ProtocolState, changed: () => void) {
  const g = state.generated!;
  const file = g.files[0];
  const errors = h("div");
  const endpoint = h("input", { name: "endpoint", type: "url", required: true, class: "mono", placeholder: "https://<project-ref>.supabase.co/functions/v1/periskopos", value: g.endpointHint ?? "", autocomplete: "off", spellcheck: false });
  const result = h("div");

  return section("Your endpoint", {
    body: [
      h("div", { class: "notice" }, lamp("attention"), h("span", null, h("strong", null, "The secret in step 2 is shown only now."), " It's also saved in .env.local on this computer under ", h("code", null, g.secretRef), ", but this page won't show it again. Leaving the page clears it.")),

      h("h3", { class: "label" }, "1 · Save this file in the app"),
      codeBlock(file.path, file.content, copyButton(file.content), downloadButton("index.ts", file.content)),
      h("p", { class: "meta" }, "Fill in the three functions marked FILL IN (the numbers, the buttons, what a button does). Counts and short text only: never emails or names."),

      h("h3", { class: "label" }, "2 · Install the secret and deploy"),
      ...g.commands.map((c, i) => codeBlock(`command ${i + 1}`, c, copyButton(c))),
      h("p", { class: "meta" }, "Run them in the app's folder, logged in to Supabase. ", h("code", null, "--no-verify-jwt"), " is needed: Periskopos authenticates with its own secret, not a Supabase login."),

      h("h3", { class: "label" }, "3 · Test the connection"),
      submitting(
        h(
          "form",
          { class: "form" },
          field("Endpoint address", endpoint, "Periskopos calls it with the secret and saves it if it answers."),
          errors,
          result,
          h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn--primary" }, "Test connection")),
        ),
        errors,
        async (data) => {
          result.replaceChildren();
          const r = await api<{ ok: boolean; message?: string; manifest?: { app: { name: string }; capabilities: string[] } }>("POST", `/apps/${encodeURIComponent(app.slug)}/protocol/test`, { endpoint: data.get("endpoint") });
          if (!r.ok) {
            result.replaceChildren(errorBox(new Error(r.message ?? "The endpoint didn't answer")));
            return;
          }
          state.generated = undefined; // the secret leaves this page now it is installed
          toast(`Connected to ${r.manifest?.app.name}`);
          changed();
        },
        "Testing…",
      ),
    ],
  });
}
