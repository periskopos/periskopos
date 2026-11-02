# Security

Periskopos holds keys to people's production services, so security
reports are taken seriously and answered quickly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). If you
can't use that, email hello@periskopos.com.

Include what you found, how to reproduce it, and what an attacker could do
with it. You'll get an answer within a few days, and a fix or a plan within
two weeks for anything serious. Once it's fixed and released, the advisory
is published with credit to you, unless you'd rather not be named.

## What's in scope

- Getting a provider key, token or the session key out of Periskopos.
- Driving Periskopos (its API, its actions) from anything other than
  its own window: another program, a web page, an AI assistant past its
  token's limits or without approval.
- Anything an AI assistant can do that [docs/AGENT-SAFETY.md](docs/AGENT-SAFETY.md)
  says it can't.
- The protocol endpoints Periskopos generates for apps, and the updater.

## What isn't

- An attacker who already runs code as your own OS user with full access:
  [docs/AGENT-SAFETY.md §3](docs/AGENT-SAFETY.md) explains where that line is.
- Problems in the providers' own APIs.

## Supported versions

Only the latest release gets security fixes; the app updates itself.
