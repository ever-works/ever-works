import type { TasksService } from '../tasks-domain/tasks.service';
import type { TaskChatService } from '../tasks-domain/task-chat.service';
import type { TaskAgentReviewService } from '../tasks-domain/task-agent-review.service';
import type {
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
} from '../database/repositories/task-side.repositories';
import type { IngestedEventRepository } from '../ingest/ingested-event.repository';
import type { DigestService } from '../digest/digest.service';
import type { MeetingRepository } from '../meetings/meeting.repository';
import type { FleetService } from '../fleet/fleet.service';
import type { FleetMachineActionsService } from '../fleet/machine/fleet-machine-actions.service';
import type { FleetVirtualService } from '../fleet/virtual/fleet-virtual.service';
import type { FleetCloudService } from '../fleet/cloud/fleet-cloud.service';
import type { FleetSessionsToolService } from '../fleet/agent-fleet-session-tools';
import type { FleetCommandService } from '../fleet/commands/fleet-command.service';
import type { FleetScheduleService } from '../fleet/schedules/fleet-schedule.service';
import type { FleetNodeHealthService } from '../fleet/fleet-node-health.service';
import type { FleetCheckoutService } from '../fleet/checkouts/fleet-checkout.service';
import type { FleetSessionActionService } from '../fleet/session-git/fleet-session-action.service';
import type { FleetSessionPullRequestOpener } from '../fleet/session-git/agent-fleet-session-git-tools';
import type { NeedsALookService } from '../fleet/needs-a-look/needs-a-look.service';
import type { FleetPortsService } from '../fleet/ports/fleet-ports.service';
import type { FleetLogsReaderPort } from '../fleet/logs/agent-fleet-logs-tools';
import type { FleetFilesReaderPort } from '../fleet/files/agent-fleet-files-tools';
import type { FleetGitIdentityToolPort, FleetTaskHandoffToolPort } from '../fleet/agent-fleet-task-tools';
import type { FleetPortTunnelService } from '../fleet/ports/fleet-port-tunnel.service';
import type { FleetOperationsToolPort, FleetStatusReaderPort, FleetWakeToolPort } from '../fleet/fleet-status';
import type { PrReviewToolService } from '../pr-review/agent-pr-review-tools';
import type { MergePolicyResolveInput, MergePolicyService } from '../policy/merge-policy.service';
import type { ResolveMergePolicyArgs } from '../policy/agent-merge-policy-tools';
import type { BrowserAutomationFacadeService } from '../facades/browser-automation.facade';
import type { EscalationToolService } from './agent-escalation-tools';
import type { ToolGrantEnforcer, ToolGrantResolveInput } from '../policy/tool-grant.enforcer';
import type { ResolveToolGrantsArgs } from '../policy/agent-tool-grant-tools';
import type { WorkflowGraphExecutorService } from './workflow-graph-executor.service';
import type { InboxToolService } from '../inbox/agent-inbox-tools';
import type { AppChangeToolService } from '../app-works/agent-app-change-tools';
import type { Work } from '../entities/work.entity';

/**
 * Domain chat-tool sources — the ONE injection seam that lets
 * `AgentToolService.resolveAllowedTools()` (the single tool-assembly
 * point of the agent tool loop) build the per-domain chat tools without
 * the `agents/` subpath gaining a runtime import of the tasks / ingest /
 * digest / meetings / fleet / pr-review / policy graphs.
 *
 * Why a "sources" bundle instead of one facade per domain:
 *
 *  - The descriptor FACTORIES already exist next to their domains
 *    (`tasks-domain/agent-task-tools.ts`, `ingest/agent-ingest-tools.ts`,
 *    `digest/agent-digest-tools.ts`, `meetings/agent-meeting-tools.ts`,
 *    `fleet/agent-fleet-tools.ts`, `pr-review/agent-pr-review-tools.ts`,
 *    `policy/agent-merge-policy-tools.ts`) and are type-only imports of
 *    their services, so importing the factory FUNCTIONS into
 *    `AgentToolService` pulls in zero runtime graph. What cannot be
 *    imported there are the SERVICES themselves — which is exactly (and
 *    only) what this token carries.
 *  - Assembly therefore stays in `resolveAllowedTools`, next to the
 *    permission gates for the built-in tools. No second tool mechanism.
 *
 * Same circular-dep dodge and posture as `AGENT_GIT_FACADE` /
 * `AGENT_PLUGIN_TOOLS_FACADE` / `AGENT_EMAIL_FACADE`: bound by the
 * api-side `@Global()` AgentsModule, `@Optional()` at the consumer, and
 * every sub-bundle is individually optional so a runtime that only wires
 * some domains exposes only those tools (the model never sees a tool
 * whose backing service is absent).
 */
