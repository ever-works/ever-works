import type { TaskDeliveryDeployOutcome, TaskDeliveryState } from '@ever-works/contracts';

/**
 * APW-08 T20 — `decideDelivery`, the PURE decision of where a merged App Work change stands.
 *
 * Spec FR-30…FR-34; plan §2.4's **delivery input table is normative** (APW08-G08): this function
 * implements every row of that table and nothing else, and `task-delivery.rules.spec.ts` has one
 * case per row. A state is never inferred from an input the table does not name — in particular,
 * recording a Deployment never changes a delivery state on its own; only the rows below do.
 *
 * | Input (containing the merge commit, newest first) | State |
 * |---|---|
 * | No Build and no Deployment started yet | `merged` |
 * | Build `queued` / `running` | `building` |
 * | Build `succeeded` + `deployable`, target **None** | `built` → Task **Done** |
 * | Build `succeeded` + `deployable`, auto-deploy off, or the Deployment not started | `built` |
 * | Build `succeeded` + not `deployable`, `failed`, or `blocked` | `build_failed` |
 * | Build `cancelled` | unchanged |
 * | `build.strategy: image`/`none`, no Build, Deployment queued / deploying / verifying | `deploying` |
 * | `build.strategy: none`, no Build, no Deployment | `built` → Task **Done** |
 * | Deployment `READY` | `live` → Task **Done** |
 * | Deployment `READY` with `appRender.warnings` or a failed public smoke check | `live` + `liveWithWarnings` (→ Done, APW08-G25 `CL-08-1`) |
 * | Deployment `ERROR` / `ROLLED_BACK` / rollback failed | `deploy_failed` + `{outcome}` |
 * | Deployment `CANCELED` | `built` (FR-34) |
 * | Deployment `SUPERSEDED`, or a newer Deployment exists | unchanged; the newer row decides |
 * | Provider cannot answer ancestry and no exact-sha row exists | `merged` (held) |
 * | Task already `live` / `closed_without_deploy` | unchanged |
 *
 * **"Contains"** (FR-31): the row's commit IS the merge commit, or the provider said the merge
 * commit is its ancestor. `ancestry` carries the provider's answers (`true` / `false` / `null` =
 * cannot say); anything but an exact match or a `true` is "does not contain", so the decision never
 * claims live without proof (plan §8.2).
 *
 * **Which row decides.** The newest containing Deployment that is not `SUPERSEDED` decides when it
 * belongs to the newest containing Build (or is newer than it, or there is no Build — the `image`
 * strategy); otherwise the newest containing Build decides. So a newer Build in flight moves a
 * failed change back to `building`, and a newer live Deployment carries an older failed change to
 * `live` (S23, S24).
 *
 * Only `push` and `manual` Builds of the tracked branch are candidates: a `pull_request` Build is
 * of the head branch and a `verification` Build is APW-04's, neither of which delivers anything.
 */

/** The Build fields the decision reads (`work_builds`). */
export interface DeliveryBuildRow {
    readonly id: string;
    readonly number?: number | null;
    readonly status: string;
    readonly deployable: boolean;
    readonly trigger: string;
    readonly branch: string;
    readonly commitSha: string;
    readonly createdAt: Date | string | number;
}

/** The Deployment fields the decision reads (`work_deployments`). */
export interface DeliveryDeploymentRow {
    readonly id: string;
    readonly buildId?: string | null;
    readonly commitSha?: string | null;
    readonly state: string;
    readonly createdAt: Date | string | number;
    readonly smokeResult?: Record<string, unknown> | null;
    readonly appRender?: Record<string, unknown> | null;
    readonly website?: string | null;
}

export interface DeliveryDecisionInput {
    /** The Task's current delivery state; `null` before the first decision. */
    readonly currentState: TaskDeliveryState | string | null;
    readonly mergeCommitSha: string;
    /** The tracked (source) branch — Builds of any other branch are not candidates. */
    readonly sourceBranch: string;
    readonly builds: readonly DeliveryBuildRow[];
    readonly deployments: readonly DeliveryDeploymentRow[];
    /** `isAncestorCommit(mergeCommitSha, sha)` answers, by candidate sha. */
    readonly ancestry: Readonly<Record<string, boolean | null | undefined>>;
    /** The App Work's deploy target (`none` · `your-cluster` · `ever-works-apps`); `null` = none set. */
    readonly target: string | null;
    /** `targetSettings.autoDeploy` AND the operator's auto-deploy switch. */
    readonly autoDeploy: boolean;
    /** The App spec's `build.strategy`; `null` = unknown (a Build is expected). */
    readonly buildStrategy: string | null;
    /** APW08-G25 `CL-08-1` — Live with warnings closes the Task (default `true`). */
    readonly liveWithWarningsCloses: boolean;
}

