---
id: anonymous-statistics
title: Anonymous usage statistics
sidebar_label: Anonymous usage statistics
description: The one small, signed, anonymous report an Ever Works installation sends each day — exactly what is in it, what never is, when it is sent, how to switch it off and how to check every byte yourself.
---

# Anonymous usage statistics

**Audience:** operators of self-hosted Ever Works installations; privacy and security reviewers.
**Prerequisites:** the platform admin account of the installation (for the settings page), and shell access if you want to change environment variables.

The statistics module sends **one small, signed, anonymous report a day** so the maintainers can learn which versions and features are in use. It is on by default, it can be switched off in two ways, you can see every byte it sent, and it can never carry your business data: the report format is a closed schema, and every string in it must match an allow-list.

## 1. What is sent

One JSON document per day, schema `ever.stats.v1`, at most 16 KiB, integers only for numbers. A real Ever Works report:

```json
{
	"schema": "ever.stats.v1",
	"report_id": "63d8c277-7fa0-4f5d-a5a7-c88fc94e6186",
	"instance_id": "41b54444-0795-416c-bdb8-72fe2925a157",
	"sent_at": "2026-11-02",
	"module_version": "1.0.0",
	"product": "works",
	"instance_kind": "backend",
	"serves": ["works"],
	"version": "1.4.2",
	"channel": "stable",
	"install_source": "self-hosted",
	"country": "ZZ",
	"period": "2026-11",
	"final": false,
	"counts": {
		"users": 1,
		"tenants": 1,
		"organizations": 1,
		"works": 3,
		"agents": 1,
		"missions": 1,
		"teams": 1,
		"fleet_nodes": 0,
		"plugins_enabled": 12,
		"works_by_kind": {
			"website": 1,
			"landing_page": 0,
			"blog": 0,
			"directory": 1,
			"awesome_repo": 0,
			"repo": 0,
			"company": 0,
			"campaign": 0,
			"default": 0,
			"app": 1,
			"other": 0
		}
	},
	"features": {
		"app_works_enabled": true,
		"app_launcher_enabled": false,
		"dynamic_plugins": false,
		"deploy_ever_works_enabled": false,
		"subscriptions_enabled": false,
		"mcp_enabled": false
	},
	"aggregates": {
		"deployments": 4,
		"deployments_by_provider": {
			"ever_works": 0,
			"vercel": 3,
			"k8s": 1,
			"your_cluster": 0,
			"ever_works_apps": 0,
			"other": 0
		},
		"runs": 27,
		"credits_consumed": 410
	}
}
```

