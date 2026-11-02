import { httpUrl, requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration } from "./types.ts";

// A labelled button that opens a URL. Nothing to check.
export const link: Integration = {
  ...described("link"),

  parse({ resource, settings }) {
    const s = (settings ?? {}) as Record<string, unknown>;
    return {
      resource: httpUrl(resource, "URL"),
      settings: { label: requiredText(s.label, "Label", 40) },
    };
  },
};
