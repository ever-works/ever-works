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

The harness is the public egress audit of the Ever Platform SDK,
[`ever-co/ever-connect-sdk`](https://github.com/ever-co/ever-connect-sdk) (Apache-2.0),
`tools/egress-audit` with the mock platform from `tools/mock-platform`. It is not copied here and
not installed from a registry: the workflow checks the SDK out at a **pinned commit** and installs
the harness's own dependencies from the SDK's lockfile.

| Pinned commit                              | Where it is set                                                |
| ------------------------------------------ | -------------------------------------------------------------- |
| `2fd74dad9357a18471292f38012a5f5e4e6d2938` | `EVER_CONNECT_SDK_SHA` in `.github/workflows/egress-audit.yml` |

To move to a newer harness, change that one value in a pull request; the audit runs on it.

This directory holds only Works' inputs:

- `egress-audit.config.json` — the compose files, the API service, the statistics routes probed
  in the off modes, and the Works mode `off_env_file`;
- `adapter.mjs` — what an operator does: for `loaded_off`, register the platform admin and switch
  statistics off in Settings; per mode, `CI=true` so the module honours the modes' short send
  interval (otherwise raised to one hour);
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
git clone https://github.com/ever-co/ever-connect-sdk .egress-audit/sdk
git -C .egress-audit/sdk checkout 2fd74dad9357a18471292f38012a5f5e4e6d2938
(cd .egress-audit/sdk && corepack enable && pnpm install --frozen-lockfile --filter ./tools/egress-audit)

docker build -f .deploy/docker/api/Dockerfile -t ever-works-api:egress-audit .

: > /tmp/api-empty.env
printf 'EVER_STATS_ENABLED=false\n' > /tmp/api-stats-off.env

EVER_WORKS_AUDIT_DOTENV=/tmp/api-empty.env \
  node .egress-audit/sdk/tools/egress-audit/run.mjs --config tools/egress-audit/egress-audit.config.json --mode off
EVER_WORKS_AUDIT_DOTENV=/tmp/api-stats-off.env \
  node .egress-audit/sdk/tools/egress-audit/run.mjs --config tools/egress-audit/egress-audit.config.json --mode off_env_file
```

Exit codes: `0` pass, `1` a violation, `2` the harness could not prove anything (for example the
capture was refused).
