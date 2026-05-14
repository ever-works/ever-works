# EW-617 G8 — Funnel telemetry + ops runbook

> Sub-task: **EW-625**. Parent epic: **EW-617**.

## Goal

Make the zero-friction prompt → deployed Work flow observable so we can
answer:

- How many visitors who type a prompt actually end up with a deployed
  site? (top-of-funnel conversion)
- Where do users drop off — at anon-auth, at wizard finish, at deploy?
- How long does the median Work take from prompt to live URL?
- How often does claim-account follow within 24 / 72 hours?

## Functional requirements

- **FR-G8-1** A canonical TypeScript schema for funnel events lives in
  `@ever-works/contracts/telemetry`. Event names are pinned in
  `ZERO_FRICTION_FUNNEL_EVENTS` and each payload extends
  `FunnelEventBase` with a numeric `funnelStep` (1..8).
- **FR-G8-2** A `correlationId` is minted on the landing page (G1) at
  prompt submit, carried via the URL fragment alongside the prompt,
  picked up by the wizard (G4) into `OnboardingWizardStateV2.promptCorrelationId`,
  and reused by every downstream emit through `deploy-ready`.
  Lets ops trace a single user end-to-end across async task runs.
- **FR-G8-3** `ZeroFrictionFunnelService.emit(payload)` writes a single
  structured log line tagged `[zero-friction]` with the full JSON
  payload. Stage 1 stays log-based so we ship the schema without taking
  a PostHog/OpenTelemetry dependency; stage 2 swaps the log sink for
  real telemetry without changing call sites.
- **FR-G8-4** PII rules: no raw IPs, no raw user agents, no email
  addresses, no full prompts. `ipPrefix` is `/24` (IPv4) / `/48`
  (IPv6); `clientKind` is the UA family bucket only.

## Emit sites (one row per funnel step)

| Step | Event                                 | Where to emit                                                         | Status     |
| ---- | ------------------------------------- | --------------------------------------------------------------------- | ---------- |
| 1    | `zero_friction.landing_prompt_submit` | website: `LandingPromptForm.onSubmit`                                 | wiring TBD |
| 2    | `zero_friction.anon_user_created`     | platform: `AnonymousAuthService.createAnonymousUser`                  | wiring TBD |
| 3    | `zero_friction.wizard_finished`       | platform: `EverWorksOnboardingWizard` (just before quick-create call) | wiring TBD |
| 4    | `zero_friction.work_created`          | platform: `WorksController.quickCreateWork` (after `createWork`)      | wiring TBD |
| 5    | `zero_friction.repos_pushed`          | platform: `WorkLifecycleService.createWork` (EW-614 path)             | wiring TBD |
| 6    | `zero_friction.deploy_started`        | platform: `DeployService.deploy` (right before workflow dispatch)     | wiring TBD |
| 7    | `zero_friction.deploy_ready`          | platform: `DeploymentVerifierService` (poll succeeds)                 | wiring TBD |
| 8    | `zero_friction.claim_account`         | platform: `ClaimAccountService.claim` (on success)                    | wiring TBD |

"wiring TBD" means the schema + service exist; the actual
`funnelService.emit(...)` call sites are deliberately deferred so each
upstream PR (#756 G2, #757 G3, #758 G4, #759 G5, ever-works-website#37
G1) can add its emit independently without merge conflicts.

## Ops runbook

The runbook proper — how to demo, debug, and roll back each gap —
lives at `docs/runbooks/EVER_WORKS_ZERO_FRICTION_FLOW.md` (this PR).
It's mirrored to `Workspace/knowledge/runbooks/EVER_WORKS_ZERO_FRICTION_FLOW.md`
on the next Workspace sync so it shows up in the bot's runbook index.

## Tests

- `zero-friction-funnel.service.spec.ts` (3 tests): single-line JSON
  log output, timestamp back-fill when caller omits it, fallback
  key=value line when JSON.stringify throws on a circular payload.

## Out of scope (follow-ups)

- Wire the actual `emit(...)` call sites — done in the matching PRs
  (#756/#757/#758/#759/ever-works-website#37) as they land.
- PostHog dashboard JSON + alert rules.
- OpenTelemetry exporter (replaces the log sink in stage 2).
