/**
 * api-side AgentsModule — module-shape pin.
 *
 * This module is where the agent-side `@Optional() @Inject(TOKEN)` seams
 * are actually bound. An unbound token is invisible to `tsc`, invisible
 * to every unit test (the optional injection just resolves to
 * `undefined`), and invisible to `generate:openapi` — which runs Nest in
 * PREVIEW mode and never instantiates a provider. The chat-tool
 * assembly this pin guards spent an entire program dead for exactly that
 * reason: six descriptor factories existed, were unit-tested, and were
 * never handed their services.
 *
 * Pattern (and mocking posture) mirrors
 * `trigger/trigger-internal.module.spec.ts`: stub the heavy workspace
 * barrels at module scope so the decorator metadata can be asserted
 * without dragging the entity/zod graph through Jest's CJS transformer.
 * Injection tokens are plain strings, so the stubs re-declare their real
 * values and the assertions stay honest.
 */

jest.mock('@ever-works/agent/agents', () => ({
    AgentsModule: class AgentsModule {},
    AgentRepository: class AgentRepository {},
    RunSteeringService: class RunSteeringService {},
    // Judgment layer G3/G10 — backs the `escalations` domain tool source.
    AgentEscalationService: class AgentEscalationService {},
    // Judgment layer G5 — backs the `workflow` domain tool source.
    WorkflowGraphExecutorService: class WorkflowGraphExecutorService {},
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_RUN_CHAT_BACK_POSTER: 'AGENT_RUN_CHAT_BACK_POSTER',
    AGENT_RUN_TASK_FINISHER: 'AGENT_RUN_TASK_FINISHER',
    AGENT_PLUGIN_TOOLS_FACADE: 'AGENT_PLUGIN_TOOLS_FACADE',
    AGENT_AI_DISPATCH_FACADE: 'AGENT_AI_DISPATCH_FACADE',
    AGENT_GIT_FACADE: 'AGENT_GIT_FACADE',
    AGENT_EMAIL_FACADE: 'AGENT_EMAIL_FACADE',
    AGENT_NOTIFY_CHANNEL_FACADE: 'AGENT_NOTIFY_CHANNEL_FACADE',
    AGENT_DOMAIN_TOOL_SOURCES: 'AGENT_DOMAIN_TOOL_SOURCES',
    // Agent Plugins MCP slice (T26) — the MCP tool-source seam.
    AGENT_MCP_TOOL_SOURCE: 'AGENT_MCP_TOOL_SOURCE',
}));
jest.mock('@ever-works/agent/mcp', () => ({
    McpModule: class McpModule {},
    McpToolSource: class McpToolSource {},
}));
jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
    AgentEmailAssignmentRepository: class AgentEmailAssignmentRepository {},
    TenantEmailAddressRepository: class TenantEmailAddressRepository {},
    NotificationChannelRepository: class NotificationChannelRepository {},
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    FacadesModule: class FacadesModule {},
    NotificationChannelFacadeService: class NotificationChannelFacadeService {},
    SearchFacadeService: class SearchFacadeService {},
    ScreenshotFacadeService: class ScreenshotFacadeService {},
    BrowserAutomationFacadeService: class BrowserAutomationFacadeService {},
    ContentExtractorFacadeService: class ContentExtractorFacadeService {},
    AiFacadeService: class AiFacadeService {},
    GitFacadeService: class GitFacadeService {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    INBOUND_EMAIL_TASK_SPAWNER: 'INBOUND_EMAIL_TASK_SPAWNER',
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksDomainModule: class TasksDomainModule {},
    TaskChatService: class TaskChatService {},
    TasksService: class TasksService {},
    TaskAssigneeRepository: class TaskAssigneeRepository {},
    TaskReviewerRepository: class TaskReviewerRepository {},
    TaskApproverRepository: class TaskApproverRepository {},
    TaskStatus: {},
    RUN_STEERING_PORT: 'RUN_STEERING_PORT',
}));
jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestModule: class EventIngestModule {},
    IngestedEventRepository: class IngestedEventRepository {},
}));
jest.mock('@ever-works/agent/digest', () => ({
    DigestModule: class DigestModule {},
    DigestService: class DigestService {},
}));
jest.mock('@ever-works/agent/meetings', () => ({
    MeetingsModule: class MeetingsModule {},
    MeetingRepository: class MeetingRepository {},
}));
jest.mock('@ever-works/agent/fleet', () => ({
    FleetModule: class FleetModule {},
    FleetService: class FleetService {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({
    PrReviewModule: class PrReviewModule {},
    PrReviewService: class PrReviewService {},
}));
jest.mock('@ever-works/agent/policy', () => ({
    PolicyModule: class PolicyModule {},
    MergePolicyService: class MergePolicyService {},
    PullRequestGateService: class PullRequestGateService {},
    ToolGrantService: class ToolGrantService {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/skills', () => ({
    SkillsModule: class SkillsModule {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('@ever-works/agent/inbox', () => ({
    InboxModule: class InboxModule {},
    InboxService: class InboxService {},
}));
jest.mock('@ever-works/trigger-tasks', () => ({
    TriggerModule: class TriggerModule {},
    TriggerService: class TriggerService {},
    agentHeartbeatTriggerAdapter: {},
    createAgentRunCancellerAdapter: () => ({}),
}));
jest.mock('../email/email.module', () => ({ EmailModule: class EmailModule {} }));
jest.mock('../email/email.service', () => ({ EmailService: class EmailService {} }));
jest.mock('../auth/auth.module', () => ({ AuthModule: class AuthModule {} }));
jest.mock('./agents.controller', () => ({ AgentsController: class AgentsController {} }));
// Agent Collaborators — same stub posture as the sibling controllers so
// the decorator-metadata assertions never drag the DTO/entity graph in.
jest.mock('./agent-collaborators.controller', () => ({
    AgentCollaboratorsController: class AgentCollaboratorsController {},
}));
jest.mock('./agent-templates.controller', () => ({
    AgentTemplatesController: class AgentTemplatesController {},
}));
jest.mock('./agent-template-catalog.service', () => ({
    AgentTemplateCatalogService: class AgentTemplateCatalogService {},
}));

import 'reflect-metadata';
import { AgentsModule } from './agents.module';
import { EventIngestModule, IngestedEventRepository } from '@ever-works/agent/ingest';
import { DigestModule, DigestService } from '@ever-works/agent/digest';
import { MeetingsModule, MeetingRepository } from '@ever-works/agent/meetings';
import { FleetModule, FleetService } from '@ever-works/agent/fleet';
import { PrReviewModule, PrReviewService } from '@ever-works/agent/pr-review';
import { PolicyModule, MergePolicyService, ToolGrantService } from '@ever-works/agent/policy';
import { WorkOwnershipService } from '@ever-works/agent/services';
import {
    TasksService,
    TaskChatService,
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
} from '@ever-works/agent/tasks-domain';
import {
    AgentRepository,
    AgentEscalationService,
    WorkflowGraphExecutorService,
    AGENT_DOMAIN_TOOL_SOURCES,
    AGENT_MCP_TOOL_SOURCE,
    AGENT_GIT_FACADE,
    AGENT_RUN_CANCELLER,
} from '@ever-works/agent/agents';
import { McpModule, McpToolSource } from '@ever-works/agent/mcp';
import { BrowserAutomationFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import { InboxModule as AgentInboxModule, InboxService } from '@ever-works/agent/inbox';
import { PullRequestGateService } from '@ever-works/agent/policy';
import { WorkRepository } from '@ever-works/agent/database';

type FactoryProvider = {
    provide?: unknown;
    inject?: unknown[];
    useFactory?: (...args: unknown[]) => unknown;
};

const meta = (key: string): unknown[] => Reflect.getMetadata(key, AgentsModule) ?? [];

const findProvider = (token: unknown): FactoryProvider | undefined =>
    (meta('providers') as FactoryProvider[]).find(
        (provider) => provider && typeof provider === 'object' && provider.provide === token,
    );

describe('api-side AgentsModule — domain chat-tool wiring', () => {
    it('imports every module that backs a domain chat tool', () => {
        const imports = meta('imports');
        expect(imports).toContain(EventIngestModule);
        expect(imports).toContain(DigestModule);
        expect(imports).toContain(MeetingsModule);
        expect(imports).toContain(FleetModule);
        expect(imports).toContain(PrReviewModule);
        expect(imports).toContain(PolicyModule);
        expect(imports).toContain(AgentInboxModule);
    });

    it('binds AGENT_DOMAIN_TOOL_SOURCES — without it every domain tool is dead code', () => {
        expect(findProvider(AGENT_DOMAIN_TOOL_SOURCES)).toBeDefined();
    });

    it('injects exactly the services the descriptor factories need', () => {
        expect(findProvider(AGENT_DOMAIN_TOOL_SOURCES)?.inject).toEqual([
            TasksService,
            TaskChatService,
            TaskAssigneeRepository,
            TaskReviewerRepository,
            TaskApproverRepository,
            IngestedEventRepository,
            DigestService,
            MeetingRepository,
            FleetService,
            PrReviewService,
            MergePolicyService,
            WorkOwnershipService,
            AgentRepository,
            // Audit G22 — headless browsing (read-only).
            BrowserAutomationFacadeService,
            // Judgment layer G3/G10 — the escalation queue tools.
            AgentEscalationService,
            // Tool-grant matrix (audit item G4) — the read-only grant tools.
            ToolGrantService,
            // Judgment layer G5 — the workflow-graph tools. This binding is
            // what gives `WorkflowGraphExecutorService` a production caller.
            WorkflowGraphExecutorService,
            // Inbox (operator message center) — the `ask_human` tool.
            InboxService,
        ]);
    });

    it('provides WorkOwnershipService locally but does NOT export it from this @Global module', () => {
        expect(meta('providers')).toContain(WorkOwnershipService);
        expect(meta('exports')).not.toContain(WorkOwnershipService);
    });

    it('exports the token so the agent-side @Optional() injection resolves', () => {
        expect(meta('exports')).toContain(AGENT_DOMAIN_TOOL_SOURCES);
    });

    it('imports McpModule and binds AGENT_MCP_TOOL_SOURCE to the shared McpToolSource', () => {
        // Agent Plugins MCP slice (T26). Without this binding the
        // @Optional() injection in AgentToolService resolves to undefined
        // and no run ever sees an mcp__<server>__<tool> descriptor —
        // exactly the dead-seam failure mode this pin exists to catch.
        expect(meta('imports')).toContain(McpModule);
        const provider = (meta('providers') as { provide?: unknown; useExisting?: unknown }[]).find(
            (p) => p && typeof p === 'object' && p.provide === AGENT_MCP_TOOL_SOURCE,
        );
        expect(provider).toBeDefined();
        expect(provider?.useExisting).toBe(McpToolSource);
        expect(meta('exports')).toContain(AGENT_MCP_TOOL_SOURCE);
    /**
     * Goals autonomy layer — `GoalOrchestratorService.cancelActiveRun` takes
     * this token through `@Optional() @Inject()`. `@Global()` publishes only
     * EXPORTED providers, so leaving it out of `exports` resolves it to
     * `undefined` in production and the Goal loop's cancel/restart silently
     * degrades to a DB-only cancel — the row reads `cancelled` while the
     * Trigger.dev job keeps running and spending.
     */
    it('exports AGENT_RUN_CANCELLER so the Goal loop cancels the REMOTE run too', () => {
        expect(
            meta('providers').map((p: unknown) => (p as { provide?: unknown })?.provide),
        ).toContain(AGENT_RUN_CANCELLER);
        expect(meta('exports')).toContain(AGENT_RUN_CANCELLER);
    });

    it('binds all three Task membership repositories (the commentOnTask gate is fail-closed)', () => {
        const factory = findProvider(AGENT_DOMAIN_TOOL_SOURCES);
        const bundle = factory?.useFactory?.(
            ...(factory.inject ?? []).map((_, index) => ({ stub: index })),
        ) as { tasks?: Record<string, unknown> };
        expect(bundle?.tasks?.assignees).toBeDefined();
        expect(bundle?.tasks?.reviewers).toBeDefined();
        expect(bundle?.tasks?.approvers).toBeDefined();
    });

    it('carries every domain in the assembled bundle', () => {
        const factory = findProvider(AGENT_DOMAIN_TOOL_SOURCES);
        const bundle = factory?.useFactory?.(
            ...(factory.inject ?? []).map((_, index) => ({ stub: index })),
        ) as Record<string, unknown>;
        expect(Object.keys(bundle)).toEqual([
            'tasks',
            'ingest',
            'digest',
            'meetings',
            'fleet',
            // Audit G22 — headless browsing. Bound with only `read`, so the
            // capability's page-driving `act` is unreachable from chat.
            'browser',
            'prReview',
            'mergePolicy',
            'escalations',
            // Audit G4 — the read-only tool-grant matrix.
            'toolGrants',
            // Judgment layer G5 — workflow graphs.
            'workflow',
            // Inbox (operator message center) — the `ask_human` tool.
            'inbox',
        ]);
    });
});

/**
 * Quality gates (audit W3 M3) — the `openPullRequest` Agent tool is one of
 * the non-worker `createPullRequest` callers, so its adapter has to consult
 * `PullRequestGateService`. These build the real factory with stubs and
 * exercise the three outcomes.
 */
describe('api-side AgentsModule — AGENT_GIT_FACADE PR gate', () => {
    type OpenPrFacade = {
        openPullRequest: (input: Record<string, unknown>) => Promise<{ number: number }>;
    };

    const buildFacade = (gate: { assertAllowed: jest.Mock }, git: Record<string, jest.Mock>) => {
        const factory = findProvider(AGENT_GIT_FACADE);
        return factory?.useFactory?.(git, { findById: jest.fn() }, gate, {
            findById: jest.fn().mockResolvedValue({ id: 'work-1', checksPolicy: 'required' }),
        }) as OpenPrFacade;
    };

    const makeGit = () => ({
        getRepoDir: jest.fn().mockResolvedValue('/tmp/work-1'),
        createPullRequest: jest.fn().mockResolvedValue({ number: 12, url: 'https://pr/12' }),
    });

    it('injects the PR gate and the Work repository alongside the git facade', () => {
        expect(findProvider(AGENT_GIT_FACADE)?.inject).toEqual([
            GitFacadeService,
            AgentRepository,
            PullRequestGateService,
            WorkRepository,
        ]);
    });

    it('opens the PR when the gate allows it', async () => {
        const git = makeGit();
        const gate = { assertAllowed: jest.fn().mockResolvedValue({ allowed: true }) };
        const facade = buildFacade(gate, git);

        const pr = await facade.openPullRequest({
            userId: 'u1',
            agentId: 'a1',
            workId: 'work-1',
            title: 't',
            body: 'b',
            head: 'feature',
        });

        expect(gate.assertAllowed).toHaveBeenCalled();
        expect(git.createPullRequest).toHaveBeenCalled();
        expect(pr.number).toBe(12);
    });

    it('opens NO PR and surfaces the refusal when the gate fails', async () => {
        const git = makeGit();
        const gate = {
            assertAllowed: jest
                .fn()
                .mockRejectedValue(new Error('Quality gate red — build (red).')),
        };
        const facade = buildFacade(gate, git);

        await expect(
            facade.openPullRequest({
                userId: 'u1',
                agentId: 'a1',
                workId: 'work-1',
                title: 't',
                body: 'b',
                head: 'feature',
            }),
        ).rejects.toThrow('Quality gate red');
        expect(git.createPullRequest).not.toHaveBeenCalled();
    });
});
