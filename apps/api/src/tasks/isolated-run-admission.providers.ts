import type { Provider } from '@nestjs/common';
import {
    APP_WORK_RUN_ADMISSION,
    APP_WORK_RUN_CONTAINMENT_RECORDER,
    APP_WORK_TASK_CONTAINMENT_READER,
    IsolatedRunAdmissionService,
    type AdmissionWork,
    type AppWorkRunPlacementPreview,
} from '@ever-works/agent/app-works';
import { AgentRunRepository, WorkRepository } from '@ever-works/agent/database';
import { FleetJobRepository, FleetJobService, FleetNodeRepository } from '@ever-works/agent/fleet';
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
 * own rows and answers, served under the three ports its callers inject `@Optional()`:
 *
 * | Token | Asked by |
 * |---|---|
 * | `APP_WORK_RUN_ADMISSION` | `TaskTransitionService.dispatchAgentRun` (T12 site 1, ahead of the gate) |
 * | `APP_WORK_RUN_CONTAINMENT_RECORDER` | `FleetAgentTaskReconcilerService` (T48, beside the receipt) |
 * | `APP_WORK_TASK_CONTAINMENT_READER` | `GET /api/tasks/:id/cost` and the allowance route (T48 / T27) |
 *
 * Provided in `TasksModule` because that is the `@Global()` module that already owns the
 * dispatcher (`previewPlacement`) and imports the fleet graph — the push-credential service and
 * the Fleet repositories this needs.
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

/** Jobs of one node scanned for its latest containment report. */
const NODE_JOBS_SCAN = 25;

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
            jobs: FleetJobService,
            pushCredentials: FleetPushCredentialService,
            dispatcher: AgentTaskExecuteDispatcher,
        ) =>
            new IsolatedRunAdmissionService({
                works: {
                    findById: (id) => works.findById(id) as Promise<AdmissionWork | null>,
                    updateAppWorkColumns: (id, userId, patch) =>
                        works.updateAppWorkColumns(id, userId, patch),
                },
                tasks: { findById: (id) => tasks.findById(id) },
                runs: {
                    recordContainment: (runId, record) => runs.recordContainment(runId, record),
                    findRecentForTask: (taskId, limit) => runs.findRecentForTask(taskId, limit),
                },
                assignees,
                fleet: {
                    nodesForUser: (userId) => nodes.findByUser(userId),
                    nodeById: (nodeId) => nodes.findById(nodeId),
                    pinnedNodeFor: (userId, agentId) =>
                        jobs.resolveAgentTaskTarget(userId, agentId),
                    latestContainment: async (userId, nodeId) => {
                        const rows = await jobRows.findByNodeForUser(
                            userId,
                            nodeId,
                            NODE_JOBS_SCAN,
                        );
                        for (const row of rows) {
                            if (row.kind !== 'agent-task' || !row.completedAt) continue;
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
            FleetJobService,
            FleetPushCredentialService,
            AGENT_TASK_EXECUTE_DISPATCHER,
        ],
    },
    { provide: APP_WORK_RUN_CONTAINMENT_RECORDER, useExisting: APP_WORK_RUN_ADMISSION },
    { provide: APP_WORK_TASK_CONTAINMENT_READER, useExisting: APP_WORK_RUN_ADMISSION },
];

/** The tokens `TasksModule` exports (it is `@Global()`, so the agent-side injections see them). */
export const ISOLATED_RUN_ADMISSION_TOKENS = [
    APP_WORK_RUN_ADMISSION,
    APP_WORK_RUN_CONTAINMENT_RECORDER,
    APP_WORK_TASK_CONTAINMENT_READER,
];
