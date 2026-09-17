# Feature Specification: Ever Works Apps — isolated hosting tier for user-controlled code (launch gate)

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-10-apps-hosting-tier`
**Program**: [App Works](../README.md) — Wave 2 (P1, P2) · Wave 3 (P3)
**Branch**: `feat/apw-10-apps-hosting-tier`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Platform engineering + Operations
**Size**: XL · **Depends on**: — (P1) · APW-03, APW-06, APW-07 (P2) · APW-05 (P3) · **Depended on by**: APW-06 P2–P3, APW-07 P2, APW-13 P2

> **Additive-only (program rule #1).** Every existing deploy option keeps its behaviour: bring-your-own
> clusters, the platform-managed clusters that serve generated websites today, and the managed-hosting
> flags and caps. The **Ever Works Apps** deploy target is new and stays unavailable until this epic's
> launch gate is green (program decision D15).

> **Public-repository hygiene (program rule #10).** This spec states requirements and how they are
> verified. It contains no addresses, host names, cluster or node names, vendor account details, or
> assessments of existing systems. Those live in the private operations repository, which holds the
> infrastructure plan that satisfies this gate.

> **Program audit resolutions applied (2026-09-17, [CONTRACTS.md §0](../CONTRACTS.md)).** R-5 — on Ever Works
> Apps the platform never applies workloads; the App runtime (APW-06) renders an App Work into desired state and this
> epic's zone controller reconciles it (FR-24). R-15 — removing an App Work removes its workloads and keeps its stored
> data unless the owner explicitly asked to delete it (FR-28). R-20 — the per-App-Work stop is **Quarantine**; the
> platform stop flag and Agent or workspace pauses never quarantine tier workloads (§4.10, §9). R-24 — a sandboxed
> runtime for tenant workloads is required from Wave 2 (LG-04); sandboxed in-zone builds arrive in Wave 3 (LG-24).

---

## 1. Overview

Ever Works Apps is where App Works run when their owner picks **Ever Works Apps** as the deploy target:
software the person — or their agents — changed, built and shipped, running on infrastructure Ever
Works operates. That code is untrusted by definition. This epic defines the **launch gate**: a closed,
numbered list of isolation and abuse controls, each verifiable either by an **automated check** or by an
expiring **operator attestation**. A **self-check** runs every automated check from inside a real tenant
sandbox — "can a tenant reach a private network? the cloud metadata address? the cluster's control plane?
another tenant? Is its token gone? Does quarantine actually stop it?" — and the platform **refuses to
open the tier** unless the latest self-check is green, less than 24 hours old, and every attestation is
current. The tier closes itself to new deployments the moment that stops being true. Around the gate the
epic delivers the platform side of the tier: an in-zone provisioning controller that the platform
instructs by writing desired state (so platform servers hold no cluster-admin credential), quarantine
(scale to zero plus network isolation) with an admin surface, quota profiles, per-tenant metering that
becomes usage and receipts, and abuse signals. P2 admits App Works built from verified App Blueprints
only; P3 admits any App Work and adds builds inside the zone.

## 2. Why now

### 2.1 The questions

> _Owner:_ "Before a stranger's app runs next to our production products — how do we **prove** it
> cannot hurt them, and how do we stop it within a minute if it tries?"

> _User:_ "I don't have a cluster. Can Ever Works just run my app?"

### 2.2 What exists today

| Need                                          | Today                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Run platform-generated websites for customers | Managed hosting ships, env-gated, 3 Works per user, on clusters built for code the platform generated. |
| Run arbitrary user code for customers         | Not offered. Wave 1 runs App Works only on the user's own cluster.                                     |
| Prove a hosting tier is isolated              | No machine-checkable definition exists; readiness is a judgement call.                                 |
| Stop one misbehaving tenant                   | No per-Work stop control exists for deployed workloads.                                                |
| Charge for compute                            | Usage and credits cover AI and plugin calls; hosting compute is not metered.                           |

### 2.3 The gaps, all of them ours

1. **"Isolated" has no definition anyone can run.** Without a numbered checklist and a probe per item,
   every launch decision is an opinion, and every later change can silently undo an earlier control.
2. **Credentials must flow one way.** A platform server able to create anything on a cluster would turn one
   platform bug into a fleet-wide incident. The tier needs the platform to _request_ and the zone to
   _enforce_.
3. **No brakes.** Abuse — mining, spam, attacks launched from our addresses — is a matter of when, not
   if. A tier without a tested per-App-Work quarantine, abuse signals and metering is not launchable.

### 2.4 What this epic changes

```
 platform (trusted)                                   isolated zone (untrusted)
 ─────────────────                                    ───────────────────────────────────────────
 Deploy target "Ever Works Apps"                      provisioning controller ── enforces template:
   │ admission: tier open? eligible? phase?             namespace per App Work · restricted pods ·
   ▼                                                    sandbox runtime · default-deny network ·
 write desired state ─────── only this ─────────────►   egress deny list · quotas · no tokens ·
 read status, usage, signals ◄──────────────────────    signed images from the tenant's registry
   │                                                          │
 Admin ▸ Ever Works Apps                                      ├─ self-check canaries (probes)
   gate board · self-check · attestations ·                   ├─ quarantine (scale 0 + isolate)
   open/close · tenants · quarantine · signals ·              ├─ usage reports (hourly)
   quota profiles                                             └─ abuse signals
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Run the self-check.** An operator opens **Admin ▸ Ever Works Apps** and clicks **Run
  self-check**. Within 15 minutes the board shows every automated gate item as **Passed**, **Failed**,
  **Inconclusive** or **Error**, each with a one-line reason code and duration; the run is kept.
- **S2 — Attest an item.** For "Dedicated capacity" the operator clicks **Attest**, writes the evidence
  note and a private evidence reference, and confirms. The item shows **Attested by {name} · expires {date}**
  (90 days later).
- **S3 — Open the tier for verified Blueprints.** With the latest self-check green and 3 hours old, all
  attestations current and the operator ceiling allowing it, the operator clicks **Open for verified
  Blueprints**, gives a reason, and the tier opens. The board and the audit trail record who, when, why
  and which self-check run it relied on.
