import { changesBetween, feedRows } from "../../../../shared/world.ts";
import type { World, WorldChange } from "../../../../shared/world.ts";
import type { NotificationsView } from "../../../../shared/types.ts";
import { h, mount } from "../../dom.ts";
import { lamp, timeAgo } from "../../ui.ts";
import type { Standing } from "./scene/types.ts";

// What's just happened: the Recent changes card, and how long a changed label stays lit.

const CHANGED_MS = 2 * 60_000;
const KEPT = 20;

export type FeedDeps = {
  card: HTMLElement;
  goTo(target: { kind: Standing; id: string }): void;
};

export function createFeed({ card, goTo }: FeedDeps) {
  const changedUntil = new Map<string, number>();
  let changes: WorldChange[] = [];
  let shown = "";

  return {
    changedUntil,
    note(before: World | undefined, after: World) {
      if (!before) return;
      const now = Date.now();
      const found = changesBetween(before, after, now);
      for (const change of found) changedUntil.set(change.key, now + CHANGED_MS);
      changes = [...found, ...changes].slice(0, KEPT);
    },
    // Nothing in a replay is recent, so it isn't given rows at all.
    draw(world: World | undefined, notifications: NotificationsView | undefined, replaying: boolean) {
      const rows = world && !replaying ? feedRows(changes, notifications, world.plots) : [];
      card.hidden = rows.length === 0;
      // Redrawn often, to keep its times right: read out only when there's something new.
      const key = rows.map((r) => r.id).join("|");
      card.setAttribute("aria-live", key === shown ? "off" : "polite");
      shown = key;
      mount(
        card,
        rows.length > 0 && h("h2", { class: "world-feed-title" }, "Recent changes"),
        rows.length > 0 &&
          h(
            "ul",
            { class: "world-feed-rows" },
            rows.map((row) => {
              const body = [lamp(row.state), h("span", { class: "world-feed-text" }, h("strong", null, row.name), " ", row.text), h("span", { class: "world-feed-when" }, timeAgo(new Date(row.at).toISOString()))];
              const target = row.target;
              // Named for itself, so focus stays on it when its time changes.
              return h("li", null, target ? h("button", { type: "button", name: row.id, class: "world-feed-row", onclick: () => goTo(target) }, body) : h("a", { name: row.id, class: "world-feed-row", href: row.href ?? "#/status" }, body));
            }),
          ),
      );
    },
  };
}