export const AGENT_DOMAIN_TOOL_SOURCES = 'AGENT_DOMAIN_TOOL_SOURCES' as const;

/** Tasks surface — createTask / commentOnTask / transitionTask / submitTaskReview. */
export interface AgentTaskToolSource {
    tasksService: TasksService;
    chatService: TaskChatService;
    /**
     * Security (fail-closed): `commentOnTask`'s membership gate DENIES
     * every call unless all three are bound — see `buildAgentTaskTools`.
     * Production wiring must supply all three.
     */
    assignees?: TaskAssigneeRepository;
    reviewers?: TaskReviewerRepository;
    approvers?: TaskApproverRepository;
    /**
     * Reviewer agent stage (slice AD, EW-811) — backs `submitTaskReview`.
     * Individually optional like every other sub-bundle here: unbound,
     * the tool is not offered and no agent approval can be recorded.
     */
    agentReviews?: Pick<TaskAgentReviewService, 'submitVerdict'> &
        // Settles the review bound to a review run that started without its
        // brief (a job-runtime retry). Optional so a bundle that only backs
        // the verdict tool still type-checks; unbound, the tool loop still
        // refuses to call the model for that run.
        Partial<Pick<TaskAgentReviewService, 'abandonRunWithoutBrief'>>;
}

export interface AgentIngestToolSource {
    repository: IngestedEventRepository;
}

export interface AgentDigestToolSource {
    digestService: Pick<DigestService, 'composeDigest'>;
}

export interface AgentMeetingToolSource {
    repository: MeetingRepository;
}

export interface AgentFleetToolSource {
    service: Pick<FleetService, 'listForUser'>;
    /**
     * Servers and ports (FL-10) — `fleet_ports_list` / `fleet_ports_open`.
     * Optional: unbound (a context without the API's node link), the two tools
     * are simply not offered.
     */
    ports?: Pick<FleetPortsService, 'list' | 'open'>;
    /** Servers and ports, phase 2 — `fleet_ports_preview_open|close` (offered only while the tunnel flag is on). */
    portTunnels?: Pick<FleetPortTunnelService, 'open' | 'closeForUser' | 'isEnabled'>;
    /**
     * Services, processes and Docker on computers (FL-09) — backs
     * `fleet_services_*`, `fleet_processes_*` and `fleet_docker_*`.
     * Optional: unbound, those tools are simply not offered.
     */
    /**
     * Virtual computers (FL-16) — backs `fleet_virtual_*`. Optional: unbound (or
     * `FLEET_VIRTUAL_ENABLED` off), those tools are simply not offered.
     */
    virtual?: Pick<FleetVirtualService, 'options' | 'listChildren' | 'listAllChildren' | 'create' | 'power' | 'destroy'>;
    /**
     * Cloud computers (FL-17) — backs `fleet_cloud_*`. Optional: unbound (or
     * `FLEET_CLOUD_ENABLED` off), those tools are simply not offered.
     */
    cloud?: Pick<FleetCloudService, 'list' | 'options' | 'usage' | 'create' | 'power' | 'destroy'>;
    machine?: Pick<
        FleetMachineActionsService,
        | 'listServices'
        | 'serviceAction'
        | 'listProcesses'
        | 'signalProcess'
        | 'listContainers'
        | 'containerAction'
        | 'listImages'
        | 'pullImage'
        | 'listComposeProjects'
        | 'describeComposeProject'
        | 'composeAction'
    >;
    /**
     * Computer health (FL-03 second phase) — when bound, the read-only
     * `fleet_nodes_health` / `fleet_nodes_needs_a_look` tools are offered
     * (`buildFleetHealthTools`). Optional and unbound by default: FL-19 owns
     * the Agent catalogue and binds it with the Agent gates.
     */
    health?: {
        service: Pick<FleetService, 'getVisibleForUser' | 'listVisibleForUser'>;
        history: Pick<FleetNodeHealthService, 'history' | 'isHistoryEnabled'>;
        needsALook?: Pick<NeedsALookService, 'forNodes'>;
    };
    /**
     * Checkouts on computers (FL-14 P2, spec FR-29) — when bound, the
     * `fleet_checkouts_*` tools are offered (`buildFleetCheckoutTools`), each
     * act checked against the Node's `checkouts` audience for the Agent's
     * owner and classified on the trust ladder (`safety/action-category.ts`).
     */
    checkouts?: {
        service: Pick<
            FleetCheckoutService,
            'list' | 'listForNode' | 'get' | 'create' | 'sync' | 'archive' | 'remove'
        >;
    };
    /**
     * Session git & actions (FL-06 P3, spec FR-26) — when bound, the
     * `fleet_sessions_actions_list|action`, `fleet_checkouts_changes` and
     * `fleet_checkouts_open_pull_request` tools are offered
     * (`buildFleetSessionGitTools`), each act checked against the Node's
     * audience for the Agent's owner. The pull-request opener is the API's.
     */
    sessionGit?: {
        actions: Pick<FleetSessionActionService, 'list' | 'send'>;
        checkouts?: Pick<FleetCheckoutService, 'changes'>;
        pullRequests?: FleetSessionPullRequestOpener;
    };
    /**
     * Logs on computers (FL-08) — when bound, the read-only
     * `fleet_logs_sources` / `fleet_logs_read` tools are offered
     * (`buildFleetLogsTools`), reading through the API's node link. Optional
     * and unbound by default: FL-19 owns the Agent catalogue and binds it
     * (the API binds the port under `FLEET_LOGS_READER`).
     */
    logs?: {
        reader: FleetLogsReaderPort;
    };
    /**
     * Files on computers (FL-11) — when bound, the read-only
     * `fleet_files_roots` / `fleet_files_list` / `fleet_files_stat` tools are
     * offered (`buildFleetFilesTools`), reading through the API's node link.
     * Optional and unbound by default: FL-19 owns the Agent catalogue and binds
     * it (the API binds the port under `FLEET_FILES_READER`).
     */
    files?: {
        reader: FleetFilesReaderPort;
    };
    /**
     * FL-19 — `fleet_status` ("how is my fleet?" in one call): the API's status
     * service under `FLEET_STATUS_READER`. Unbound, the tool is not offered.
     */
    status?: FleetStatusReaderPort;
    /**
     * FL-19 — `fleet_operations_get|list`: the node link's operations registry
     * (FL-02). Unbound (no link in this context), the tools are not offered.
     */
    operations?: FleetOperationsToolPort;
    /** FL-19 P2 — `fleet_nodes_wake` (FL-03's wake route as the owner). Unbound, not offered. */
    wake?: FleetWakeToolPort;
}