- **S4 — A user deploys to Ever Works Apps.** A verified, paying user with an App Work built from a
  verified App Blueprint picks **Ever Works Apps**. The deployment runs in its own isolated namespace, gets
  an address under the user-apps domain, and appears in **Admin ▸ Ever Works Apps ▸ App Works** with its
  quota profile and usage.
- **S5 — Quarantine an abusive App Work.** An operator sees a **High** mining signal, clicks
  **Quarantine**, picks **Abuse**, writes a reason. Within 15 seconds the App Work's network is isolated,
  within 60 seconds it runs zero replicas, within 120 seconds its address shows the unavailable page. Its
  volumes, database and secrets are untouched. The Work's Activity records it; the owner sees a banner.
- **S6 — Release.** After review the operator clicks **Release** with a reason; the App Work returns to
  its previous replica counts and network access, and becomes reachable again within 180 seconds.
- **S7 — Automatic quarantine.** A runtime sensor reports a **High** severity event (for example, a known
  miner binary starting). The App Work is quarantined automatically within 60 seconds with source
  **Detector**, and operators are notified.
- **S8 — Usage becomes a receipt.** Each hour, usage for every App Work on the tier is imported; each day
  the owner's Activity shows one receipt per App Work with CPU, memory, egress and storage totals and the
  credits charged.

### 3.2 Unhappy paths

- **S9 — Open refused.** The operator tries to open the tier while the latest run is red. The action is
  refused, listing every reason: **"Self-check failed: LG-07, LG-13"**, and nothing changes.
- **S10 — Stale gate.** The last green run finished 25 hours ago. The tier closes to new deployments with
  reason **Stale self-check**; when the next scheduled run is green it reopens automatically, because
  staleness — unlike failure — is not evidence of a breach.
- **S11 — A check turns red while open.** A scheduled run fails LG-06. The tier closes to new
  deployments within 5 minutes, operators are notified, running App Works keep running, and the tier
  stays closed until an operator re-opens it after a green run.
- **S12 — Inconclusive is not green.** The public control target is unreachable, so every "unreachable"
  probe would pass vacuously. The run reports those items **Inconclusive** and the gate is not green.
- **S13 — Attestation expires.** An attestation passes its 90-day expiry; the tier closes to new
  deployments with reason **Attestation expired: LG-01**. Operators were warned 14 days earlier.
- **S14 — Controller silent.** The zone controller's heartbeat is older than 120 seconds; the tier
  closes to new deployments with reason **Controller not responding** and reopens automatically once the
  heartbeat and a fresh green run are back.
- **S15 — Not eligible.** An unverified or non-paying user sees **Ever Works Apps** disabled with the
  exact reason and a link to fix it; the refusal is also enforced server-side.
- **S16 — Not a verified Blueprint (P2).** An App Work provisioned by the App Provisioner, not from a
  verified Blueprint, sees **"Ever Works Apps runs apps from verified Blueprints for now. Deploy to your
  own cluster instead."**
- **S17 — Refused by the zone.** The controller refuses a deployment whose environment carries a
  credential issued to the platform or an organization, or whose image failed the vulnerability policy.
  The deployment fails with a named reason; no workload starts.
- **S18 — Quota reached.** An App Work that would exceed its quota profile fails to scale with **"This
  app has reached its {resource} limit on its plan."**; running replicas are unaffected.

### 3.3 Race and permission edges

- **S19 — Two operators, one App Work.** Quarantine and release requests on the same App Work are applied
  in order; a release that arrives while a quarantine is still applying waits for it; the audit trail
  shows both.
- **S20 — Quarantine during a deployment.** Quarantine wins: the in-flight deployment is stopped at its
  next step and recorded as **Cancelled — quarantined**.
- **S21 — Non-admins.** Every operator surface and action answers **not found** to anyone who is not a
  platform administrator.
- **S22 — Overlapping self-checks.** A second **Run self-check** while one is running returns the running
  one instead of starting another.

---

## 4. Functional requirements

Every threshold is a number on purpose.

### 4.1 The launch gate

- **FR-1.** The launch gate is a closed, versioned list of items. Each item has an id, a title, a kind
  (**Automated**, **Attested**, or **Both**), the phase that requires it, and a pass condition. Adding,
  removing or relaxing an item is a reviewed change to this spec.
- **FR-2.** The items:

