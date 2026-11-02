import { badRequest } from "./errors.ts";

export function text(
  value: unknown,
  field: string,
  { max = 200, optional = false }: { max?: number; optional?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw badRequest(`${field} is required`);
  }
  if (typeof value !== "string") throw badRequest(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed && !optional) throw badRequest(`${field} is required`);
  if (trimmed.length > max) throw badRequest(`${field} is longer than ${max} characters`);
  return trimmed || undefined;
}

export function requiredText(value: unknown, field: string, max = 200): string {
  return text(value, field, { max })!;
}

// Only http(s): a stored URL ends up in links and in fetch().
export function httpUrl(value: unknown, field: string): string {
  const raw = requiredText(value, field, 2000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`${field} must be a full URL, like https://example.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest(`${field} must start with http:// or https://`);
  }
  if (url.username || url.password) throw badRequest(`${field} must not contain a password`);
  return url.toString();
}