/**
 * Commands on computers (FL-12 P2) — the `commands` tool family
 * (`fleet/commands/agent-fleet-command-tools.ts`). `fleet_commands_run` only
 * ever files an approval (`proposals`); the reads and the cancel use this.
 */
export interface AgentFleetCommandToolSource {
    service: Pick<FleetCommandService, 'listRecent' | 'get' | 'cancel'>;
}

/**
 * FL-15 P3 — Tasks on computers (`fleet/agent-fleet-task-tools.ts`): the
 * hand-off options and the git identity check. Each half is optional; the
 * builder offers nothing while FLEET_CHECKOUTS_ENABLED is off.
 */
export interface AgentFleetTaskToolSource {
    handoff?: FleetTaskHandoffToolPort | null;
    identity?: FleetGitIdentityToolPort | null;
}

/**
 * Schedules on computers (FL-13 P2) — the `schedules` tool family
 * (`fleet/schedules/agent-fleet-schedule-tools.ts`). Create, update, delete and
 * run only ever file an approval (`proposals`); the reads, pause and resume use this.
 */
export interface AgentFleetScheduleToolSource {
    service: Pick<FleetScheduleService, 'listForUser' | 'get' | 'runs' | 'pause' | 'resume'>;
}

/** FL-04 P2 — the `sessions` tool family (`fleet/agent-fleet-session-tools.ts`). */
export interface AgentFleetSessionToolSource {
    service: FleetSessionsToolService['service'];
}

export interface AgentPrReviewToolSource {
    prReviewService: PrReviewToolService;
}

export interface AgentMergePolicyToolSource {
    service: Pick<MergePolicyService, 'resolve'>;
    /**
     * Owner check for the model-supplied ids. Takes the acting `userId`
     * explicitly (unlike the factory's closure form) because the binding
     * is built once at module scope, not per agent. Returns the scope
     * tuple the user may resolve, or null when they may not — mirroring
     * `MergePolicyController.resolve`'s 404-on-foreign-id posture.
     */
    authorize(
        userId: string,
        input: ResolveMergePolicyArgs,
    ): Promise<MergePolicyResolveInput | null>;
}

/**
 * Judgment layer G3/G10 — the escalation queue ("what is waiting on
 * me?"). Routed through this bundle like every other domain even though
 * `AgentEscalationService` lives in `agents/` itself: importing the
 * class into `AgentToolService` for a DI token would drag the AI facade
 * (the confidence judge) into the tool-assembly module graph, which is
 * exactly the runtime coupling this seam exists to prevent.
 */
export interface AgentEscalationToolSource {
    service: EscalationToolService;
}