| Id    | Item                               | Kind      | Phase | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------------------- | --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LG-01 | Dedicated capacity                 | Attested  | P2    | **Attested per deploy shape (R-27), and no shape is dropped.** On the shared zone: the tier's namespaces and node pool host nothing belonging to the platform's own dashboard or to any production product. On a connected customer node / customer cluster / SSH host: that machine hosts nothing the platform depends on, and the operator attests it. Passes on whichever shape the tenant actually runs on; a shape that cannot satisfy it is recorded `Failed` with the reason, never skipped.                                                                      |
| LG-02 | Network segmentation               | Both      | P2    | A tenant cannot open a connection to any configured platform or production endpoint, nor to any address in private ranges; segmentation attested.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| LG-03 | Separate egress identity           | Both      | P2    | **Evaluated per deploy shape (R-27).** On the shared zone the public address a tenant's outbound traffic presents is the tier's own egress identity, not one used by the platform or a production product; on a connected customer node or customer cluster the tenant's egress is the identity that shape provides, and the item passes when it is distinguishable from the platform's own — the operator attests which. The requirement is never removed, only located.                                                                                                |
| LG-04 | Sandboxed runtime, enforced        | Automated | P2    | The probe runs under the sandbox kernel; a workload without the sandbox runtime is refused or forced onto it.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| LG-05 | Restricted pod security by default | Automated | P2    | Privileged, root, host-namespace and host-path workloads are refused in tenant namespaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| LG-06 | Default-deny networking            | Automated | P2    | Tenant A cannot connect to tenant B; tenant workloads accept traffic only from the tier's edge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| LG-07 | Egress deny list                   | Automated | P2    | Link-local and metadata addresses and the cluster's control-plane endpoints are unreachable, while a public control target is reachable.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| LG-08 | Mail and mining ports blocked      | Automated | P2    | Outbound ports 25, 465, 587 and the configured mining-pool ports are refused to a public sentinel, while port 443 to the same sentinel succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| LG-09 | Quotas and limits                  | Automated | P2    | Quota and default limits match the App Work's profile; a load balancer or node port service is refused; an over-quota workload is refused.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| LG-10 | One namespace per App Work         | Automated | P2    | Two App Works get two namespaces; nothing a request contains can choose or reuse a namespace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| LG-11 | No platform credentials in tenants | Automated | P2    | No service-account token exists in tenant workloads; an environment carrying a planted platform credential is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| LG-12 | Platform credential is narrow      | Automated | P2    | The platform's credential can read and write only the tier's own desired-state objects in one namespace — nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| LG-13 | Image supply chain                 | Automated | P2    | Unsigned images and images outside the tenant's registry space are refused; an image with a blocked vulnerability is refused at promotion.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| LG-14 | Tenant-only data servers           | Both      | P2    | A tenant cannot connect to another tenant's database; data servers serve only the tier; backups and a restore test within 90 days are attested.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| LG-15 | User-apps domain                   | Both      | P2    | The hostname root the installation serves managed addresses under is checked against the host's own configuration: when an operator has configured a **dedicated** user-apps apex, it must not be under any platform domain and must be present on the Public Suffix List (this is the cookie-isolating configuration, kept and still supported — owner decision 2026-09-17); when the installation serves managed addresses under its **platform** domain (the default), the item passes with the shared-domain note recorded and the cookie controls of R-16 in force. |
| LG-16 | Separate edge                      | Both      | P2    | A canary address serves HTTPS with a valid wildcard certificate through the edge that fronts the share the tenant runs on, and that edge is distinct from the platform's own where the shape provides one; a separate edge account is attested when the shape has one. On the shared zone the tier's ingress is its own, as LG-06 and LG-12 already require (`deploy-shapes.md` §3, R-27).                                                                                                                                                                               |
| LG-17 | Custom hostnames                   | Automated | P2    | A canary custom hostname is active through the hostname-for-SaaS mechanism; a host not registered to that App Work is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| LG-18 | Tenant quarantine drill            | Automated | P2    | Quarantine isolates ≤ 15 s, reaches zero replicas ≤ 60 s, shows unavailable ≤ 120 s; release restores ≤ 180 s; a data marker survives.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| LG-19 | Abuse controls                     | Both      | P2    | Bandwidth limits are applied; a benign sensor test event raises a signal ≤ 120 s; eligibility rules, abuse contact and acceptable-use policy attested.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| LG-20 | Metering flowing                   | Automated | P2    | The newest usage report is ≤ 2 h old and the newest import succeeded ≤ 2 h ago.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| LG-21 | Audit trail                        | Both      | P2    | The drill's quarantine and release appear in the audit trail; zone control-plane audit retention ≥ 90 days is attested.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| LG-22 | Policies from Git, no drift        | Automated | P2    | Every live zone policy object matches the policy manifest published from Git.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| LG-23 | Controller healthy                 | Automated | P2    | Heartbeat ≤ 120 s old; controller version ≥ the platform's minimum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| LG-24 | Sandboxed in-zone builds           | Both      | P3    | Build workloads run sandboxed, reach only allow-listed egress, push only to their own registry space; build capacity is separate from serving capacity (attested).                                                                                                                                                                                                                                                                                                                                                                                                       |
| LG-25 | Build limits                       | Automated | P3    | A build exceeding its time or resource cap is terminated and recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Phase P2 ships in **Wave 2** and P3 in **Wave 3**: the sandboxed runtime for tenant workloads (LG-04) is required
before the tier accepts any App Work, while sandboxed in-zone builds (LG-24) are required only to open the tier for
all App Works (Resolution R-24).

- **FR-3.** The gate is **green for a phase** only when: every Automated and Both item required by that
  phase **Passed** in one self-check run that finished less than 24 hours ago; every Attested and Both item
  has a current attestation; and the controller heartbeat is ≤ 120 seconds old.

### 4.2 Self-check

- **FR-4.** A self-check runs every automated item from inside two canary App Works that use the **same**
  tenant template real App Works use — never a special-cased one.
- **FR-5.** Every "cannot reach" probe is paired with a control that must succeed from the same workload;
  a failed control makes dependent items **Inconclusive**. Outcomes are exactly **Passed**, **Failed**,
  **Inconclusive**, **Error**; only **Passed** counts.
- **FR-6.** Network probes use a 3-second connect timeout and 2 attempts. A whole run has a 15-minute
  budget; items not finished by then are **Error**.
- **FR-7.** Probe targets (sentinels per private range, platform and production endpoints, egress
  addresses, mining ports) are operator configuration held in the zone, never in this repository. A run
  with fewer than 1 sentinel per private range, fewer than 3 platform or production endpoints, or fewer
  than 2 public controls marks the dependent items **Error — misconfigured**.
- **FR-8.** Runs are started manually by an operator or automatically every 6 hours. At most one run is
  in progress; a second request returns the running one.
- **FR-9.** Each run records its trigger, who started it, start and finish times, per-item outcome with
  reason code and duration, the zone policy revision and the controller version. Runs are kept for 180
  days or the latest 500, whichever is more.
- **FR-10.** Canary App Works are excluded from metering, receipts, tenant lists and caps.

### 4.3 Attestations

- **FR-11.** An attestation records the item, the operator, a written evidence note (20 to 2,000
  characters), an optional private evidence reference (≤ 500 characters), the time, and an expiry exactly
  90 days later.
- **FR-12.** Attestations can be revoked with a reason; revocation takes effect immediately. Operators are
  notified 14 days and 1 day before expiry.

### 4.4 Opening and closing the tier

- **FR-13.** The tier has three states: **Closed**, **Open for verified Blueprints**, **Open for all App
  Works**. It starts **Closed**.
- **FR-14.** Opening requires, all at once: the installation's operator ceiling allows that state; the
  gate is green for the phase (FR-3); a reason of at least 10 characters. Otherwise opening is refused with
  every failing reason listed. Opening **for all App Works** also requires the P3 items.
- **FR-15.** Closing by an operator is always allowed and takes effect immediately for new deployments.
- **FR-16.** The platform re-evaluates the gate at least every 5 minutes. If it stops being green while
  open, the tier closes to new deployments. It reopens **automatically** only when the only reasons were a
  stale self-check or a silent controller and both have recovered; any failed item or expired attestation
  requires an operator to open it again.
- **FR-17.** "Closed" refuses new App Works on the tier and new deployments of existing ones. It never
  stops, quarantines or modifies running App Works.
