# Releasing a new version

For maintainers. The version lives in one place, `package.json`; the tag,
the installers, the release, the changelog heading and the website all take
it from there.

First put the release's larger steps in `CHANGELOG.md` under
`## Next release`, then:

```bash
npm version minor
```

```bash
git push --follow-tags
```

`npm version` (or `patch` / `major`) raises the version in `package.json`,
renames `## Next release` to `## 0.2.0 (<today>)` (`scripts/changelog.ts`),
commits both and tags it `v0.2.0`. With no `## Next release` section it stops
before committing or tagging; undo its bump with
`git checkout package.json package-lock.json`. Pushing the tag runs the **Desktop build**
workflow: it makes a **draft** release, then tests and builds Windows,
macOS and Linux side by side, each adding its files to the draft. A
platform whose build fails leaves its files out: rerun that job, or publish
without it. (The Mac build's minutes count ten times against a private
repo's free Actions minutes.)

The draft is the approval step. Installed copies never see a draft, so open
it under [Releases](https://github.com/periskopos/periskopos/releases),
check the files and the notes (download and run the installer if the
change is risky), then click **Publish release**. Within 6 hours every
installed copy has it. A wrong tag is undone by deleting the draft and the
tag; nobody got it.
Running the workflow by hand (Actions → Desktop build → Run workflow) builds
without releasing; the installers are on the run's page.

Publishing rebuilds [periskopos.com](https://periskopos.com),
which shows the latest version and its [changelog](https://periskopos.com/docs/changelog/)
(made from `CHANGELOG.md`).
It does this through the site's Cloudflare deploy hook, kept as the
`SITE_DEPLOY_HOOK` repository secret; without the secret the job (`site-rebuild.yml`) is skipped.

## Screenshots

The site's screenshots, the walkthrough video and the README's GIFs come
from the demo's made-up apps. When a release changes what the app looks
like, take them before tagging, showing the version about to go out:

```bash
npm run shots -- all --version 0.5.0 --out data/captures
```

It starts a fresh demo of its own and stops it after, and checks every shot
before taking it: the version, and nothing late, failed or still loading.
If any fails, it ends with an error naming each one; take it again rather
than use it. Then, in the periskopos.com checkout:

```bash
npm run shots -- ../periskopos/data/captures
```

That replaces every site image at its own size, the video and its posters,
and this repo's `.github/assets` GIFs. Commit both, and push the site only
once the release is published, so it never shows a version nobody can
download yet.

The MCP server for AI assistants runs from the installed app's folder or a checkout; nothing about it changes per release.
