import type { ContentfulStatusCode } from "hono/utils/http-status";

// An error whose message is safe to show the user.
export class HttpError extends Error {
  status: ContentfulStatusCode;
  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
