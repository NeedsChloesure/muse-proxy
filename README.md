**This repository is written by agents, for agents. Limited amounts of review have been done. This is your only warning.**
---
# Muse Proxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NeedsChloesure/muse-proxy)

An API-key gateway for services that normally require a username and password, plus inbound mail hosted by this Worker. This service is primarily for [Meta Muse](https://muse.ai), which has strict guardrails against agents storing passwords and other secrets in plaintext. Agents adhere to this very well, so it's easier to work around it by supporting **what is allowed** rather than doing creative workarounds.

The account owner stores the upstream credentials once, and chooses the connection ceiling (what must never happen). API keys may then be created and handed to agents so they can access/edit your supported service. Additionally, API keys can be scoped to allow access to only some access (i.e. ceiling is write, but this other agent should only read).

The currently supported services are:
 - CalDAV / CardDAV
 - Mail (inbound email, stored by this Worker)

You may add additional services by [submitting a pull request](./CONTRIBUTING.md), and it is also permissible to fork this service for private or commercial use — see the [license](./LICENSE).

## Getting started

```bash
npm install
npm --prefix frontend install
npm run typecheck        # generates Wrangler bindings, then checks Worker + frontend
npm test -- --run        # builds frontend assets, then runs the suite
npm run build            # builds the SPA into frontend/dist
```

Create the database and the attachment bucket, apply the schema:

```bash
npx wrangler d1 create muse-proxy     # replace the placeholder database_id in wrangler.jsonc
npx wrangler kv namespace create ATTACHMENTS   # replace the placeholder id in wrangler.jsonc
npm run db:migrate:local
```

Mail is part of the same Worker: the D1 database stores mailboxes, messages and attachment metadata, and the `ATTACHMENTS` KV namespace holds attachments above `INLINE_ATTACHMENT_MAX`.

Provide the one required secret (it encrypts stored upstream credentials):

```bash
cp .dev.vars.example .dev.vars        # then put a real key in it
openssl rand -base64 32               # generate one
```

Run it:

```bash
npm run dev              # Worker on :8787
npm run dev:web          # Vite dev server on :5173, proxying /api to :8787
```

Open `/user/` and create the first account. The first account always works even
with sign-up disabled, and it is the deployment's administrator.

### Deploying

The button above clones this repository into your own GitHub account, provisions the
D1 database, and asks for `CREDENTIAL_ENCRYPTION_KEY` (generate one with
`openssl rand -base64 32`, as `.dev.vars.example` describes). Nothing else needs
pasting: the build installs the frontend's own dependencies, and the deploy command
applies the migrations before it ships the Worker.

By hand instead, against a database you created yourself:

```bash
npx wrangler d1 create muse-proxy     # replace the placeholder id in wrangler.jsonc
npm run deploy                        # migrations, then the SPA, then the Worker
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

`npm run deploy` applies migrations on every run. Only unapplied ones are applied,
and the confirmation prompt is skipped outside an interactive terminal, so it is safe
in a build pipeline.

## How permission works

By default, everything is set to `none`, this is so that you can scope appropriately. 

| Layer | Set by | Scope |
| --- | --- | --- |
| Connection ceiling | The account owner, per resource | `none`, `read` or `write` |
| Key grant | The account owner, per key | One resource, or `*` for the whole connection |

A key can never exceed its connection, and a connection is never implicitly
exposed. A refusal returns `403` with a JSON body naming `required`, `effective`
and `permittedResources`, so a caller can correct itself instead of retrying
blindly.

Requests that span the whole connection (a root `PROPFIND`, for example) require
a wildcard grant **and** a connection-level permission on every known resource.
They are refused rather than filtered: an unfiltered multi-status response would
leak collection names and etags.

## Mail

Mail is a local service in the same Worker. Cloudflare Email Routing delivers to the `email()` handler, messages are parsed and stored in D1, and attachments above `INLINE_ATTACHMENT_MAX` spill to the `ATTACHMENTS` KV namespace. There is no IMAP, SMTP, or outbound sending.

Each account owns one local `Mail` connection. Every mailbox is a resource on that connection (`kind: mailbox`), so the existing two-layer permission model scopes it with no new grant type: the mailbox's ceiling is set on the Mail page, and a key needs a matching grant. New mailboxes start at `none`, exactly like a discovered calendar.

- Console: `/user/mail` — add addresses, set quotas, read messages, download attachments, trim, purge, and choose the agent ceiling per mailbox.
- Agent API: `GET /api/agent/mail/<connectionId>/...`, authenticated with `muse_...`. There is no `/api/v1`, `ADMIN_TOKEN`, or `mk_` key. See `/docs/agent/mail.html`.
- Owner-only actions: creating/deleting a mailbox and minting keys. An agent key can read, flag, delete, trim and purge mail inside the mailboxes it was granted; it cannot create a mailbox or issue another key.
- Every address still needs a Cloudflare Email Routing rule that sends it to this Worker. Mail for an unknown or disabled address is rejected at delivery.

## Using it with an agent/Muse

Self-configuration should work, tell your agent to fetch the home page, and any agent should recognize and attempt configuration. This behavior is tested and works for at least one supported service, CalDAV. 

1. Create a key in the console at `/user/` and tell your agent to fetch the home page of the proxy. With Muse, it will write some basic tooling, and then ask for your API key.

2. Enter your API key in the connection request set up request (in Muse, this is *separate* from the chat interface, Meta does not want your agent to *know* the secrets.)

3. The agent should investigate and write its own tooling for accessing the services you have configured.

Agents send the apikeys as `Authorization: Bearer muse_...`. Machine-readable documentation is at `/llms.txt` and `/api/agent/openapi.json`, with per-service prose under `/docs/`.

## Operating notes

- **`SIGNUP_ENABLED`** — self-service account creation. The first account bootstraps the deployment regardless. You should change this after signing up.
- **`PBKDF2_ITERATIONS`** — account password hashing cost. The default keeps
  sign-in inside the Workers Free plan's 10ms CPU budget; raise it on Paid. The
  count is stored inside each hash, so raising it never locks anyone out.
- **`ALLOW_PRIVATE_NETWORKS`** — permits upstream servers on LAN addresses, for
  a self-hosted Radicale or similar. Off by default: it is what stops a
  connection from reaching `169.254.169.254` and friends.
- **`ALLOW_INSECURE_HTTP`** — permits plain `http://` upstreams. Off by default,
  because upstream credentials would otherwise travel in the clear.
- **`AGENT_CORS_ORIGIN`** — one or more comma-separated origins allowed to call
  `/api/agent` from a browser. Preflight advertises the full supported DAV method
  set. Empty disables CORS entirely.
- **`DEFAULT_DOMAIN`** — mail domain used when the console is given a bare name
  instead of a full address.
- **`MAX_MESSAGE_BYTES`** — largest inbound message accepted (10 MiB by default;
  Cloudflare's ceiling is 25 MiB).
- **`INLINE_ATTACHMENT_MAX`** — attachments at or below this size stay in D1;
  larger ones go to `ATTACHMENTS` KV. Keep it well under D1's 2 MB row limit.
- **`RAW_INLINE_MAX`**, **`MAX_BODY_BYTES`** — raw source and body retention
  budgets per message. `raw_available` is false when the source was not kept.
- **`RETENTION_DAYS`** — stored for future use. `trim` and `purge` are the active
  cleanup controls; no cron runs.
- **`CREDENTIAL_ENCRYPTION_KEY`** — AES-GCM key for credentials at rest. Losing
  it means re-entering every stored credential.

Upstream credentials are injected by the gateway and never echoed back: the
console shows a masked hint only, and responses are stripped of `Set-Cookie` and
any other hop-by-hop header.