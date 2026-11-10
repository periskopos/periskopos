import type { ActionDef, AgentAccess, AgentAuditEntry, AgentRule, AgentView, App, McpStatus, Settings } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h, mount } from "../dom.ts";
import { clock } from "../format.ts";
import { toggleRow } from "../settingRows.ts";
import { busyButton, empty, errorBox, field, lamp, section, submitting, timeAgo, toast } from "../ui.ts";
import type { LampState } from "../ui.ts";
import { codeBlock, copyButton } from "./protocolParts.ts";

// Settings → AI assistants: the connection (on or off, whether the MCP server
// can run, how to set it up, who's talking now); the assistants, "This PC"
// for every setup without a token and one per token, each with what it may
// see and do, a rule per action and grants given from the approval dialog;
// and the audit log of what they asked for.

type Setup = { claudeCode: string; json: string };
type ActionsOf = Map<string, ActionDef[]>; // app id → its actions

const ACCESS: Record<AgentAccess, { text: string; lamp: LampState }> = {
  read: { text: "Read only", lamp: "unknown" },
  ask: { text: "May ask for actions", lamp: "info" },
};
const RULE: Record<AgentRule, string> = { ask: "Ask me", allow: "Allow without asking", never: "Never" };
// A request this recent means it's connected now.
const ACTIVE_MS = 2 * 60_000;
const isActive = (iso: string | undefined, now = Date.now()) => !!iso && now - Date.parse(iso) < ACTIVE_MS;

const OUTCOME_TONE: Record<string, string> = {
  approved: "up",
  "allowed by rule": "info",
  "allowed by grant": "info",
  declined: "attention",
  expired: "attention",
  refused: "down",
  "refused by rule": "down",
  failed: "down",
};

