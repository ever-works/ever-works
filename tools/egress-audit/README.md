# Egress audit

A runtime proof of what the anonymous usage statistics module may send
([Anonymous usage statistics](../../docs/ever-platform/anonymous-statistics.md)): **nothing at all**
when it is switched off, and **only the statistics report** when it is on.

The audit runs the API and web images built from the commit under test with the self-hosting
compose file (`docker-compose.yml`), on Docker networks that have no route out. CoreDNS is the only
resolver and logs every query; a `tcpdump` sniffer in the network namespace of the API and of the
web app starts before each process and records every connection attempt and DNS question. A run
fails when either process looks up an Ever host (or any name outside the compose services), tries to
reach anything outside the sealed networks, the API answers a statistics route while the module is
off, or makes a call its mode does not allow.

In the modes `off`, `loaded_off` and `positive_stats` the **browser leg** runs as well: a real
browser (Chromium, in its own sniffed namespace on the same sealed networks) signs in through the web
app's sign-in page and opens every page of the web app. It fails when the browser looks up an Ever
host or any name outside the compose services, requests an Ever host, or renders a new link to one.

## The harness

The harness is the egress audit of the Ever Platform SDK, with its mock platform: the dev-only
[`@ever-co/connect-tools`](https://www.npmjs.com/package/@ever-co/connect-tools) package (Apache-2.0,
source in [`ever-co/ever-connect-sdk`](https://github.com/ever-co/ever-connect-sdk)). Nothing of it
is copied here: this directory is a small workspace package (`@ever-works/egress-audit`) whose only
dependency is that package, **pinned to one exact version** and installed from the repository's
lockfile. The workflow runs its `ever-egress-audit` bin; the statistics job against the mock runs
its `ever-mock-platform` bin. The browser leg is specified in the SDK's
[`docs/egress-audit.md`](https://github.com/ever-co/ever-connect-sdk/blob/main/docs/egress-audit.md).

| Pinned version | Where it is set                                               |
| -------------- | ------------------------------------------------------------- |
| `1.0.0-rc.7`   | `@ever-co/connect-tools` in `tools/egress-audit/package.json` |

The module itself uses `@ever-co/connect-sdk` and `@ever-co/connect-contracts` at the same
version (`apps/api`, `packages/agent`, `packages/contracts`); `drift.spec.ts` in the statistics
module fails when the pins in these four manifests differ. To move to a newer release, change them
together in one pull request and refresh the lockfile; the audit runs on it.

This directory holds only Works' inputs:

- `egress-audit.config.json` — the compose files, the API and web services (both captured), the
  statistics routes probed in the off modes, the browser leg's inputs (web address, idle pages, the
  positive control) and the Works modes `default_off` and `off_env_file`;
- `adapter.mjs` — what an operator and a person do: register the platform admin (the
  installation's first person), close the onboarding wizard, create one plain record of each kind a
  detail page shows (an organization, a team, a goal, an idea, a task, a meeting; the ids of a
  plugin, a workflow and a playbook of the catalogue), each best effort, and hand their ids to the
  walk; for `loaded_off` switch statistics off in Settings; in the off modes, call all six
  statistics routes with their own method (the
  harness's probe sends GET only) and require 404 from each; sign in through the web app's sign-in
  page and prove the session holds (in `positive_stats`, the operator's statistics section on Settings → Ever Platform must render, not its "unavailable" notice); per
  mode, `CI=true` so the module honours the modes' short send interval (otherwise raised to one
  hour);
- `compose.egress-audit.yml` — the images built from the commit, fake test-only values the
  production images need to start, the web app's address on the sealed network, the API's `.env`
  file of the mode, and no published port;
- `ui-routes.json` — every page of the web app, generated from the Next.js app router (see below);
- `route-params.json` — the values the walk fills the route parameters with: `en` for the locale,
  real values where a page needs one to render (a help article, a plugin category), and
  placeholders for the ids the adapter does not create (a page for an id that does not exist renders
  its not-found state, which the walk opens like any other page). Works, agents and missions stay
  placeholders: creating one starts background work (generation, runs) that needs AI providers and
  GitHub;
- `ui-baseline.json` — the links to an Ever host the web app already rendered when the browser leg
  was adopted (see below).

## Modes

| Mode             | The API                                                             | Passes when                                                                                     | Browser walk                                                         |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `default_off`    | nothing about statistics configured (off by default)                | no Ever host or unlisted name looked up, no connection attempt out, `/api/instance-stats/*` 404 | —                                                                    |
| `off`            | `EVER_STATS_ENABLED=false` in the container environment             | the same                                                                                        | every page, no Ever host                                             |
| `off_env_file`   | the same switch written ONLY in the API's `.env` file (`/app/.env`) | the same                                                                                        | —                                                                    |
| `loaded_off`     | module loaded (`EVER_STATS_ENABLED=true`), switched off in Settings | no request at all                                                                               | every page, no Ever host                                             |
| `positive_stats` | module on (`EVER_STATS_ENABLED=true`), `EVER_STATS_API_URL` = mock  | reports accepted (`202`), and no call but the statistics report                                 | every page, no Ever host; the operator's statistics section rendered |
| control          | `positive_stats` with the mock platform left out                    | must **fail** (exit 1): a green run is not a blind one                                          | as `positive_stats`                                                  |

The send interval is a few seconds in every mode but `loaded_off`, where it is 60 seconds (the
first send is due a minute after first boot, after the operator's switch-off), so a module that
should be silent but is not would try to send inside the watched window (two minutes after the
scenario).

## The route list

`ui-routes.json` is generated from the app router. CI fails when a page is added, moved or removed without regenerating it: on the pull request (`.github/workflows/egress-audit-routes.yml`, which runs on every pull request that touches `apps/web/src/app`) and on every push (the `routes` job of the audit):

```sh
tools/egress-audit/node_modules/.bin/ever-egress-audit ui-routes --framework next-app --entry apps/web/src/app --out tools/egress-audit/ui-routes.json
```

Run it again after adding or removing a page, and commit the result. A page that signs the person
out or changes the account belongs in `ui_skip_routes` in the config, with its reason.

One page is skipped today: `/:locale/templates`. Its template previews come from
`opengraph.githubassets.com` through the web app's image optimizer; inside the sealed network that
lookup fails, and Next.js logs the error as a multi-line object whose `code: 'ENOTFOUND'` line names
no host, so the audit cannot attribute it to the allowed host. The page returns to the walk once the
harness attributes such lines.

## Allowed third-party hosts

No Ever host and no analytics service can ever be allowed: the harness refuses them in the config
and fails on them whatever it says. The names below are third-party services that features of the
app (not the statistics module) look up; a lookup of any other name fails the run. None of them
answers inside the sealed network.

| Host                                                                                                              | Who looks it up      | Why                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `api.github.com`, `raw.githubusercontent.com`                                                                     | the API              | the template catalogue syncs the website templates it discovers on GitHub                          |
| `opengraph.githubassets.com`                                                                                      | the web app (server) | template previews, fetched by the image optimizer                                                  |
| `cdn.jsdelivr.net`, `unpkg.com`                                                                                   | the browser          | the animation player loads its WebAssembly from a CDN; plugin icons (dashboard-icons on jsDelivr)  |
| `challenges.cloudflare.com`                                                                                       | the browser          | the Cloudflare Turnstile script of the onboarding wizard (its built-in site key is the hosted one) |
| `framerusercontent.com`, `jina.ai`, `cdn.scrapfly.io`, `composio.dev`, `www.make.com`, `www.sim.ai`, `zapier.com` | the browser          | the logos of plugins on the plugins page, served by their vendors (favicon images)                 |

## The DOM baseline

`ui-baseline.json` lists the links to an Ever host the web app rendered when the browser leg was
adopted (`base_commit`): the documentation link of the dashboard navigation (`docs.ever.works`), the
Terms and Privacy links of the registration form (`ever.works`), and the statistics section's link to
the public description of what the module sends (rendered only while the module is loaded). Each
entry excuses that one link on that one page, and nothing else: never a lookup or a request. The
file may only shrink: CI fails when an entry is added (`check-baseline-shrink`), and the report lists
entries no longer seen under `stale_baseline`, so they can be removed.

## When it runs

`.github/workflows/egress-audit.yml`: on every push to `develop`, `stage` and `main`, on pull
requests that touch the statistics module, the web app's statistics page, the API or web image or
the self-hosting compose files, and on demand (`gh workflow run egress-audit.yml --ref <branch>`,
with `-f modes='["off"]'` for a subset). The images are built once; each mode then runs in its own
job, in parallel. The evidence of each mode — `report.json`, the pcaps, the DNS log, the API and web
logs, the mock's call record, and for the browser leg the HAR, the requests, the rendered references
and the pages visited — is uploaded as the `egress-audit-<mode>` artifact.

## Running it locally

Linux with Docker (the sniffers need `NET_RAW` and `NET_ADMIN`), Node.js 20 or later; the browser
leg pulls the pinned Playwright image (about 3.5 GB) on its first run:

```sh
pnpm install --frozen-lockfile --filter @ever-works/egress-audit

docker build -f .deploy/docker/api/Dockerfile -t ever-works-api:egress-audit .
docker build -f .deploy/docker/web/Dockerfile -t ever-works-web:egress-audit .

: > /tmp/api-empty.env
printf 'EVER_STATS_ENABLED=false\n' > /tmp/api-stats-off.env

EVER_WORKS_AUDIT_DOTENV=/tmp/api-empty.env \
  tools/egress-audit/node_modules/.bin/ever-egress-audit --config tools/egress-audit/egress-audit.config.json --mode default_off
EVER_WORKS_AUDIT_DOTENV=/tmp/api-empty.env \
  tools/egress-audit/node_modules/.bin/ever-egress-audit --config tools/egress-audit/egress-audit.config.json --mode off
EVER_WORKS_AUDIT_DOTENV=/tmp/api-stats-off.env \
  tools/egress-audit/node_modules/.bin/ever-egress-audit --config tools/egress-audit/egress-audit.config.json --mode off_env_file
```

In the positive mode the harness points the API at the mock platform's fixed address on the
sealed network (`__MOCK_URL__`, a private address the module accepts over `http`); the mock's
documents name the issuer `https://mock-platform.test` (`__MOCK_ISSUER__`), which the statistics
module does not read.

The real sender against the mock outside the audit (what the workflow's second job runs):

```sh
tools/egress-audit/node_modules/.bin/ever-mock-platform --host 127.0.0.1 --port 18080 &
(cd apps/api && EVER_STATS_MOCK_URL=http://127.0.0.1:18080 \
  npx jest src/instance-stats/__tests__/instance-stats.mock.itest.spec.ts)
```

Exit codes: `0` pass, `1` a violation, `2` the harness could not prove anything (for example the
capture was refused, a page never loaded, or the sign-in did not hold).
