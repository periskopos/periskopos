# Changelog

Each release's notes, generated from its commits, are on
[GitHub Releases](https://github.com/periskopos/periskopos/releases). This
file records the larger steps.

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
