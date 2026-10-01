/**
 * Ever Works Apps — the `apps-tier` capability's plugin contract
 * (APW-10 plan §5.1:546–598, tasks T2:73–81).
 *
 * Owning epic: **APW-10 (Ever Works Apps — isolated hosting tier)**. Spec:
 * `docs/specs/features/app-works/APW-10-apps-hosting-tier/spec.md`. Plan: §2.1
 * (the tier is a zone the platform writes desired state to, never workloads —
 * Resolution R-5), §2.5 (quarantine), §2.6 (removal, R-15), §3.1–§3.2 (the
 * `hosting.ever.works/v1alpha1` objects), §3.3 (the platform's narrow control
 * credential), §3.6 (zone configuration), §5.1 (this file), §5.2 (the
 * `ever-works-apps` plugin that implements it), §5.3 (metering), §5.5
 * (`AppsTierPolicy`, which is APW-06's port and not this one).
 *
 * ## The one thing this contract is for
 *
 * The platform never sends a workload object. It writes **desired state** —
 * a `Work` — into the zone's control namespace and reads status back, and the
 * zone's controller renders the tenancy template and APW-06's workload objects
 * itself (plan §3.4, APW10-G03). `applyWork` is therefore not a deploy call: it
 * is one write of one object, and the four members around it are the four things
 * a `Work` can be told that are not a new desired state — a state transition
 * (`setDesiredState`), a throttle (`setEgressThrottle`), a dependency list
 * (`setDependencies` / `releaseDependencies`) or a removal (`removeWork`).
 * Everything else in this interface reads.
 *
 * ## What is declared where (Resolution R-1)
 *
 * The wire-level model lives in `packages/contracts/src/apps/apps-tier.ts`
 * (APW-10 T1, landed) and is re-exported, never restated; the plugin-facing
 * shapes live in `./apps-tier.types.js`. The substitutions this file makes
 * against plan §5.1's literal text — and the one identifier it had to resolve —
 * are tabulated in the header of `apps-tier.types.ts`, which is the reviewable
 * artefact for that decision.
 *
 * ## Additive only (CONTRACTS R-26)
 *
 * `apps-tier` is **appended** to `PLUGIN_CAPABILITIES` (after `build` and
 * APW-12's `identity-provider`, keeping every existing constant and its order)
 * and **no category is appended**: the implementing plugin declares the existing
 * `deployment` category (plan §5.2:602), so `PLUGIN_CATEGORIES` is unchanged and
 * every exhaustive map over it in `apps/web` stays total. A plugin that never
 * declares `apps-tier` compiles and behaves exactly as before.
 *
 * ## Who calls this
 *
 * `AppsTierFacadeService` (plan §5.3:655) resolves the enabled `apps-tier`
 * plugin and passes every method through, so no plugin id and no credential
 * appears outside the plugin: the control-namespace kubeconfig is operator
 * environment (`EVER_WORKS_APPS_CONTROL_KUBECONFIG`, plan §5.2:604) and the
 * facade — never the caller — holds it. Callers are the gate services (self-check
 * request and read, heartbeat, access review), the quarantine service
 * (`setDesiredState`), the metering and signal importers (the four list/ack
 * pairs), APW-07's dependency reconciliation (the three dependency members) and
 * APW-06's App runtime (`applyWork`, `getWork`, `getAppLogs`, `removeWork`).
 *
 * ## Fail-closed rules this interface carries
 *
 * - A `null` return from `getWork`, `getSelfCheck` or `getBuild` means **"no such
 *   object"**, never "I could not tell" — an unreadable zone throws. APW-06
 *   renders a missing `Work` as not-deployed and the gate treats a missing
 *   self-check as a run that never happened (plan §5.1:579).
 * - `setDesiredState` and `removeWork` resolve **after** the zone has accepted
 *   the write, not after it has reconciled it: the platform's ordering guarantee
 *   is "the `Work` says so", and the controller's progress is read back through
 *   `getWork` (plan §2.5:182–183, tasks T17: "`setDesiredState` is awaited before
 *   the method resolves and no job is dispatched").
 * - No member ever takes a credential. The plugin holds the control kubeconfig
 *   and a per-Work pull credential travels **inside** `Work.spec.images[]`, sealed
 *   (plan §3.1:241–244), so a caller cannot hand the zone a second identity.
 */

import type { IPlugin } from '../plugin.interface.js';
import type {
	AppsTierAccessReview,
	AppsTierAbuseSignalReport,
	AppsTierBuildRequest,
	AppsTierBuildStatus,
	AppsTierDependencyRef,
	AppsTierDependencyStatusView,
	AppsTierHeartbeat,
	AppsTierLogPage,
	AppsTierLogRequest,
	AppsTierQuarantineRequest,
	AppsTierSelfCheckStatus,
	AppsTierUsageReport,
	AppsTierWorkSpec,
	AppsTierWorkStatus,
	AppsTierZoneInfo
} from './apps-tier.types.js';

