import type { Connection, TopPage, ZoneVisitors } from "../../../shared/types.ts";
import type { ServiceAuth } from "../types.ts";
import { PERMISSION, SETUP_TTL_MS, cf, gql, refused, settingOf, zoneIdOf } from "./api.ts";
import type { CfRumSite } from "./api.ts";
import { DAYS_TTL_MS, DAY_MS, utcDate } from "./traffic.ts";

// Who visits, from Web Analytics (Cloudflare's RUM beacon): visits and page
// views by day, and the most viewed pages this week and month.

const HOW_TO_RUM =
  "In the Cloudflare dashboard: Analytics & Logs → Web Analytics → this site → turn on automatic setup. Visits show here from then on.";

export async function visitors(conn: Connection, auth: ServiceAuth, now = Date.now()): Promise<ZoneVisitors> {
  const account = settingOf(conn, "accountId");
  const dashboardUrl = account ? `https://dash.cloudflare.com/${account}/web-analytics` : undefined;
  const link = dashboardUrl ? { dashboardUrl } : {};
  if (!account)
    return {
      state: "unavailable",
      message: "This domain has no Cloudflare account id; connect it again from the list.",
    };
  let sites: CfRumSite[];
  try {
    sites = await cf<CfRumSite[]>(auth, `/accounts/${account}/rum/site_info/list?per_page=100`, SETUP_TTL_MS);
  } catch (err) {
    if (refused(err))
      return {
        state: "unavailable",
        message: `Web Analytics can't be read with this token. ${PERMISSION.rum}.`,
        ...link,
      };
    return {
      state: "unavailable",
      message: `Web Analytics couldn't be read: ${(err as Error).message}`,
      ...link,
    };
  }
  const zoneId = zoneIdOf(conn);
  const site = sites.find((s) => s.ruleset?.zone_tag === zoneId || s.ruleset?.zone_name === conn.resource);
  if (!site) {
    return {
      state: "none",
      message: `Web Analytics isn't set up for ${conn.resource}.`,
      howTo: HOW_TO_RUM,
      ...link,
    };
  }

  const dates = Array.from({ length: 30 }, (_, i) => utcDate(now - (29 - i) * DAY_MS));
  const since = (days: number) => `${utcDate(now - (days - 1) * DAY_MS)}T00:00:00Z`;
  type RumGroup = {
    count: number;
    sum?: { visits?: number };
    dimensions: { date?: string; requestPath?: string };
  };
  let data: {
    viewer: {
      accounts: { days: RumGroup[]; week: RumGroup[]; month: RumGroup[] }[];
    };
  };
  try {
    data = await gql(
      auth,
      `query($account: String!, $site: String!, $month: Time!, $week: Time!) { viewer { accounts(filter: { accountTag: $account }) {
        days: rumPageloadEventsAdaptiveGroups(limit: 40, filter: { siteTag: $site, datetime_geq: $month }, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
        week: rumPageloadEventsAdaptiveGroups(limit: 5, filter: { siteTag: $site, datetime_geq: $week }, orderBy: [count_DESC]) { count dimensions { requestPath } }
        month: rumPageloadEventsAdaptiveGroups(limit: 5, filter: { siteTag: $site, datetime_geq: $month }, orderBy: [count_DESC]) { count dimensions { requestPath } }
      } } }`,
      { account, site: site.site_tag, month: since(30), week: since(7) },
      DAYS_TTL_MS,
    );
  } catch (err) {
    if (refused(err))
      return {
        state: "unavailable",
        message: `Web Analytics can't be read with this token. ${PERMISSION.rum}.`,
        ...link,
      };
    return {
      state: "unavailable",
      message: `Web Analytics couldn't be read: ${(err as Error).message}`,
      ...link,
    };
  }
  const groups = data.viewer.accounts[0] ?? { days: [], week: [], month: [] };
  // Off, and nothing came in another way (a beacon added by hand): say how
  // to switch it on, rather than showing a row of zeros.
  if (site.ruleset?.enabled !== true && groups.days.length === 0) {
    return {
      state: "off",
      message: `Web Analytics is off for ${conn.resource}.`,
      howTo: HOW_TO_RUM,
      ...link,
    };
  }
  const byDate = new Map(groups.days.map((g) => [g.dimensions.date, g]));
  const pages = (list: RumGroup[]): TopPage[] =>
    list.map((g) => ({
      path: g.dimensions.requestPath ?? "/",
      views: g.count,
    }));
  return {
    state: "on",
    days: dates.map((date) => ({
      date,
      visits: byDate.get(date)?.sum?.visits ?? 0,
      pageViews: byDate.get(date)?.count ?? 0,
    })),
    topPages: { week: pages(groups.week), month: pages(groups.month) },
    ...link,
  };
}