| Field                                | Meaning                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_id`                        | a random UUID your installation generates on first boot; not derived from a URL, host name or licence; you can reset it (§5)                                                                 |
| `product`, `instance_kind`, `serves` | always `works`, `backend`, `["works"]` for Ever Works                                                                                                                                        |
| `sent_at`                            | the UTC date the report was built; no time of day, so a report cannot be matched to a request log line                                                                                       |
| `version`, `module_version`          | the product version and the statistics module version, both `major.minor.patch` only — a build suffix (for example `1.2.3-acme-corp`) could name a company, so it is never sent              |
| `channel`                            | `stable`, `rc`, `beta`, `dev` or `custom`: the module turns any suffix of the version into one of these                                                                                      |
| `install_source`                     | `self-hosted` unless you set `EVER_INSTALL_SOURCE` (`cloud`, `ever.sh`, `works_app`, `desktop`, `partner:<slug>`, where `<slug>` is the id of a published partner template) — never guessed  |
| `country`                            | `ZZ` (not declared) unless you set `EVER_STATS_COUNTRY`; never derived from your data or your address                                                                                        |
| `period`, `final`                    | the UTC month the numbers cover; `final: true` on the one re-send for the previous month (days 1–3)                                                                                          |
| `counts`                             | installation-wide totals at the time of the report: people (guest accounts excluded), tenants, organizations, Works and Works per kind, agents, missions, teams, fleet nodes, loaded plugins |
| `features`                           | which product switches are on (booleans only)                                                                                                                                                |
| `aggregates`                         | totals for the month: deployments and deployments per provider, agent runs, credits consumed                                                                                                 |

Every installation sends the same fields whatever its size — a one-person installation included. The keys of the nested maps (`works_by_kind`, `deployments_by_provider`) come from closed lists: a kind or a deployment provider the list does not name (a custom provider plugin, say) is counted under `other`, never under its own name.

The schema is published in the open-source [`ever-connect-sdk`](https://github.com/ever-co/ever-connect-sdk) repository (`contracts/schemas/ever.stats.v1.json`, SHA-256 `0cd746f7dec75117a6b812b7a832f9ceca4c97a6ecf65d22d6967a6475efc6e5`). Ever Works carries a byte-for-byte copy and a test that fails if it differs. The schema closes every object (`additionalProperties: false`), so no unknown field can be added by accident, and Ever Platform refuses anything off-schema.

### 1.1 What is never included

Names of people or companies, e-mail addresses, phone numbers, postal addresses, IP addresses or host names, account, tenant, organization or Work identifiers, the contents of Works, documents, prompts or messages, individual records or amounts, URLs, free text of any kind, precise location. The only string fields are `schema`, `report_id`, `instance_id`, `sent_at`, `module_version`, `product`, `instance_kind`, `serves`, `version`, `channel`, `install_source`, `country` and `period`, each constrained by a pattern or a list. Tests in the repository build a report from a database in which every text column of the tables the report reads holds a unique marker, and fail if any marker appears in the bytes that would be sent.

## 2. When it is sent

- Once per UTC day, at a second drawn at random for each report, starting one day after the installation's first boot (ten minutes after boot if the installation was down so long that a report is overdue by more than a day).
- On days 1–3 of a month, one more report: the `final: true` report for the previous month.
- If the receiver cannot be reached or answers with a server error, a rate limit or a request timeout (`408`), the module retries after 1 h, 4 h and 12 h, then at the next day's slot.
- A report the receiver refuses as invalid (`422`), or because another key holds the `instance_id` (`409`), is not retried until a release changes the Ever Works version or the statistics module version — or, for `409`, until you reset the identity (§5). Any other refusal (a redirect, `401`, `403`, `404`, …) is retried after 7 days.
- _Send now_ (§5) sends one more report each time the operator uses it.
- Installations with several API replicas on one database elect one sender through a database lease: the replicas together send what a single API would, never one report per replica.

So the scheduled traffic is one request a day — two on days 1–3 of a month — plus up to three retries on a day a delivery failed, and one request for each _Send now_.

The request is `POST <EVER_STATS_API_URL>/v1/stats/reports` with `Content-Type: application/json`, no cookie and no credential, no redirects followed, and three headers:

| Header                 | Value                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| `Ever-Stats-Key`       | the statistics public key: base64url (no padding) of the 32 Ed25519 key bytes |
| `Ever-Stats-Signature` | `ed25519=` and the base64url signature over the exact request body            |
| `Ever-Stats-Key-Id`    | base64url of the first 8 bytes of SHA-256 over the public key                 |

The statistics key is an Ed25519 key pair your installation generates on first boot for statistics only. Its private half never leaves the installation. It is stored encrypted when `PLUGIN_SECRET_ENCRYPTION_KEY` is set — set it in production; a key stored before you set it is encrypted at the next restart. Without it the key is stored unencrypted in the database: the API logs `key_stored_unencrypted` at boot and the settings page says so. If you later remove or change `PLUGIN_SECRET_ENCRYPTION_KEY`, the stored key cannot be read: nothing is sent, the page shows the reason, and restoring the key or _Reset instance identity_ fixes it. Ever Platform remembers the public key the first time it sees an `instance_id`, so nobody else can send reports under that id. The key proves continuity, not identity: nothing about it says who you are.

The `User-Agent` is `ever-stats/<module version> (works/<version>)`.

## 3. Defaults

| Where                    | Default                                               | Who can change it                                           |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------- |
| Self-hosted installation | **on**                                                | the operator: the environment variable or the settings page |
| Ever Works cloud         | managed by Ever ("Managed by Ever Cloud" on the page) | Ever                                                        |

People and organization admins inside an installation cannot change it: it is a setting of the whole installation, held by its platform admin. The settings page tells everyone else who manages it: "managed by the instance operator", or "managed by Ever Cloud" on an installation that declares `EVER_INSTALL_SOURCE=cloud`.

## 4. How to switch it off

### 4.1 Environment: the module is not loaded

Set `EVER_STATS_ENABLED=false` and restart the API. The module is not loaded at all: no route, no timer, no request; every `/api/instance-stats/*` route answers 404, and the **Ever Platform** settings tab is not shown. Any value other than empty or `true` also switches it off.

Set it where the API reads its settings: in `.env.compose` with the Docker Compose files (a `.env` next to them only fills in placeholders of the compose file and never reaches the containers), in `apps/api/.env` when you run the API from source, or in the container or pod environment. A value already in the environment wins over the `.env` file.

### 4.2 Settings: the module is loaded and sends nothing

**Settings → Ever Platform** (`/settings/ever-platform`) → _Send anonymous usage statistics_. With the switch off, the module makes **no** request at all and _Send now_ is disabled. The switch, _Send now_ and _Reset instance identity_ each add an entry to the Activity log with who did it and nothing else, and each needs the platform admin signed in to the web app: an API key or an automation acting as the admin is refused (`403`), so nothing but a person can switch statistics back on.

## 5. How to see what is sent

The same settings page, for the platform admin:

| Element                     | What it shows                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Show what would be sent** | a report built right now from your database; nothing leaves the server (`POST /api/instance-stats/preview`)                             |
| **Last payload**            | the exact bytes of the last report as they were posted, with the time, the outcome and the HTTP status (`GET /api/instance-stats/last`) |
| **Send now**                | sends one report immediately, at most once per 10 minutes; unavailable while the switch is off                                          |
| **Reset instance identity** | a new random `instance_id` and a new statistics key, so future reports cannot be linked to past ones                                    |

Anyone else signed in to the installation sees only whether statistics are on, and that the instance operator manages them.

## 6. Verify it yourself

Watch every connection attempt of the API container, for example with statistics switched off:

```sh
# In .env.compose (or your environment): EVER_STATS_ENABLED=false, then
docker compose up -d
# Every new outgoing TCP connection and DNS query of the API container:
docker run --rm --net container:ever-works-api nicolaka/netshoot tcpdump -n '(tcp[tcpflags] & tcp-syn != 0) or udp port 53'
```

With statistics off you will see no query for an Ever host and no connection to one. With them on, you will see the connections §2 lists — one a day to the statistics endpoint, a second one on days 1–3 of a month, retries after a failed delivery and one per _Send now_ — and nothing else from this module.

The repository runs the same check in CI on every push to `develop`, `stage` and `main`: an egress audit boots the API image on a Docker network with no route out and records every DNS query and connection attempt, with statistics off through the environment and through `.env`, and on against a mock receiver (where the only call allowed is the report itself).

You can also run the stack on a Docker network created with `docker network create --internal`, which has no route out at all: the installation keeps working, and the settings page shows the daily report as not delivered.

## 7. Reference

| Item        | Value                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint    | `POST {EVER_STATS_API_URL}/v1/stats/reports` (default base: `EVER_PLATFORM_API_URL`, then `https://api.ever.co`)                                                                                                                                      |
| Schema      | `ever.stats.v1` — JSON Schema 2020-12, closed, ≤ 16 KiB, integers only                                                                                                                                                                                |
| Answers     | `202` accepted; `422` refused by the schema (the refused paths are shown under _Last payload_); `409` the `instance_id` is held by another key — use _Reset instance identity_; `408`, `429` or `5xx` retried; any other refusal retried after 7 days |
| Environment | `EVER_STATS_ENABLED`, `EVER_STATS_API_URL`, `EVER_PLATFORM_API_URL`, `EVER_STATS_COUNTRY`, `EVER_INSTALL_SOURCE`, `EVER_STATS_SEND_INTERVAL_S` (tests only below one hour), `EVER_WORKS_STATS_SINK`                                                   |
| Routes      | `GET /api/instance-stats/status`, `POST /api/instance-stats/preview`, `GET /api/instance-stats/last`, `POST /api/instance-stats/send-now`, `PUT /api/instance-stats/toggle`, `POST /api/instance-stats/reset-identity`                                |
| Delivery    | the `stats-sink` plugin capability; the built-in sender is the hidden `ever-stats-sink` plugin, and `EVER_WORKS_STATS_SINK` selects another one                                                                                                       |