export type DeliveryDecision =
    | {
          readonly kind: 'unchanged';
          /** Why nothing moved — for logs and specs, never shown to a user. */
          readonly reason: string;
      }
    | {
          readonly kind: 'state';
          readonly state: TaskDeliveryState;
          /** The Build behind the state, when a Build decided (or the Deployment ran one). */
          readonly buildId: string | null;
          readonly deploymentId: string | null;
          /** The Task moves to Done (FR-32). */
          readonly close: boolean;
          readonly liveWithWarnings: boolean;
          /** `{outcome}` of a `deploy_failed` (FR-30). */
          readonly outcome: TaskDeliveryDeployOutcome | null;
          /** Which phase failed, for the follow-up title (FR-36). */
          readonly failurePhase: 'build' | 'deploy' | null;
          /** The deciding row's commit is a LATER one that carried this change along (S23). */
          readonly carried: boolean;
          readonly reason: string;
      };

const DELIVERY_BUILD_TRIGGERS = new Set(['push', 'manual']);
const IN_FLIGHT_DEPLOYMENT_STATES = new Set([
    'INITIALIZING',
    'QUEUED',
    'BUILDING',
    'DEPLOYING',
    'VERIFYING',
]);

function time(value: Date | string | number): number {
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `appRender.warnings` non-empty, or any failed check in `smokeResult.public` (FR-30). */
export function deploymentHasWarnings(deployment: DeliveryDeploymentRow): boolean {
    const render = isRecord(deployment.appRender) ? deployment.appRender : null;
    const warnings = render?.warnings;
    if (Array.isArray(warnings) && warnings.length > 0) return true;
    const smoke = isRecord(deployment.smokeResult) ? deployment.smokeResult : null;
    const publicChecks = smoke?.public;
    if (Array.isArray(publicChecks)) {
        // APW-06 `CheckResult.status` — `passed` · `failed` · `skipped`.
        return publicChecks.some((check) => isRecord(check) && check.status === 'failed');
    }
    return false;
}

/**
 * `{outcome}` of a failed Deployment, from APW-06's own record: `ROLLED_BACK` is "rolled back",
 * `ERROR` with the `rollback_failed` failure code (APW-06 writes a failed rollback as `ERROR`,
 * `app-deploy.orchestrator.ts` `mapOutcome`) is "rollback failed", every other `ERROR` / `TIMEOUT`
 * is "failed". `null` for a state that is not a failure.
 */
export function deploymentFailureOutcome(
    deployment: Pick<DeliveryDeploymentRow, 'state' | 'appRender'>,
): TaskDeliveryDeployOutcome | null {
    const state = String(deployment.state ?? '').toUpperCase();
    if (state === 'ROLLED_BACK') return 'rolled_back';
    if (state === 'ERROR' || state === 'TIMEOUT') {
        const render = isRecord(deployment.appRender) ? deployment.appRender : null;
        const failure = isRecord(render?.failure) ? render.failure : null;
        const rollback = isRecord(render?.rollback) ? render.rollback : null;
        if (failure?.code === 'rollback_failed' || rollback?.outcome === 'failed') {
            return 'rollback_failed';
        }
        return 'failed';
    }
    return null;
}

/** FR-31 — the row's commit is the merge commit, or the provider said it descends from it. */
export function containsMerge(
    sha: string | null | undefined,
    mergeCommitSha: string,
    ancestry: Readonly<Record<string, boolean | null | undefined>>,
): boolean {
    const candidate = (sha ?? '').trim();
    if (!candidate) return false;
    if (candidate === mergeCommitSha) return true;
    return ancestry[candidate] === true;
}

/** The candidate shas the caller must ask the provider about (everything that is not exact). */
export function ancestryQuestions(
    input: Pick<DeliveryDecisionInput, 'mergeCommitSha' | 'sourceBranch' | 'builds' | 'deployments'>,
): string[] {
    const shas = new Set<string>();
    for (const build of input.builds) {
        if (!isCandidateBuild(build, input.sourceBranch)) continue;
        const sha = (build.commitSha ?? '').trim();
        if (sha && sha !== input.mergeCommitSha) shas.add(sha);
    }
    for (const deployment of input.deployments) {
        const sha = (deployment.commitSha ?? '').trim();
        if (sha && sha !== input.mergeCommitSha) shas.add(sha);
    }
    return [...shas];
}

function isCandidateBuild(build: DeliveryBuildRow, sourceBranch: string): boolean {
    return DELIVERY_BUILD_TRIGGERS.has(String(build.trigger)) && build.branch === sourceBranch;
}

function stateOf(
    state: TaskDeliveryState,
    extra: Partial<Extract<DeliveryDecision, { kind: 'state' }>> & { reason: string },
): DeliveryDecision {
    return {
        kind: 'state',
        state,
        buildId: extra.buildId ?? null,
        deploymentId: extra.deploymentId ?? null,
        close: extra.close ?? false,
        liveWithWarnings: extra.liveWithWarnings ?? false,
        outcome: extra.outcome ?? null,
        failurePhase: extra.failurePhase ?? null,
        carried: extra.carried ?? false,
        reason: extra.reason,
    };
}

/** Plan §2.4's table. Pure: the same input always gives the same decision. */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
    if (input.currentState === 'live' || input.currentState === 'closed_without_deploy') {
        return { kind: 'unchanged', reason: 'terminal' };
    }

    const merge = input.mergeCommitSha;
    const contains = (sha: string | null | undefined) => containsMerge(sha, merge, input.ancestry);

    const builds = input.builds
        .filter((build) => isCandidateBuild(build, input.sourceBranch) && contains(build.commitSha))
        .sort(
            (a, b) =>
                time(b.createdAt) - time(a.createdAt) || Number(b.number ?? 0) - Number(a.number ?? 0),
        );
    const buildIds = new Set(builds.map((build) => build.id));

    const deployments = input.deployments
        .filter(
            (deployment) =>
                String(deployment.state).toUpperCase() !== 'SUPERSEDED' &&
                (contains(deployment.commitSha) ||
                    (deployment.buildId ? buildIds.has(deployment.buildId) : false)),
        )
        .sort((a, b) => time(b.createdAt) - time(a.createdAt));

    const build = builds[0] ?? null;
    const deployment = deployments[0] ?? null;

    const deploymentDecides =
        deployment !== null &&
        (build === null ||
            deployment.buildId === build.id ||
            time(deployment.createdAt) >= time(build.createdAt));

    if (deployment && deploymentDecides) {
        const state = String(deployment.state).toUpperCase();
        // A Deployment that recorded no commit carries its Build's (review of #3030) — the same
        // fallback the delivery view uses — so a Deployment of the merge Build is not "carried".
        const linkedBuild = deployment.buildId
            ? input.builds.find((row) => row.id === deployment.buildId)
            : undefined;
        const decidingSha = ((deployment.commitSha ?? '').trim() || linkedBuild?.commitSha || '').trim();
        const carried = decidingSha !== merge;
        const ids = {
            deploymentId: deployment.id,
            buildId: deployment.buildId ?? build?.id ?? null,
            carried,
        };

        if (IN_FLIGHT_DEPLOYMENT_STATES.has(state)) {
            return stateOf('deploying', { ...ids, reason: `deployment ${state.toLowerCase()}` });
        }
        if (state === 'READY') {
            if (deploymentHasWarnings(deployment)) {
                if (!input.liveWithWarningsCloses) {
                    // APW08-G25 `CL-08-1`, the alternative the owner may choose: a failed public
                    // smoke check (or render warnings) is a failed delivery.
                    return stateOf('deploy_failed', {
                        ...ids,
                        outcome: 'live_with_warnings',
                        failurePhase: 'deploy',
                        reason: 'live with warnings, treated as a failure (operator setting)',
                    });
                }
                return stateOf('live', {
                    ...ids,
                    liveWithWarnings: true,
                    close: true,
                    reason: 'live with warnings',
                });
            }
            return stateOf('live', { ...ids, close: true, reason: 'live' });
        }
        const outcome = deploymentFailureOutcome(deployment);
        if (outcome) {
            return stateOf('deploy_failed', {
                ...ids,
                outcome,
                failurePhase: 'deploy',
                reason: `deployment ${outcome}`,
            });
        }
        if (state === 'CANCELED') {
            // FR-34: a cancelled Deployment returns the state to `built`.
            return stateOf('built', { ...ids, reason: 'deployment cancelled' });
        }
        return { kind: 'unchanged', reason: `deployment state ${state} is not in the table` };
    }

    if (build) {
        const carried = build.commitSha.trim() !== merge;
        const ids = { buildId: build.id, deploymentId: null, carried };
        switch (build.status) {
            case 'queued':
            case 'running':
                return stateOf('building', { ...ids, reason: `build ${build.status}` });
            case 'succeeded':
                if (!build.deployable) {
                    return stateOf('build_failed', {
                        ...ids,
                        failurePhase: 'build',
                        reason: 'build not deployable',
                    });
                }
                if (!input.target || input.target === 'none') {
                    // S21 — target None: a green containing Build closes the Task.
                    return stateOf('built', { ...ids, close: true, reason: 'built, target none' });
                }
                return stateOf('built', {
                    ...ids,
                    reason: input.autoDeploy ? 'built, deployment not started' : 'built, auto-deploy off',
                });
            case 'failed':
            case 'blocked':
                return stateOf('build_failed', {
                    ...ids,
                    failurePhase: 'build',
                    reason: `build ${build.status}`,
                });
            case 'cancelled':
                return { kind: 'unchanged', reason: 'build cancelled; a newer build decides' };
            default:
                return { kind: 'unchanged', reason: `build status ${build.status} is not in the table` };
        }
    }

    if (input.buildStrategy === 'none') {
        // FR-32: `build.strategy: none` closes at merge.
        return stateOf('built', { close: true, reason: 'build strategy none' });
    }

    // Nothing containing the merge has started — or the provider cannot prove a later commit
    // contains it (held, never claimed live without proof).
    return stateOf('merged', { reason: 'waiting for a build' });
}
