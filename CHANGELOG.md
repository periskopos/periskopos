# Changelog

Each release's notes, generated from its commits, are on
[GitHub Releases](https://github.com/periskopos/periskopos/releases). This
file records the larger steps.

## Next release

- **The World:** a second way to see the Apps page, as your own Silicon Valley, drawn from
  your real data. A highway comes in from the side and becomes a curving main road, with a
  campus for each app in front of it, the services they rely on behind them on higher ground,
  and the watcher's dish on a hill behind those. Adding an app never moves a service.
  Everything in it is a fact from the same data as the Apps page: a floor for each thing
  watched, fog for what isn't known, frost for no recent data, smoke when an app is down, a
  crane during a deploy. There is no decoration: nothing is drawn that says nothing. Open it from the Apps page, **See on map** on an app's page, or
  `periskopos://world`. It opens by coming down through cloud while the picture gets ready.
- **Signs and lights:** each building has a sign on its roof with the app's or service's logo,
  turning to face you, and a light on a short mast above it: green running, amber needs
  attention, red down, blue a service's maintenance. It's lit only while the state is known,
  and the screen behind the logo is tinted to match. A thin line between two buildings is a
  real dependency of that app on that service.
- **The key, and how to read the map:** **What am I looking at?** is a key grouped by Needs a
  look, Under way, Not known and Fine. What's on the map now is lit up, and clicking a status
  takes you to the next thing that has it. The full explanation opens from **?**.
- **Since you last looked:** opening the World says what went wrong while you were away, what
  recovered and which apps were added, each a click away. Only what's on the record: deploys
  aren't kept, so they aren't counted.
- **A valley that grows:** a new app's campus comes up floor by floor, one that's watching
  more or getting more traffic visibly grows, and the valley floor widens at a new stage:
  small up to 3 apps, wider from 4, widest from 10. What changed while you were away
  plays when you come back.
- **Everything on the road is real, and you can click it:** a van is one check the watcher
  really made, in the colour of its result. A truck is a deploy under way, or stopped at the
  door when a push isn't live. Cars are a share of an app's real requests where its
  Cloudflare domain is connected, which also sets how wide its building is and how full the
  car park.
- **The watcher:** a radio dish on its own hill turns only while your apps are being checked.
  Clicking it opens a radar of everything on the map and the log of its latest checks.
- **Figures:** Running, Deploying (only while something is), Requests, Lowest uptime with the
  app it belongs to, and Last check run across the top, and each opens what it's about. When
  all is well they step back to one quiet line. The title says "All systems normal" only when
  the services your apps rely on are fine too, here and on the Apps page.
- **Moving round:** drag, turn and zoom, smoothly and by how far you scroll, on a mouse or a
  trackpad. **Tour** goes round every campus, whatever most needs looking at first. The map's
  one setting, its sky (by your clock or your theme), is behind a gear.
- **What changed:** an app that changes state sends out rings and its label pulses, and a
  Recent changes card says what happened and when.
- **Replay:** a slider shows how every app stood at any moment of the last 24 hours, from the
  incident record, greyed and with nothing on the road, so it can't pass for now.
- **Works by keyboard, and goes easy on the machine:** arrow keys, zoom, turn and Tab all
  work, and the key reaches screen readers. It draws less when another window has the focus
  and stops when it can't be seen. The 3D code loads only when the page is opened. On a
  machine that can't keep up it lowers its own detail. The guided tour stops at the World
  button on the Apps page.
- **Uptime strips:** every live app on the Apps page shows its last 30 days, one small bar a
  day, in the list and on cards. Hover a day for its uptime and outages, click to open the
  app's history. A day nothing was watching stays blank, not green.
- **Apps list:** every column now starts under its heading and keeps its place, a long name or
  message is cut short rather than pushing the page sideways, and the state shows once instead
  of twice. On a wide window the spare room goes to the uptime strip.
- **Charts:** Traffic and Search now share one chart: a line with a real axis and gridlines, a
  crosshair and a proper tooltip on hover, and a switch between measures (requests or
  visitors, clicks or impressions). The period still counting is dashed, so a part-filled hour
  doesn't look like a drop, and days when 5% or more of requests failed are marked. Search
  also gets the table of numbers.
- **Choosing your alerts:** under **Notify me**, each kind of alert has its own switch.
  **Pause alerts** quiets all of them, or one app's from its own page, for 1 hour, 4 hours or
  until 8 am, and when the pause ends one message says what you missed.
- **Settings in full:** six tabs (General, Appearance, Notifications, AI assistants, Data,
  About), one row per setting, with switches for what saves at once. New: your name, the
  interval for new apps (and for all of them), what closing the window does, the page it
  opens on, 12- or 24-hour times, how long history is kept, and restoring the defaults.
  `periskopos://settings/...` links reach every tab.
- **Export and import a setup:** **Export my setup** saves your apps, checks, accounts' names
  and settings as a file, without keys or history. **Import** says what it would do before it
  does anything, only adds, and connects what was waiting once you've added the accounts.
- **Report an issue:** a bug button in the title bar copies the diagnostics, now including how
  the World has run on this computer, and opens the bug form. Nothing is sent by itself.
- **Smaller things:** dropdowns are drawn in the app's own colours with a tick on the current
  choice. Every disclosure toggle is at least 24px tall. Long paths and figures no longer
  push pages sideways on a narrow window.
- **Safer settings, import and alerts:** an exported setup no longer carries where your alerts go
  (addresses, chat id) or a pause, only the settings an import takes back. An import is all or
  nothing, and a file over 6 MB is refused. A damaged row in the settings can't stop the checks
  any more. "Checks stopped" is dropped during a pause instead of arriving days late. An
  assistant limited to some apps no longer sees the pauses of the others, and a link with a
  broken encoding no longer shows the "unreachable" page.

## 0.4.1 (2026-11-05)

- **A failed Dependabot job isn't failing CI:** when Dependabot can't make an
  update, the app no longer shows "CI failing". Real CI failures and other jobs
  GitHub runs, like a Pages deployment, still count.

## 0.4.0 (2026-11-03)

- **No recent data:** an app that looked up when last checked, but whose check
  is now two rounds late, says so instead of staying green, on the Apps page,
  the app's page, the tray and for AI assistants. "All systems normal" is only
  said on recent checks. The Checked column follows the check that says whether
  the app is up, not the newest check of any kind.
- **When the checks themselves stop:** Needs attention says when background
  checks are off or have stopped running, and checks that stop on their own
  send a notification, and another when they're back.
- **Checks that can't read:** a CI, deploy, payments or similar check that can't
  read for over an hour shows in Needs attention, instead of leaving "All
  normal" standing over a problem nobody can see.
- **Alerts that don't arrive:** a phone alert is retried, and one that couldn't
  be delivered (or a desktop notification the system refused) shows in the bell
  until one gets through. Notifications switched off show there too, without
  adding to the bell's count.
- **What counts as up:** an answer from another host is said to be that, and a
  403 or 429 counts as "can't tell", not down. If it goes on for over an hour,
  Needs attention and a notification say so. This PC is only called offline when
  neither GitHub nor Cloudflare answers.
- **Honest numbers:** uptime runs from when the app was added and its site first
  checked, and leaves out stretches when the checks couldn't tell. A figure
  resting on under a week says so ("100% of 3 h"). An outage that spanned a
  sleeping PC reports the time watched, and says part wasn't.
- **The tray and the Apps page:** the tray is grey when an app's state isn't
  known, and says so when the server stops answering; the Apps headline does the
  same when it can't load. "Accounts and providers fine" only appears when they
  were really read. A used-up free plan needs attention. Apps with no checks are
  counted apart from "All normal".
- **AI assistants** get the same facts: what's wrong with the watching itself,
  how much time uptime rests on, and what couldn't be read.

## 0.3.8 (2026-11-02)

- Windows and Linux: the ☰ menu button sits after Reload, before Minimize.

## 0.3.7 (2026-11-02)

- Windows and Linux: the menu (File, Edit, View, Help) opens from a ☰ button
  in the window's top bar, or a tap of Alt. The frameless window had no menu
  bar, so Help → Report an issue and File → Show log couldn't be reached.

## 0.3.6 (2026-11-02)

- **No duplicate connections:** connecting something an app already has
  (the same repository, account or address) is refused with a message.
  Another set of a repository's folders still counts as its own.
- **A choice, not a guess:** when a few things in an account are named like
  the app (the periskopos and periskopos.com repositories), Get more from
  this app lists them to choose from, the likeliest first. A name with a dot
  (periskopos.com) now matches too.
- An app whose domain ending has no expiry lookup (.co.il) stays up, not
  unknown, while its site answers.
- The missing-CAA finding names the authority behind the site's certificate
  today (pki.goog for Google Trust Services, …) instead of always Let's
  Encrypt.
- A domain's expiry date reads dd/mm/yyyy.
- Windows: the app finds a leftover Periskopos server holding its port even
  where Windows reports the listening socket in a wrong state.
- For contributors: the test suite was checked by breaking the code each
  test covers (about 60 tests now catch what they missed), the tests never
  touch your real keys file, and the server's keys, agents, alerts and
  audits code each have their own folder.

## 0.3.5 (2026-11-01)

- **Cloudflare zone checks:** the audit flags what quietly breaks a site
  behind Cloudflare: an unchecked origin certificate, plain HTTP, no HSTS,
  Rocket Loader, Bot Fight Mode or Web Analytics blocked by the site's own
  Content-Security-Policy, hidden email addresses, and Email Routing DNS.
- Checks run at most four at a time per provider, so a long list of apps
  stays under each provider's rate limit.
- The keys file is written all at once, so a crash mid-save can't leave it
  half-written.
- **The keys file is encrypted** by the installed app, with a key your
  system's store for secrets locks to you on this computer: a copy of the
  file shows no keys. A line added by hand at its end is encrypted with the
  rest.
- The app's id is now `com.periskopos.app`; an update still replaces the
  installed copy.
- Releases wait as drafts until published by hand.
- **Help → Report an issue** copies the diagnostics (redacted) and opens
  the bug form; crashes of the app and its window are logged with the
  server's, so the diagnostics show them.
- **macOS and Linux** are in every release: a disk image for Apple silicon
  and Intel, and an AppImage.

## 0.3.4 (2026-11-01)

- A guided tour after the first run walks the top bar (Apps, Status,
  Accounts, the bell, Settings), one stop at a time, by mouse or keyboard.

## 0.3.1 to 0.3.3 (2026-11-01)

- A new icon: four rounded tiles, the top-right one a status-green circle.
  The tray turns that tile amber or red when something needs a look.
- Dependency updates.

## 0.3.0 (2026-11-01)

- **Renamed from Ground Control to Periskopos** (periskopos.com), everywhere:
  the app, its folders and files (`%APPDATA%\Periskopos`, `periskopos.db`),
  environment variables (`PERISKOPOS_…`, were `GC_…`), the
  `periskopos://` links, the MCP server's name, and the generated protocol
  endpoint (`supabase/functions/periskopos`, `PERISKOPOS_SECRET`). Nothing
  carries over from a Ground Control install: install Periskopos fresh,
  copy your keys file across with its variables renamed, and add your
  assistants again.
- Prepared for open source: a README for newcomers, the reference material
  moved into [docs/](docs/) (user guide, providers and keys, AI assistants,
  releasing), a pull request template and Dependabot.

## 0.2.0 (2026-10-17) onwards

- The desktop app: its own window, tray, menu, start at login and updates
  from GitHub Releases.
- More providers: Vercel, Netlify, Fly.io, Railway, DigitalOcean, AWS
  Amplify, GitLab, Neon, MongoDB Atlas, Sentry, Stripe, Paddle, Resend,
  SendGrid, Google Search Console, Google Analytics, Clerk and OpenAI.
- Configuration checks, runtime error logs, traffic, payments, phone alerts,
  daily backups, and AI assistants with their own limits and approvals.

## Before 0.2.0 (October 2026)

The eight milestones of the original plan's build order:

1. **Skeleton:** first-run setup, adding apps, a status check per app, the
   Apps and app screens.
2. **Watcher:** checks on a timer, 30 days of history with uptime and
   incidents, honest "not watched" gaps, desktop notifications.
3. **Services and deploys:** GitHub and Render connected once; commits, CI,
   deploys, and whether the last push is live.
4. **Dependencies:** certificates, domain registrations, Supabase project
   health, providers' status pages.
5. **Claude:** an MCP server to read apps and, only when asked, redeploy.
6. **Protocol:** apps report their own numbers and offer their own buttons,
   from generated code.
7. **Actions panel:** confirmed actions on the app page, every run recorded.
8. **Second app:** a very different app alongside the first, which found and
   fixed four rough edges.
