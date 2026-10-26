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

## Create one

The dialog lists the providers you connected (with the account they are connected to), then:

- **Name** — 2–39 lower-case letters, digits and hyphens; also the machine's name at the provider.
- **Region** and **Size** — each size with its **monthly and hourly list price**, read from the provider when the
  dialog opens (cached for 10 minutes).
- **Software** — Docker, Node.js, Claude Code and Codex, all ticked by default. Node.js is always installed: the
  node runtime needs it.

Before **Create · $24/mo** the dialog states the price and the billing rule: *about $24/month ($0.036/hour), billed
by the provider to your account from the moment it exists until you destroy it — also while powered off.* If the
provider's price changed while the dialog was open, Create is refused and the dialog reloads the prices and asks
again.

Create answers at once. The row appears with its progress — asking the provider → booting → installing → enrolling →
online — and the machine is usually online within five minutes. Ever Works writes the Fleet registration **before**
it asks the provider, tags the machine with that registration's id, and hands the machine a one-time enrolment token
that expires after 15 minutes; the machine reads it from a private file, enrols, and deletes it.

At most **10** cloud computers per owner.

## What the page shows

A cloud computer's Overview carries a **Cloud** block: provider, region, size, whether it is running, powered off,
being created or gone, and what it costs — **per hour, this month, since it was created, and the projected month**
(capped at the monthly price). Every figure is an **estimate from the provider's list prices; your bill may differ**.
Cloud spend is never counted against model-spend budgets or the fleet model-cost ceiling.

## Power off, power on, destroy

- **Power off** asks first and says whether the provider still bills the machine while it is off (DigitalOcean does).
  Sessions on it end.
- **Power on** brings it back; it is online again after its next heartbeat. Refused while the Fleet is stopped.
- **Destroy…** states the cost so far and the creation date and asks you to type the name. The machine and its disk
  are deleted at the provider, then its Fleet registration; job history is kept. Refused while a Run or a session is
  live on it. Power off and Destroy stay available while the Fleet is stopped — they stop spending.

## Why "Remove from Fleet" is disabled

Removing a registration leaves the machine behind — and a cloud machine keeps billing until it is destroyed. So for a
cloud computer **Remove from Fleet** is disabled with the line *"Cloud computers are destroyed, not removed, so a machine
you pay for is never left behind"*, and the server refuses it (`unsupported_on_node`, "destroy it instead"). It becomes
available when the provider reports the machine gone (destroyed outside Ever Works), or when the create failed before
any machine existed.

## Needs a look

- **Never came online** — the provider runs the machine but it has not enrolled ten minutes after the create: the hub
  shows *"nyc-ops never came online and is billing $0.036/h"* with **Destroy…**.
- **Could not be created** — the provider refused (for example a droplet limit); its first line is shown, nothing bills.
- **Gone at the provider** — destroyed outside Ever Works; it no longer bills and can be removed.

## Agents, MCP and the API

Agents use `fleet_cloud_list`, `fleet_cloud_options` and `fleet_cloud_usage` (read-only) and `fleet_cloud_create`,
`fleet_cloud_power`, `fleet_cloud_destroy`. A create needs `acknowledgedPriceCents` — the monthly price the Agent read
— and is refused when the price changed. Create, power changes and destroy are **always held for your approval** in My
Decisions, with the exact size and price. On MCP the three acts register only when the operator sets
`MCP_PRIVILEGED_TOOLS=true`.

| Route | What it does |
| --- | --- |
| `GET /api/fleet/providers` | The machine providers enabled for you |
| `GET /api/fleet/providers/:plugin/options` | Regions, sizes with list prices, software, account |
| `GET /api/fleet/cloud` · `GET /api/fleet/cloud/usage` | Your cloud computers and their cost |
| `POST /api/fleet/cloud` | Create (`acknowledgedPriceCents`, `confirm: true`) |
| `POST /api/fleet/cloud/:id/power` | `on` · `off` (`confirm: true`) |
| `POST /api/fleet/cloud/:id/destroy` | Destroy (`confirmName`) |

## Coming next

The idle policy (tell me, or power off after N idle hours), the provider's own month-to-date figure and a Usage-tab
block, sign-in with the provider, the overlay-VPN preset, unclaimed-machine detection and the `ever-works fleet cloud`
CLI.
