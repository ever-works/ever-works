---
id: fleet-cloud-computers
title: Cloud computers in your Fleet
sidebar_label: Cloud computers
description: Create a machine at a cloud provider, on your own account, with the price shown before you say yes — it installs the Ever Works node, enrols itself and shows what it has cost.
---

# Cloud computers

A **cloud computer** is a computer Ever Works creates for you at a cloud provider, through a provider plugin,
with its price shown before you create it. It installs the Ever Works node on first boot and enrols itself, so it
appears in the [Fleet hub](./fleet-hub.md) as an ordinary computer: it takes work, hosts sessions, shows its logs
and services, and is covered by the kill switch. The provider bills **your own account**; Ever Works charges nothing
for it and keeps **no password or key** for the machine.

The first provider is DigitalOcean (the `digitalocean-machines` plugin).

:::info Status: shipped behind a flag

Cloud computers ship behind `FLEET_CLOUD_ENABLED` (default off), on top of `FLEET_ENABLED` and `FLEET_HUB_ENABLED`.
With it off every `/api/fleet/providers` and `/api/fleet/cloud` route answers 404 and the menu item is absent. The
deployment must also know the address a new machine enrols against: `FLEET_NODE_API_URL` (or `PLATFORM_API_URL`).

:::

## Connect a provider

1. Open **Plugins**, enable **DigitalOcean Machines** and save a personal access token with **read and write**
   scope. The token is a secret setting of your own account: it is never shown again, logged or written to an audit
   row.
2. In **Fleet → Computers**, choose **Add computer ▾ → New cloud computer…**. With no provider connected the dialog
   says so and links to Plugins.

**Or sign in instead of pasting a token.** Where the operator registered an OAuth application with the provider (see
_Operator setup_ below), the dialog offers **Sign in with DigitalOcean**: you approve access at DigitalOcean and come
back to the dialog, connected. A token you saved still wins over a sign-in. A sign-in lasts as long as the provider's
token does (30 days at DigitalOcean); sign in again, or save a token, when it runs out.

## Create one

The dialog lists the providers you connected (with the account they are connected to), then:

- **Name** — 2–39 lower-case letters, digits and hyphens; also the machine's name at the provider.
- **Region** and **Size** — each size with its **monthly and hourly list price**, read from the provider when the
  dialog opens (cached for 10 minutes).
- **Software** — Docker, Node.js, Claude Code and Codex, all ticked by default. Node.js is always installed: the
  node runtime needs it.

Before **Create · $24/mo** the dialog states the price and the billing rule: _about $24/month ($0.036/hour), billed
by the provider to your account from the moment it exists until you destroy it — also while powered off._ If the
provider's price changed while the dialog was open, Create is refused and the dialog reloads the prices and asks
again.

Create answers at once. The row appears with its progress — asking the provider → booting → installing → enrolling →
online — and the machine is usually online within five minutes. Ever Works writes the Fleet registration **before**
it asks the provider, tags the machine with that registration's id, and hands the machine a one-time enrolment token
that expires after 15 minutes; the machine reads it from a private file, enrols, and deletes it.

At most **10** cloud computers per owner.

### The overlay-VPN client

When the operator configured an overlay-VPN client (see _Operator setup_), the software list offers it. Tick it and,
optionally, paste a **one-time auth key**: the first-boot script installs the client and joins your network with it.
The key is handed to the machine once, as a private file the script deletes; Ever Works never stores it, shows it
again, logs it or writes it to an audit row. Agents and the command line cannot pass a key.

## What the page shows

A cloud computer's Overview carries a **Cloud** block: provider, region, size, whether it is running, powered off,
being created or gone, and what it costs — **per hour, this month, since it was created, and the projected month**
(capped at the monthly price). Every figure is an **estimate from the provider's list prices; your bill may differ**.
Cloud spend is never counted against model-spend budgets or the fleet model-cost ceiling.

The figures are refreshed every ten minutes. Where the provider plugin can read your account's own month-to-date figure,
it is shown beside the estimate and labelled as the provider's — it covers everything on that account, not only the
machines Ever Works created.

## What they cost together

The Fleet hub's Overview carries a **Cloud computers** block: what your cloud computers bill per hour right now, this
month so far — **machines destroyed this month still count** — the projected month, and a row per machine (destroyed
ones last, marked "destroyed — still counted this month"). The same estimate disclaimer applies.

## Idle policy

Every cloud computer has an idle policy, shown in its Cloud block with **Change**:

- **Nothing** — never mind;
- **Tell me after N hours** (the default, 3 hours) — the hub shows _"fra-nina has been idle for 4 h · $0.28 while
  idle"_ with **Power off…**, and one Inbox item arrives for that stretch of idleness; the Cloud block offers
  **Keep running**, which starts the count again;
- **Power off after N hours** — Ever Works powers the machine off, records it in the Fleet audit as done by
  `system:idle-policy`, and the hub shows _"fra-nina was powered off after 2 h idle — it still bills while off"_ with
  **Power on…**.

N is a whole number from 1 to 72. **Idle** means, for the whole time: no session working or waiting for you, no job
running, and the CPU under 5 % in every health sample. A powered-off machine, or one still being created, is never
idle. Changing the policy starts the count again from that moment. **Ever Works never destroys a cloud computer on its
own** — the policy can only tell you or power the machine off.

## Power off, power on, destroy

- **Power off** asks first and says whether the provider still bills the machine while it is off (DigitalOcean does).
  Sessions on it end.