- **FR-18.** Every open, close and automatic transition is recorded with actor (or **System**), reason,
  resulting state and the self-check run relied on. The record is append-only.

### 4.5 Tenant isolation contract

- **FR-19.** Each App Work on the tier runs in its own namespace. The namespace, its security profile,
  network policies, quota, default limits and service identity are created together, before any workload,
  and are managed by the zone — not by the platform.
- **FR-20.** Every tenant workload runs with the sandboxed runtime, as a non-root user, without privilege
  escalation, with all capabilities dropped, with the default seccomp profile, without host namespaces or
  host paths, and without a service-account token.
- **FR-21.** Tenant networking is deny-by-default in both directions. Allowed: DNS resolution; inbound
  from the tier's edge to declared component ports; outbound to the public internet excluding private,
  shared, link-local, loopback, multicast and reserved ranges, and excluding the blocked ports of LG-08;
  outbound to the App Work's own dependency endpoints. **A mail dependency is served by the platform's own relay
  over its HTTPS endpoint, never by opening 25, 465 or 587 to the tenant:** an app that declares `smtp` reaches ready
  and sends mail, and the blocked ports stay blocked (GAP-22).
- **FR-22.** A tenant namespace can create no load balancer and no node port, and its labels and
  annotations can be changed only by the zone controller.
- **FR-23.** No credential issued to the platform, to an organization, or to another App Work is ever
  delivered into a tenant. Only per-App-Work credentials are. The controller refuses a deployment whose
  environment contains a value matching any configured platform credential fingerprint.

### 4.6 The provisioning controller contract

- **FR-24.** The platform instructs the tier only by writing an App Work's desired state and reading its
  status, usage reports and abuse signals, all inside one control namespace. Its credential can do nothing
  else (LG-12). The platform never applies workloads to the tier: the App runtime (APW-06) renders the App Work
  into desired state, and the zone's provisioning controller reconciles that desired state into workloads with the
  same renderer, inside the zone (Resolution R-5).
- **FR-25.** Desired state carries: components, jobs, schedules, **smoke checks**, hosts, a sealed environment,
  dependency references (postgres, cache, object storage and mail), image references by digest, the quota profile name,
  whether the App Work should be **running, paused or quarantined**, and — when paused — the replica counts to restore.
  Secrets travel sealed to the controller's public key; the platform never
  creates a secret in the zone.
- **FR-26.** The controller validates desired state against hard limits — at most 8 components, 10 jobs,
  10 schedules, **20 smoke checks**, 20 hosts, 200 environment variables, 4 volumes per component, a sealed environment of at
  most 256 KiB and a desired-state object of at most 512 KiB — and refuses anything outside them with a
  named reason.
- **FR-27.** Status reports a phase (**Pending**, **Promoting**, **Provisioning**, **Ready**, **Degraded**,
  **Quarantined**, **Refused**, **Failed**, **Removed**), the observed generation, per-component readiness and image
  digest, and — when refused — a machine reason code and the field it concerns.
- **FR-28.** Removing an App Work from the tier (Resolution R-15) isolates it, then removes its workloads —
  components, services, routes, jobs, schedules, network policies other than the isolation policy, and its
  environment secret — and its addresses. It keeps its volumes, databases and buckets unless the owner ticked
  **Also delete stored data** and typed the App Work's slug when deleting it; they are then deleted only after the
  workloads are gone, and dependencies are released by their own providers first. Without that confirmation the
  stored data is retained for 30 days and removed only by a separate, explicit operator action outside this epic.
  Backups are never deleted by a removal. The tier never touches the upstream or the Work Repository; those follow
  the App Work deletion rules of APW-01.
- **FR-29.** The controller publishes a heartbeat at least every 30 seconds.

### 4.7 Images

- **FR-30.** Before first use, each image is copied by digest into the App Work's own registry space in
  the zone, scanned, and signed by the zone. Only signed images from the App Work's own registry space may
  run in its namespace.
- **FR-31.** Promotion is refused when the scan finds any critical vulnerability for which a fixed
  version exists. An operator may allow one image digest with a reason for at most 30 days; the allowance
  is recorded.
- **FR-32.** Private source images are pulled with a single-use credential sealed to the controller and
  valid for at most 15 minutes.

### 4.8 Addresses and domains

- **FR-33.** Managed addresses live under a dedicated user-apps apex (program D10) served by the tier's own
  edge with a wildcard certificate. No App Work is ever served under a platform domain.
- **FR-34.** Custom domains on the tier are onboarded through the edge's hostname-for-SaaS mechanism,
  which validates ownership and issues the certificate. A host is admitted to an App Work's routing only
  after that validation is active, and a host can belong to exactly one App Work.

### 4.9 Eligibility and abuse

- **FR-35.** A person may deploy to the tier only with a verified email, an active paid subscription, no
  App Work currently quarantined for **Abuse** or **Security**, and fewer than their per-person App Work cap
  on the tier. Each failed condition has its own reason and copy.
- **FR-36.** Bandwidth is limited per workload by quota profile. Monthly egress has a profile allowance;
  owners are notified at 80 %; at 100 % egress is throttled to 2 Mbit/s until the next month or an
  upgrade.
- **FR-37.** Abuse signals have a kind (**Runtime**, **Mining**, **Mail**, **Bandwidth**, **Report**), a
  severity (**Low**, **Medium**, **High**), a time, and a summary of at most 500 characters that contains
  no tenant data.
- **FR-38.** Mining is signalled **High** when a workload sustains ≥ 90 % of its CPU limit for 30 minutes
  and makes ≥ 10 refused connection attempts to mining-pool ports in that window; **Medium** on CPU alone
  for 6 hours. Mail is signalled **Medium** at ≥ 50 refused mail-port attempts in an hour.
- **FR-39.** A **High** signal from the runtime sensor or the mining rule quarantines the App Work
  automatically (source **Detector**) within 60 seconds. **Medium** and **Low** signals wait in the
  operator queue. Operators can dismiss a signal with a reason or quarantine from it.
- **FR-40.** Operators can record an external abuse report as a **Report** signal against an App Work.

### 4.10 Quarantine

