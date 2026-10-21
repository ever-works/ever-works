# FL-17 — Cloud computers: machine-provider plugins, cost, idle policy

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. Substrate citations (`path:Lnn`) appear only as evidence for "we do not
> have this today" claims (program rule 13). Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-17-cloud-computers`
**Program:** [Fleet](../README.md) · Wave 3 (creating machines)
**Branch:** `feat/fl-17-cloud-computers`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** FL-03 (health samples, "needs a look" producers), FL-01 (hub, Usage tab shell, module registry) · **Related:** FL-16 (shares the `origin` column), FL-19 (tool parity), FL-20 (Usage tab), AW-15 (connections & scopes), AW-17 (costs & caps)
**Extends (existing Ever Works nouns):** Node · Fleet · Plugin · Plugin settings · Enrolment token · Budget · Inbox · Fleet audit · Needs a look · Organization

---

## 0. TL;DR

A **cloud computer** is a Node that Ever Works creates for you at a cloud provider, through a plugin,
with its price shown before you say yes. You pick a provider, a region, a size (monthly and hourly
price beside it), the software you want preinstalled, and press Create; the provider boots a
machine whose first-boot script installs `ever-works-node` and enrols it with a one-time token minted
for it — so it appears in the Fleet as an ordinary Node with `origin: cloud`, leasable, manageable,
watchable, and **never holding a credential the platform keeps**. Its page always answers "what has
this cost?" — hourly rate, this month, since created, projected month — and offers power on/off and
destroy (which states the cost so far). Because a cloud machine bills until it is destroyed, **Remove
from Fleet** is refused for one until the provider reports the machine gone (CONTRACTS R-36 — an
additive guard, the action itself stays); an idle policy can tell you about an idle machine or power
it off after N hours, but never destroys anything by itself.

