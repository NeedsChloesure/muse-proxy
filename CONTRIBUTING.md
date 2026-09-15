# Contributing

Muse Proxy is MIT-licensed and contributions are welcome, especially
additional services. The usual path is a pull request against `main`:

1. Fork the repository and branch from `main`.
2. Get the suite running locally (see [Tests](#tests)).
3. Make the change, and add a test that fails without it.
4. Open the pull request describing what changed and why.

Before opening it, these must be green:

```bash
npm run typecheck        # generates Wrangler bindings, then checks Worker + frontend
npm test -- --run        # builds frontend assets, then runs the suite
npm run build            # builds the SPA into frontend/dist
```

Adding a service is a bigger change than a normal one: [Adding a
service](#adding-a-service) describes the provider contract, and
`test/provider-kit.ts` is the conformance suite a new provider has to pass. That
kit is the bar — a provider that passes it is genuinely pluggable.

## Licensing of contributions

Contributions are accepted under the project's own license, MIT: submitting a
pull request means your contribution may be distributed under those terms.
Signing off your commits (`git commit -s`) records that you wrote the code or
otherwise have the right to submit it.

## Layout

```
src/
  index.ts            routing contract (see the header comment)
  landing.ts          the plain-text/HTML page served at /
  admin/              session-authed console API: auth, connections, keys, notices
  agent/              agent API: catalog, notices, provider dispatch
  providers/          the service contract, shared routing/authorization, and caldav/
  auth/               session + API-key resolution
  db/                 D1 access, one module of typed queries
  lib/                crypto, path/SSRF policy, upstream fetch, credential injection, permissions
migrations/           D1 schema
test/                 workerd-hosted tests (real runtime, real local D1)
frontend/             React SPA served at /user/, docs and llms.txt as static assets
```

Routing, on one origin, with no CORS for the console:

| Path | Served by | Auth |
| --- | --- | --- |
| `/` | the Worker | none |
| `/api/admin/*` | the Worker | session cookie |
| `/api/agent/*` | the Worker | `Authorization: Bearer muse_...` |
| `/user/*` | SPA shell, built to `frontend/dist` | none |
| `/docs/*`, `/llms.txt` | static assets | none |

`run_worker_first` covers only `/` and `/api/*`, so static assets and SPA deep
links are served by the platform without invoking the Worker.

## Adding a service

The permission model is protocol-neutral on purpose. A resource key is an opaque
string, the core decides access from a provider-supplied resolution, and nothing
in `lib/access.ts` knows what a URL, a method or a DAV collection is. The
responsibilities are split so that the security-relevant parts live in one place:

| Concern | Owner |
| --- | --- |
| `<connectionId>` routing, account isolation, loading both permission layers | `providers/gateway.ts` (the router calls it before dispatch) |
| The two-layer intersection and the shape of a refusal | `lib/access.ts`, `providers/gateway.ts` |
| Injecting the stored credential upstream, including the Digest handshake | `lib/upstream-auth.ts` and `lib/digest.ts` |
| Everything specific to the service | `providers/<service>/` |

A provider declares:

- `fields` — its connection config, rendered by the console and validated by
  `validateFields`, so a new service appears in the UI with no frontend change;
- `credentials` — labels for the stored credential pair, and whether a username
  is needed at all;
- `validateConfig` / `verifyConfig` — normalise the config, then enforce the SSRF
  policy on whatever this provider dials (`assertAllowedBaseUrl` for an HTTP
  service, a host/port check for a socket-based one);
- `test` / `discover` — verify the credential, and report the scope universe;
- `handle` — map one request to a `Resolution` plus the access it requires, then
  call `ctx.decide` / `ctx.require`.

A connection stores only what is genuinely shared: provider, label, auth type,
the sealed credential pair and a masked hint. What the provider dials lives in
its own `config_json`, so adding a service never means migrating a table.

Adding a service is then one directory plus one line in
`src/providers/registry.ts` — and `test/provider-kit.spec.ts`, which runs the
shared conformance suite (`test/provider-kit.ts`) against CalDAV. The kit is what
makes "pluggable" enforceable rather than aspirational: catalog presence, the
mount convention, cross-account isolation, the guided 403, config validation,
credential secrecy. Implement a provider for a new service and run it through
the kit.

## Upstream authentication

A connection stores a username and password. `lib/upstream-auth.ts` decides how
to present them, because that is the product:

- **Basic and Bearer** are decided locally and cost one request.
- **Digest** cannot be decided locally — it needs the server's nonce — so a
  request refused with a Digest challenge is answered and retried exactly once.
  This is why a connection is not misconfigured just because its server insists
  on Digest: Baikal defaults to it (its SabreDAV backend is a Digest backend),
  as does a good deal of DAV software. `authType: 'digest'` skips the first
  attempt and asks immediately; `basic` reaches it by negotiation.
- The negotiated challenge is cached per connection, so later requests go out
  pre-authenticated with an advancing nonce count instead of redoing the
  handshake. The cache is per-isolate and best effort: a miss costs one extra
  round trip and nothing else. It is keyed by connection, never by origin, so
  one connection cannot ride another's session.
- A Digest response is bound to the request-target it was computed for, so it is
  recomputed for the URL that actually answers (a `/.well-known/caldav` redirect
  lands somewhere else) and is never replayed across a redirect. Basic and
  Bearer are not bound to a target and are not dropped.
- Because the challenge costs a retry, a body-bearing request is buffered when
  the connection authenticates with a password, and refused with
  `body_too_large` above 16 MiB rather than sent twice. Bearer keeps streaming.
- Deliberately unsupported: `qop=auth-int`, `userhash`, and SHA-512-256. Each is
  refused with a message naming it, because quietly computing a response the
  server cannot verify is worse than saying so.

The maths is pinned to the published RFC 7616 §3.9.1 vectors in
`test/digest.spec.ts`, so it can be checked without trusting the implementation.

## Agent surface

Start at `GET /api/agent`. Without a key it lists the services; with one it also
reports every connection and collection that key can reach, with effective
access. Each service owns its own namespace:

```
/api/agent/caldav/<connectionId>/<path-inside-the-upstream-server>
```

Agents speak DAV directly. The method decides the access required (`PROPFIND`,
`REPORT`, `GET` are reads; `PUT`, `PROPPATCH`, `MKCOL`, `DELETE` are writes),
the longest matching collection wins, and `MOVE`/`COPY` authorise the
`Destination` as well as the source. `OPTIONS` is answered locally and
advertises only what the key can actually do. Request bodies are forwarded, so
`REPORT` queries (`calendar-query`, `calendar-multiget`, `sync-collection`) and
`PROPFIND` property sets reach the server as sent.

A `REPORT` is the one request whose targets are not in its URL: a
`calendar-multiget` lists `<D:href>` elements that the server resolves
independently, so each one is authorized too. A href outside the key's grants is
refused and never reaches upstream, and a body that cannot be read well enough
to know what it references is refused rather than forwarded — two XML parsers
are in play, and a parser differential is how such a check would be defeated.

Changes that affect an agent (access narrowed, key expired) are delivered as
notices: a `X-Muse-Notices` count on any response, readable at
`GET /api/agent/notices`, acknowledged with `POST /api/agent/notices/ack`. A
notice reaches every key whose grants touch the change, including keys minted —
or granted the collection — after it was recorded, so a notice the account can
see is never one the affected agent cannot.

Machine-readable documentation lives at `/llms.txt` and
`/api/agent/openapi.json`.

## Tests

```bash
npm run typecheck        # generates Wrangler bindings, then checks Worker + frontend
npm test -- --run        # builds frontend assets, then runs the suite
```

The suite runs inside workerd through `@cloudflare/vitest-pool-workers`, against
a real local D1, with the upstream DAV server mocked at the `fetch` layer
(`test/dav.ts`). It needs no Cloudflare credentials and no network.

Tests read `wrangler.test.jsonc`, not `wrangler.jsonc`. That is not a
preference: the pool pins an exact, older wrangler internally which rejects the
deploy-only route keys in the real config, and pointing at it aborted the entire
run. `wrangler.test.jsonc` mirrors the parts of `wrangler.jsonc` that change what
tests exercise — entry point, compatibility date and flags, the D1 binding, the
assets binding — so **update it whenever you change one of those**, or the suite
will quietly keep testing the old ones. Routes, vars, secrets and `keep_vars`
live only in `wrangler.jsonc`.

The permission matrix is pinned by `test/access.spec.ts`; `test/caldav.spec.ts`
covers the gateway end to end, including path traversal, encoded separators,
destination authorization, REPORT href authorization and the two-layer
intersection. `test/upstream-auth.spec.ts`
puts a Digest-demanding upstream in front of both discovery and the gateway, and
`test/discovery.spec.ts` covers the server layouts that actually break — DAV
mounted under a path, a web interface at the root, a well-known redirect.
`test/provider-kit.ts` is the shared conformance suite every provider must pass,
and `test/provider-kit.spec.ts` runs it against CalDAV. `test/report.spec.ts`
pins the two halves of REPORT authorization — reading the hrefs out of a body,
and translating each into gateway coordinates.