export function assistantsSections() {
  const list = h("div", null, h("p", { class: "meta" }, "Loading…"));
  const log = h("div", null, h("p", { class: "meta" }, "Loading…"));
  const panel = h("div");
  const strip = h("div", null, h("p", { class: "meta" }, "Loading…"));
  let agents: AgentView[] = [];
  let mcp: McpStatus | undefined;
  let on = false;
  let apps: App[] = [];
  const actions: ActionsOf = new Map();
  let filter = "";

  async function load() {
    try {
      let settings: Settings;
      [{ agents, mcp }, { apps }, { settings }] = await Promise.all([
        api<{ agents: AgentView[]; mcp: McpStatus }>("GET", "/agents"),
        api<{ apps: App[] }>("GET", "/apps"),
        api<{ settings: Settings }>("GET", "/settings"),
      ]);
      on = settings.agentAccess;
      drawStrip();
      drawList();
      await loadLog();
    } catch (err) {
      list.replaceChildren(errorBox(err));
    }
  }

  async function loadLog() {
    try {
      const { entries } = await api<{ entries: AgentAuditEntry[] }>("GET", `/agents/audit${filter ? `?agent=${encodeURIComponent(filter)}` : ""}`);
      drawLog(entries);
    } catch (err) {
      log.replaceChildren(errorBox(err));
    }
  }

  const appName = (id: string) => apps.find((a) => a.id === id)?.name ?? "a removed app";
  const actionLabel = (appId: string, actionId: string) => actions.get(appId)?.find((x) => x.id === actionId)?.label ?? actionId;

  async function actionsFor(ids: string[]) {
    await Promise.all(
      ids
        .filter((id) => !actions.has(id))
        .map(async (id) => {
          const app = apps.find((a) => a.id === id);
          if (!app) return;
          try {
            const r = await api<{ actions: ActionDef[] }>("GET", `/apps/${encodeURIComponent(app.slug)}/actions`);
            actions.set(id, r.actions);
          } catch {
            actions.set(id, []);
          }
        }),
    );
  }

  function drawList() {
    list.replaceChildren(
      agents.length === 0
        ? empty("No assistants yet. Set one up as Connect an assistant says above, and it appears here as This PC.")
        : h("ul", { class: "account-list" }, agents.map(card)),
    );
  }

  // ── The connection ─────────────────────────────────────────────────────

  async function setOn(next: boolean) {
    try {
      ({ settings: { agentAccess: on } } = await api<{ settings: Settings }>("PATCH", "/settings", { agentAccess: next }));
      toast(on ? "AI assistants can connect" : "AI assistants are cut off");
    } catch (err) {
      toast((err as Error).message, "down");
    }
    drawStrip();
    drawList();
  }

  // Where it stands, in one line: off, can't start, talking now, or waiting.
  function headline(m: McpStatus): { lamp: LampState; text: Node | string } {
    if (!on) return { lamp: "none", text: "Off: no assistant can see anything." };
    if (!m.installed || !m.node?.ok) return { lamp: "down", text: "On, but assistants can't start the MCP server: see below." };
    const last = m.lastRequest;
    if (!last) return { lamp: "attention", text: "On. No assistant has connected yet." };
    const who = last.client ?? last.agentName;
    return isActive(last.at)
      ? { lamp: "up", text: h("span", null, h("strong", null, who), " is connected", timeAgo(last.at, " · last request ")) }
      : { lamp: "info", text: h("span", null, "On. Last request from ", h("strong", null, who), timeAgo(last.at, ", ")) };
  }

  const nodeLink = () => h("a", { href: "https://nodejs.org", target: "_blank", rel: "noopener noreferrer" }, "nodejs.org");

  function drawStrip() {
    if (!mcp) return;
    const m = mcp;
    const top = headline(m);
    const fact = (label: string, ...value: unknown[]) => h("div", { class: "fact" }, h("dt", null, label), h("dd", null, ...(value as Node[])));
    const ok = (text: string) => h("span", { class: "key-line" }, lamp("up"), text);
    const bad = (...text: unknown[]) => h("span", { class: "key-line" }, lamp("down"), ...(text as Node[]));
    mount(
      strip,
      h("p", { class: "key-line connection-line" }, lamp(top.lamp), top.text),
      toggleRow(
        "agentAccess",
        "Let AI assistants use Periskopos",
        "Claude, Cursor, VS Code or any tool that speaks MCP can read your apps and ask to run their actions, as each assistant's limits below allow. While off, none can see anything, and whatever they're waiting on is withdrawn. The tray's Cut off AI assistants turns this off at once.",
        on,
        (next) => void setOn(next),
      ),
      h(
        "dl",
        { class: "account-facts connection-facts" },
        fact("MCP server", m.installed ? ok("In this install") : bad("Missing from this install: update Periskopos (tray → Check for updates).")),
        fact(
          "Node.js",
          m.node?.ok
            ? ok(`${m.node.version}, which assistants start it with`)
            : m.node
            ? bad(`${m.node.version} is too old: the MCP server needs Node.js 24 or later, from `, nodeLink(), ".")
            : bad("Not found: install Node.js 24 or later from ", nodeLink(), ", then restart the assistant."),
        ),
        m.thisPcOff &&
          fact(
            "This PC",
            h(
              "div",
              { class: "fact-line" },
              h("span", { class: "secondary" }, "Turned off: setups without a token are refused."),
              busyButton("Turn back on", "Turning on…", async () => {
                await api("POST", "/agents/this-pc");
                toast("This PC can connect again");
                await load();
              }, "btn btn--sm fact-action"),
            ),
          ),
      ),
      h(
        "details",
        { class: "provider-details connect-steps", ...(m.lastRequest ? {} : { open: "" }) },
        h("summary", null, "Connect an assistant"),
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "meta" }, "No token needed: set up like this, an assistant connects as This PC, with the limits you give This PC below."),
          codeBlock("Claude Code: run this once", m.setup.claudeCode, copyButton(m.setup.claudeCode)),
          h("p", { class: "meta" }, "Then ", h("code", null, "/mcp"), " in Claude Code lists periskopos as connected, and the line above says so."),
          codeBlock("Claude desktop, Cursor, VS Code and others: in their MCP settings", m.setup.json, copyButton(m.setup.json)),
          h("p", { class: "meta" }, "For the Claude desktop app, that's ", h("code", null, m.setup.claudeDesktop), " (Settings → Developer → Edit config). Restart Claude, and Periskopos is in its tools menu."),
        ),
      ),
    );
  }

  // While the tab is open, the line keeps up with who's talking. Only the
  // line: a card being edited isn't redrawn under you.
  const poll = setInterval(async () => {
    if (!strip.isConnected) return clearInterval(poll);
    try {
      ({ mcp } = await api<{ mcp: McpStatus }>("GET", "/agents"));
      drawStrip();
    } catch {
      // the next one will try again
    }
  }, 15_000);

  // ── An assistant ───────────────────────────────────────────────────────

  function card(a: AgentView) {
    const slot = h("div");
    const rules = Object.entries(a.rules);
    const allowed = rules.filter(([, r]) => r === "allow").length;
    const never = rules.filter(([, r]) => r === "never").length;
    const fact = (label: string, ...value: unknown[]) => h("div", { class: "fact" }, h("dt", null, label), h("dd", null, ...(value as Node[])));
    return h(
      "li",
      { class: "account-card", "aria-labelledby": `agent-${a.id}` },
      h(
        "div",
        { class: "account-head" },
        h("span", { class: "service-mark", "aria-hidden": "true" }, a.name.slice(0, 2).toUpperCase()),
        h(
          "div",
          { class: "account-title" },
          h("h3", { class: "account-name", id: `agent-${a.id}` }, a.name),
          h("span", { class: "meta" }, `Added ${new Date(a.createdAt).toLocaleDateString()}`, a.lastUsedAt ? timeAgo(a.lastUsedAt, " · last used ") : " · not used yet"),
        ),
        h(
          "div",
          { class: "account-pills" },
          on && isActive(a.lastUsedAt) && h("span", { class: "health-pill health-pill--up" }, lamp("up"), "Active now"),
          h("span", { class: `health-pill health-pill--${ACCESS[a.access].lamp}` }, lamp(ACCESS[a.access].lamp), ACCESS[a.access].text),
        ),
      ),
      h(
        "dl",
        { class: "account-facts" },
        a.legacy && fact("Token", h("span", { class: "secondary" }, "None needed: every assistant set up without a token connects as This PC.")),
        fact("Apps", a.apps === "all" ? h("span", { class: "secondary" }, "All apps") : h("div", { class: "chips" }, a.apps.map((id) => h("span", { class: "chip chip--static" }, appName(id))))),
        a.access === "ask" &&
          fact(
            "Actions",
            h("span", { class: "secondary" }, allowed || never ? [allowed && `${allowed} allowed without asking`, never && `${never} never`, "the rest ask you"].filter(Boolean).join(" · ") : "Every action asks you first"),
          ),
        a.grants.length > 0 &&
          fact(
            "For now",
            h(
              "ul",
              { class: "event-list" },
              a.grants.map((g) =>
                h(
                  "li",
                  { class: "fact-line" },
                  h("span", { class: "secondary" }, `${actionLabel(g.appId, g.actionId)} on ${appName(g.appId)}, without asking until ${clock(g.until)}`),
                  busyButton("End now", "Ending…", async () => {
                    await api("DELETE", `/agents/${a.id}/grants?appId=${encodeURIComponent(g.appId)}&actionId=${encodeURIComponent(g.actionId)}`);
                    toast("Back to asking");
                    await load();
                  }, "btn btn--sm btn--ghost fact-action"),
                ),
              ),
            ),
          ),
      ),
      slot,
      h(
        "div",
        { class: "account-foot" },
        h("button", { type: "button", class: "btn btn--sm", onclick: () => void edit(a, slot) }, "Edit"),
        h("button", { type: "button", class: "btn btn--sm btn--danger account-remove", onclick: () => void revoke(a) }, a.legacy ? "Turn off" : "Revoke"),
      ),
    );
  }

  async function revoke(a: AgentView) {
    const question = a.legacy
      ? `Turn off ${a.name}? Every assistant set up without a token is refused from now on, and anything it's waiting on is withdrawn. You can turn it back on.`
      : `Revoke ${a.name}? Its token stops working now, and anything it's waiting on is withdrawn.`;
    if (!confirm(question)) return;
    try {
      await api("DELETE", `/agents/${a.id}`);
      toast(a.legacy ? `${a.name} turned off` : `${a.name} revoked`);
      await load();
    } catch (err) {
      toast((err as Error).message, "down");
    }
  }

  // What it may see and do, and a rule for each action of those apps.
  async function edit(a: AgentView, slot: HTMLElement) {
    slot.replaceChildren(h("div", { class: "inline-panel" }, h("p", { class: "meta" }, "Loading its apps' actions…")));
    const scope = a.apps === "all" ? apps.map((x) => x.id) : a.apps;
    await actionsFor(scope);
    const errors = h("div");
    const form = submitting(
      h(
        "form",
        { class: "form" },
        field("Name", h("input", { name: "name", value: a.name, maxlength: 40, required: true })),
        accessField(a.access),
        appsField(a.apps),
        a.access === "ask" && rulesField(a, scope),
        errors,
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn btn--ghost", onclick: () => slot.replaceChildren() }, "Cancel"), h("button", { type: "submit", class: "btn btn--primary" }, "Save")),
      ),
      errors,
      async (data) => {
        const rules: Record<string, AgentRule> = {};
        for (const [key, value] of data.entries()) if (key.startsWith("rule:")) rules[key.slice(5)] = value as AgentRule;
        await api("PATCH", `/agents/${a.id}`, { name: data.get("name"), access: data.get("access"), apps: appsFrom(data), rules });
        toast(`${String(data.get("name"))} saved`);
        await load();
      },
      "Saving…",
    );
    slot.replaceChildren(h("div", { class: "inline-panel" }, form));
  }

  function accessField(current: AgentAccess) {
    return field(
      "What it may do",
      h(
        "select",
        { name: "access" },
        h("option", { value: "read", ...(current === "read" ? { selected: "" } : {}) }, "Only read: apps, checks, deploys, traffic"),
        h("option", { value: "ask", ...(current === "ask" ? { selected: "" } : {}) }, "Read, and ask to run actions (each one as its rules say)"),
      ),
    );
  }

  function appsField(current: "all" | string[]) {
    const some = h(
      "div",
      { class: "stack-sm app-picks" },
      apps.map((x) =>
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "app", value: x.id, ...(current !== "all" && current.includes(x.id) ? { checked: "" } : {}) }), " ", x.name),
      ),
    );
    const select = h(
      "select",
      { name: "appsMode", onchange: () => (some.hidden = select.value === "all") },
      h("option", { value: "all", ...(current === "all" ? { selected: "" } : {}) }, "All apps, and any added later"),
      h("option", { value: "some", ...(current !== "all" ? { selected: "" } : {}) }, "Only the apps ticked below"),
    ) as HTMLSelectElement;
    some.hidden = current === "all";
    return h("div", { class: "stack-sm" }, field("Which apps it sees", select, "An app it can't see doesn't exist as far as it can tell."), some);
  }

  const appsFrom = (data: FormData): "all" | string[] => (data.get("appsMode") === "all" ? "all" : data.getAll("app").map(String));

  function rulesField(a: AgentView, scope: string[]) {
    const rows = scope.flatMap((appId) =>
      (actions.get(appId) ?? []).map((def) => {
        const key = `${appId}:${def.id}`;
        const current = a.rules[key] ?? "ask";
        return h(
          "li",
          { class: "fact-line rule-row" },
          h("span", { class: "secondary" }, `${def.label} on ${appName(appId)}`, def.danger ? h("span", { class: "tag" }, "danger: always on screen") : null),
          h(
            "select",
            { name: `rule:${key}`, "aria-label": `${def.label} on ${appName(appId)}` },
            (["ask", "allow", "never"] as AgentRule[])
              .filter((r) => !(r === "allow" && def.danger))
              .map((r) => h("option", { value: r, ...(r === current ? { selected: "" } : {}) }, RULE[r])),
          ),
        );
      }),
    );
    return h(
      "div",
      { class: "stack-sm" },
      h("span", { class: "label" }, "When it asks for an action"),
      rows.length ? h("ul", { class: "event-list" }, rows) : h("p", { class: "meta" }, "Its apps have no actions yet."),
    );
  }

  // ── Adding one ─────────────────────────────────────────────────────────

  function add() {
    const errors = h("div");
    const form = submitting(
      h(
        "form",
        { class: "form" },
        field("Name", h("input", { name: "name", maxlength: 40, required: true, placeholder: "Claude Code on my laptop" }), "Shown in approvals and the activity log."),
        accessField("ask"),
        appsField("all"),
        errors,
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn btn--ghost", onclick: () => panel.replaceChildren() }, "Cancel"), h("button", { type: "submit", class: "btn btn--primary" }, "Add assistant")),
      ),
      errors,
      async (data) => {
        const r = await api<{ agent: AgentView; token: string; setup: Setup }>("POST", "/agents", { name: data.get("name"), access: data.get("access"), apps: appsFrom(data) });
        panel.replaceChildren(created(r.agent, r.setup));
        await load();
      },
      "Adding…",
    );
    panel.replaceChildren(h("div", { class: "inline-panel" }, form));
    form.querySelector<HTMLInputElement>("input[name=name]")?.focus();
  }

  // Its token, once: as a command for Claude Code, and as JSON for others.
  function created(a: AgentView, setup: Setup) {
    return h(
      "div",
      { class: "inline-panel stack-sm" },
      h("div", { class: "notice notice--attention", role: "status" }, lamp("attention"), h("div", null, h("strong", null, `${a.name} is added. Copy its setup now: the token isn't shown again.`), h("p", { class: "meta" }, "Lost it? Revoke the assistant and add it again."))),
      codeBlock("Claude Code: run this once", setup.claudeCode, copyButton(setup.claudeCode)),
      codeBlock("Cursor, VS Code and others: their MCP settings", setup.json, copyButton(setup.json)),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => panel.replaceChildren() }, "Done")),
    );
  }

  // ── The audit log ──────────────────────────────────────────────────────

  function drawLog(entries: AgentAuditEntry[]) {
    const select = h(
      "select",
      { "aria-label": "Show the activity of", onchange: () => {
        filter = select.value;
        void loadLog();
      } },
      h("option", { value: "" }, "Every assistant"),
      agents.map((a) => h("option", { value: a.id, ...(a.id === filter ? { selected: "" } : {}) }, a.name)),
    ) as HTMLSelectElement;
    const exportAs = (format: "csv" | "json") =>
      busyButton(format.toUpperCase(), "…", async () => {
        const r = await fetch(`/api/agents/audit?format=${format}${filter ? `&agent=${encodeURIComponent(filter)}` : ""}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`The export failed (HTTP ${r.status})`);
        const url = URL.createObjectURL(await r.blob());
        const link = h("a", { href: url, download: `periskopos-assistants.${format}` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "btn btn--sm");
    log.replaceChildren(
      h("div", { class: "fact-line audit-tools" }, select, h("div", { class: "actions" }, h("span", { class: "meta" }, "Export"), exportAs("csv"), exportAs("json"))),
      entries.length === 0
        ? empty("Nothing yet. Every request an assistant makes is listed here, kept 90 days.")
        : h(
            "ul",
            { class: "event-list audit-list" },
            entries.map((e) =>
              h(
                "li",
                { class: "event-row audit-row" },
                h("span", { class: "event-date" }, h("span", null, clock(e.at)), h("span", { class: "meta" }, new Date(e.at).toLocaleDateString())),
                h(
                  "span",
                  { class: "event-main" },
                  h("span", { class: "secondary" }, h("strong", null, e.agentName), e.client && e.client !== e.agentName ? h("span", { class: "meta" }, ` (${e.client})`) : null),
                  h("span", { class: "meta mono truncate" }, `${e.method} ${e.path.replace(/^\/api/, "")}`),
                  e.detail && h("span", { class: "meta" }, e.detail),
                ),
                h("span", { class: `tag tag--${OUTCOME_TONE[e.outcome] ?? "none"}` }, e.outcome),
              ),
            ),
          ),
    );
  }

  void load();

  return [
    section("Connection", { body: [strip] }),
    section("Assistants", {
      action: h("button", { type: "button", class: "btn btn--sm", onclick: add }, "Add one with its own token"),
      body: [
        h("p", { class: "secondary" }, "What each may see, whether it may ask for actions, and a rule for each action. This PC covers every setup without a token; add one with its own token only when a tool needs different limits from the rest."),
        panel,
        list,
      ],
    }),
    section("Activity", { body: [h("p", { class: "secondary" }, "Every request an assistant made, and what came of it."), log] }),
  ];
}