- **Power on** brings it back; it is online again after its next heartbeat. Refused while the Fleet is stopped.
- **Destroy…** states the cost so far and the creation date and asks you to type the name. The machine and its disk
  are deleted at the provider, then its Fleet registration; job history is kept. Refused while a Run or a session is
  live on it. Power off and Destroy stay available while the Fleet is stopped — they stop spending.

## Why "Remove from Fleet" is disabled

Removing a registration leaves the machine behind — and a cloud machine keeps billing until it is destroyed. So for a
cloud computer **Remove from Fleet** is disabled with the line _"Cloud computers are destroyed, not removed, so a machine
you pay for is never left behind"_, and the server refuses it (`unsupported_on_node`, "destroy it instead"). It becomes
available when the provider reports the machine gone (destroyed outside Ever Works), or when the create failed before
any machine existed.

## Needs a look

- **Never came online** — the provider runs the machine but it has not enrolled ten minutes after the create: the hub
  shows _"nyc-ops never came online and is billing $0.036/h"_ with **Destroy…**.
- **Could not be created** — the provider refused (for example a droplet limit); its first line is shown, nothing bills.
- **Gone at the provider** — destroyed outside Ever Works; it no longer bills and can be removed.
- **Idle for N hours** and **powered off after N hours idle** — from the idle policy (above).
- **Unclaimed machine at DigitalOcean — tagged ever-works** — once an hour Ever Works asks the provider for every
  machine carrying its tags. A machine whose registration never learned its id is repaired in place. A machine that
  carries **this** deployment's tags but no registration (for example, the create was given up on, then the provider
  finished it) is added to your Fleet as **unclaimed**, with its price where the provider names its size, so you see
  the bill and can **Destroy…** it. Machines tagged by another Ever Works deployment on the same account are never
  touched.

## Agents, MCP and the API

Agents use `fleet_cloud_list`, `fleet_cloud_options` and `fleet_cloud_usage` (read-only) and `fleet_cloud_create`,
`fleet_cloud_power`, `fleet_cloud_destroy` and `fleet_cloud_idle_policy`. A create needs `acknowledgedPriceCents` —
the monthly price the Agent read — and is refused when the price changed. Create, power changes, destroy and idle-policy
changes are **always held for your approval** in My Decisions, with the exact size and price (or the policy change). On
MCP the four acts register only when the operator sets `MCP_PRIVILEGED_TOOLS=true`.

| Route                                                 | What it does                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/fleet/providers`                            | The machine providers enabled for you                                |
| `GET /api/fleet/providers/:plugin/options`            | Regions, sizes with list prices, software, account                   |
| `GET /api/fleet/cloud` · `GET /api/fleet/cloud/usage` | Your cloud computers and their cost                                  |
| `POST /api/fleet/cloud`                               | Create (`acknowledgedPriceCents`, `confirm: true`)                   |
| `POST /api/fleet/cloud/:id/power`                     | `on` · `off` (`confirm: true`)                                       |
| `POST /api/fleet/cloud/:id/destroy`                   | Destroy (`confirmName`)                                              |
| `GET /api/fleet/cloud/:id/usage`                      | One cloud computer's cost                                            |
| `PUT /api/fleet/cloud/:id/idle-policy` (or `PATCH`)   | `mode` (`nothing`, `tell-me` or `power-off`) and `afterHours` (1–72) |
| `POST /api/fleet/cloud/:id/keep-running`              | Start the idle count again                                           |

## From the command line

```bash
ever-works fleet cloud providers
ever-works fleet cloud options digitalocean-machines          # prices; the last column is --acknowledge-price
ever-works fleet cloud create nyc-ops --provider digitalocean-machines --region nyc3 --size s-2vcpu-4gb \
    --acknowledge-price 2400 --yes
ever-works fleet cloud list
ever-works fleet cloud usage [nyc-ops]
ever-works fleet cloud power nyc-ops off --yes
ever-works fleet cloud idle-policy nyc-ops power-off --after 2
ever-works fleet cloud destroy nyc-ops --confirm-name nyc-ops
```

Every verb takes `--json` (the API's own answer in `{ ok, data }`) and exits 0 / 1 / 2. `create` without
`--acknowledge-price` exits 2 before anything is sent.

## Operator setup

| Variable                                                           | What it does                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_CLOUD_ENABLED`                                              | Switches cloud computers on (default off).                                                                                                                                                                      |
| `FLEET_NODE_API_URL`                                               | The public API origin new machines enrol against (else `PLATFORM_API_URL`). Its hash is also the deployment's site tag on every machine.                                                                        |
| `DIGITALOCEAN_OAUTH_CLIENT_ID`, `DIGITALOCEAN_OAUTH_CLIENT_SECRET` | Offer **Sign in with DigitalOcean** (or the plugin's admin-only `clientId` / `clientSecret` settings). Register the application's redirect URI as `<app URL>/api/oauth/digitalocean-machines/callback/plugins`. |
| `FLEET_CLOUD_OVERLAY_VPN_INSTALL_URL`                              | An `https://` script that installs your overlay-VPN client; without it the preset is not offered.                                                                                                               |
| `FLEET_CLOUD_OVERLAY_VPN_JOIN_COMMAND`                             | The client's join command, an absolute path with a `{keyFile}` placeholder (for example `/usr/bin/vpn-client up --auth-key-file={keyFile}`); without it the client is installed but no key is accepted.         |
| `EVER_WORKS_NODE_CLOUD_RUNTIME_SPEC`                               | Pins another node runtime than the default the bootstrap installs.                                                                                                                                              |
