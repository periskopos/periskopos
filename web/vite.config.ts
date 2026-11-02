import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
// The app's version, built into the page (shown after the logo): the UI and
// the app are built from the same package.json, so they always agree.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  root: here,
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
