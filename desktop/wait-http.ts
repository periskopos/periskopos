import http from "node:http";

// One GET, returning the status and body, or rejecting on no answer.
export function fetchOnce(url: string, headers: Record<string, string> = {}, timeoutMs = 3000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 1_000_000) body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`No answer from ${url}`));
    });
  });
}

// Every page Periskopos serves carries <meta name="periskopos">: the
// app's own window gets content="app", anything without the session key gets
// content="locked". Seeing it is how the app knows what answers on the port is
// Periskopos, and not some other program.
export const isPeriskoposPage = (body: string): boolean => /<meta name="periskopos"/.test(body);

// "ours": Periskopos answering with its page for this key. "locked": a
// Periskopos that doesn't know this key (another copy holds the port).
export async function probe(origin: string, sessionKey?: string): Promise<"ours" | "locked" | "other" | "none"> {
  try {
    const { status, body } = await fetchOnce(`${origin}/`, sessionKey ? { "x-periskopos-token": sessionKey } : {});
    if (!isPeriskoposPage(body)) return "other";
    return status === 200 ? "ours" : "locked";
  } catch {
    return "none";
  }
}

// Polls until Periskopos answers, or gives up with what went wrong.
export async function waitForPeriskopos(
  origin: string,
  { sessionKey, attempts = 60, intervalMs = 500, stillRunning = () => true }: { sessionKey?: string; attempts?: number; intervalMs?: number; stillRunning?: () => boolean } = {},
): Promise<void> {
  let last = "no answer";
  for (let i = 0; i < attempts; i++) {
    if (!stillRunning()) throw new Error("The server stopped while starting");
    const found = await probe(origin, sessionKey);
    if (found === "ours") return;
    last = found === "other" ? "something else answered on that port" : found === "locked" ? "another Periskopos answered on that port" : "no answer yet";
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Periskopos didn't start on ${origin} (${last})`);
}
