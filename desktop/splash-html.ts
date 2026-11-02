import { DARK_CHROME_COLORS } from "./shell-chrome.ts";
import type { ChromeColors } from "./shell-chrome.ts";

// Markup for the startup splash, free of any electron import so it can be
// checked in a plain test. It takes the remembered colours (shell-chrome.ts)
// so the first thing shown is the app the user actually uses; only three
// colours are carried and the greys between them are derived with color-mix.

// The brand mark (the fleet tiles and lamp of the in-app mark and of
// icon.svg), inline because the splash loads from a data: URL with no
// network or file access. The lamp is the status green in either theme.
const mark = (foreground: string) =>
  `<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true">
      <rect x="11" y="11" width="19" height="19" rx="4.5" fill="${foreground}" fill-opacity=".6"/>
      <circle cx="43.5" cy="20.5" r="9.1" fill="#3fb950"/>
      <rect x="11" y="34" width="19" height="19" rx="4.5" fill="${foreground}" fill-opacity=".6"/>
      <rect x="34" y="34" width="19" height="19" rx="4.5" fill="${foreground}"/>
    </svg>`;

export function splashHtml(colors: ChromeColors = DARK_CHROME_COLORS): string {
  const { background, foreground, accent } = colors;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Starting Periskopos</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    -webkit-app-region: drag;
    display: flex; flex-direction: column; gap: 18px;
    align-items: center; justify-content: center;
    background: ${background}; color: ${foreground};
    font: 400 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    user-select: none;
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: .01em; }
  #status { margin: 0; min-height: 1.5em;
            color: color-mix(in srgb, ${foreground} 62%, ${background}); }
  .track { width: 220px; height: 3px; border-radius: 2px; overflow: hidden;
           background: color-mix(in srgb, ${foreground} 18%, ${background}); }
  .track > i { display: block; width: 40%; height: 100%; border-radius: 2px;
               background: ${accent};
               animation: slide 1.35s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(320%); } }
  @media (prefers-reduced-motion: reduce) { .track > i { animation: none; width: 100%; opacity: .5; } }
</style>
</head>
<body>
  <div class="brand">${mark(foreground)}<h1>Periskopos</h1></div>
  <div class="track"><i></i></div>
  <p id="status">Starting&#8230;</p>
</body>
</html>`;
}