```
 FLEET HUB › Computers                                         [+ Add computer ▾]
                                                               │ Enrol a computer…
                                                               │ New virtual computer…  (FL-16)
                                                               │ New cloud computer…    ◀ this epic
 ┌─────────────────────────────────────────────────────────────────────────────────────┐
 │ build-01    ● online  Linux    2 sessions                                            │
 │ nyc-ops     ● online  Linux    Cloud computer · DigitalOcean · nyc3 · $24/mo · $3.10 │
 │ fra-nina    ◌ idle 4 h Linux   Cloud computer · DigitalOcean · fra1 · $48/mo · $11.60│
 └─────────────────────────────────────────────────────────────────────────────────────┘

 NEW CLOUD COMPUTER
 ┌─────────────────────────────────────────────────────────────────────────────────────┐
 │ Provider   [ DigitalOcean ▾ ]  (connected as acme)                                  │
 │ Name       [ nyc-ops                ]                                               │
 │ Region     [ New York 3 (nearest) ▾ ]                                               │
 │ Size       ( ) 1 CPU · 2 GB · 50 GB        $12/mo   ($0.018/h)                      │
 │            (•) 2 CPU · 4 GB · 80 GB        $24/mo   ($0.036/h)                      │
 │            ( ) 4 CPU · 8 GB · 160 GB       $48/mo   ($0.071/h)                      │
 │ Software   [x] Docker  [x] Node.js  [x] Claude Code  [x] Codex  [ ] overlay-VPN client│
 │                                                                                     │
 │ About $24/month ($0.036/hour), billed by DigitalOcean to your account from the      │
 │ moment it exists until you destroy it — also while powered off. Ever Works stores   │
 │ no password or key for this machine; it enrols itself as its own computer.          │
 │                                                [ Cancel ]   [ Create · $24/mo ]     │
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

Three phases, each independently shippable:

| Phase  | Ships                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | The `machine-provider` plugin category + capability, the facade, the first plugin (DigitalOcean, API token), the create dialog with the price statement, self-enrolment, the machine block, power on/off, destroy with cost so far, the Remove guard (R-36), audit, Agent tools |
| **P2** | Cost: hourly / month-to-date / since-created / projected on the page and in the hub **Usage** tab; the idle policy (nothing · tell me · power off after N hours) evaluated by a platform job; the `cloud-idle` producer; `fleet_cloud_usage`                                    |
| **P3** | Sign-in with the provider (OAuth) where supported; software presets incl. the overlay-VPN client with a one-time auth key; reconciliation of machines changed outside Ever Works; contract review for a second provider                                                         |

---

## 1. Overview

**New cloud computer…** lives beside the other two ways of adding a computer. The dialog lists the
machine-provider plugins the owner has enabled and configured; choosing one loads its regions, sizes
(with the provider's current list prices) and the software presets. Create is refused until the
owner has seen the price sentence and the name is valid. On Create the platform first registers the
new Node (`enrolling`, `origin: cloud`, the provider plugin id, region, size and hourly rate in its
provider facts), then asks the plugin to create the machine with a **bootstrap script** the platform
generated: it installs the chosen software and the node runtime, writes the one-time enrolment token
to a private file, enrols, and starts the runtime as a service with `--work --manage`. The platform
keeps no key, password or token for the machine — the enrolment token is single-use and expires in
15 minutes; the machine's heartbeat is what turns the row online.

The machine's page shows where it is, what it is, whether it is running or idle, and what it costs:
hourly rate, this month so far, since it was created, and the projected month. **Power off** keeps
the machine (and, for providers that bill stopped machines, the bill); **Power on** brings it back;
**Destroy…** states the cost so far and requires typing the name. **Remove from Fleet** — the action
that deletes a registration while leaving a machine running — is shown disabled with the reason for
cloud computers and refused by the server (`unsupported_on_node`, "destroy it instead"; CONTRACTS
R-36), so a billing machine can never be orphaned; it becomes available when the provider itself
reports the machine gone. An **idle policy** per machine (nothing · tell me, the
default · power off after N hours) is evaluated by a platform job: idle means no Session working, no
job leased and the CPU flat for the window. "Tell me" raises a "needs a look" item with the money it
is costing; "power off" powers off and tells you. Nothing is ever destroyed automatically.

Cloud computers are plain Nodes everywhere else (README rule 18): they lease work, host Sessions,
show logs and services, and honour the kill switch.

---

## 2. Why now

### 2.1 The user's question

> _"I need a box in Frankfurt for the weekend — how much, and will I forget to turn it off?"_

### 2.2 What they do today, and what breaks

| To get…                                    | Today they must…                                                                                               | What breaks                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A machine at a cloud provider in the Fleet | Create it in the provider's console, SSH in, install Node and the runtime, come back for a token, run `enroll` | No plugin category or capability for machine providers exists (`packages/plugin/src/contracts/plugin-manifest.types.ts:5-128`; `packages/plugin/src/contracts/facade-capabilities.ts:1-159`); no DigitalOcean plugin exists under `packages/plugins/` (the `vercel` deployment plugin is the closest shape). |
| To know what it costs                      | Open the provider's billing page                                                                               | A Node has no provider, region, size or rate (`packages/agent/src/entities/fleet-node.entity.ts:96-115`); Budgets and the fleet cost ceiling track **model** spend only (`packages/agent/src/budgets/budget.service.ts`; `packages/agent/src/fleet/fleet-cost-ceiling.service.ts`).                          |
| To avoid an orphaned bill                  | Remember                                                                                                       | **Remove** deletes the registration and nothing else (`apps/web/src/components/settings/FleetSettings.tsx:257-271`; `apps/api/src/fleet/fleet.controller.ts:562-571`), so a cloud machine would keep billing with no trace in Ever Works.                                                                    |
| To be told about an idle box               | Nothing                                                                                                        | Health samples exist from FL-03 but nothing evaluates idleness against money.                                                                                                                                                                                                                                |

Three existing mechanics make this cheap: plugins already declare a category and capabilities in
`package.json` and are consumed through facades that resolve by capability and scope
(`packages/agent/src/facades/base.facade.ts:57-110`, `metrics.facade.ts:47-60`); a plugin already
advertises an optional `oauth` capability only when operator credentials exist
(`packages/plugins/vercel/src/vercel.plugin.ts:57-95`); and the enrolment flow already creates a
Node row in `enrolling` state with a one-time token
(`packages/agent/src/fleet/fleet.service.ts:349-394`) that any machine can consume outbound.

### 2.3 Why this epic is additive only

`FleetNode` stays the entity (R-4); new columns default to today's meaning. A new plugin category
and capability are appended (both lists are append-only). "Remove from Fleet" is not removed: an
additional guard disables and refuses it for one origin while a billing machine exists (CONTRACTS
R-36).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Create (owner).**
  **Given** the DigitalOcean plugin is enabled and the owner has saved an API token for it,
  **when** they choose **New cloud computer…**, pick `DigitalOcean`, name `nyc-ops`, region `New
York 3`, the `$24/mo` size, keep Docker · Node.js · Claude Code · Codex, read the price sentence and
  press **Create · $24/mo**, **then** within 500 ms a row `nyc-ops · creating · Cloud computer ·
DigitalOcean · nyc3 · $24/mo` appears, progress reads _"asking DigitalOcean → booting → installing
  → enrolling"_, and within 5 minutes the row is `● online`; an audit row `node.cloud.create` names
  the owner, the plugin, the region, the size and the hourly rate.

- **S2 — The page answers "what did it cost?".**
  **Given** `nyc-ops` has existed for 3 days 7 hours, **when** the owner opens its page, **then**
  the Cloud block reads `DigitalOcean · nyc3 · 2 CPU · 4 GB · running · $0.036/h · this month $2.84