> **Naming (Resolution R-20).** The per-App-Work stop on Ever Works Apps is **Quarantine**, and its drill is gate item
> LG-18 **Tenant quarantine drill**. The platform's stop flag, an Agent's **Pause** and a workspace's **Pause
> everything** stop agent runs only: they never quarantine, scale or isolate a tier workload, and a quarantine never
> pauses an Agent or a workspace. No copy in this epic calls quarantine a "kill switch".

- **FR-41.** Quarantine takes a category (**Abuse**, **Security**, **Billing**, **Legal**) and a reason of
  at least 10 characters. It isolates the network first — measurably, not by record: while quarantined a workload can
  reach nothing outside its namespace, including the public internet and the tier's edge — then scales every workload
  to zero and suspends
  schedules and jobs, then replaces the App Work's addresses with an unavailable page — within the LG-18
  timings when the controller is healthy.
- **FR-42.** Quarantine never deletes or modifies volumes, databases, buckets, secrets or images, and
  records the replica counts it replaced.
- **FR-43.** Release requires a reason of at least 10 characters and restores the recorded replica counts,
  schedules, network access and addresses.
- **FR-44.** **Pause all** quarantines every tenant App Work at once with category **Security**; it
  requires typing `PAUSE ALL`. **Release all paused** releases only quarantines created by that pause.
- **FR-45.** Quarantine does not depend on the job runtime: the request records desired state
  immediately; the zone enforces it even if the platform's background workers are down. In the other direction,
  setting the platform stop flag or pausing an Agent or a workspace never changes the desired state of any App Work
  on the tier (Resolution R-20).
- **FR-46.** Quarantine and release are recorded in the Work's Activity with category (never the operator's
  reason text) and in the operator audit trail with the full reason. The owner cannot release.

### 4.11 Quota profiles

- **FR-47.** Two profiles ship: **Starter** — CPU requests 1 / limits 2, memory requests 2 GiB / limits 4
  GiB, 10 pods, 4 volumes totalling 10 GiB, bandwidth 20 Mbit/s out and 50 Mbit/s in, 100 GiB monthly
  egress — and **Standard** — 2 / 4 CPU, 4 / 8 GiB, 20 pods, 8 volumes totalling 50 GiB, 50 / 100 Mbit/s,
  500 GiB monthly egress. Both allow 0 load balancers and 0 node ports.
- **FR-48.** Operators can edit profiles within hard ceilings of 16 CPU, 32 GiB memory, 100 pods and 500
  GiB storage, and assign a profile per App Work. Changes apply on the App Work's next reconcile, at most 5
  minutes later.

### 4.12 Metering and receipts

- **FR-49.** Usage is measured per App Work per hour in CPU core-seconds, memory MiB-hours, egress MiB and
  storage GiB-hours (and build minutes in P3).
- **FR-50.** Hourly usage is imported exactly once per App Work, hour and unit — re-imports change
  nothing — and becomes platform usage priced from the credit price list.
