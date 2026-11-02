import { ACCOUNTS } from "../../shared/catalog.ts";
import type { Service, ServiceType } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { SERVICE_TYPES, integrations } from "../integrations/index.ts";
import { testKey } from "../keys/keys.ts";
import { SECRET_NAME, authFor, freeKeyName, pastedKey, removeSecret, writeSecret } from "../keys/secrets.ts";
import * as store from "../store.ts";
import { requiredText, text } from "../validate.ts";
import { accountView, findService, fromProvider, jsonBody, pasted, router, visible } from "./context.ts";
import type { RouteDeps } from "./context.ts";

// Accounts, called services in the API (FR-S1–S5): connected once, used by
// every app. Keys go straight into the keys file and never come back out.
export function accountRoutes({ db }: RouteDeps) {
  const r = router();

  const view = (s: Service, usage?: Map<string, { slug: string; name: string }[]>) => accountView(db, s, usage);
  const takenKeyNames = (ownerId: string) => store.listServices(db, ownerId).map((s) => s.secretRef);
  // A plain token, or what the account's own kind of key is (a JSON key file).
  const keyOf = (type: ServiceType, value: unknown) => pasted(() => SERVICE_TYPES[type].keyFromPaste?.(value) ?? pastedKey(value));

  r.get("/services", (c) => {
    const usage = store.serviceUsage(db, c.var.user.id);
    // An assistant limited to some apps hears only of those using an account.
    const shown = new Set(visible(c, store.listApps(db, c.var.user.id)).map((a) => a.slug));
    return c.json({ services: store.listServices(db, c.var.user.id).map((s) => view(s, usage)).map((s) => ({ ...s, apps: s.apps.filter((a) => shown.has(a.slug)) })) });
  });

  r.post("/services", async (c) => {
    const body = await jsonBody(c);
    const type = requiredText(body.type, "Type", 20);
    if (!Object.hasOwn(SERVICE_TYPES, type)) throw badRequest(`Unknown service type "${type}"`);
    // Usually the key is pasted on screen: it goes straight into the keys
    // file under a name of its own and is never stored or shown anywhere
    // else. A key already in the file can be named instead (Advanced).
    const name = requiredText(body.name, "Name", 60);
    let secretRef = text(body.secretRef, "Key variable", { max: 64, optional: true });
    let key: string | undefined;
    if (body.key !== undefined && body.key !== "") {
      key = keyOf(type as ServiceType, body.key);
      secretRef ??= freeKeyName(type as ServiceType, takenKeyNames(c.var.user.id));
    }
    if (secretRef && !SECRET_NAME.test(secretRef)) {
      throw badRequest("The key variable must look like RENDER_API_KEY: capital letters, digits and _");
    }
    if (!secretRef && type !== "github") throw badRequest("Paste the key from your account first");
    if (key && secretRef) writeSecret(secretRef, key);
    const service = store.createService(db, c.var.user.id, {
      type: type as ServiceType,
      name,
      ...(secretRef ? { secretRef } : {}),
      canWrite: body.canWrite === true,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ service: view(service, new Map()) }, 201);
  });

  // A new key for a connected service (it was missing, wrong, or replaced),
  // pasted on screen and saved straight into the keys file.
  r.post("/services/:id/key", async (c) => {
    const service = findService(db, c);
    const body = await jsonBody(c);
    const key = keyOf(service.type, body.key);
    let secretRef = service.secretRef;
    if (!secretRef) {
      // GitHub on the gh login so far: the pasted token takes over.
      secretRef = freeKeyName(service.type, takenKeyNames(c.var.user.id));
      store.setServiceSecretRef(db, service, secretRef);
    }
    writeSecret(secretRef, key);
    store.setServiceLastTest(db, service, undefined); // about the old key
    c.header("Cache-Control", "no-store");
    return c.json({ service: view(store.getService(db, c.var.user.id, service.id)!) });
  });

  // Makes one read call with the key (FR-S2), and remembers what it found
  // so the list can say whether the key works (the watcher does the same
  // daily: server/keys/keys.ts).
  r.post("/services/:id/test", async (c) => {
    const service = findService(db, c);
    const { result } = await testKey(service);
    store.setServiceLastTest(db, service, result);
    const { at: _at, ...answer } = result;
    return c.json(answer);
  });

  // ?type= picks one of the things an account can hold when it holds more
  // than one kind (a Cloudflare account: Pages projects, or domains).
  r.get("/services/:id/resources", async (c) => {
    const service = findService(db, c);
    const type = c.req.query("type");
    const integration =
      type === undefined ? SERVICE_TYPES[service.type] : Object.hasOwn(integrations, type) && integrations[type].serviceType === service.type ? integrations[type] : undefined;
    if (!integration?.listResources) throw badRequest(`${service.name} has nothing of type "${type}"`);
    return c.json({ resources: await fromProvider(() => integration.listResources!(authFor(service))) });
  });

  // "Allow actions", and which plan the account is on, can be switched
  // later, from the Accounts page.
  r.patch("/services/:id", async (c) => {
    const service = findService(db, c);
    const body = await jsonBody(c);
    if (body.canWrite === undefined && body.paidPlan === undefined) throw badRequest("Send canWrite or paidPlan");
    if (body.canWrite !== undefined && typeof body.canWrite !== "boolean") throw badRequest("canWrite must be true or false");
    if (body.paidPlan !== undefined && (typeof body.paidPlan !== "boolean" || !ACCOUNTS[service.type].plan)) throw badRequest(`${ACCOUNTS[service.type].label} has no plan to choose`);
    if (typeof body.canWrite === "boolean") store.setServiceCanWrite(db, service, body.canWrite);
    if (typeof body.paidPlan === "boolean") store.setServicePaidPlan(db, service, body.paidPlan);
    return c.json({ service: view(store.getService(db, c.var.user.id, service.id)!) });
  });

  r.delete("/services/:id", (c) => {
    const service = findService(db, c);
    store.deleteService(db, service);
    // Its key goes with it, unless another account reads the same one.
    const ref = service.secretRef;
    if (ref && !store.listServices(db, c.var.user.id).some((s) => s.secretRef === ref)) removeSecret(ref);
    return c.body(null, 204);
  });

  return r;
}