/**
 * A hosting-tier provider: one plugin, one zone (plan §5.1:548–593).
 *
 * The zone is addressed by the plugin's own configuration, so no method takes a
 * cluster, a namespace or a kubeconfig — a caller cannot point the tier at a
 * different zone than the one an operator configured (plan §5.2:604). What each
 * method answers for is the single `Work` named by its `workId`.
 *
 * **The two optional members are P3 and only P3.** `submitBuild` and `getBuild`
 * are the sandboxed in-zone build path (LG-24, LG-25) that arrives with Phase 3;
 * nothing in P1 or P2 calls them, and a provider that implements none of them is
 * a complete P1/P2 provider. They are optional rather than absent so the P3
 * plugin is the same plugin, and a caller materialises the member before calling
 * it — the same rule this package applies to every other wave-gated member.
 *
 * **`removeWork`'s `deleteData` is required, and so is the options object.**
 * Removal has two outcomes that differ in an irreversible way (spec FR-28,
 * Resolution R-15): the `Work` goes to `removed` and keeps its data for 30 days,
 * or the owner ticked **Also delete stored data** and typed the slug, and the
 * volumes and the namespace go with it. `deleteData: false` is a decision; an
 * omitted argument is a mistake, and the caller must make it explicitly. APW-06's
 * `deleteVolumes` is passed through unchanged (plan §5.2:609) — never defaulted,
 * never inverted.
 */
export interface IAppsTierProvider extends IPlugin {
	/**
	 * What the zone is — its user-apps domain, sandbox runtime class, registry,
	 * edge ingress class and controller version floor (plan §3.6:427).
	 *
	 * The only call in this interface that dials nothing beyond the control
	 * namespace: `checkAppCluster` answers from it (plan §5.2:622, "never dials")
	 * and `podPolicy()` / `ingress()` read their class names from it
	 * (plan §5.5:717–718). Never returns `null` — a zone that cannot publish its
	 * own info is a zone the tier must not be opened against.
	 */
	zoneInfo(): Promise<AppsTierZoneInfo>;

	/**
	 * Write the whole desired state of one App Work, and answer the generation
	 * that was written (plan §5.1:551, §3.1:230–253).
	 *
	 * This is the write APW-06's `deployApp` becomes: one `Work` object, whose
	 * `spec.generation` the platform has already incremented. The zone's
	 * controller reconciles it; the platform polls `getWork` for the outcome.
	 * The parameter is the whole spec — including `env` and `images`, whose
	 * credentials the platform has already sealed (plan §2.1 D-D) — because a
	 * partial write would race the controller's own view of the Work.
	 *
	 * The returned `generation` is the number the platform wrote and must read
	 * back from `Work.spec.generation`: APW-06 treats `observedGeneration <
	 * generation` as "the zone has not caught up" and never as a result, which is
	 * what makes a quarantine arriving mid-rollout readable as **Cancelled —
	 * quarantined** (plan §3.1:294, ACC-10-35).
	 */
	applyWork(input: AppsTierWorkSpec): Promise<{ generation: number }>;

	/**
	 * Read one App Work's status, or `null` when the zone has no such `Work`
	 * (plan §5.1:552, §3.1:254–269).
	 *
	 * Every field APW-06's App page shows comes from here — components, jobs,
	 * smoke, `deployPhase`, `quarantine`, `dependencies`, `removal` — so this is
	 * the read the deploy poll is built on. A `Quarantined` phase observed while
	 * `observedGeneration < spec.generation` maps to a cancelled result with
	 * reason `quarantined` (plan §5.2:606–607).
	 */
	getWork(workId: string): Promise<AppsTierWorkStatus | null>;

	/**
	 * Move a Work between `running` and `quarantined` (plan §2.5:181–183).
	 *
	 * The quarantine object is optional because the two directions do not both
	 * carry one: entering `quarantined` writes `Work.spec.quarantine`
	 * (`requestId`, `category`, `requestedAt`), while releasing answers no
	 * argument at all. The zone's sequencer does the rest — isolate, record
	 * counts, scale to zero, switch the hosts — in the LG-18 budgets, in that
	 * order, and a release replays it in reverse from the counts it recorded.
	 *
	 * The call resolves once the `Work` is written, not once the zone has
	 * finished: the operator surface is `202` and the timings are mirrored back
	 * from `status.quarantine` on the next poll or watch tick (plan §2.5:188).
	 */
	setDesiredState(workId: string, state: 'running' | 'quarantined', q?: AppsTierQuarantineRequest): Promise<void>;

