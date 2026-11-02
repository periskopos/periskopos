import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { amplify, clearAmplifyCache, keyFromPaste, readKey, signV4, toDeploys } from "../server/integrations/amplify.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// AWS Amplify as a host: requests signed with Signature Version 4, apps'
// branches, build jobs as deploys, Redeploy. Everything here is a fake;
// nothing reaches the network.

const ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const KEY = `${ID}:${SECRET}:eu-west-1`;

const NOW = Date.now();
const sec = (min: number) => (NOW - min * 60_000) / 1000; // Amplify's epoch seconds
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const realFetch = globalThis.fetch;
type Seen = { method: string; url: URL; body?: unknown; headers: Headers; rawBody?: string };
let seen: Seen[];
let answer: (s: Seen) => Response;
beforeEach(() => {
  clearAmplifyCache();
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      method: init?.method ?? "GET",
      url: new URL(String(input instanceof Request ? input.url : input)),
      headers: new Headers(init?.headers),
      ...(init?.body ? { body: JSON.parse(String(init.body)), rawBody: String(init.body) } : {}),
    };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "aws", name: "AWS", canWrite: true }, token: async () => KEY } as ServiceAuth;
const conn = (branch = "main"): Connection => ({ id: "c", appId: "a", type: "amplify", serviceId: "s", resource: `d1abc23/${branch}`, settings: { appId: "d1abc23", branchName: branch, appName: "shop", region: "eu-west-1" } });
const app = (url: string, name = "Shop"): App => ({ id: "a", slug: name.toLowerCase(), ownerId: "u", name, url, live: true, checkIntervalMin: 5, connections: [] });
const job = (jobId: string, status: string, min: number, extra: Record<string, unknown> = {}) => ({
  jobId,
  jobType: "WEB_HOOK",
  status,
  commitId: `${jobId}aaaa111bbbb`,
  commitMessage: `Change ${jobId}\n\nbody`,
  commitTime: sec(min + 1),
  startTime: sec(min),
  ...(status === "RUNNING" || status === "PENDING" ? {} : { endTime: sec(min - 3) }),
  ...extra,
});

// ── Signing ─────────────────────────────────────────────────────────────

