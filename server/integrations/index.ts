import type { ServiceType } from "../../shared/types.ts";
import { cloudflareIntegration } from "./cloudflare.ts";
import { cloudflareZone } from "./cloudflare-zone/index.ts";
import { domain } from "./domain.ts";
import { github } from "./github.ts";
import { githubSecurity } from "./github-security.ts";
import { paddle } from "./paddle.ts";
import { stripe } from "./stripe.ts";
import { link } from "./link.ts";
import { renderIntegration } from "./render.ts";
import { digitalocean } from "./digitalocean.ts";
import { fly } from "./fly.ts";
import { netlify } from "./netlify.ts";
import { railway } from "./railway.ts";
import { sentry } from "./sentry.ts";
import { vercel } from "./vercel.ts";
import { resend } from "./resend.ts";
import { searchConsole } from "./search-console.ts";
import { site } from "./site.ts";
import { ssl } from "./ssl.ts";
import { supabase } from "./supabase.ts";
import { amplify } from "./amplify.ts";
import { clerk } from "./clerk.ts";
import { gitlab } from "./gitlab.ts";
import { googleAnalytics } from "./google-analytics.ts";
import { mongodb } from "./mongodb.ts";
import { neon } from "./neon.ts";
import { openai } from "./openai.ts";
import { sendgrid } from "./sendgrid.ts";
import { cloudflareLogs } from "./logs/cloudflare.ts";
import { digitaloceanLogs } from "./logs/digitalocean.ts";
import { flyLogs } from "./logs/fly.ts";
import { railwayLogs } from "./logs/railway.ts";
import { renderLogs } from "./logs/render.ts";
import { supabaseLogs } from "./logs/supabase.ts";
import { vercelLogs } from "./logs/vercel.ts";
import type { Integration } from "./types.ts";

export const integrations: Record<string, Integration> = {
  [site.type]: site,
  [link.type]: link,
  [github.type]: github,
  [githubSecurity.type]: githubSecurity,
  [renderIntegration.type]: renderIntegration,
  [cloudflareIntegration.type]: cloudflareIntegration,
  [cloudflareZone.type]: cloudflareZone,
  [supabase.type]: supabase,
  [searchConsole.type]: searchConsole,
  [resend.type]: resend,
  [digitalocean.type]: digitalocean,
  [vercel.type]: vercel,
  [netlify.type]: netlify,
  [fly.type]: fly,
  [railway.type]: railway,
  [sentry.type]: sentry,
  [stripe.type]: stripe,
  [paddle.type]: paddle,
  [gitlab.type]: gitlab,
  [amplify.type]: amplify,
  [neon.type]: neon,
  [mongodb.type]: mongodb,
  [sendgrid.type]: sendgrid,
  [googleAnalytics.type]: googleAnalytics,
  [clerk.type]: clerk,
  [openai.type]: openai,
  [vercelLogs.type]: vercelLogs,
  [renderLogs.type]: renderLogs,
  [railwayLogs.type]: railwayLogs,
  [cloudflareLogs.type]: cloudflareLogs,
  [supabaseLogs.type]: supabaseLogs,
  [digitaloceanLogs.type]: digitaloceanLogs,
  [flyLogs.type]: flyLogs,
  [ssl.type]: ssl,
  [domain.type]: domain,
};

export const SERVICE_TYPES: Record<ServiceType, Integration> = {
  github,
  render: renderIntegration,
  cloudflare: cloudflareIntegration,
  supabase,
  "search-console": searchConsole,
  resend,
  digitalocean,
  vercel,
  netlify,
  fly,
  railway,
  sentry,
  stripe,
  paddle,
  gitlab,
  aws: amplify,
  neon,
  mongodb,
  sendgrid,
  "google-analytics": googleAnalytics,
  clerk,
  openai,
};
