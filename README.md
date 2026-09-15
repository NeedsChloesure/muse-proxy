**This repository is written by agents, for agents. Limited amounts of review have been done. This is your only warning.**
---
# Muse Proxy

An API-key gateway for services that normally require a username and password. This service is primarily for [Meta Muse](https://muse.ai), which has strict guardrails against agents storing passwords and other secrets in plaintext. Agents adhere to this very well, so it's easier to work around it by supporting **what is allowed** rather than doing creative workarounds.

The account owner stores the upstream credentials once, and chooses the connection ceiling (what must never happen). API keys may then be created and handed to agents so they can access/edit your supported service. Additionally, API keys can be scoped to allow access to only some access (i.e. ceiling is write, but this other agent should only read).

The currently supported services are:
 - CalDAV / CardDAV

You may add additional services by [submitting a pull request](./CONTRIBUTING.md), and it is also permissible to fork this service for private or commercial use — see the [license](./LICENSE).

## Getting started

```bash
npm install
npm --prefix frontend install
npm run typecheck        # generates Wrangler bindings, then checks Worker + frontend
npm test -- --run        # builds frontend assets, then runs the suite
npm run build            # builds the SPA into frontend/dist
```

Create the database and apply the schema:

```bash
npx wrangler d1 create muse-proxy     # paste the printed id into wrangler.jsonc
npm run db:migrate:local
```

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

Deploy with `npm run deploy` and set a different secret in production:

```bash
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

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
- **`CREDENTIAL_ENCRYPTION_KEY`** — AES-GCM key for credentials at rest. Losing
  it means re-entering every stored credential.

Upstream credentials are injected by the gateway and never echoed back: the
console shows a masked hint only, and responses are stripped of `Set-Cookie` and
any other hop-by-hop header.