· since created $2.84 · projected month $24.00 (provider list price; your bill may differ)`.

- **S3 — Power off and on.**
  **Given** `nyc-ops` is running, **when** the owner presses **Power off** and confirms, **then**
  the row reads `powering off`, then `■ off`, and the block states _"Powered off — DigitalOcean
  still bills this size while it is off"_; **Power on** returns it to `online` after its heartbeat.

- **S4 — Destroy with the cost so far.**
  **Given** `nyc-ops` has cost $2.84, **when** the owner presses **Destroy…**, **then** the dialog
  reads _"Destroy nyc-ops? It has cost $2.84 since 15 Oct. The machine and its disk are deleted at
  DigitalOcean; this cannot be undone."_ and requires typing `nyc-ops`; on confirm the provider
  deletes it, the Fleet registration is removed, job history is kept, and `node.cloud.destroy` is
  audited with the final cost.

- **S5 — Remove from Fleet is refused while the machine exists.**
  **Given** `nyc-ops` exists, **when** the owner opens its **⋯** menu or the drawer, **then** the
  **Remove from Fleet** item is disabled with the line _"Cloud computers are destroyed, not removed,
  so a machine you pay for is never left behind"_; a direct removal request is refused
  `unsupported_on_node` with the hint "destroy it instead" (CONTRACTS R-36).

- **S6 — Idle: tell me (P2).**
  **Given** `fra-nina`'s idle policy is **Tell me after 3 hours** (the default), **when** it has had
  no working Session, no leased job and a flat CPU for 3 hours, **then** a "needs a look" item
  `fra-nina has been idle for 3 h · $0.21 so far today` appears in the hub with **Power off** and
  **Keep running**, and an Inbox item is created once (deduped on the attention key).

- **S7 — Idle: power off (P2).**
  **Given** the policy is **Power off after 2 hours**, **when** the window passes, **then** the
  platform powers the machine off, audits `node.cloud.power` with `requestedBy: system:idle-policy`
  (CONTRACTS §2.3), and
  raises a "needs a look" item _"fra-nina was powered off after 2 h idle — it still bills while
  off"_ with **Power on** and **Destroy…**.

- **S8 — Usage in the hub (P2).**
  **Given** two cloud computers exist and one was destroyed this month, **when** the owner opens
  Fleet → Usage, **then** a **Cloud computers** block shows hourly spend now, this month so far
  (including the destroyed one), the projected month, and a per-machine table.

- **S9 — An Agent asks for a box.**
  **Given** Agent `Ops`'s tool grants allow `fleet_cloud_create` and its trust ladder puts the
  tool's categories (`spend.metered`, `machine.admin`) at **Ask** (CONTRACTS §2.1), **when** it calls
  `fleet_cloud_create` with `providerPluginId`, `regionId`, `sizeId` and `acknowledgedPriceCents`,
  **then** the call is held as an `agent_action_proposals` row (CONTRACTS R-33) and returns `{ held:
true, decisionId }`; the Decision states _"Creates a 2 CPU · 4 GB cloud computer at DigitalOcean
  (nyc3) for about $24/month ($0.036/hour), billed to your DigitalOcean account until destroyed."_;
  at **Auto** the call answers 409 `confirmation_required` with that summary until repeated with
  `confirm: true` (CONTRACTS §2.2); a call whose `acknowledgedPriceCents` differs from the current
  price is refused `invalid` with the current price in the hint.

- **S10 — An Organization member.**
  **Given** the machine's control policy grants `machines` to `org-admins`, **then** an admin may
  power and destroy it; a member sees the actions disabled with the audience named.

### 3.2 Edge cases, refusals and failures

- **U1 — No provider configured.** No `machine-provider` plugin is enabled or none has a token →
  the menu item is enabled but opens an empty state: _"Connect a cloud provider first"_ with a link
  to Plugins.
- **U2 — Provider refuses.** The token is invalid or the account is out of quota → `operation_failed`
  with the provider's first message as hint (_"DigitalOcean: droplet limit reached for this
  account"_); the `enrolling` row is marked `failed` with **Retry** and **Remove** (removal is
  allowed here: no machine exists).
- **U3 — Created but never enrols.** The provider reports the machine running but no heartbeat
  arrives within 10 minutes → a "needs a look" item of kind `cloud-idle` (CONTRACTS §4.6; the title
  and detail carry the variant) _"nyc-ops never came online and is billing $0.036/h"_ with
  **Destroy…** and **Retry enrolment** (re-mints the token; the bootstrap polls for a replacement
  through the provider's metadata service where supported, else Destroy is the fix).
- **U4 — Kill switch.** The Fleet kill switch is on → **Create** and **Power on** are refused
  `kill_switch`; **Power off** and **Destroy** stay available (they stop spending — CONTRACTS R-36)
  and say so.
- **U5 — Plugin disabled while machines exist.** The owner disables the plugin → machines stay in
  the Fleet with a banner _"DigitalOcean plugin is disabled — enable it to power or destroy this
  computer"_; actions refuse `operation_failed` with that hint; cost keeps being estimated.
- **U6 — Destroyed outside Ever Works.** The provider no longer knows the machine → within one
  reconcile cycle the row reads `gone at DigitalOcean`, cost stops accruing, and **Remove from
  Fleet** becomes available with a note.
- **U7 — Partial create.** The provider created the machine but the platform failed to record its
  reference → the reconcile job finds a provider machine tagged with the Node id and repairs the
  row; if no row exists it raises _"unclaimed machine at DigitalOcean — tagged ever-works"_ with
  **Destroy…**.
- **U8 — Permission denied.** Covered by S10.
- **U9 — Price changed.** The provider's price for the chosen size changed between options and
  Create → refused `invalid`, the dialog reloads prices and asks again.
- **U10 — Limit.** More than **10** cloud computers per owner → `limit_exceeded` (CONTRACTS §10).
- **U11 — Idle but powered off.** A powered-off machine is never "idle" for the policy and raises
  no item in this epic beyond S7's one-time "powered off by policy" item.

---

## 4. Functional requirements

Values marked **(C)** come from [CONTRACTS.md](../CONTRACTS.md).

### 4.1 Action families (program rule 12)

| Family action      | Consent on the machine  | Permission family / default audience (C §2.1) | Confirmation (C §2.2)                                      | Audit (C §7)                                                                                                               | Agent tool (C §11.3)                                                      |
| ------------------ | ----------------------- | --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Create             | — (platform → provider) | `machines` / owner                            | `confirm` — the price sentence; Agents: held at Ask (R-33) | `node.cloud.create`                                                                                                        | `fleet_cloud_create` — destructive                                        |
| Power on / off     | —                       | `machines` / owner                            | `confirm` — "still bills while off" when applicable        | `node.cloud.power`                                                                                                         | `fleet_cloud_power` — destructive                                         |
| Destroy            | —                       | `machines` / owner                            | `confirm-destructive` — type the name; shows cost so far   | `node.cloud.destroy`                                                                                                       | `fleet_cloud_destroy` — destructive                                       |
| Idle policy change | —                       | `machines` / owner                            | `plain`                                                    | `node.policy.change` (C §7) for the change; `node.cloud.power` with `requestedBy: system:idle-policy` when the policy acts | `fleet_cloud_idle_policy` — destructive: false                            |
| Options / usage    | —                       | `view`                                        | `plain`                                                    | —                                                                                                                          | `fleet_cloud_options`, `fleet_cloud_usage`, `fleet_cloud_list` — readOnly |

Every caller satisfies a class with the same request fields (`confirm: true`, `confirmName`); a call
without them answers 409 `confirmation_required` with the summary — the price sentence for Create
(C §2.2). Cloud actions do not cross the node link, so R-24's link refusal does not apply; the
platform applies the kill switch itself as CONTRACTS R-36 fixes: create and power-on refuse
`kill_switch`; power-off and destroy proceed (U4). Once the machine is a Node, every node-side family
(sessions, logs, …) is governed by its own epic, and its link is paused like any node's
(`link.pause`, C §3.2).

### 4.2 Providers and options (P1)

- **FR-1** The platform MUST resolve machine providers through the `machine-provider` capability
  **(C R-15)**; core code MUST NOT name a provider plugin id.
- **FR-2** **New cloud computer…** MUST list only providers that are enabled for the owner and
  configured (a token saved or a sign-in completed), and MUST name the connected account.
- **FR-3** Options MUST include regions (nearest first when the provider exposes it), sizes with
  CPUs, memory, disk, **monthly and hourly price**, availability per region, and the software presets:
  Docker, Node.js, Claude Code, Codex, overlay-VPN client (P3 for the auth key); Docker · Node.js ·
  Claude Code · Codex MUST be on by default.
- **FR-4** Prices MUST be the provider's current list prices fetched at dialog open, MUST be
  labelled as estimates ("your bill may differ"), and a Create whose acknowledged price no longer
  matches MUST be refused `invalid` with the current price.
- **FR-5** The provider's API token MUST be a plugin setting marked secret at user scope; the
  platform MUST never return it after save, log it, or put it in an audit row.

### 4.3 Creating (P1)

- **FR-6** The dialog MUST state, before Create, the monthly and hourly price, that the provider
  bills the owner's account from creation until destruction — also while powered off where the
  provider does so — and that Ever Works stores no password or key for the machine.
- **FR-7** Pressing Create MUST return within 500 ms with the Node id and an operation id, and MUST
  create the registration (`origin: cloud`, `providerPluginId`, region, size, hourly rate, created
  at — no secrets) before calling the provider.
- **FR-8** The platform MUST generate the bootstrap script; it MUST install the chosen software and
  the node runtime pinned to the platform's supported version, write the one-time enrolment token to a
  private file, enrol by file (never on a command line), delete the file, and start the runtime as a
  service with `--work --manage`.
- **FR-9** The platform MUST NOT create, keep or receive any machine credential: no SSH private key,
  no root password, no provider-side agent token; where the provider requires a key to avoid
  emailing a root password, a throwaway public key MUST be passed and its private half discarded
  before the request completes.
- **FR-10** The machine MUST be tagged at the provider with the Node id so reconciliation can
  recognise it (U7).
- **FR-11** A machine that has not heartbeated **10 minutes** after the provider reports it running
  MUST raise a `cloud-idle` "needs a look" item **(C §4.6)** naming its hourly cost, with Destroy and
  Retry enrolment.
- **FR-12** At most **10** cloud computers MAY exist per owner **(C §10)**; the eleventh MUST be
  refused `limit_exceeded`.
- **FR-13** The machine's name MUST match `^[a-z0-9][a-z0-9-]{1,38}$` and be unique among the
  owner's Nodes.
- **FR-14** The machine MUST be bound to the Organization the owner was acting in when creating it,
  and owned by that owner (D15).

### 4.4 The machine page and power (P1)

- **FR-15** A cloud computer's Overview MUST show a **Cloud** block with provider, region, size,
  running / off / idle-for, hourly rate, this month, since created, projected month, and the
  estimate disclaimer.
- **FR-16** **Power off** MUST ask the provider for a graceful power-off, MUST state before
  confirmation whether the provider bills powered-off machines, and MUST show `powering off` until
  the provider confirms.
- **FR-17** **Power on** MUST show `starting` until the machine's heartbeat and MUST be refused
  `kill_switch` while the Fleet is stopped.
- **FR-18** **Destroy…** MUST show the cost so far and the creation date, MUST require the typed
  name, MUST ask the provider to delete the machine, MUST remove the registration only after the
  provider confirms deletion (or reports it gone), MUST keep job history, and MUST record the final
  cost in the audit row.
- **FR-19** **Remove from Fleet** MUST be shown disabled with the reason for a cloud computer and
  MUST be refused server-side with `unsupported_on_node` and the hint _"destroy it instead; it bills
  until destroyed"_ (CONTRACTS R-36) — except when the provider has reported the machine gone
  (FR-29) or creation failed before a machine existed (U2).
- **FR-20** Destroy MUST be refused `busy` while a Run or owner Session is live on the machine,
  naming it.

### 4.5 Cost and usage (P2)

- **FR-21** Cost MUST be computed from the hourly rate and the machine's lifetime (creation to
  destruction), per the provider's billing rule (per-second to a monthly cap for the first
  provider), and MUST be refreshed at least every **10 minutes** while the machine exists.
- **FR-22** Month-to-date MUST include machines destroyed this month; projected month MUST assume
  the machine stays as it is until month end, capped at the monthly price.
- **FR-23** The hub **Usage** tab MUST carry a **Cloud computers** block (total hourly now,
  month-to-date, projected, per-machine rows) and MUST label all figures as estimates from list
  prices; where the plugin can read the provider's own month-to-date figure, it MUST be shown beside
  the estimate and labelled as the provider's.
- **FR-24** Cost figures MUST appear on the Fleet usage surfaces only; they MUST NOT be added to
  model-spend Budgets or the fleet model-cost ceiling (different money, different cap).

### 4.6 Idle policy (P2)

- **FR-25** Each cloud computer MUST carry an idle policy: **Nothing**, **Tell me after N hours**
  (default, N = 3), **Power off after N hours**; N MUST be 1–72.
- **FR-26** Idle MUST mean, for the whole window: no Session in `working` or `needs_you`, no
  leased or running job, and CPU under **5 %** in every health sample; a machine that is powered
  off or `enrolling` MUST NOT count as idle.
- **FR-27** The policy MUST be evaluated by a platform job at least every **10 minutes**; "tell
  me" MUST raise one `cloud-idle` "needs a look" item **(C §4.6)** and one Inbox item, deduped on
  the attention key `fleet-node:<id>:cloud-idle:<windowStart>`; "power off" MUST power the machine
  off, write `node.cloud.power` with the policy as requester, and raise the item.
- **FR-28** The platform MUST NEVER destroy a cloud computer automatically.

### 4.7 Reconciliation (P1 minimal, P3 full)

- **FR-29** At least hourly the platform MUST ask the provider for the state of every cloud computer;
  a machine the provider no longer knows MUST be marked `gone`, cost MUST stop accruing, and Remove
  MUST become available.
- **FR-30** A machine at the provider tagged with a Node id that has no row MUST raise a "needs a
  look" item with Destroy (U7).

### 4.8 Sign-in and software (P3)

- **FR-31** Where the provider supports it and the operator has registered an application, the
  dialog MUST offer **Sign in with <provider>** as an alternative to pasting a token, through the
  plugin's `oauth` capability; the token path MUST remain available.
- **FR-32** The overlay-VPN client preset MUST accept an optional auth key entered at create time,
  pass it only into the bootstrap, and never store it.

### 4.9 Agents, tools and audit

- **FR-33** `fleet_cloud_list`, `fleet_cloud_options` and `fleet_cloud_usage` MUST be read-only;
  `fleet_cloud_create`, `fleet_cloud_power`, `fleet_cloud_destroy` MUST be destructive with the
  classes in §4.1 and gated as C §2.1 fixes — the Agent's tool grants and trust ladder (AW-15,
  AW-24) allow the tool **and** the Node's `machines` audience includes the Agent's owner (for
  create, where no Node exists yet, the new machine is owned by the Agent's owner and only the
  grants and ladder apply).
- **FR-34** `fleet_cloud_create` MUST require `acknowledgedPriceCents`, MUST state size and price in
  its confirmation text, and MUST be refused `invalid` on a mismatch.
- **FR-35** Every state-changing action MUST write one `fleet_audit` row with `family: machines`,
  the Node as target, `requestedBy`, `confirmationClass`, and `extra` carrying provider id,
  region, size, hourly rate and — for destroy — the final cost, never the token.

---

## 5. UX

Copy is the exact user-visible string, keyed under `fleet.cloud.*` (§5.8).

### 5.1 Dialog states

- **Empty (no provider)**: _"Connect a cloud provider first. Enable a provider under Plugins and
  save its token or sign in."_ `[Open Plugins]`.
- **Loading**: provider selected, regions/sizes skeleton; Create disabled.
- **Ready**: as §0; the Create button carries the price (`Create · $24/mo`).
- **Price changed**: inline amber _"Prices changed — now $26/mo. Check and create again."_
- **Submitting**: ≤ 500 ms, then the row appears.
- **Error**: inline from the hint (_"DigitalOcean: droplet limit reached for this account"_).

### 5.2 Row and progress

```
 nyc-ops   ◌ creating   Cloud computer · DigitalOcean · nyc3 · $24/mo
 ├────────●────────────┤  booting · 00:48        asking provider ✓  booting …  installing  enrolling  online