	/**
	 * Switch the 100 % egress state on or off (plan §5.1:554, spec FR-36).
	 *
	 * Separate from `applyWork` on purpose: the owner is told at 80 % of their
	 * profile's monthly egress and throttled at 100 %, and this is a one-field
	 * change to `Work.spec.egressThrottle` — going through `applyWork` would bump
	 * the generation and restart the Work's workloads to move a bandwidth
	 * annotation (the same reasoning that split the dependency members out,
	 * plan §5.1:557–559).
	 */
	setEgressThrottle(workId: string, throttled: boolean): Promise<void>;

	/**
	 * Remove a Work — and its data only when `deleteData` says so
	 * (plan §5.1:555, §2.6, Resolution R-15).
	 *
	 * `deleteData` is `false` for the ordinary removal: the `Work` goes to
	 * `desiredState: removed`, the workloads and the hosts go away, and the
	 * namespace is labelled `hosting.ever.works/retained-until=<+30 d>` with its
	 * PVCs intact. It is `true` only after the owner ticked **Also delete stored
	 * data** and typed the App Work's slug, and then the zone deletes the PVCs and
	 * the namespace — but only after every `status.dependencies[]` entry reports
	 * `released`, which is why APW-07's `releaseDependencies` runs first
	 * (plan §2.6:207–211).
	 *
	 * The whole `opts` object is required, not just the field: an omitted second
	 * argument would silently mean "keep the data" for a caller that meant to
	 * delete it, and the two outcomes are not recoverable from each other. The
	 * boolean is passed through unchanged from APW-06's `deleteVolumes`
	 * (plan §5.2:609, :624).
	 */
	removeWork(workId: string, opts: { deleteData: boolean }): Promise<void>;

	/**
	 * Write the Work's managed dependency list, and nothing else
	 * (plan §5.1:556–565, APW10-G01 / GAP-22).
	 *
	 * The zone resolves each `(kind, ref)` pair to an endpoint it provisions and
	 * reports progress in `status.dependencies[]`; the platform never learns an
	 * address (plan §3.6:431 — the tenant data servers are zone-only).
	 *
	 * Deliberately not a field of `applyWork`: APW-07 writes the dependency list
	 * on its own schedule, and replacing the whole desired state would bump
	 * `generation` and restart the app's workloads for a change that does not
	 * touch them.
	 */
	setDependencies(workId: string, deps: AppsTierDependencyRef[]): Promise<void>;

	/**
	 * Ask the zone to deprovision the Work's managed dependencies
	 * (plan §5.1:566–569, APW10-G01).
	 *
	 * Runs **before** data deletion, because the removal gate is the zone's own
	 * status: PVCs and the namespace are deleted only when every entry reports
	 * `released` (plan §2.6:207–208). `deleteData` is required for the same
	 * reason `removeWork`'s is — a dependency's data is the app's data.
	 *
	 * `remaining` is what could not be released, in the same `(kind, ref)` form it
	 * was given. A caller that sees a non-empty list must not proceed to delete
	 * data; an empty list is the "all released" signal, and the zone's
	 * `status.dependencies[]` is the durable record of it.
	 */
	releaseDependencies(workId: string, opts: { deleteData: boolean }): Promise<{ remaining: AppsTierDependencyRef[] }>;

	/**
	 * Read the Work's dependencies as the zone sees them (plan §5.1:570–577).
	 *
	 * `phase: 'released'` is the gate removal waits on; `lastBackupAt` is the
	 * freshness header APW-07's managed providers show, and `null` means the zone
	 * has no backup to report — never "backed up just now".
	 */
	getDependencies(workId: string): Promise<AppsTierDependencyStatusView[]>;

	/**
	 * Create one `SelfCheck` for the run id the platform generated
	 * (plan §5.1:578, §3.2:299–301).
	 *
	 * `items` are the launch-gate ids this run must cover, as `string[]` — not
	 * T1's `LaunchGateItemId[]` — because the zone reads its own probe plan from a
	 * mounted ConfigMap (tasks T8) and reports per item; the platform's typed id
	 * set is the value domain, and the zone is the one that must refuse an item it
	 * cannot probe. LG-01 is the one id that is never in the list: it is an
	 * operator attestation with no probe.
	 *
	 * Resolves when the object exists. Results are read back through
	 * `getSelfCheck`; a run whose items are still pending at the 15-minute budget
	 * is `error`, not green (plan §5.1:579, tasks T16).
	 */
	startSelfCheck(runId: string, items: string[]): Promise<void>;

	/**
	 * Read one self-check run, or `null` when the zone has no such run
	 * (plan §5.1:579, §3.2:299–301). See `AppsTierSelfCheckStatus`.
	 */
	getSelfCheck(runId: string): Promise<AppsTierSelfCheckStatus | null>;

