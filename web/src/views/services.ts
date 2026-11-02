import { ACCOUNTS, ACCOUNT_KINDS, hostLabel, isHostType, kindLabel } from "../../../shared/catalog.ts";
import { KEY_WARN_DAYS, daysLeft, duration } from "../../../shared/format.ts";
import type { ServiceType, ServiceView, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { isDegraded, loadProviders, providerStatusLine } from "./providers.ts";
import type { ProviderStatus } from "../../../shared/types.ts";
import { busyButton, checkbox, errorBox, ext, field, lamp, shell, submitting, timeAgo, toast } from "../ui.ts";
import type { LampState } from "../ui.ts";

// What each kind of account gives you, and exactly how to get its key
// (shared/catalog.ts): the setup page walks through it step by step.
const guideOf = (type: ServiceType) => ({ label: ACCOUNTS[type].label, ...ACCOUNTS[type].guide });

// With more accounts than this, the Accounts page lists them under their
// kind; with fewer, headings would be most of the page.
export const GROUP_OVER = 6;

// Things listed under the kind of account each is, in the kinds' order;
// kinds with nothing are left out.
export function byKind<T>(items: T[], typeOf: (x: T) => ServiceType) {
  return ACCOUNT_KINDS.map(({ key }) => ({ kind: key, items: items.filter((x) => ACCOUNTS[typeOf(x)].kinds[0] === key) })).filter((g) => g.items.length > 0);
}

const kindTags = (type: ServiceType) => ACCOUNTS[type].kinds.map((k) => h("span", { class: "tag" }, kindLabel(k)));

// The account's own logo, in its colour (web/src/logos, from Simple Icons, CC0).
export const serviceLogo = (type: ServiceType) =>
  h("span", { class: "service-mark", "aria-hidden": "true" }, h("span", { class: `service-logo service-logo--${type}` }));

// Whether the key works, as far as anyone knows: the last test (Test, or
// the watcher's daily one) says, and until there is one, only whether a key
// is there at all. A key that says when it expires warns 14 days ahead.
function keyLine(s: ServiceView, now = Date.now()) {
  if (s.keyState === "missing") {
    return h("span", { class: "key-line" }, lamp("attention"), h("span", { class: "reason reason--attention" }, "No key yet: choose Add key to paste one."));
  }
  const t = s.lastTest;
  if (t && !t.ok) {
    return h("span", { class: "key-line" }, lamp("down"), h("span", { class: "reason reason--down" }, `Last test failed: ${t.message}. Choose Change key to paste a working one.`), timeAgo(t.at, " · "));
  }
  if (t?.ok) {
    const tested = h("span", { class: "meta" }, timeAgo(t.at, " · tested "));
    const days = t.expiresAt ? daysLeft(t.expiresAt, now) : undefined;
    const date = t.expiresAt?.slice(0, 10);
    if (days !== undefined && days <= 0) {
      return h("span", { class: "key-line" }, lamp("down"), h("span", { class: "reason reason--down" }, `Key expired on ${date}. Choose Change key to paste a new one.`), tested);
    }
    if (days !== undefined && days <= KEY_WARN_DAYS) {
      const left = `${days} day${days === 1 ? "" : "s"}`;
      return h("span", { class: "key-line" }, lamp("attention"), h("span", { class: "reason reason--attention" }, `Key expires in ${left} (${date}): make a new one and choose Change key.`), tested);
    }
    return h("span", { class: "key-line" }, lamp("up"), h("span", { class: "secondary" }, `${t.message}${date ? ` · expires ${date}` : ""}`), tested);
  }
  const key = KEY[s.keyState];
  return h("span", { class: "key-line" }, lamp("unknown"), h("span", { class: "secondary" }, `${key.text} · not tested yet`));
}

// The card's one-word verdict on its key, for the pill in its header.
function keyHealth(s: ServiceView, now = Date.now()): { lamp: LampState; text: string } {
  if (s.keyState === "missing") return { lamp: "attention", text: "No key" };
  const t = s.lastTest;
  if (t && !t.ok) return { lamp: "down", text: "Key failing" };
  if (t?.ok) {
    const days = t.expiresAt ? daysLeft(t.expiresAt, now) : undefined;
    if (days !== undefined && days <= 0) return { lamp: "down", text: "Key expired" };
    if (days !== undefined && days <= KEY_WARN_DAYS) return { lamp: "attention", text: "Key expiring" };
    return { lamp: "up", text: "Working" };
  }
  return { lamp: "unknown", text: "Not tested" };
}

const KEY: Record<ServiceView["keyState"], { lamp: LampState; text: string }> = {
  set: { lamp: "up", text: "Key saved on this computer" },
  missing: { lamp: "attention", text: "No key yet" },
  gh: { lamp: "up", text: "Uses the GitHub login on this computer (gh)" },
};

// Accounts (IA: Services): my accounts, connected once, used by any app.
export function servicesView(root: Element, user: User) {
  const list = h("div", null, h("p", { class: "meta" }, "Loading…"));
  const results = new Map<string, HTMLElement>();
  let providers: ProviderStatus[] = [];

  mount(
    root,
    shell(
      user,
      "services",
      h(
        "div",
        { class: "page-header" },
        h("div", null, h("h1", null, "Accounts"), h("p", { class: "meta" }, "Connected once, used by every app. A key changes in one place.")),
        h("div", { class: "actions" }, h("a", { class: "btn btn--primary", href: "#/services/new" }, "Connect an account")),
      ),
      list,
    ),
  );

  async function load() {
    try {
      const { services } = await api<{ services: ServiceView[] }>("GET", "/services");
      providers = await loadProviders();
      mount(
        list,
        services.length === 0
          ? h(
              "div",
              { class: "section empty-hero" },
              h("h2", null, "No accounts yet"),
              h("p", null, "Connect GitHub or GitLab to see commits and CI, and your host (Vercel, Netlify, Cloudflare, Render…) to see deploys and whether your last push is live. Each account takes a minute: you copy one key from its website."),
              h("a", { class: "btn btn--primary", href: "#/services/new" }, "Connect an account"),
            )
          : h(
              "section",
              { class: "accounts", "aria-labelledby": "s-connected" },
              h("h2", { class: "label", id: "s-connected" }, `${services.length} connected`),
              services.length > GROUP_OVER
                ? byKind(services, (s) => s.type).map(({ kind, items }) =>
                    h("div", { class: "account-group", role: "group", "aria-label": kindLabel(kind) }, h("h3", { class: "label account-group-label" }, kindLabel(kind)), h("ul", { class: "account-list" }, items.map(item))),
                  )
                : h("ul", { class: "account-list" }, services.map(item)),
            ),
      );
    } catch (err) {
      mount(list, errorBox(err));
    }
  }

  function item(s: ServiceView) {
    const result = results.get(s.id) ?? h("div");
    results.set(s.id, result);
    const plan = ACCOUNTS[s.type].plan;
    const status = providers.find((x) => x.id === s.type);
    const health = keyHealth(s);
    // A row of the card: what it's about, what's known, and the one control
    // that belongs with it.
    const fact = (label: string, ...value: unknown[]) => h("div", { class: "fact" }, h("dt", null, label), h("dd", null, ...(value as Node[])));
    // A card: who it is and whether its key works (header), what's known
    // about it, a row each (body), and what can be done with the key
    // (footer, Remove kept apart at the far end).
    return h(
      "li",
      { class: "account-card", "aria-labelledby": `acct-${s.id}` },
      h(
        "div",
        { class: "account-head" },
        serviceLogo(s.type),
        h("div", { class: "account-title" }, h("h3", { class: "account-name", id: `acct-${s.id}` }, s.name), h("span", { class: "meta account-kinds" }, ACCOUNTS[s.type].label, kindTags(s.type))),
        h("span", { class: `health-pill health-pill--${health.lamp}` }, lamp(health.lamp), health.text),
      ),
      h(
        "dl",
        { class: "account-facts" },
        fact("Key", keyLine(s)),
        isHostType(s.type) &&
          fact(
            "Access",
            h("span", { class: "fact-line" }, h("span", { class: "secondary" }, s.canWrite ? "Actions allowed: redeploys and cache purges, each confirmed" : "Read only"), h("button", { type: "button", class: "btn btn--sm btn--ghost fact-action", onclick: () => toggleActions(s) }, s.canWrite ? "Make read only" : "Allow actions")),
          ),
        plan &&
          fact(
            "Plan",
            h("div", { class: "fact-stack" }, h("span", { class: "fact-line" }, h("span", { class: "secondary" }, s.paidPlan ? plan.paid : "Free plan"), h("button", { type: "button", class: "btn btn--sm btn--ghost fact-action", onclick: () => togglePlan(s) }, s.paidPlan ? "Mark as free plan" : `Mark as ${plan.paid}`)), planLine(s)),
          ),
        status &&
          fact(
            "Status",
            h("span", { class: "fact-line" }, providerStatusLine(status), h("a", { class: "btn btn--sm btn--ghost fact-action", href: "#/status" }, isDegraded(status) ? "See what's affected" : "Details")),
          ),
        fact(
          "Used by",
          s.apps.length === 0
            ? h("span", { class: "meta" }, "No apps yet")
            : h("div", { class: "chips" }, s.apps.map((a) => h("a", { class: "chip", href: `#/apps/${encodeURIComponent(a.slug)}` }, a.name))),
        ),
      ),
      result,
      h(
        "div",
        { class: "account-foot" },
        busyButton("Test", "Testing…", () => test(s, result), "btn btn--sm"),
        h("button", { type: "button", class: "btn btn--sm", onclick: () => askKey(s, result) }, s.keyState === "missing" ? "Add key" : "Change key"),
        h("button", { type: "button", class: "btn btn--sm btn--danger account-remove", onclick: () => remove(s) }, "Remove"),
      ),
    );
  }

  // Tests the key; the row's own line then says what it found.
  async function test(s: ServiceView, slot: HTMLElement) {
    try {
      const { ok, message } = await api<{ ok: boolean; message: string }>("POST", `/services/${s.id}/test`);
      toast(ok ? `${s.name}: ${message}` : `${s.name}: the test failed`, ok ? "up" : "down");
      slot.replaceChildren();
      await load();
    } catch (err) {
      slot.replaceChildren(errorBox(err));
    }
  }

  // Paste a key for a service already connected: the same steps as setting
  // one up, then a test straight away.
  function askKey(s: ServiceView, slot: HTMLElement) {
    const errors = h("div");
    const form = submitting(
      h("form", { class: "form" }, keySteps(s.type), keyField(s.type), errors, h("div", { class: "actions" }, h("button", { type: "button", class: "btn btn--ghost", onclick: () => slot.replaceChildren() }, "Cancel"), h("button", { type: "submit", class: "btn btn--primary" }, "Save and test"))),
      errors,
      async (data) => {
        await api("POST", `/services/${s.id}/key`, { key: data.get("key") });
        const { ok, message } = await api<{ ok: boolean; message: string }>("POST", `/services/${s.id}/test`);
        if (!ok) throw new Error(`Saved, but the test failed: ${message}. Check the steps above and paste the key again.`);
        toast(`${s.name}: ${message}`);
        results.delete(s.id);
        await load();
      },
      "Saving…",
    );
    slot.replaceChildren(h("div", { class: "inline-panel" }, form));
    form.querySelector<HTMLInputElement>("input[name=key]")?.focus();
  }

  // Which plan the account is on: the free one's limit is watched, the
  // paid one has none.
  async function togglePlan(s: ServiceView) {
    const plan = ACCOUNTS[s.type].plan!;
    const paid = !s.paidPlan;
    try {
      await api("PATCH", `/services/${s.id}`, { paidPlan: paid });
      toast(paid ? `${s.name}: on ${plan.paid}, no daily limit to watch` : `${s.name}: on the free plan, its limit is watched`);
      await load();
    } catch (err) {
      toast((err as Error).message, "down");
    }
  }

  // Whether Periskopos, or Claude through it, may change things with
  // this key (FR-S5). Switching it on says what that means first.
  async function toggleActions(s: ServiceView) {
    const on = !s.canWrite;
    if (on && !confirm(`Allow actions with ${s.name}?\n\nPeriskopos, and AI assistants when you approve it, will be able to redeploy your apps on ${hostLabel(s.type)}. Every action is confirmed first and recorded.`)) return;
    try {
      await api("PATCH", `/services/${s.id}`, { canWrite: on });
      toast(on ? `${s.name}: actions allowed` : `${s.name} is read only again`);
      await load();
    } catch (err) {
      toast((err as Error).message, "down");
    }
  }

  async function remove(s: ServiceView) {
    const apps = s.apps.map((a) => a.name).join(", ");
    if (!confirm(apps ? `Remove ${s.name}? These apps lose their ${ACCOUNTS[s.type].label} connection: ${apps}.` : `Remove ${s.name}?`)) return;
    try {
      await api("DELETE", `/services/${s.id}`);
      results.delete(s.id);
      toast(`${s.name} removed`);
      await load();
    } catch (err) {
      toast((err as Error).message, "down");
    }
  }

  void load();
}

// The numbered steps for getting one kind of account's key.
function keySteps(type: ServiceType) {
  const t = guideOf(type);
  return h(
    "div",
    { class: "stack-sm" },
    h("p", null, ext(t.link.href, t.link.text)),
    h("ol", { class: "steps" }, t.steps.map((step) => h("li", null, step))),
  );
}

function keyField(type: ServiceType) {
  const t = guideOf(type);
  return field(
    t.keyIs ? `Paste ${t.keyIs}` : "Paste the key",
    h("input", { name: "key", type: "password", autocomplete: "off", spellcheck: false, class: "mono", placeholder: t.looksLike ? `${t.looksLike}…` : "Paste here", required: true }),
    "Saved only in the keys file on this computer, never in Periskopos's database, and never shown again.",
  );
}

// Connect an account (IA: #/services/new), as numbered steps: which account,
// how to get its key, paste it, name it. It's tested before you leave; if the
// test fails you stay here, see why, and can paste another key.
export function connectServiceView(root: Element, user: User, done: () => void) {
  let type: ServiceType = "github";
  let created: ServiceView | undefined; // connected, but the key didn't work yet
  const body = h("div", { class: "stack" });

  function draw() {
    const t = guideOf(type);
    const errors = h("div");
    const usesGh = h("input", { type: "radio", name: "githubHow", value: "gh", checked: true });
    const usesToken = h("input", { type: "radio", name: "githubHow", value: "token" });
    const keyPart = h("div", { class: "stack-sm" }, keySteps(type), keyField(type));
    const name = h("input", { name: "name", maxlength: 60, placeholder: `My ${t.label}` });
    const submit = h("button", { type: "submit", class: "btn btn--primary" }, created ? "Save the new key and test" : "Connect and test");
    const keep = h("p", { class: "meta", hidden: !created }, h("a", { href: "#/services" }, "Keep it and fix it later"));
    const advanced = h("input", { name: "secretRef", maxlength: 64, class: "mono", autocomplete: "off", spellcheck: false, placeholder: "e.g. RENDER_API_KEY" });

    const syncGithub = () => {
      const pasting = type !== "github" || usesToken.checked;
      keyPart.hidden = !pasting;
      const input = keyPart.querySelector<HTMLInputElement>("input[name=key]");
      if (input) input.required = pasting && !advanced.value;
    };
    usesGh.addEventListener("change", syncGithub);
    usesToken.addEventListener("change", syncGithub);
    advanced.addEventListener("input", syncGithub);

    const choices = h(
      "div",
      { class: "choice-groups", role: "radiogroup", "aria-label": "Account" },
      byKind(Object.keys(ACCOUNTS) as ServiceType[], (k) => k).map(({ kind, items }) =>
        h(
          "div",
          { class: "choice-group", role: "group", "aria-label": kindLabel(kind) },
          h("p", { class: "label choice-group-label" }, kindLabel(kind)),
          h(
            "div",
            { class: "choices" },
            items.map((k) =>
              h(
                "label",
                { class: `choice${k === type ? " choice--on" : ""}` },
                h("input", { type: "radio", name: "type", value: k, checked: k === type, onchange: () => ((type = k), (created = undefined), draw()) }),
                serviceLogo(k),
                h("span", null, h("span", { class: "field-label" }, ACCOUNTS[k].label), h("span", { class: "field-hint" }, guideOf(k).gives)),
              ),
            ),
          ),
        ),
      ),
    );

    const form = submitting(
      h(
        "form",
        { class: "form" },
        step(1, "Choose the account", choices),
        step(
          2,
          type === "github" ? "Choose how Periskopos signs in" : `Get a key from ${t.label}`,
          type === "github"
            ? h(
                "div",
                { class: "stack-sm" },
                h("label", { class: "check" }, usesGh, h("span", null, h("span", { class: "field-label" }, "Use the GitHub login on this computer"), h("span", { class: "field-hint" }, "If you've signed in with the GitHub CLI (gh auth login), there's nothing to paste."))),
                h("label", { class: "check" }, usesToken, h("span", null, h("span", { class: "field-label" }, "Paste a GitHub token"), h("span", { class: "field-hint" }, "For a computer without the GitHub CLI, or to give Periskopos only some repositories."))),
                keyPart,
              )
            : keyPart,
        ),
        step(
          3,
          "Name it",
          h(
            "div",
            { class: "stack-sm" },
            field("Name", name, "How it's listed. Useful if you connect more than one account of the same kind."),
            t.actions && checkbox("canWrite", "Allow actions", t.actions),
            h(
              "details",
              { class: "advanced" },
              h("summary", null, "Advanced: the key is already in your keys file"),
              field("Variable name in the keys file", advanced, "Leave the paste box empty, and Periskopos reads the key from this variable instead (Settings → About shows where the keys file is)."),
            ),
          ),
        ),
        errors,
        h("div", { class: "actions" }, h("a", { class: "btn btn--ghost", href: "#/services" }, "Cancel"), submit),
        keep,
      ),
      errors,
      async (data) => {
        const key = type === "github" && usesGh.checked ? "" : String(data.get("key") ?? "");
        const secretRef = String(data.get("secretRef") ?? "").trim();
        if (created) {
          // Already connected on an earlier try: only the key changes.
          if (key) await api("POST", `/services/${created.id}/key`, { key });
        } else {
          ({ service: created } = await api<{ service: ServiceView }>("POST", "/services", {
            type,
            name: String(data.get("name") ?? "") || name.placeholder,
            ...(key ? { key } : {}),
            ...(secretRef && !key ? { secretRef } : {}),
            canWrite: data.get("canWrite") === "on",
          }));
        }
        const { ok, message } = await api<{ ok: boolean; message: string }>("POST", `/services/${created.id}/test`);
        if (!ok) {
          // Stay: say what failed and let a corrected key be pasted.
          submit.textContent = "Save the new key and test";
          keep.hidden = false;
          const input = form.querySelector<HTMLInputElement>("input[name=key]");
          if (input) input.value = "";
          throw new Error(`${created.name} is connected, but the test failed. ${message}. Follow step 2 again and paste the new key.`);
        }
        toast(`${created.name}: ${message}`);
        done();
      },
      "Testing…",
    );

    mount(body, form);
    syncGithub();
  }

  mount(
    root,
    shell(
      user,
      "services",
      h(
        "div",
        { class: "narrow stack" },
        h(
          "div",
          { class: "page-header" },
          h(
            "div",
            null,
            h("nav", { class: "crumb", "aria-label": "Back" }, h("a", { href: "#/services" }, "← Accounts")),
            h("h1", null, "Connect an account"),
            h("p", { class: "meta" }, "Connect each account once; then any app can use it. It takes a minute: you'll copy a key from the account's website."),
          ),
        ),
        body,
      ),
    ),
  );
  draw();
}

function step(n: number, title: string, content: HTMLElement) {
  return h("section", { class: "step" }, h("h2", { class: "step-title" }, h("span", { class: "step-number", "aria-hidden": "true" }, String(n)), title), content);
}

// How much of its free plan's limit an account has used, as a bar per
// meter; or which plan it's on, when the paid one lifts the limit.
export function planLine(s: ServiceView) {
  const plan = ACCOUNTS[s.type].plan;
  if (!plan) return undefined;
  if (s.paidPlan) return h("span", { class: "meta" }, "No daily limit to watch");
  const u = s.planUsage;
  if (!u) return h("span", { class: "meta" }, `${plan.free}. Usage is read every 30 minutes.`);
  if ("error" in u) return h("span", { class: "meta" }, `Couldn't read usage: ${u.error}`);
  return h(
    "div",
    { class: "usage" },
    u.meters.map((m) => {
      const pct = Math.min(100, Math.round((m.used / m.limit) * 100));
      const level = m.used >= m.limit ? "over" : m.used >= 0.8 * m.limit ? "near" : "ok";
      const resets = Math.max(0, Date.parse(m.resetsAt) - Date.now());
      // Set through the DOM: the page's policy refuses style attributes.
      const fill = h("span", { class: "usage-fill" });
      fill.style.width = `${pct}%`;
      return h(
        "div",
        { class: `usage-meter usage-meter--${level}` },
        h("span", { class: "meta" }, `${m.label}: `, h("span", { class: "mono" }, `${m.used.toLocaleString()} of ${m.limit.toLocaleString()}`), ` (${pct}%) · resets in ${duration(resets)} · `, timeAgo(u.at, "read ")),
        h("span", { class: "usage-bar", role: "meter", "aria-label": m.label, "aria-valuemin": "0", "aria-valuemax": String(m.limit), "aria-valuenow": String(Math.min(m.used, m.limit)) }, fill),
      );
    }),
  );
}