- **FR-51.** Once a day each owner's Activity shows one receipt per App Work with the day's totals and
  credits (program rule #12).

### 4.13 Permissions and audit

- **FR-52.** Every operator surface and action requires platform administrator rights and answers **not
  found** otherwise.
- **FR-53.** No operator surface, log, Activity entry or telemetry event contains an environment value, a
  sealed payload, a credential, or a probe target address.

### 4.14 Managed dependencies inside the zone (added 2026-09-17, APW10-G01 / GAP-22)

- **FR-54.** The zone creates the dependencies an App Work's desired state declares and reports each one back with a
  phase — **Pending**, **Ready**, **Failed** (with a reason) or **Released** — and, for anything with stored data, the
  time of its last completed backup. A dependency the zone cannot resolve is reported **Failed** by name rather than
  left pending, and an App Work is never reported **Ready** while one of its dependencies is not.
- **FR-55.** A dependency reference the platform sealed into the environment is replaced with the real value inside the
  zone, after unsealing and before the app's own secret is written. A reference the zone does not recognise fails the
  deployment with a named reason; a placeholder is never delivered to an app.
- **FR-56.** Each App Work's database is created with its own owner role, closed to every other role, capped at 20
  connections for that role with a 60-second default statement timeout and a 60-second idle-in-transaction timeout;
  its cache is its own instance; its buckets carry its own prefix and credential; and each of these is backed up at
  least once every 24 hours. These properties are **probed on the live servers**, not asserted from configuration.
- **FR-57.** Mail on the tier is a first-class managed dependency: an App Work that declares it receives a relay
  endpoint, a per-App-Work credential and a from-address, and reaches **Ready** like any other dependency, while the
  tier's outbound mail ports stay blocked (FR-21). The relay is the platform's own, rate-limited per App Work per day,
  and its use is metered.
- **FR-58.** Releasing a dependency on removal is reported before stored data is deleted, and the tier deletes a
  dependency's data only after every one of them reports **Released**.
- **FR-59.** Every dependency's storage is metered per App Work and appears in the daily receipt, like the compute
  units of FR-49.

### 4.15 Spending, suspension and retention (added 2026-09-17, XC-12 / XC-13 / EXT-18)

- **FR-60.** While an App Work on the tier is running, its owner is told before they run out rather than after: a
  notification at 80 % and at 100 % of their available credits, and the owner can set a monthly cap per App Work. When
  credits reach zero or the subscription lapses, the App Work is **Quarantined** with category **Billing** after a
  7-day grace period — data untouched, an owner banner with a **Go to billing** link, and automatic release once
  payment resumes.
- **FR-61.** Choosing the tier shows an estimate of the App Work's monthly cost from its quota profile before the
  owner commits, and the tier's own price list is the source of the numbers.
- **FR-62.** Retained data is deleted only by the owner's own action or by an operator action recorded in the audit
  trail; backups of deleted tenant data expire within 30 days of the deletion, and the owner's export request is
  answered within 30 days. Retention is never extended silently and never shortened by a removal.
- **FR-63.** Hosting user apps requires a current hosting terms addendum and acceptable-use policy, recorded as
  accepted documents through the platform's existing terms-acceptance mechanism before an owner's first deployment to
  the tier, and the abuse contact and takedown process LG-19 attests to are the same ones those documents name.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                | Today                                        | This epic adds                                                  |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| **Work** (kind `app`) | An App Work with a deploy target.            | A quota profile assignment and a quarantine state on the tier.  |
| **Deployment**        | A record of a deploy.                        | Can be refused by admission or by the zone with a named reason. |
| **Activity**          | The Work's log.                              | Quarantine, release and daily hosting receipts.                 |
| **Usage**             | Priced records of platform-paid consumption. | Hosting compute units.                                          |

### 5.2 New

| Entity                | Why it must exist                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Launch gate item**  | Code-defined list (FR-2); not stored — its definitions are versioned with the platform.  |
| **Self-check run**    | Evidence the gate relies on; the open action must cite one (FR-18).                      |
| **Attestation**       | Some isolation facts are physical or contractual and cannot be probed; they must expire. |
| **Tier state change** | Append-only record of opening, closing and automatic transitions.                        |
| **Quarantine**        | A per-App-Work stop with its category, reasons, timings and replaced replica counts.     |
| **Abuse signal**      | The input operators and the automatic quarantine act on.                                 |
| **Quota profile**     | Named resource limits an operator can adjust within ceilings.                            |

> **No other new noun.** The canary App Works are App Works. The in-zone controller is infrastructure, not
> a product noun.

### 5.3 States

```
 Tier:        Closed ──open(phase, green gate)──► Open(verified Blueprints) ──open(all, P3 green)──► Open(all)
                 ▲ ◄──operator close / failed item / expired attestation (manual reopen)───────────────┘
                 └──── stale run / silent controller (automatic reopen when both recover) ────────────┘
 App Work:    Pending → Promoting → Provisioning → Ready ⇄ Degraded      Refused / Failed (terminal per generation)
              any ──quarantine──► Quarantined ──release──► previous phase
              any ──remove──► Removed (workloads gone; stored data kept, or deleted only when the owner confirmed it)
```

---

## 6. UX

All copy is final English copy.

### 6.1 Admin ▸ Ever Works Apps — gate board

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  Ever Works Apps                                     State: ● Closed               ║
║  Reasons: Self-check failed (LG-07, LG-13) · Attestation expired (LG-01)          ║
║  [ Run self-check ]  [ Open for verified Blueprints ]  [ Open for all App Works ] ║
╟──────────────────────────────────────────────────────────────────────────────────╢
║  Last run: Failed · finished 2 h ago · 11 m 42 s · policy rev a1b2c3 · v0.4.1     ║
║  Controller heartbeat: 12 s ago                                                   ║
╟──────┬──────────────────────────────────┬───────────┬────────────────────────────╢
║ LG-04│ Sandboxed runtime, enforced      │ Passed    │ 3.1 s                      ║
║ LG-07│ Egress deny list                 │ Failed    │ METADATA_REACHABLE         ║
║ LG-01│ Dedicated capacity               │ Attested  │ Ana · expires 12 Dec  [↻]  ║
║ LG-15│ User-apps domain                 │ Inconclusive │ PSL_UNREACHABLE         ║
╚══════╧══════════════════════════════════╧═══════════╧════════════════════════════╝
```

> **LG-15 renders differently per configuration, and both are shipped** (owner decision 2026-09-17). On an
> installation with a **dedicated** user-apps apex the row and its probes are exactly as drawn above
> (`Passed` · `Failed` with `APEX_UNDER_PLATFORM_DOMAIN` / `APEX_NOT_ON_PSL` · `Inconclusive` with
> `PSL_UNREACHABLE`). On an installation serving managed addresses under its **platform** domain — the default —
> the row reads `LG-15│ User-apps domain │ Passed │ Shared platform domain …` and the shared-domain
> note is recorded as the item's evidence. The probes are never deleted; they simply have nothing to fetch
> when no dedicated apex is configured.

| Element       | Copy                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| States        | `Closed` · `Open for verified Blueprints` · `Open for all App Works`                                                                                                                                   |
| Outcomes      | `Passed` · `Failed` · `Inconclusive` · `Error` · `Attested` · `Not attested` · `Expired`                                                                                                               |
| Close reasons | `Self-check failed ({ids})` · `Stale self-check` · `Attestation expired ({ids})` · `Not attested ({ids})` · `Controller not responding` · `Closed by an operator` · `Not allowed on this installation` |
| Open dialog   | `Open Ever Works Apps for {phase}?` · `Relies on self-check from {time}.` · `Reason` · `Open`                                                                                                          |
| Refused toast | `Can't open yet: {reasons}`                                                                                                                                                                            |
| Attest dialog | `Attest {id} — {title}` · `Evidence` · `Private evidence reference (optional)` · `Expires {date}`                                                                                                      |

### 6.2 App Works on the tier, quarantine and signals

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  App Works on Ever Works Apps (38)          [ Pause all ]                         ║
║  Work        Owner      Profile   State         CPU 24h   Egress 30d   Signals   ║
║  Cal         r…@…       Starter   Ready         1.4 h     12 GiB       —         ║
║  miner-demo  x…@…       Starter   Quarantined   —         —            ● High    ║
║                                   [ Quarantine ] [ Release ] [ Profile ▾ ]       ║
╚══════════════════════════════════════════════════════════════════════════════════╝
 Quarantine dialog: "Quarantine {work}?" · Category [Abuse ▾] · Reason · "It stops the app and
 isolates it. Nothing is deleted." · [ Quarantine ]
 Pause all dialog: "Type PAUSE ALL to quarantine every App Work on Ever Works Apps."
 Signals: kind · severity · time · summary · [ Dismiss ] [ Quarantine ]
```

### 6.3 What the owner sees

| Where                         | Copy                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy target, tier closed    | `Ever Works Apps is paused for new deployments. Apps already running are not affected.`                                                                                                                                                                         |
| Not eligible: email           | `Verify your email to use Ever Works Apps.` · `Verify email`                                                                                                                                                                                                    |
| Not eligible: plan            | `Ever Works Apps needs a paid plan.` · `See plans`                                                                                                                                                                                                              |
| Not eligible: quarantined app | `One of your apps is paused for review, so new apps can't be deployed here yet.`                                                                                                                                                                                |
| Not eligible: cap             | `You've reached {count} apps on Ever Works Apps.`                                                                                                                                                                                                               |
| Not a verified Blueprint (P2) | `Ever Works Apps runs apps from verified Blueprints for now. Deploy to your own cluster instead.`                                                                                                                                                               |
| Quarantine banner             | `This app is paused. Ever Works paused it on {date} while we review activity on it. Your data is untouched.` · `Contact support`                                                                                                                                |
| Billing quarantine banner     | `This app is paused because of a billing issue. Your data is untouched.` · `Go to billing`                                                                                                                                                                      |
| Refused deployment            | `Ever Works Apps refused this deployment: {reason}.` with reasons `a platform credential was found in its environment` · `its image failed the security scan` · `its image isn't signed` · `a host isn't verified for this app` · `it exceeds the app's limits` |
| Quota reached                 | `This app has reached its {resource} limit on its plan.`                                                                                                                                                                                                        |
| Egress 80 % / 100 %           | `{work} has used 80% of this month's data transfer.` · `{work} used all of this month's data transfer; it's now slowed down.`                                                                                                                                   |
| Daily receipt (Activity)      | `Hosting for {date}: {cpu} CPU-hours, {memory} GiB-hours memory, {egress} GiB out, {storage} GiB-days storage — {credits} credits.`                                                                                                                             |

---

## 7. Out of scope

- The concrete infrastructure (hosts, networks, providers, accounts) — private operations repository.
- Rendering App specs into workloads (APW-06), building images
  (APW-05) — this epic defines the tier they target and the rules they must meet. **Dependency _provisioning_ is
  jointly owned and is in scope here (corrected 2026-09-17, APW10-G01):** what a dependency _is_ and how it is
  configured stays APW-07's, but the tier **runs** it — this epic's zone controller creates the tenant database, the
  per-App-Work cache, the prefixed buckets and the mail credential, substitutes the dependency references inside the
  sealed environment, reports their phase and last backup, and releases them on removal. Without that, nothing ever
  sets the `released` phase APW-06's removal waits for, and no managed dependency can become ready.
- A free tier; pricing values; refunds.
- Deleting retained tenant data; data export for quarantined users (support process).
- Hosting anything other than App Works (generated websites keep their current clusters).

## 8. Acceptance criteria

**Gate and self-check**

- [ ] **ACC-10-01** The board lists LG-01…LG-25 with kind and phase exactly as FR-2.
- [ ] **ACC-10-02** A manual run finishes within 15 minutes and records per-item outcome, reason code,
      duration, policy revision and controller version.
- [ ] **ACC-10-03** A second run request while one is running returns the same run.
- [ ] **ACC-10-04** Blocking the public control target turns dependent items **Inconclusive** and the gate
      not green.
- [ ] **ACC-10-05** Removing one sentinel below the FR-7 minimum turns dependent items **Error —
      misconfigured**.
- [ ] **ACC-10-06** The canaries' namespaces carry the same template as a real App Work's (compared
      object by object, names and ids excepted).
- [ ] **ACC-10-07** A scheduled run starts every 6 hours without operator action.

**Each automated item fails when its control is broken** (run against a deliberately weakened staging zone)

- [ ] **ACC-10-08** Allowing a private-range sentinel → LG-02 **Failed**.
- [ ] **ACC-10-09** Removing the sandbox runtime requirement → LG-04 **Failed**.
- [ ] **ACC-10-10** Relaxing pod security to baseline → LG-05 **Failed**.
- [ ] **ACC-10-11** Allowing tenant-to-tenant traffic → LG-06 **Failed**.
- [ ] **ACC-10-12** Allowing the metadata address → LG-07 **Failed**.
- [ ] **ACC-10-13** Allowing port 25 → LG-08 **Failed**.
- [ ] **ACC-10-14** Removing the quota → LG-09 **Failed**.
- [ ] **ACC-10-15** Mounting a service-account token → LG-11 **Failed**.
- [ ] **ACC-10-16** Granting the platform credential read on secrets → LG-12 **Failed**.
- [ ] **ACC-10-17** Admitting an unsigned image → LG-13 **Failed**.
- [ ] **ACC-10-18** Hand-editing one zone policy object → LG-22 **Failed**.
- [ ] **ACC-10-19** Stopping the controller for 3 minutes → LG-23 **Failed** and the tier closes.

**Opening and closing**

- [ ] **ACC-10-20** Opening with a red, stale (25 h) or missing run, an expired attestation, or the
      operator ceiling off is refused with every reason listed; state unchanged.
- [ ] **ACC-10-21** Opening with a green 3-hour-old run and current attestations succeeds and records the
      run id, actor and reason.
- [ ] **ACC-10-22** A red scheduled run closes the tier within 5 minutes; a later green run does not
      reopen it.
- [ ] **ACC-10-23** A stale-only closure reopens automatically after the next green run.
- [ ] **ACC-10-24** While closed, new App Works and redeployments on the tier are refused and running App
      Works keep serving.
- [ ] **ACC-10-25** Opening **for all App Works** is refused until LG-24 and LG-25 pass.

**Tenancy, controller, images, domains**

- [ ] **ACC-10-26** Two App Works get two namespaces; a desired state naming a namespace is refused.
- [ ] **ACC-10-27** A desired state over any FR-26 limit is **Refused** with a reason naming the limit.
- [ ] **ACC-10-28** An environment value matching a platform credential fingerprint is **Refused**.
- [ ] **ACC-10-29** Removing an App Work leaves its volumes and database present 30 days later.
- [ ] **ACC-10-30** An image with a fixable critical vulnerability is refused at promotion; an operator
      allowance lets that digest through and expires after 30 days.
- [ ] **ACC-10-31** An App Work's managed address is under the user-apps apex; a custom host routes only
      after its hostname-for-SaaS validation is active; the same host on a second App Work is refused.

**Quarantine**

- [ ] **ACC-10-32** Quarantine meets ≤ 15 s isolation, ≤ 60 s zero replicas, ≤ 120 s unavailable page
      (10 consecutive drills).
- [ ] **ACC-10-33** Release restores the previous replica counts and addresses within 180 s; a marker
      file written before quarantine is intact.
- [ ] **ACC-10-34** With the platform's background workers stopped, quarantine still takes effect.
- [ ] **ACC-10-35** A quarantine during a deployment cancels it as **Cancelled — quarantined**.
- [ ] **ACC-10-36** **Pause all** requires `PAUSE ALL`; **Release all paused** leaves abuse quarantines
      in place.
- [ ] **ACC-10-37** The Work's Activity shows category, never the operator's reason; the owner cannot
      release.

**Abuse, eligibility, quotas, metering**

- [ ] **ACC-10-38** Each FR-35 condition refuses deployment server-side with its own reason.
- [ ] **ACC-10-39** A simulated mining pattern raises a **High** signal and quarantines within 60 s.
- [ ] **ACC-10-40** 50 refused mail-port attempts in an hour raise a **Medium** signal and no quarantine.
- [ ] **ACC-10-41** Starter and Standard quota objects match FR-47; an edit above a ceiling is refused.
- [ ] **ACC-10-42** Importing the same hour twice creates no duplicate usage.
- [ ] **ACC-10-43** The owner's Activity shows one daily receipt per App Work with non-zero CPU.
- [ ] **ACC-10-44** Egress notifications fire at 80 % and throttling at 100 %.

**Permissions and hygiene**

- [ ] **ACC-10-45** Every operator route answers not found to a non-admin.
- [ ] **ACC-10-46** No response, log line, Activity entry or telemetry event from a full drill contains an
      environment value, sealed payload, credential or probe target address.

**Removal and stop independence** (added with Resolutions R-15 and R-20)

- [ ] **ACC-10-47** Removing an App Work removes its components, services, routes, jobs, schedules and environment
      secret; with **Also delete stored data** confirmed its volumes are deleted only after its dependencies are
      released, and without it they are still present.
- [ ] **ACC-10-48** Setting the platform stop flag, pausing an Agent and pausing a workspace leave every App Work on
      the tier in its previous phase with no quarantine recorded.

**Managed dependencies in the zone** (added with §4.14–§4.15)

- [ ] **ACC-10-49** An App Work whose desired state declares a database, a cache and a bucket gets each one created in
      the zone, each reported **Ready** with a `lastBackupAt` no older than 24 hours, and each reference in its sealed
      environment replaced by the real value before its secret is written; a reference the zone does not recognise
      fails the deployment with `DEPENDENCY_TOKEN_UNKNOWN` and the app never receives a placeholder (FR-54, FR-55,
      FR-56).
- [ ] **ACC-10-50** An App Work that declares mail reaches **Ready** on the tier with a per-App-Work relay credential,
      sends a message through the relay, and still cannot open outbound 25, 465 or 587 (FR-57, FR-21, GAP-22).
- [ ] **ACC-10-51** On removal without data deletion every dependency reports **Released** and its data is still
      present 30 days later; with **Also delete stored data** confirmed, no dependency's data is deleted before every
      one reports **Released** (FR-58).
- [ ] **ACC-10-52** A quarantined App Work's live canary sees both the public control and the edge path refused within
      15 s — the drill fails with `QUARANTINE_NOT_ISOLATING` if only the timestamp is right — and release restores the
      previous replica counts and reachability within 180 s (FR-41, FR-43, LG-18).
- [ ] **ACC-10-53** A deployment on the tier runs its phases in one order — pre-deploy jobs, rollout, first-deploy jobs,
      in-cluster smoke, hosts published, post-deploy jobs, schedules — with job and smoke results visible in the App
      Work's status, and a scheduled call declared with `authScheme: raw` sends the declared header form (GAP-25,
      FR-25).
