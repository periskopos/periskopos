import { CONNECTIONS } from "../../../../shared/catalog.ts";
import type { App, ConnectionDetails, DetailsLink } from "../../../../shared/types.ts";
import { empty, ext } from "../../ui.ts";
import { detailsError } from "./details.ts";
import type { AppPage } from "./page.ts";

// What an app's connections show (deploys, commits, traffic…): the first
// connection showing each shape and what it showed (an Error when it couldn't
// be read; nothing yet while loading), or undefined when none shows it.
export type Shown<S extends ConnectionDetails["shape"]> = { d: Extract<ConnectionDetails, { shape: S }> | Error | undefined };

export function shapesOf(page: AppPage, a: App) {
  const showing = <S extends ConnectionDetails["shape"]>(shape: S): Shown<S> | undefined => {
    const conn = a.connections.find((c) => CONNECTIONS[c.type]?.shows === shape);
    const d = conn && page.details.get(conn.id);
    return conn ? { d: d instanceof Error ? d : d?.shape === shape ? (d as Extract<ConnectionDetails, { shape: S }>) : undefined } : undefined;
  };
  return {
    deploys: showing("deploys"),
    commits: showing("commits"),
    traffic: showing("traffic"),
    search: showing("search"),
    errors: showing("errors"),
    payments: showing("payments"),
    logs: showing("logs"),
  };
}

// A panel's list: what it showed, why it couldn't, or that it's loading.
export const listOf = <D>(x: { d: D | Error | undefined }, list: (d: D) => Node) => (x.d instanceof Error ? detailsError(x.d) : x.d ? list(x.d) : empty("Loading…"));

// The provider's own "All in …" link, once there is one.
export const linkOf = (x: { d: { link?: DetailsLink } | Error | undefined }) => (x.d && !(x.d instanceof Error) && x.d.link ? ext(x.d.link.url, x.d.link.label) : undefined);
