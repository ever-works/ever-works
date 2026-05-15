# EW-617 G4 — Wizard "Generate now" + `POST /api/works/quick-create`

> Sub-task: **EW-621**. Parent epic: **EW-617**.
>
> Companion gaps (separate PRs): G6 #752 (merged-ready), G2 #756 (anon
> auth), G3 #757 (claim-account), G1/G5/G7/G8 planned.

## Goal

Replace the wizard's hand-off to `/works/new` with a single "Generate now"
button that creates a Work and starts AI generation in one API call. When
a prompt is carried over from the landing page (G1), the wizard jumps
straight to this final step.

## Functional requirements

- **FR-G4-1** `OnboardingWizardStateV2` gains an optional `prompt: string`
  field, persisted server-side alongside the existing
  `ai`/`storage`/`deploy` choices. The patch endpoint accepts it via
  `OnboardingStatePatchRequest.state.prompt`.
- **FR-G4-2** A new `POST /api/works/quick-create` endpoint (authenticated
  by `AuthSessionGuard`, throttled 10/min per IP) accepts
  `QuickCreateWorkDto { slug, name, description, prompt, organization?,
owner?, gitProvider?, deployProvider?, storageProvider?,
websiteTemplateId?, model?, readmeConfig? }` and: 1. Calls `WorkLifecycleService.createWork` with the subset that maps to
  `CreateWorkDto`. Provider defaults (`storage`/`deploy`/`git`) are
  resolved from the user's onboarding state inside `createWork` — the
  endpoint forwards explicit overrides only. 2. Calls `WorkGenerationService.generateItems(workId, { name, prompt,
model? }, user, /*awaitCompletion*/ false)` to dispatch generation
  asynchronously. 3. Returns `202 Accepted` with `{ status: 'pending', work: { id, slug,
name }, generation: { historyId, message } }`.
- **FR-G4-3** When `createWork` returns a non-success status the endpoint
  MUST throw `BadRequestException` and not attempt to start generation.
- **FR-G4-4** Generation errors after a successful create MUST bubble up
  unmodified — the caller can retry generation via
  `POST /works/:id/generate` against the new work id.
- **FR-G4-5** `CreateWorkStep` MUST render "Generate now" only when a
  non-empty `prompt` is available and an `onQuickCreate` callback is
  passed. Otherwise it renders the legacy "Create your first work" link
  to `/works/new`. The component MUST be I/O-free; the parent owns the
  fetch.
- **FR-G4-6** On wizard mount, the parent MUST read `?prompt=…` from
  the URL query OR from the `#prompt=…` URL fragment, seed
  `flow.setPrompt(...)`, jump to the `create-work` step, and strip the
  parameter from the URL via `history.replaceState`. Fragment transport
  is preferred (lands client-side only, never hits server logs).

## Non-functional requirements

- **NFR-G4-1** Slug + name derivation on the client MUST be deterministic
  enough for the server's validation to pass without bouncing: slug is
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 46 chars, and SHOULD include a short
  randomized suffix to dodge collisions across users typing the same
  prompt.
- **NFR-G4-2** The "Generate now" button MUST disable itself while the
  request is in flight and surface API errors inline (no global toast)
  so the user can retry without losing wizard context.
- **NFR-G4-3** Prompt MUST be bounded to 5000 chars on the wire (matches
  `CreateItemsGeneratorDto.prompt`).

## Out of scope (other gaps)

- G1 — landing-page input + signed-token URL handoff (EW-618).
- G3 — claim-account banner shown after a successful quick-create
  (EW-620, in flight as #757).
- G7 — captcha / global cap (EW-624).
- G8 — funnel telemetry for the quick-create event (EW-625).

## Acceptance

- A logged-in (or anonymous, post-G2) user with `prompt` populated on
  their wizard state can click "Generate now" and receive a 202 with a
  pending generation history id. Polling `GET
/works/:id/generation-history` shows the run progressing.
- Landing on `app.ever.works/onboarding#prompt=AI%20coding%20assistants`
  drops the user on the `create-work` step with the prompt pre-filled
  and the URL cleaned to `app.ever.works/onboarding`.
