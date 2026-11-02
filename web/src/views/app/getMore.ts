import { CONNECTIONS, connectionLabel } from "../../../../shared/catalog.ts";
import type { Suggestion, SuggestionKind } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { busyButton, section } from "../../ui.ts";

// "Get more from this app": what each kind of connection adds, and what
// it's called in its account.
const offerOf = (kind: SuggestionKind) => CONNECTIONS[kind]?.offer ?? { gives: connectionLabel({ type: kind }), noun: "one" };

// Several things named like the app (the periskopos and periskopos.com
// repos): a list to pick from, the likeliest first, and Connect.
function choose(s: Suggestion, connect: (s: Suggestion) => Promise<void>) {
  const choices = s.choices ?? [];
  const pick = h(
    "select",
    { "aria-label": `Which ${offerOf(s.kind).noun} from ${s.serviceName}` },
    choices.map((c, i) => h("option", { value: String(i) }, c.label)),
  );
  return h(
    "div",
    { class: "item-end item-end--choose" },
    pick,
    busyButton("Connect", "Connecting…", () => connect({ ...s, match: choices[Number(pick.value)] }), "btn btn--sm btn--primary"),
  );
}

// One line per thing an account could add: one click when the match is
// plain, a short list when a few are named like the app, otherwise a way to
// choose in Settings. Nothing at all when the app already has everything
// its accounts offer.
export function getMoreSection(list: Suggestion[] | undefined, settingsHref: string, connect: (s: Suggestion) => Promise<void>) {
  if (!list?.length) return null;
  return section("Get more from this app", {
    list: h(
      "ul",
      { class: "list" },
      list.map((s) =>
        h(
          "li",
          { class: "item" },
          h("span", { class: "service-mark", "aria-hidden": "true" }, h("span", { class: `service-logo service-logo--${s.serviceType}` })),
          h(
            "div",
            { class: "item-main" },
            h("span", { class: "item-title" }, offerOf(s.kind).gives),
            h(
              "span",
              { class: "meta" },
              s.match
                ? `Connect ${s.match.label} from ${s.serviceName}`
                : s.choices?.length
                  ? `From ${s.serviceName}: ${s.choices.length} are named like this app, choose which`
                  : `From ${s.serviceName}: choose which ${offerOf(s.kind).noun} in Settings`,
            ),
          ),
          s.choices?.length && !s.match ? choose(s, connect) : h(
            "div",
            { class: "item-end" },
            s.match
              ? busyButton("Connect", "Connecting…", () => connect(s), "btn btn--sm btn--primary")
              : h("a", { class: "btn btn--sm", href: settingsHref }, "Choose…"),
          ),
        ),
      ),
    ),
  });
}