/**
 * Tool-grant matrix (audit item G4) — the read-only grant surface.
 *
 * Same shape and same reasoning as `AgentMergePolicyToolSource`: the ids
 * come from the MODEL, so `authorize` runs an owner check before any
 * resolution and returns null (never throws) when the user may not reach
 * the scope — no existence leak.
 */
export interface AgentToolGrantToolSource {
    service: Pick<ToolGrantEnforcer, 'resolve' | 'decide'>;
    authorize(userId: string, input: ResolveToolGrantsArgs): Promise<ToolGrantResolveInput | null>;
}

/**
 * Headless browsing (audit item G22). Read-only by construction — the
 * source carries only `read`, so no wiring mistake can hand the model the
 * capability's page-driving `act` method.
 */
export interface AgentBrowserToolSource {
    facade: Pick<BrowserAutomationFacadeService, 'read'>;
}

/**
 * Workflow graphs (judgment layer G5) — the seam that finally gives
 * `WorkflowGraphExecutorService` a production caller. Only `execute` is
 * carried: a graph is admitted and clamped inside the descriptor factory,
 * and nothing else on the executor should be reachable from chat.
 */
export interface AgentWorkflowToolSource {
    executor: Pick<WorkflowGraphExecutorService, 'execute'>;
}

/**
 * Inbox (operator message center) — the `ask_human` blocking-question
 * tool. Ungated by agent permissions on purpose: asking the OWNER a
 * question grants nothing and touches nothing, and a gated question
 * tool would push agents back to guessing. Only `askHuman` is carried
 * — the reply router and list surface must not be reachable from the
 * model.
 */
export interface AgentInboxToolSource {
    service: InboxToolService;
}

/**
 * APW-08 T26 — the App change chat tools. `authorize` is the owner check the model-supplied
 * Work id goes through on every call: the Work when the Agent's owner has `level` access to
 * it AND it is an App Work, `null` otherwise (no existence leak).
 */
export interface AgentAppChangeToolSource {
    service: AppChangeToolService;
    authorize(userId: string, workId: string, level: 'edit' | 'view'): Promise<Work | null>;
}

/**
 * Prompt-injection hardening — the owner-approval seam for Agent actions that
 * must never take effect on a model's say-so alone (`resolve_escalation`,
 * `editAgentFile`). Files a PENDING Agent Action Approval Queue proposal
 * (`actionType: 'other'`, `humanDecisionRequired`: a guardrail may block it,
 * never approve it) and returns its id and status. The approved action is
 * applied by `AgentProposalExecutionListener`, never by the tool.
 *
 * Unbound, both tools fail CLOSED: they refuse and tell the model to ask the
 * owner, rather than acting without an approval path.
 */
export interface AgentProposalToolSource {
    propose(
        userId: string,
        input: {
            agentId: string;
            runId?: string | null;
            title: string;
            payload: Record<string, unknown>;
            /**
             * What the proposal is ABOUT, for de-duplication (e.g.
             * `escalation:<id>`): one proposal per subject — a repeat returns
             * the existing pending one instead of a second card.
             */
            subjectKey?: string | null;
        },
    ): Promise<{ id: string; status: 'pending' | 'approved' | 'rejected' }>;
}

/**
 * The bundle itself. Every member optional: a runtime binds what it can
 * reach, and `resolveAllowedTools` registers exactly the corresponding
 * tools.
 */
export interface AgentDomainToolSources {
    tasks?: AgentTaskToolSource;
    ingest?: AgentIngestToolSource;
    digest?: AgentDigestToolSource;
    meetings?: AgentMeetingToolSource;
    fleet?: AgentFleetToolSource;
    fleetSessions?: AgentFleetSessionToolSource;
    /** FL-12 P2 — bound only while FLEET_COMMANDS_ENABLED is on. */
    fleetCommands?: AgentFleetCommandToolSource;
    /** FL-15 P3 — `fleet_tasks_handoff_options`, `fleet_nodes_git_identity_*`. */
    fleetTasks?: AgentFleetTaskToolSource;
    /** FL-13 P2 — `fleet_schedules_*` (bound only while FLEET_COMMANDS_ENABLED is on). */
    fleetSchedules?: AgentFleetScheduleToolSource;
    prReview?: AgentPrReviewToolSource;
    mergePolicy?: AgentMergePolicyToolSource;
    browser?: AgentBrowserToolSource;
    escalations?: AgentEscalationToolSource;
    toolGrants?: AgentToolGrantToolSource;
    workflow?: AgentWorkflowToolSource;
    inbox?: AgentInboxToolSource;
    appChanges?: AgentAppChangeToolSource;
    proposals?: AgentProposalToolSource;
}