- [ ] **ACC-10-54** The owner of a running tier App Work is notified at 80 % and 100 % of their credits; at zero with a
      lapsed subscription and after the 7-day grace period the App Work is **Quarantined** with category **Billing**,
      its data untouched, and it is released automatically once payment resumes; a monthly cap set by the owner is
      enforced (FR-60).
- [ ] **ACC-10-55** Every hosting price key resolves through a `credit-pricebook` version that carries an effective
      date, `hosting` is a valid price group, the whole-unit conversions are applied with their remainder carried, and
      the daily receipt's credits are debited once per App Work per day with the stated idempotency key (FR-61,
      APW10-G07).
- [ ] **ACC-10-56** A custom hostname on the tier is stored with its edge id, status and validation record; the owner
      sees the TXT record and the CNAME target; the host routes only once both statuses are `active`; and the hostname
      is deleted when the domain or the App Work is removed (FR-34, ACC-10-31).
- [ ] **ACC-10-57** A P1 self-check run completes on a real zone, its probe and canary workloads are admitted because
      P1 promotes the controller's and the canary's images, and the P2-only items report **Inconclusive** with
      `PHASE_NOT_ENABLED` rather than passing (APW10-G08).

---

## 9. Open questions

**Resolved by the program audit (2026-09-17)**