```

Failure: `✕ failed — DigitalOcean: <message>` with **Retry** and **Remove**. Never-enrolled:
`needs a look — created 11 min ago, not online · $0.036/h`.

### 5.3 The Cloud block (computer Overview)

```
 CLOUD   DigitalOcean · New York 3 · 2 CPU · 4 GB · 80 GB · running 3 d 7 h
         $0.036/hour · this month $2.84 · since created $2.84 · projected month $24.00
         Estimates from DigitalOcean list prices; your bill may differ.
         Idle policy: Tell me after 3 h  [Change]            [Power off]  [Destroy…]
```

Off: `■ powered off 2 h · still billed at this size while off` `[Power on]`.
Gone: `gone at DigitalOcean since 09:12 · no longer billing` `[Remove from Fleet]`.
Plugin disabled: amber banner _"DigitalOcean plugin is disabled — enable it to power or destroy
this computer."_

### 5.4 Confirmations

```
 Power off nyc-ops?                            Destroy nyc-ops?
 DigitalOcean still bills this size while      It has cost $2.84 since 15 Oct 2026.
 it is off. Sessions on it end.                The machine and its disk are deleted at
            [ Cancel ]  [ Power off ]          DigitalOcean. This cannot be undone.
                                               Type the name to confirm: [          ]
                                                          [ Cancel ]  [ Destroy ]