	/**
	 * LG-12 — what the platform's control credential may actually do
	 * (plan §5.1:580, §3.3:342–345, §3.7:449).
	 *
	 * The tier's weakest link is the identity the platform holds inside it, so the
	 * gate reviews it on every run: the credential must be a namespaced Role with
	 * no ClusterRole binding, and it must fail every one of the zone's forbidden
	 * checks. A success is not a proof of narrowness — `ok: false` with
	 * `CREDENTIAL_TOO_BROAD` is the only answer that fails LG-12, and an
	 * unreachable review is an error rather than a pass.
	 */
	reviewCredentialScope(): Promise<AppsTierAccessReview>;

	/**
	 * The controller's Lease, as the platform's own role reads it
	 * (plan §5.1:581, LG-23:460).
	 *
	 * A heartbeat older than 120 s closes the tier with `CONTROLLER_STALE`, and a
	 * version below the floor closes it with `CONTROLLER_TOO_OLD` — one call, two
	 * gate reasons, both fail-closed. The platform's role has `get` on exactly one
	 * Lease name (plan §3.3:337–340), so this can never enumerate the zone's other
	 * leases.
	 */
	getHeartbeat(): Promise<AppsTierHeartbeat>;

	/**
	 * Unacknowledged `UsageReport`s, newest first, at most `limit` of them
	 * (plan §5.1:582, §3.2:302–304).
	 *
	 * `limit` is a caller's page size, capped at 500 by the method's own contract:
	 * the metering import is hourly and idempotent by window, so a page larger
	 * than the hourly float would only postpone the acknowledgement. Reports for
	 * the self-check canaries are excluded by the zone (spec FR-10).
	 */
	listUsageReports(limit: number): Promise<AppsTierUsageReport[]>;

	/**
	 * Acknowledge the named reports so the zone may collect them
	 * (plan §5.1:583, §3.2:304).
	 *
	 * Acknowledgement is the platform's statement "this window is imported". It is
	 * not idempotency: importing the same hour twice must create no second usage
	 * row (spec FR-49, tasks T28), so an acknowledgement that never arrives costs
	 * a re-import, never a double charge.
	 */
	acknowledgeUsageReports(names: string[]): Promise<void>;

	/**
	 * `AbuseSignal`s, newest first, at most `limit` of them (plan §5.1:584,
	 * §3.2:305–306).
	 *
	 * The summaries are owner-safe by construction: a signal carries a rule id, a
	 * severity and a capped summary, never a raw log line or an environment value
	 * (spec FR-37).
	 */
	listAbuseSignals(limit: number): Promise<AppsTierAbuseSignalReport[]>;

	/**
	 * Acknowledge the named signals (plan §5.1:585, §3.2:306).
	 *
	 * Acknowledgement is not triage: dismissing a signal, acting on it or
	 * quarantining from it are platform-side operator actions (tasks T29), and the
	 * zone only needs to know the platform has the row.
	 */
	acknowledgeAbuseSignals(names: string[]): Promise<void>;

	/**
	 * A page of the Work's logs, read from the tenant namespace through the
	 * platform's Role (plan §5.1:589, §5.2:621, APW-06 FR-48).
	 *
	 * Required, not optional, and not deferred: APW-06 routes "status, jobs, logs
	 * and removal … through the tier", and without this member the managed target
	 * would have no log path at all. `pods/log` is the one workload-adjacent verb
	 * the platform's Role grants (plan §3.3:334–336) — read-only, in the control
	 * namespace's Role, and LG-12's review is what keeps it from growing.
	 *
	 * The lines are redacted before they leave the plugin, with the request's own
	 * `secretValues`. A temporary refusal answers `status: 'unavailable'` with
	 * `logs_unavailable_on_tier` rather than throwing, so the route reports a
	 * retryable state (tasks T26).
	 */
	getAppLogs(workId: string, opts: AppsTierLogRequest): Promise<AppsTierLogPage>;

	/**
	 * Submit a sandboxed build into the zone (plan §5.1:590, P3, LG-24/LG-25).
	 *
	 * Optional: nothing before Phase 3 calls it. The zone runs it on
	 * build-dedicated capacity with an allow-listed egress and the build's own
	 * caps, pushes only into the Work's own tenant space, and deletes the build
	 * workload within ten minutes of finishing (tasks T33).
	 */
	submitBuild?(input: AppsTierBuildRequest): Promise<void>;

	/**
	 * Read one build's status, or `null` when the zone has no such build
	 * (plan §5.1:591, P3). Optional with `submitBuild`, for the same reason: the
	 * pair is the P3 path, and a P1/P2 provider implements neither.
	 */
	getBuild?(buildId: string): Promise<AppsTierBuildStatus | null>;
}
