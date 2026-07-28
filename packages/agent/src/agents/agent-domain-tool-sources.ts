import type { TasksService } from '../tasks-domain/tasks.service';
import type { TaskChatService } from '../tasks-domain/task-chat.service';
import type {
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
} from '../database/repositories/task-side.repositories';
import type { IngestedEventRepository } from '../ingest/ingested-event.repository';
import type { DigestService } from '../digest/digest.service';
import type { MeetingRepository } from '../meetings/meeting.repository';
import type { FleetService } from '../fleet/fleet.service';
import type { PrReviewToolService } from '../pr-review/agent-pr-review-tools';
import type { MergePolicyResolveInput, MergePolicyService } from '../policy/merge-policy.service';
import type { ResolveMergePolicyArgs } from '../policy/agent-merge-policy-tools';
import type { BrowserAutomationFacadeService } from '../facades/browser-automation.facade';
import type { EscalationToolService } from './agent-escalation-tools';

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

/** Tasks surface — createTask / commentOnTask / transitionTask. */
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
 * The bundle itself. Every member optional: a runtime binds what it can
 * reach, and `resolveAllowedTools` registers exactly the corresponding
 * tools.
 */
/**
 * Headless browsing (audit item G22). Read-only by construction — the
 * source carries only `read`, so no wiring mistake can hand the model the
 * capability's page-driving `act` method.
 */
export interface AgentBrowserToolSource {
    facade: Pick<BrowserAutomationFacadeService, 'read'>;
}

export interface AgentDomainToolSources {
    tasks?: AgentTaskToolSource;
    ingest?: AgentIngestToolSource;
    digest?: AgentDigestToolSource;
    meetings?: AgentMeetingToolSource;
    fleet?: AgentFleetToolSource;
    prReview?: AgentPrReviewToolSource;
    mergePolicy?: AgentMergePolicyToolSource;
    browser?: AgentBrowserToolSource;
    escalations?: AgentEscalationToolSource;
}
