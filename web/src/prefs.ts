// What this computer remembers about how the page looks, in the browser's own
// storage. It can be refused, so each read has a fallback and nothing depends on it.

export type ClockPref = "system" | "12" | "24";
export type StartPage = "#/" | "#/status" | "#/services" | "#/world";

const CLOCK_KEY = "periskopos-clock";
const START_KEY = "periskopos-start-page";
const STARTED_KEY = "periskopos-started"; // for this window's session

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered: it still applies until the page is reloaded
  }
};

export const START_PAGES: { value: StartPage; label: string }[] = [
  { value: "#/", label: "Apps" },
  { value: "#/status", label: "Status" },
  { value: "#/services", label: "Accounts" },
  { value: "#/world", label: "World" },
];

export function clockPref(): ClockPref {
  const saved = read(CLOCK_KEY);
  return saved === "12" || saved === "24" ? saved : "system";
}
export const saveClockPref = (pref: ClockPref) => write(CLOCK_KEY, pref);

// For a time formatter: the clock asked for, or the system's.
export function hourStyle(): { hourCycle?: "h12" | "h23" } {
  const pref = clockPref();
  return pref === "12" ? { hourCycle: "h12" } : pref === "24" ? { hourCycle: "h23" } : {};
}

export function startPage(): StartPage {
  const saved = read(START_KEY);
  return START_PAGES.find((p) => p.value === saved)?.value ?? "#/";
}
export const saveStartPage = (page: StartPage) => write(START_KEY, page);

// Once a window's session, and only if nothing asked for a page: a reload, or a
// link from a notification, stays where it is.
export function goToStartPage() {
  try {
    if (sessionStorage.getItem(STARTED_KEY)) return;
    sessionStorage.setItem(STARTED_KEY, "1");
  } catch {
    return;
  }
  const page = startPage();
  if (page !== "#/" && (location.hash === "" || location.hash === "#/")) location.hash = page;
}
