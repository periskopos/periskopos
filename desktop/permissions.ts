import type { Session } from "electron";
import { isAppPage } from "./external-links.ts";

// Electron grants most permission requests by default. Periskopos's page
// needs only one: writing to the clipboard, for its Copy buttons (a secret
// or a command to paste elsewhere). Its notifications come from the app, not
// the page. Everything else is refused, and so is the clipboard for anything
// but the app's own page.
export function allowPermission(permission: string, url: string, appOrigin: string): boolean {
  return permission === "clipboard-sanitized-write" && isAppPage(url, appOrigin);
}

export function lockDownPermissions(session: Session, appOrigin: string): void {
  session.setPermissionRequestHandler((contents, permission, callback) => callback(allowPermission(permission, contents.getURL(), appOrigin)));
  session.setPermissionCheckHandler((contents, permission) => allowPermission(permission, contents?.getURL() ?? "", appOrigin));
}
