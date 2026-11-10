import type {
  ActionDef,
  ActivityEntry,
  App,
  AppPause,
  ConfigReport,
  AppHistory,
  AppStatus,
  ProtocolView,
  ProviderStatus,
  ServiceView,
  Suggestion,
} from "../../../../shared/types.ts";
import type { ActionOutcome, ActionsList } from "../actionsParts.ts";
import type { ProtocolState } from "../protocolParts.ts";
import type { Details } from "./details.ts";
import type { SearchRange } from "./search.ts";
import type { TrafficRange } from "./traffic.ts";

export type AppTab = "overview" | "deploys" | "traffic" | "config" | "actions" | "history" | "settings";
export const APP_TABS: readonly AppTab[] = ["overview", "deploys", "traffic", "config", "actions", "history", "settings"];

// The parts of an app's Settings, from its side menu.
export type SettingsPart = "general" | "connections" | "protocol";
export const SETTINGS_PARTS: readonly { key: SettingsPart; label: string }[] = [
  { key: "general", label: "General" },
  { key: "connections", label: "Connections" },
  { key: "protocol", label: "Protocol" },
];

// One app's page, as its tabs see it: what's been loaded so far (any of it
// may still be missing), what's been chosen on screen, and what a tab can
// ask the page to do. appPage.ts owns it; the tabs read it, change the
// on-screen choices, and call back.
export type AppPage = {
  readonly slug: string;
  readonly tab: AppTab;
  readonly settingsPart: SettingsPart;
  readonly base: string; // #/apps/<slug>
  readonly apiBase: string; // /apps/<slug>

  app?: App;
  status?: AppStatus;
  pause?: AppPause;
  // Bumped when a pause is set or ended here, so an answer that left before that can't undo it.
  pauseEdits: number;
  hist?: AppHistory;
  services: ServiceView[];
  // What each connection shows of itself (deploys, commits, traffic, search), by
  // connection id.
  details: Details;
  providers: ProviderStatus[];
  protocol?: ProtocolView;
  // The freshly generated endpoint code and secret live only here, in this
  // page's memory, until the connection is tested or the page is left.
  protocolState: ProtocolState;
  actions?: ActionsList;
  activity: ActivityEntry[];
  suggestions?: Suggestion[];
  // The configuration checks' findings (the Configuration tab).
  config?: ConfigReport | Error;

  // Chosen on screen.
  outcome?: ActionOutcome; // what the last action did, until dismissed
  trafficRange: TrafficRange;
  searchRange: SearchRange;
  gapsOpen: boolean;

  draw(): void;
  drawPause(): void; // the pause banner, drawn even while a form is being edited
  // After a form is sent: stop holding redraws back, and load again.
  afterSubmit(): Promise<boolean>;
  openAction(action: ActionDef): void;
  connectSuggested(s: Suggestion): Promise<void>;
  gone(): void; // the app was deleted
};
