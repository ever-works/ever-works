# Egress audit

A runtime proof of what the anonymous usage statistics module may send
([Anonymous usage statistics](../../docs/ever-platform/anonymous-statistics.md)): **nothing at all**
when it is switched off, and **only the statistics report** when it is on.

The audit runs the API image built from the commit under test with the self-hosting compose file
(`docker-compose.yml`), on Docker networks that have no route out. CoreDNS is the API's only
resolver and logs every query; a `tcpdump` sniffer in the API's network namespace starts before the
API and records every connection attempt and DNS question. A run fails when the API looks up an
Ever host (or any name outside the compose services), tries to reach anything outside the sealed
networks, answers a statistics route while the module is off, or makes a call its mode does not
allow.

## The harness

The harness is the egress audit of the Ever Platform SDK, with its mock platform: the dev-only
[`@ever-co/connect-tools`](https://www.npmjs.com/package/@ever-co/connect-tools) package (Apache-2.0,
source in [`ever-co/ever-connect-sdk`](https://github.com/ever-co/ever-connect-sdk)). Nothing of it
is copied here: this directory is a small workspace package (`@ever-works/egress-audit`) whose only
dependency is that package, **pinned to one exact version** and installed from the repository's
lockfile. The workflow runs its `ever-egress-audit` bin; the statistics job against the mock runs
its `ever-mock-platform` bin.

| Pinned version | Where it is set                                               |
| -------------- | ------------------------------------------------------------- |
| `1.0.0-rc.2`   | `@ever-co/connect-tools` in `tools/egress-audit/package.json` |

The module itself uses `@ever-co/connect-sdk` and `@ever-co/connect-contracts` at the same
version (`apps/api`, `packages/agent`, `packages/contracts`); `drift.spec.ts` in the statistics
module fails when the pins in these four manifests differ. To move to a newer release, change them
together in one pull request and refresh the lockfile; the audit runs on it.

This directory holds only Works' inputs:

- `egress-audit.config.json` — the compose files, the API service, the statistics routes probed
  in the off modes, and the Works mode `off_env_file`;
- `adapter.mjs` — what an operator does: for `loaded_off`, register the platform admin and switch
  statistics off in Settings; in the off modes, call all six statistics routes with their own
  method (the harness's probe sends GET only) and require 404 from each; per mode, `CI=true` so
  the module honours the modes' short send interval (otherwise raised to one hour);
- `compose.egress-audit.yml` — the image built from the commit, fake test-only values the
  production image needs to start, the API's `.env` file of the mode, and no published port.

## Modes

| Mode             | The API                                                             | Passes when                                                                    |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `off`            | `EVER_STATS_ENABLED=false` in the container environment             | no Ever host looked up, no connection attempt out, `/api/instance-stats/*` 404 |
| `off_env_file`   | the same switch written ONLY in the API's `.env` file (`/app/.env`) | the same                                                                       |
| `loaded_off`     | module loaded, switched off in Settings by the platform admin       | no request at all                                                              |
| `positive_stats` | module on, `EVER_STATS_API_URL` = the mock platform                 | reports accepted (`202`), and no call but the statistics report                |
| control          | `positive_stats` with the mock platform left out                    | must **fail** (exit 1): a green run is not a blind one                         |

In every mode the send interval is a few seconds, so a module that should be silent but is not
would try to send inside the watched window (two minutes after the scenario).

## When it runs

`.github/workflows/egress-audit.yml`: on every push to `develop`, `stage` and `main`, on pull
requests that touch the statistics module, the API image or the self-hosting compose files, and
on demand (`gh workflow run egress-audit.yml --ref <branch>`). The evidence — `report.json`, the
pcaps, the DNS log, the API log and the mock's call record per mode — is uploaded as the
`egress-audit` artifact.

## Running it locally

Linux with Docker (the sniffer needs `NET_RAW` and `NET_ADMIN`), Node.js 20 or later:

```sh
pnpm install --frozen-lockfile --filter @ever-works/egress-audit

docker build -f .deploy/docker/api/Dockerfile -t ever-works-api:egress-audit .

: > /tmp/api-empty.env
printf 'EVER_STATS_ENABLED=false\n' > /tmp/api-stats-off.env

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
capture was refused).
