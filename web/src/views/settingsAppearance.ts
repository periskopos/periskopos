import type { ShellPrefs } from "../../../shared/desktop.ts";
import { h } from "../dom.ts";
import { clockPref, saveClockPref, saveStartPage, startPage, START_PAGES } from "../prefs.ts";
import type { ClockPref, StartPage } from "../prefs.ts";
import { inputRow, segmented, settingRow } from "../settingRows.ts";
import { section, toast } from "../ui.ts";
import { savedSky, saveSky } from "./world/saved.ts";
import type { Sky } from "./world/scene/types.ts";

// Settings → Appearance. The theme is the app's, so it needs the app: a browser
// tab follows the system, since a page can't change that. The rest is this
// computer's, kept in the browser's storage.

export function appearanceSections(prefs: ShellPrefs | null, setPrefs: (next: ShellPrefs) => void, redraw: () => void) {
  const theme = prefs
    ? settingRow(
        "Theme",
        "System follows your computer's light or dark setting.",
        segmented<ShellPrefs["theme"]>(
          "theme",
          "Theme",
          [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          prefs.theme,
          (value) => setPrefs({ ...prefs, theme: value }),
        ),
      )
    : settingRow("Theme", "In a browser tab the theme follows your system. The Periskopos app lets you choose.");

  const clock = settingRow(
    "Times",
    "How times are written across the app. System follows your computer.",
    segmented<ClockPref>(
      "clock",
      "Times",
      [
        { value: "system", label: "System" },
        { value: "12", label: "12-hour" },
        { value: "24", label: "24-hour" },
      ],
      clockPref(),
      (value) => {
        saveClockPref(value);
        toast("Saved");
        redraw();
      },
    ),
  );

  const start = inputRow(
    "Open on",
    "The page Periskopos opens on. A link from a notification still goes where it points.",
    h(
      "select",
      {
        name: "startPage",
        onchange: (e: Event) => {
          saveStartPage((e.target as HTMLSelectElement).value as StartPage);
          toast("Saved");
        },
      },
      START_PAGES.map((o) => h("option", { value: o.value, selected: o.value === startPage() }, o.label)),
    ),
  );

  const sky = settingRow(
    "World's sky",
    "What its day and night follow. Also behind the gear on the World itself.",
    segmented<Sky>(
      "sky",
      "World's sky",
      [
        { value: "clock", label: "Your clock" },
        { value: "theme", label: "Your theme" },
      ],
      savedSky(),
      (value) => {
        saveSky(value);
        toast("Saved");
      },
    ),
  );

  return [section("Display", { body: [theme, clock, start, sky] })];
}