```

### 5.5 Remove from Fleet on a cloud computer

`⋯` menu: **Power off / Power on** · **Change idle policy…** · **Destroy…** · **Remove from Fleet**
(disabled, with the line _"Cloud computers are destroyed, not removed, so a machine you pay for is
never left behind."_; enabled once the machine is gone at the provider or never existed).

### 5.6 Idle policy editor (computer Settings tab)

```
 Idle policy    ( ) Nothing
                (•) Tell me after [ 3 ] hours
                ( ) Power off after [ 3 ] hours
 Idle means: no session working, no job running, CPU under 5 % for the whole time.
 Ever Works never destroys a cloud computer on its own.
```

### 5.7 Usage tab block and needs-a-look items

```
 CLOUD COMPUTERS       now $0.107/h · this month $14.44 · projected $72.00  (list prices)
   nyc-ops    DigitalOcean nyc3  2 CPU · 4 GB   $0.036/h   $2.84    running
   fra-nina   DigitalOcean fra1  4 CPU · 8 GB   $0.071/h   $11.60   idle 4 h
   (destroyed 12 Oct) build-tmp  DigitalOcean nyc3           $0.00/h  $0.00 → $3.12 counted
```

Needs a look: `● fra-nina idle for 4 h · $0.28 today  [Power off] [Keep running]` ·
`● nyc-ops powered off after 2 h idle — still bills while off  [Power on] [Destroy…]` ·
`● build-tmp never came online · $0.036/h  [Destroy…] [Retry enrolment]`.

### 5.8 Keyboard, palette, i18n

Dialog keyboard-operable; sizes are a radio group with price read by assistive tech. Palette:
**New cloud computer**, **Power off <name>**, **Power on <name>**. i18n groups: `fleet.cloud.menu`,
`fleet.cloud.create` (fields, software, priceSentence, disclaimer), `fleet.cloud.progress`,
`fleet.cloud.block`, `fleet.cloud.power`, `fleet.cloud.destroy`, `fleet.cloud.removeUnavailable`,
`fleet.cloud.idlePolicy`, `fleet.cloud.usage`, `fleet.cloud.needsALook`, `fleet.errors.cloud*`.

---

## 6. Non-functional requirements

- **Performance**: create/power/destroy answer ≤ 500 ms (p95); options load ≤ 3 s (p95) with a
  10-minute cache per provider+account; cost refresh every 10 min; a machine online ≤ 5 min (p95)
  after Create on the first provider's smallest sizes.
- **Reliability**: provider calls are idempotent by Node id tag; a failed record after a successful
  create is repaired by reconciliation within an hour; the idle job is exactly-once per window by
  attention key.
- **Security & privacy**: provider token secret at user scope; bootstrap carries a 15-minute,
  single-use token only; no machine credential is created or kept; audit rows carry prices, never
  tokens; the plugin never receives platform credentials beyond its own settings.
- **Observability**: audit rows; operation progress; counters of creates/destroys by provider and
  outcome; a gauge of estimated hourly spend per owner.
- **Compatibility**: new category and capability appended last; contracts additive; a deployment
  with no machine-provider plugin shows the empty state and nothing else changes.

---

## 7. Key entities & concepts

| Concept                       | New?                    | Description                                                                                                                                                                     |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node** (Computer)           | Existing                | Gains `origin: cloud`, `providerPluginId`, `providerMachineRef`, `providerMeta` (region, size, rate, created at, power state, idle policy, cost snapshot — no secrets) — C §4.1 |
| **Machine provider plugin**   | New category/capability | A plugin that can list options, create, power, destroy and report usage of machines at a provider — C R-15                                                                      |
| **Provider options**          | New (read model)        | Regions, sizes with prices, software presets for one provider+account                                                                                                           |
| **Bootstrap script**          | New (generated)         | Platform-generated first-boot script that installs the runtime and enrols; carries the one-time token                                                                           |
| **Idle policy**               | New (per Node)          | nothing · tell me after N h · power off after N h                                                                                                                               |
| **Needs a look `cloud-idle`** | Existing kind (C §4.6)  | Produced by the idle job; the same kind carries the "never came online", "powered off by policy" and "unclaimed machine" variants in its title, detail and action               |
| **Operation**                 | Existing (FL-02)        | Progress of create/power/destroy                                                                                                                                                |
| **Fleet audit**               | Existing                | `node.cloud.create\|power\|destroy`                                                                                                                                             |

---

## 8. Out of scope

- **Automatic destroy** on idle — refused by design (FR-28).
- **Reading the provider's full invoice** — only a month-to-date figure where the plugin can.
- **Provider firewalls, volumes, snapshots, floating IPs, DNS** — not in this epic.
- **Resizing a cloud computer** — destroy and create.
- **A second provider plugin** — the contract is reviewed for it in P3; none ships here.
- **Inbound access to the machine** — no SSH, no listening port; everything rides the node (D2).
- **Charging the owner through Ever Works** — the provider bills the owner's own account.

## 8b. Open questions

- **Resolved** by CONTRACTS R-35: `origin` belongs to FL-16's slot; this epic's slot `1796170000000` adds `providerPluginId`, `providerMachineRef` and `providerMeta`, and both migrations guard every column (including `origin`) with `findColumnByName`, so either may land first.
- **Resolved** by CONTRACTS §2.3: `requestedBy: system:<job>` — the idle policy writes `system:idle-policy` (S7, FR-27).
- **Resolved** by CONTRACTS §10: cloud computers per owner — 10 (FR-12, U10).
- **Resolved** within CONTRACTS §4.6 as written: the never-came-online (U3, FR-11), powered-off-by-policy (S7) and unclaimed-machine (U7) items all use kind `cloud-idle`; the shape's `title`, `detail` and `action` carry the variant, so no new kind is needed.
- **Resolved** by CONTRACTS R-36: Remove from Fleet on a cloud computer is refused `unsupported_on_node` ("destroy it instead") until the provider reports the machine gone — an additive guard, not a removed action; the UI shows it disabled with the reason (FR-19).
- **Resolved** by CONTRACTS R-36: power-off and destroy stay allowed while the kill switch is on (they stop spending); create and power-on are refused `kill_switch` (U4).
- `[NEEDS CLARIFICATION: Who registers the operator-level OAuth application for the first provider (P3), and where do its client id and secret live? Default until answered: admin-scope plugin settings (x-adminOnly, x-scope: global) with env fallbacks, as the deployment plugin does; "Sign in with the provider" stays hidden until both are set, and the token path is always available (FR-31).]`
- `[NEEDS CLARIFICATION: May the overlay-VPN auth key (FR-32) be saved as a user-scope secret setting for repeat use? Default until answered: create-time only — passed into the bootstrap once, never stored, never echoed or audited.]`

---

## 9. Acceptance criteria

**Providers and options (P1)**

- [ ] `ACC-FL17-01` (FR-1, FR-2) Providers are resolved by capability; only enabled+configured ones are listed, with the connected account; no core file names the plugin id.
- [ ] `ACC-FL17-02` (FR-3, FR-4) Options show regions, sizes with monthly and hourly prices and availability; a stale acknowledged price is refused `invalid` with the current price.
- [ ] `ACC-FL17-03` (FR-5) The provider token is `x-secret` at user scope and absent from every API response after save, every log and every audit row.

**Creating (P1)**

- [ ] `ACC-FL17-04` (FR-6, FR-7) The price sentence is shown before Create; Create answers ≤ 500 ms and the row exists before the provider call.
- [ ] `ACC-FL17-05` (FR-8, FR-9, FR-10) The bootstrap installs the chosen software and the pinned runtime, enrols by token file, starts `--work --manage`; no machine credential is kept; the machine is tagged with the Node id.
- [ ] `ACC-FL17-06` (FR-11, FR-12, FR-13, FR-14) Never-online raises the item at 10 min with the hourly cost; the eleventh machine is refused `limit_exceeded`; names are validated; Organization binding is recorded.

**Page and power (P1)**

- [ ] `ACC-FL17-07` (FR-15, FR-16, FR-17) The Cloud block shows every figure; Power off states the billed-while-off rule; Power on is refused `kill_switch` while stopped.
- [ ] `ACC-FL17-08` (FR-18, FR-20) Destroy shows the cost so far, requires the typed name, removes the registration only after provider confirmation, keeps job history, audits the final cost, and is refused `busy` under a live Run/Session.
- [ ] `ACC-FL17-09` (FR-19) Remove from Fleet is disabled with the reason in the menu and drawer for cloud computers and refused server-side `unsupported_on_node` with the destroy hint; it is enabled for `gone` and for failed-before-create rows.

**Cost and idle (P2)**

- [ ] `ACC-FL17-10` (FR-21, FR-22, FR-23, FR-24) Cost refreshes every 10 min, MTD includes destroyed machines, projection is capped at the monthly price, the Usage block renders with the disclaimer, and Budgets are untouched.
- [ ] `ACC-FL17-11` (FR-25, FR-26, FR-27, FR-28) The policy editor clamps N to 1–72; a working Session, a leased job or CPU ≥ 5 % breaks idleness; "tell me" raises exactly one item per window; "power off" powers off, audits with the policy requester and raises the item; nothing is ever destroyed by the job.

**Reconciliation and P3**

- [ ] `ACC-FL17-12` (FR-29, FR-30) A machine the provider forgot is marked `gone` within an hour and stops accruing; an unclaimed tagged machine raises an item with Destroy.
- [ ] `ACC-FL17-13` (FR-31, FR-32) Sign in appears only when the operator application is configured; the VPN auth key is used once and never stored.

**Agents and audit**

- [ ] `ACC-FL17-14` (FR-33, FR-34, FR-35) Tools carry the stated annotations; `fleet_cloud_create` requires and verifies the acknowledged price and states size and price; every action writes one audit row with provider, region, size, rate and no token.

**Cross-cutting**

- [ ] Every FR has a passing test (plan §14); every user-visible string is a `fleet.cloud.*` key; the plugin is counted once in the canonical plugin document.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** The provider is a standalone plugin (`digitalocean-machines`) under a new category and capability; core code talks only to a facade.
- [x] **II — Capability-driven resolution.** Providers resolve by `machine-provider` and scope; the dialog lists what the facade returns.
- [x] **III — Source-of-truth repos.** No Work content in the database.
- [x] **IV — Job runtime.** Cost refresh, idle evaluation and reconciliation run through the configured job-runtime provider via dispatcher symbols.
- [x] **V — Forward-only migrations.** One additive migration, slot `1796170000000`.
- [x] **VI — Tests.** Named per package in plan §14.
- [x] **VII — Secrets.** Provider token `x-secret`; no machine credential ever created or stored; bootstrap token single-use; audit redaction tested.
- [x] **VIII — Plugin counts.** The new plugin and category are counted in `docs/plugin-system/built-in-plugins.md` only.
- [x] **IX — Behaviour-first.** No class or endpoint in this document.
- [x] **X — Backwards compatibility.** Category and capability appended last; optional columns; additive contracts.

---

## 11. References

- Program: [README](../README.md) (§1 "Cloud computer" copy, D6, D8, D15, rule 18) · [CONTRACTS](../CONTRACTS.md) (R-4, R-15, R-20, R-23, R-24, R-33, R-35, R-36, §2, §3.2, §4.1, §4.6, §7, §8, §9, §10, §11.2, §13) · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §F
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Sibling epics: FL-01 (hub, Usage tab shell), FL-03 (health samples, producers), FL-16 (`origin`), FL-19 (tools), FL-20 (Usage tab)
- Substrate evidence: `packages/plugin/src/contracts/plugin-manifest.types.ts:5-128`; `packages/plugin/src/contracts/facade-capabilities.ts:1-159`; `packages/agent/src/facades/base.facade.ts:57-110`; `packages/agent/src/facades/metrics.facade.ts:47-60`; `packages/plugins/vercel/src/vercel.plugin.ts:57-95`; `packages/agent/src/entities/fleet-node.entity.ts:96-115`; `packages/agent/src/fleet/fleet.service.ts:349-394`; `apps/web/src/components/settings/FleetSettings.tsx:257-271`; `apps/api/src/fleet/fleet.controller.ts:562-571`; `packages/agent/src/budgets/budget.service.ts`; `packages/agent/src/fleet/fleet-cost-ceiling.service.ts`
- Constitution: `.specify/memory/constitution.md`
