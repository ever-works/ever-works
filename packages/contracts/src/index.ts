export * from './item/index.js';
export * from './domain/index.js';
// App Works (APW-01…APW-13) — the shared App/App-Work vocabulary: source and
// inspect model, repository limits, upstream readiness, builds and the
// verification plan, env and dependencies, the managed tier's desired state,
// and Ever ID.
//
// A PLAIN `export *`, deliberately, not `export type *`. These modules carry
// 433 runtime exports alongside their types (the closed-union arrays behind
// `X = (typeof X)[number]`, the limits, and the pure resolvers such as
// `resolveAppRepositoryModes`), and a type-only re-export would drop every one
// of them from the package root while `tsc --noEmit` stayed silent in this
// package — the break would only surface at a consumer as "X is not exported".
// The barrel spec asserts there is no name collision across areas, and a scan
// confirms all 433 are unique within this area, so the plain form is correct.
export * from './apps/index.js';
export * from './form/index.js';
export * from './github/index.js';
export * from './kb/index.js';
export * from './terminal/index.js';
// Agent computers — the live-view wire protocol and session views, riding
// the same relay, attach tokens and gateway as the streaming terminal.
export * from './computer/index.js';
// The pure secret-pattern scanner, shared by the server and the node app.
export * from './secret/index.js';
export * from './tasks/index.js';
export * from './policy/index.js';
export * from './ingest/index.js';
export * from './skills/index.js';
export * from './agents/index.js';
export * from './fleet/index.js';
export * from './fleet/fleet-task-workspace.types.js';
export * from './digest/index.js';
// Judgment layer G5 / G8s / G9 — workflow graph edges + input mapping,
// typed human-in-the-loop question payloads, sub-agent delegation.
export * from './workflow/index.js';
export * from './hitl/index.js';
export * from './delegation/index.js';
// Inbox (operator message center) — one surface for questions /
// approvals / escalations / notices addressed to the human.
export * from './inbox/index.js';
// Agent email (AW-05) — approve-before-send statuses and modes, plus the
// per-inbox / per-workspace send ceilings and their pure resolution.
export * from './email/index.js';
// Model accounts (AW-16) — several credentials per AI provider, in order, the
// workspace / Agent / schedule model ladder, and the record a Run keeps of
// what actually answered it.
export * from './model-routing/index.js';
// Release promotion lane (self-build slice AI, EW-808) — develop -> stage
// -> main as platform state, plus the ONE rule that reads the promotion
// gate's verdict. Deliberately carries no cascade.
export * from './release/index.js';
// Memory facts + context-file vocabulary (AW-07) — the atomic tier of Memory
// and the shared limits every surface validates against.
export * from './memory/index.js';
// Conversations — kinds, participants, send status and delivery outcomes for
// named conversations with Agents.
export * from './conversations/index.js';
// Connections (AW-15) — plain-English scope presets expressed on the
// tool-grant lattice, and the shared connection-health vocabulary.
export * from './connections/index.js';
// Live Feed — the narrated, filterable view of the activity log. Structure
// only (narration keys + typed destinations); renderers own the words.
export * from './feed/index.js';
// Runs ledger + run receipt (AW-09) — the calendar-navigated ledger of every
// Agent run and the itemised receipt of one run, over the existing run rows.
export * from './runs/index.js';
// Capability & playbook catalogue (AW-21) — the playbook-provider entry
// shape, its pure validator + version comparator, and the per-caller
// readiness / preflight wire types.
export * from './playbook/index.js';
// Meters and the credit price list (AW-17) — which of three ways a unit of
// spend was paid for, and what a kind of call costs before it is made.
export * from './billing/index.js';
// Attention controls (AW-13) — the notification matrix (one row per event,
// one column per delivery target) and the attention budget meter shape.
export * from './notifications/index.js';
// Workspace backup (AW-22) — the published archive format: the fifteen
// domains, their restorability classes, the trim windows, the exclusions
// list and the manifest shape. One source for the writer, the API, the web
// report and the field reference.
export * from './backup/index.js';
// Home (AW-19) — the composed morning read on the dashboard root: one status per
// block, over the decision queue, the Runs ledger, schedules, costs and the feed.
export * from './home/index.js';
// Safety rails and the trust ladder (AW-24) — the shared vocabulary the
// existing refusals (stop flag, pauses, grants, caps, merge policy) now speak:
// thirteen kinds of work, four rungs, seven rails in a published order.
export * from './safety/index.js';