- **Does gate item LG-18 keep the title "Kill switch drill"?** No. It is **Tenant quarantine drill**, so it cannot be
  read as the platform's stop flag (Resolution R-20).
- **Should setting the platform stop flag also quarantine tier workloads?** No. The stop flag and Agent or workspace
  pauses stop agent runs only; quarantining a tier App Work is always an operator, detector or **Pause all** action
  on this epic's own controls (Resolution R-20, FR-45, ACC-10-48).

**Still open**

- **[NEEDS CLARIFICATION: where does the tier run?]** README open question 1. _Default: rented dedicated
  capacity for the untrusted tier; the decision and its trade-offs are in the private operations plan._
- **[ANSWERED 2026-09-17 — which apex domain?]** The default is **the installation's own platform domain**
  (`EVER_WORKS_APPS_DOMAIN` defaults to `EVER_WORKS_DOMAIN`), so managed addresses are
  `<slug>.ever.works` out of the box and **no Public Suffix List submission is on the critical path**. An
  operator may still configure a **dedicated** apex outside every platform domain, and if they do, the PSL
  listing and LG-15's probes (`APEX_UNDER_PLATFORM_DOMAIN`, `APEX_NOT_ON_PSL`, `PSL_UNREACHABLE`) apply in
  full — that path is kept, not removed. The cookie consequence of the default is carried by R-16's
  host-only `__Host-` controls. See README D10.
- **[NEEDS CLARIFICATION: prices.]** Credit prices per hosting unit and what Starter and Standard cost.
- **[NEEDS CLARIFICATION: sandbox compatibility.]** Some software does not run under a sandboxed kernel.
  Do incompatible App Blueprints stay **Your cluster** only (default), or does a stronger-isolation
  virtual-machine runtime get added?
- **[NEEDS CLARIFICATION: who owns abuse handling?]** A named person or rota for the **Medium** queue and
  external reports, with a 24-hour response target.
- **[NEEDS CLARIFICATION: retention after removal.]** 30 days is the default; confirm against the terms
  of service.
