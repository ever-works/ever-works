import type { Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { isUUID } from 'class-validator';
import {
    APP_WORK_RUN_ADMISSION,
    APP_WORK_RUN_CONTAINMENT_RECORDER,
    APP_WORK_TASK_CONTAINMENT_READER,
    AppChangeTelemetry,
    IsolatedRunAdmissionService,
    type AdmissionWork,
    type AppWorkRunAdmissionGate,
    type AppWorkRunPlacementPreview,
} from '@ever-works/agent/app-works';
import { AgentRunRepository, WorkRepository } from '@ever-works/agent/database';
import { GitFacadeService } from '@ever-works/agent/facades';
import {
    FLEET_APP_WORK_LEASE_ADMISSION,
    FleetAgentNodeAffinityRepository,
    FleetJobRepository,
    FleetNodeRepository,
    type FleetAppWorkLeaseAdmission,
} from '@ever-works/agent/fleet';
import {
    AGENT_TASK_EXECUTE_DISPATCHER,
    TaskAssigneeRepository,
    TaskRepository,
    type AgentTaskExecuteDispatcher,
} from '@ever-works/agent/tasks-domain';
import { FleetPushCredentialService } from '../fleet/fleet-push-credential.service';

/**
 * APW-08 T12 + T48 — the API's binding of isolated-run admission.
 *
 * ONE `IsolatedRunAdmissionService` (agent package, structural reads) built over the platform's
 * own rows and answers, served under the ports its callers inject `@Optional()`:
 *
 * | Token | Asked by |
 * |---|---|
 * | `APP_WORK_RUN_ADMISSION` | `TaskTransitionService.dispatchAgentRun` (site 1), the fleet-aware dispatcher (every Fleet enqueue, lazily) and the allowance route |
 * | `FLEET_APP_WORK_LEASE_ADMISSION` | `FleetJobService.lease` — the node that takes an App Work job (lazily) |
 * | `APP_WORK_RUN_CONTAINMENT_RECORDER` | `FleetAgentTaskReconcilerService` (T48, beside the receipt) |
 * | `APP_WORK_TASK_CONTAINMENT_READER` | `GET /api/tasks/:id/cost` (T48 / T27) |
 *
 * Provided in `TasksModule` because that is the `@Global()` module that already owns the
 * dispatcher (`previewPlacement`) and imports the fleet graph — the push-credential service and
 * the Fleet repositories this needs.
 *
 * ## No construction cycle
 *
 * The admission reads placement through the dispatcher, the dispatcher asks the admission on every
 * Fleet enqueue, and `FleetJobService` (under the router and the push-credential service) asks the
 * lease half — so the two inbound edges are LAZY proxies over `ModuleRef`, resolved on first call.
 * The affinity lookup reads `FleetAgentNodeAffinityRepository` directly (the same row
 * `FleetJobService.resolveAgentTaskTarget` reads) rather than depending on that service.
 *
 * ## The facts, and where each comes from
 *
 * - **Placement** — the fleet-aware dispatcher's `previewPlacement`: the same `routeAgentTask`
 *   call `enqueue` makes (APW08-G11). Read path only; site 1 asks the dispatcher itself.
 * - **Push credential (GAP-15, FR-75)** — `FleetPushCredentialService.describeScope`, the mint's
 *   own precondition (a GitHub App is configured AND an installation this owner controls covers
 *   the repository), read from the installation snapshot with no GitHub call. The git facade's
 *   only owner-level lookup (`getInstallationTokenForOwner`) MINTS a token and does not check that
 *   the installation covers the repository or belongs to the run's owner — so it could admit a
 *   run whose push would still fail; `describeScope` is the exact question the node's mint asks.
 * - **A node's containment** — the latest `agent-task` job that node completed for this owner
 *   (`fleet_jobs.result.containment`, normalized by the reader). Job bodies are purged after
 *   `FLEET_JOB_RETENTION_DAYS`; a node idle past that reads as "not reported" — a downgrade the
 *   owner can allow once.
 * - **Cloud pipeline** — deliberately NOT bound: no Task-run path executes through a pipeline
 *   plugin today (the cloud executor is the platform's own tool loop on a shared worker), so the
 *   isolated-cloud branch admits nothing until such an executor binds `cloudPipeline`.
 */

/**
 * Completed `agent-task` jobs of one node scanned for its latest containment report (the
 * repository filters to those rows before this limit; a node's newest such job normally carries
 * one, so the scan rarely reads past the first row).
 */
const NODE_JOBS_SCAN = 25;

/**
 * The admission, resolved on first use from the module graph (see "No construction cycle").
 * Exported for the dispatcher factory in `TasksModule`.
 */
export function lazyAppWorkRunAdmission(
    moduleRef: ModuleRef,
): Pick<AppWorkRunAdmissionGate, 'admit'> {
    let resolved: IsolatedRunAdmissionService | null = null;
    const get = () =>
        (resolved ??= moduleRef.get<IsolatedRunAdmissionService>(APP_WORK_RUN_ADMISSION, {
            strict: false,
        }));
    return { admit: (input) => get().admit(input) };
}

export const ISOLATED_RUN_ADMISSION_PROVIDERS: Provider[] = [
    {
        provide: APP_WORK_RUN_ADMISSION,
        useFactory: (
            works: WorkRepository,
            tasks: TaskRepository,
            runs: AgentRunRepository,
            assignees: TaskAssigneeRepository,
            nodes: FleetNodeRepository,
            jobRows: FleetJobRepository,
            affinities: FleetAgentNodeAffinityRepository,
            pushCredentials: FleetPushCredentialService,
            dispatcher: AgentTaskExecuteDispatcher,
            git: GitFacadeService,
        ) =>
            new IsolatedRunAdmissionService({
                works: {
                    findById: (id) => works.findById(id) as Promise<AdmissionWork | null>,
                    casAppRunContainmentAllowances: (id, userId, previous, next) =>
                        works.casAppRunContainmentAllowances(id, userId, previous, next),
                },
                tasks: { findById: (id) => tasks.findById(id) },
                runs: {
                    recordContainment: (runId, record) => runs.recordContainment(runId, record),
                    findRecentForTask: (taskId, limit) => runs.findRecentForTask(taskId, limit),
                },
                assignees,
                fleet: {
                    // Every enrolled node of the owner, ANY status (a paused or enrolling node can
                    // lease later, so it is a candidate — review of #3040).
                    nodesForUser: (userId) => nodes.findByUser(userId),
                    nodeById: (nodeId) => nodes.findById(nodeId),
                    pinnedNodeFor: async (userId, agentId) =>
                        isUUID(agentId)
                            ? ((await affinities.findForOwnedAgent(userId, agentId))?.nodeId ??
                              null)
                            : null,
                    latestContainment: async (userId, nodeId) => {
                        // Completed `agent-task` rows only, filtered in the query before the
                        // limit (review of #3040), so newer jobs of other kinds never hide a report.
                        const rows = await jobRows.findLatestCompletedAgentTasksForNode(
                            userId,
                            nodeId,
                            NODE_JOBS_SCAN,
                        );
                        for (const row of rows) {
                            const result = row.result as Record<string, unknown> | null;
                            if (result && result.containment != null) return result.containment;
                        }
                        return null;
                    },
                },
                pushCredential: async (userId, owner, repo) =>
                    (
                        await pushCredentials.describeScope(userId, [
                            { repositoryId: `${owner}/${repo}` },
                        ])
                    ).ok,
                // APW-08 T53 (FR-72) — APW-01 Inspect's own reading (the provider's `sizeKb` on
                // `getRepository`). Asked only while the checkout stage has a limit; unbound (no
                // git facade in this graph) reads as unmeasurable, which that limit refuses.
                ...(git
                    ? {
                          repositorySizeKb: async (
                              userId: string,
                              owner: string,
                              repo: string,
                              work: AdmissionWork,
                          ) => {
                              const provider = (work as { gitProvider?: string | null }).gitProvider;
                              // No provider named on the Work: unmeasurable, never a guessed one.
                              if (!provider) return null;
                              const repository = await git.getRepository(owner, repo, {
                                  userId,
                                  providerId: provider,
                                  workId: work.id,
                              });
                              return typeof repository?.sizeKb === 'number'
                                  ? repository.sizeKb
                                  : null;
                          },
                      }
                    : {}),
                placementFor: async ({ task, agentId }): Promise<AppWorkRunPlacementPreview> =>
                    dispatcher.previewPlacement
                        ? dispatcher.previewPlacement({
                              agentId,
                              userId: task.userId,
                              taskId: task.id,
                              dedupKey: `${task.id}:${agentId}:containment-preview`,
                              tenantId: task.tenantId ?? null,
                              organizationId: task.organizationId ?? null,
                          })
                        : { placement: 'unknown' },
            }),
        inject: [
            WorkRepository,
            TaskRepository,
            AgentRunRepository,
            TaskAssigneeRepository,
            FleetNodeRepository,
            FleetJobRepository,
            FleetAgentNodeAffinityRepository,
            FleetPushCredentialService,
            AGENT_TASK_EXECUTE_DISPATCHER,
            GitFacadeService,
        ],
    },
    {
        // Lazy: `FleetJobService` sits under the push-credential service and the router, both of
        // which the admission depends on.
        provide: FLEET_APP_WORK_LEASE_ADMISSION,
        useFactory: (moduleRef: ModuleRef): FleetAppWorkLeaseAdmission => {
            let resolved: IsolatedRunAdmissionService | null = null;
            const admission = () =>
                (resolved ??= moduleRef.get<IsolatedRunAdmissionService>(APP_WORK_RUN_ADMISSION, {
                    strict: false,
                }));
            // APW-08 T43 — `app.change.run_admitted` through the App Works sanitizer and sink.
            // Resolved lazily, like the admission, and optional: a graph without it emits nothing.
            let telemetry: AppChangeTelemetry | null | undefined;
            const appChangeTelemetry = (): AppChangeTelemetry | null => {
                if (telemetry === undefined) {
                    try {
                        telemetry = moduleRef.get(AppChangeTelemetry, { strict: false });
                    } catch {
                        telemetry = null;
                    }
                }
                return telemetry;
            };
            return {
                admitsLease: (input) => admission().admitsLease(input),
                onLeased: async (input) => {
                    try {
                        const sink = appChangeTelemetry();
                        if (!sink) return;
                        const payload = await admission().runAdmittedPayload(input);
                        if (payload) sink.track('app.change.run_admitted', payload, input.userId);
                    } catch {
                        // Telemetry never costs a lease anything.
                    }
                },
            };
        },
        inject: [ModuleRef],
    },
    { provide: APP_WORK_RUN_CONTAINMENT_RECORDER, useExisting: APP_WORK_RUN_ADMISSION },
    { provide: APP_WORK_TASK_CONTAINMENT_READER, useExisting: APP_WORK_RUN_ADMISSION },
];

/** The tokens `TasksModule` exports (it is `@Global()`, so the agent-side injections see them). */
export const ISOLATED_RUN_ADMISSION_TOKENS = [
    APP_WORK_RUN_ADMISSION,
    FLEET_APP_WORK_LEASE_ADMISSION,
    APP_WORK_RUN_CONTAINMENT_RECORDER,
    APP_WORK_TASK_CONTAINMENT_READER,
];
