# Releasing a new version

For maintainers.

```bash
npm version minor
```

```bash
git push --follow-tags
```

`npm version` (or `patch` / `major`) raises the version in `package.json`,
commits it and tags it `v0.2.0`. Pushing the tag runs the **Desktop build**
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
(made from `CHANGELOG.md`: add the release's larger steps there before tagging).
It does this through the site's Cloudflare deploy hook, kept as the
`SITE_DEPLOY_HOOK` repository secret; without the secret the job (`site-rebuild.yml`) is skipped.

The MCP server for AI assistants runs from the installed app's folder or a checkout; nothing about it changes per release.