describe("Signature Version 4", () => {
  // AWS's own SigV4 test suite (awslabs/aws-c-auth,
  // tests/aws-signing-test-suite/v4): credentials, time and the expected
  // canonical request, string to sign and signature, verbatim.
  const suiteKey = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const at = new Date("2015-08-30T12:36:00Z");
  const sign = (path: string, query: [string, string][] = []) => signV4({ method: "GET", host: "example.amazonaws.com", path, query }, suiteKey, "us-east-1", "service", at);

  test("get-vanilla", () => {
    const s = sign("/");
    assert.equal(s.canonicalRequest, "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(s.stringToSign, "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
    assert.equal(s.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    assert.equal(
      s.headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    assert.equal(s.headers["x-amz-date"], "20150830T123600Z");
  });

  test("get-vanilla-query-order-key-case: query sorted", () => {
    assert.equal(sign("/", [["Param2", "value2"], ["Param1", "value1"]]).signature, "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  test("get-utf8, get-space-unnormalized, get-vanilla-utf8-query: encoding", () => {
    assert.equal(sign("/ሴ").signature, "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85");
    assert.equal(sign("/example space/").signature, "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741");
    assert.equal(sign("/", [["ሴ", "bar"]]).signature, "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04");
  });

  test("a branch with a slash is signed encoded twice, as AWS's other SDKs do", () => {
    const s = sign("/apps/d1/branches/feature%2Fx/jobs");
    assert.match(s.canonicalRequest, /^GET\n\/apps\/d1\/branches\/feature%252Fx\/jobs\n/);
  });
});

// ── The key ─────────────────────────────────────────────────────────────

describe("The AWS key", () => {
  test("ID:SECRET:REGION, with spaces, or the IAM CSV with the region added", () => {
    assert.equal(keyFromPaste(KEY), KEY);
    assert.equal(keyFromPaste(`  ${ID} : ${SECRET} : EU-WEST-1 \n`), KEY);
    assert.equal(keyFromPaste(`Access key ID,Secret access key\r\n${ID},${SECRET}\r\n eu-west-1`), KEY);
    assert.deepEqual(readKey(KEY), { accessKeyId: ID, secretAccessKey: SECRET, region: "eu-west-1" });
  });

  test("what's wrong with it, said plainly", () => {
    assert.throws(() => keyFromPaste(""), /Paste the key first/);
    assert.throws(() => keyFromPaste(`${ID}:${SECRET}`), /Add the region/);
    assert.throws(() => keyFromPaste(`${ID}:${SECRET}:eu-westt`), /"eu-westt" isn't an AWS region/);
    assert.throws(() => keyFromPaste(`ASIAIOSFODNN7EXAMPLE:${SECRET}:eu-west-1`), /temporary access key/);
    assert.throws(() => keyFromPaste(`AKIA123:${SECRET}:eu-west-1`), /No access key ID/);
    assert.throws(() => keyFromPaste(`${ID}:short:eu-west-1`), /No secret access key/);
    assert.throws(() => readKey("ghp_abc"), /Change key/);
  });
});

// ── Amplify ─────────────────────────────────────────────────────────────

describe("AWS Amplify", () => {
  test("parse keeps only what it should", () => {
    assert.deepEqual(amplify.parse({ resource: "d1abc23/feature/x", settings: { appName: "shop", region: "eu-west-1", evil: "x", appId: "dother" } }), {
      resource: "d1abc23/feature/x",
      settings: { appId: "d1abc23", branchName: "feature/x", appName: "shop", region: "eu-west-1" },
    });
    assert.throws(() => amplify.parse({ resource: "shop", settings: {} }), /Pick the branch/);
  });

  test("testService: a signed GET to the key's region", async () => {
    answer = () => json({ apps: [{ appId: "d1abc23", name: "shop" }, { appId: "d2def45", name: "blog" }] });
    assert.deepEqual(await amplify.testService!(auth), { message: "Connected to AWS Amplify in eu-west-1: 2 apps" });
    const s = seen[0]!;
    assert.equal(s.url.origin, "https://amplify.eu-west-1.amazonaws.com");
    assert.equal(s.url.pathname, "/apps");
    assert.equal(s.url.searchParams.get("maxResults"), "100");
    // The signature is the one signV4 gives for exactly this request.
    const date = s.headers.get("x-amz-date")!;
    assert.match(date, /^\d{8}T\d{6}Z$/);
    const at = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const expected = signV4({ method: "GET", host: s.url.host, path: "/apps", query: [["maxResults", "100"]] }, readKey(KEY), "eu-west-1", "amplify", at);
    assert.equal(s.headers.get("authorization"), expected.headers.authorization);
    assert.match(s.headers.get("authorization")!, new RegExp(`Credential=${ID}/\\d{8}/eu-west-1/amplify/aws4_request`));
  });

  test("an unknown access key, and a missing permission named", async () => {
    answer = () => json({ message: "The security token included in the request is invalid." }, 403, { "x-amzn-ErrorType": "UnrecognizedClientException:" });
    await assert.rejects(amplify.testService!(auth), /AWS doesn't know this access key/);
    answer = () =>
      json({ Message: "User: arn:aws:iam::123456789012:user/periskopos is not authorized to perform: amplify:ListJobs on resource: arn:aws:amplify:eu-west-1:123456789012:apps/d1abc23/branches/main/jobs/*" }, 403, {
        "x-amzn-ErrorType": "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.coral.service/",
      });
    const r = await amplify.check!(conn(), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /AWS refused amplify:ListJobs \(403\).*Add "amplify:ListJobs" to its policy/);
    // A refusal isn't cached: the policy fixed, the next check asks again.
    answer = () => json({ jobSummaries: [job("2", "SUCCEED", 5)] });
    assert.equal((await amplify.check!(conn(), auth)).state, "up");
  });

  test("listResources: every app's branches, with their addresses", async () => {
    answer = (s) => {
      if (s.url.pathname === "/apps") {
        return s.url.searchParams.get("nextToken")
          ? json({ apps: [{ appId: "d2def45", name: "blog", defaultDomain: "d2def45.amplifyapp.com" }] })
          : json({ apps: [{ appId: "d1abc23", name: "shop", defaultDomain: "d1abc23.amplifyapp.com", productionBranch: { branchName: "main" } }], nextToken: "page2" });
      }
      if (s.url.pathname === "/apps/d1abc23/branches") {
        return json({ branches: [{ branchName: "main", displayName: "main", stage: "PRODUCTION", customDomains: ["shop.example.com"] }, { branchName: "feature/x", displayName: "feature-x", stage: "DEVELOPMENT" }] });
      }
      return json({ branches: [{ branchName: "prod", displayName: "prod", stage: "PRODUCTION" }] });
    };
    const list = await amplify.listResources!(auth);
    assert.deepEqual(
      list.map((r) => [r.id, r.label, r.detail]),
      [
        ["d1abc23/main", "shop/main", "main.d1abc23.amplifyapp.com · shop.example.com · production"],
        ["d1abc23/feature/x", "shop/feature/x", "feature-x.d1abc23.amplifyapp.com"],
        ["d2def45/prod", "blog/prod", "prod.d2def45.amplifyapp.com · production"],
      ],
    );
    assert.equal(seen.find((s) => s.url.pathname === "/apps/d1abc23/branches")!.url.searchParams.get("maxResults"), "50");
    assert.deepEqual(list[0]!.settings, { appId: "d1abc23", branchName: "main", appName: "shop", region: "eu-west-1", production: true });
    assert.equal(amplify.resourceName!(list[1]!), "shop");

    // Matched by the address it serves, else the production branch of the app named like it.
    assert.equal(amplify.matchApp!(app("https://shop.example.com/"), list)?.id, "d1abc23/main");
    assert.equal(amplify.matchApp!(app("https://feature-x.d1abc23.amplifyapp.com/", "Other"), list)?.id, "d1abc23/feature/x");
    assert.equal(amplify.matchApp!(app("https://blog.example.org/", "Blog"), list)?.id, "d2def45/prod");
    assert.equal(amplify.matchApp!(app("https://nothing.example.org/", "Nope"), list), undefined);
    assert.deepEqual(amplify.suggestedSettings!(app("https://shop.example.com/"), list[0]!), { appId: "d1abc23", branchName: "main", appName: "shop", region: "eu-west-1" });
  });

  test("jobs as deploys: the newest success is live, older ones replaced", () => {
    const list = toDeploys(
      [job("3", "SUCCEED", 30), job("5", "RUNNING", 1), job("4", "FAILED", 10), job("2", "SUCCEED", 90), job("1", "CANCELLED", 120), job("0", "SUCCEED", 200, { commitId: "HEAD", jobType: "MANUAL" })],
      (id) => `https://console/job/${id}`,
    );
    assert.deepEqual(
      list.map((d) => [d.id, d.status, d.phase]),
      [["5", "running", "in-progress"], ["4", "failed", "failed"], ["3", "live", "live"], ["2", "superseded", "other"], ["1", "cancelled", "other"], ["0", "superseded", "other"]],
    );
    assert.deepEqual(list[2]!.commit, { sha: "3aaaa111bbbb", message: "Change 3", at: new Date(sec(31) * 1000).toISOString() });
    assert.equal(list[0]!.finishedAt, undefined);
    assert.equal(list[2]!.finishedAt, new Date(sec(27) * 1000).toISOString());
    assert.equal(list[2]!.url, "https://console/job/3");
    assert.equal(list[5]!.commit, undefined, "a manual deploy has no commit");
  });

  test("check: up when the newest job succeeded, down with a link when it failed", async () => {
    answer = () => json({ jobSummaries: [job("2", "SUCCEED", 5), job("1", "FAILED", 60)] });
    const up = await amplify.check!(conn(), auth);
    assert.equal(up.state, "up");
    assert.match(up.summary!, /^Live: 2aaaa11 “Change 2”/);
    const q = seen[0]!.url;
    assert.equal(q.pathname, "/apps/d1abc23/branches/main/jobs");
    assert.equal(q.searchParams.get("maxResults"), "20");

    clearAmplifyCache();
    answer = () => json({ jobSummaries: [job("2", "FAILED", 5), job("1", "SUCCEED", 60)] });
    const down = await amplify.check!(conn(), auth);
    assert.equal(down.state, "down");
    assert.match(down.detail!, /^Deploy failed \(failed\): 2aaaa11/);
    assert.deepEqual(down.link, { url: "https://console.aws.amazon.com/amplify/home?region=eu-west-1#/d1abc23/main/2", label: "Open the build in Amplify" });
  });

  test("check while a build runs: what the last finished one said", async () => {
    answer = () => json({ jobSummaries: [job("3", "RUNNING", 2), job("2", "SUCCEED", 30)] });
    const r = await amplify.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Deploying 3aaaa11/);

    clearAmplifyCache();
    answer = () => json({ jobSummaries: [job("3", "RUNNING", 2), job("2", "FAILED", 30)] });
    assert.equal((await amplify.check!(conn(), auth)).state, "down", "still failing until a build goes live");

    clearAmplifyCache();
    answer = () => json({ jobSummaries: [job("3", "RUNNING", 45), job("2", "SUCCEED", 90)] });
    const slow = await amplify.check!(conn(), auth);
    assert.equal(slow.state, "down");
    assert.match(slow.detail!, /^Deploy running for/);
    assert.equal(slow.link?.url, "https://console.aws.amazon.com/amplify/home?region=eu-west-1#/d1abc23/main/3");
  });

  test("a branch name with a slash goes into the path encoded", async () => {
    answer = () => json({ jobSummaries: [] });
    await amplify.deploys!(conn("feature/x"), auth);
    assert.equal(seen[0]!.url.pathname, "/apps/d1abc23/branches/feature%2Fx/jobs");
  });

  test("details: recent deploys, with the branch in the console", async () => {
    answer = () => json({ jobSummaries: [job("1", "SUCCEED", 5)] });
    const d = await amplify.details!(conn(), auth);
    assert.deepEqual((d as { link?: unknown }).link, { url: "https://console.aws.amazon.com/amplify/home?region=eu-west-1#/d1abc23/main", label: "All in Amplify" });
  });

  test("Redeploy starts a RELEASE job (the only POST), never on top of a running one", async () => {
    answer = (s) => (s.method === "POST" ? json({ jobSummary: { jobId: "6", status: "PENDING" } }) : json({ jobSummaries: [job("5", "RUNNING", 1), job("4", "SUCCEED", 30)] }));
    const busy = await amplify.run!(conn(), auth, "redeploy");
    assert.equal(busy.ok, false);
    assert.match(busy.message, /already running/);
    assert.equal(seen.filter((s) => s.method === "POST").length, 0);

    // No cache clearing here: Redeploy looks at the jobs fresh itself.
    answer = (s) => (s.method === "POST" ? json({ jobSummary: { jobId: "6", status: "PENDING" } }) : json({ jobSummaries: [job("4", "SUCCEED", 30)] }));
    const ok = await amplify.run!(conn(), auth, "redeploy");
    assert.deepEqual(ok, { ok: true, message: "Redeploy started (job 6, pending). It will show under Deploys." });
    const posts = seen.filter((s) => s.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url.pathname, "/apps/d1abc23/branches/main/jobs");
    assert.deepEqual(posts[0]!.body, { jobType: "RELEASE", jobReason: "Redeploy from Periskopos" });
    assert.match(posts[0]!.headers.get("authorization")!, /SignedHeaders=content-type;host;x-amz-date,/);
    assert.ok(seen.every((s) => s.method === "GET" || s === posts[0]));
    await assert.rejects(amplify.run!(conn(), auth, "delete"), /no action "delete"/);
  });

  test("Redeploy refuses a branch deployed by hand, and names a missing StartJob permission", async () => {
    answer = () => json({ jobSummaries: [job("2", "SUCCEED", 30, { jobType: "MANUAL", commitId: "HEAD" })] });
    const manual = await amplify.run!(conn(), auth, "redeploy");
    assert.equal(manual.ok, false);
    assert.match(manual.message, /deployed by hand/);

    clearAmplifyCache();
    answer = (s) =>
      s.method === "POST"
        ? json({ Message: "User: arn:aws:iam::123456789012:user/periskopos is not authorized to perform: amplify:StartJob on resource: x" }, 403, { "x-amzn-ErrorType": "AccessDeniedException" })
        : json({ jobSummaries: [job("4", "SUCCEED", 30), job("2", "SUCCEED", 90, { jobType: "MANUAL", commitId: "HEAD" })] }); // one by hand long ago doesn't stop it
    await assert.rejects(amplify.run!(conn(), auth, "redeploy"), /AWS refused amplify:StartJob \(403\)/);
  });
});
