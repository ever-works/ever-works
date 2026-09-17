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
    AGENT_RUN_CONVERSATION_REPLY_POSTER: 'AGENT_RUN_CONVERSATION_REPLY_POSTER',
    AGENT_RUN_TASK_FINISHER: 'AGENT_RUN_TASK_FINISHER',
    AGENT_PLUGIN_TOOLS_FACADE: 'AGENT_PLUGIN_TOOLS_FACADE',
    AGENT_AI_DISPATCH_FACADE: 'AGENT_AI_DISPATCH_FACADE',
    AGENT_GIT_FACADE: 'AGENT_GIT_FACADE',
    AGENT_EMAIL_FACADE: 'AGENT_EMAIL_FACADE',
    AGENT_NOTIFY_CHANNEL_FACADE: 'AGENT_NOTIFY_CHANNEL_FACADE',
    AGENT_DOMAIN_TOOL_SOURCES: 'AGENT_DOMAIN_TOOL_SOURCES',
    // Agent Plugins MCP slice (T26) — the MCP tool-source seam.
    AGENT_MCP_TOOL_SOURCE: 'AGENT_MCP_TOOL_SOURCE',
    // Skill files (#2080) — the uploads-spine content-reader seam.
    SKILL_FILE_CONTENT_READER: 'SKILL_FILE_CONTENT_READER',
    // Panic controls (EW-778) — the global stop flag seam.
    RUN_KILL_SWITCH: 'RUN_KILL_SWITCH',
}));
jest.mock('@ever-works/agent/conversations', () => ({
    ConversationsModule: class ConversationsModule {},
    ConversationMessageService: class ConversationMessageService {},
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
    // Reviewer agent stage (slice AD, EW-811).
    TaskAgentReviewService: class TaskAgentReviewService {},
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
    FleetJobService: class FleetJobService {},
    FleetKillSwitchService: class FleetKillSwitchService {},
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
// Safety rails (AW-24) — the one gate every side-effectful action passes
// through. Stubbed at module scope like every sibling barrel so the
// decorator-metadata assertions never drag the entity graph in.
jest.mock('@ever-works/agent/safety', () => ({
    SafetyModule: class SafetyModule {},
    SafetyGateService: class SafetyGateService {},
    SAFETY_GATE: 'SAFETY_GATE',
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
jest.mock('../skills/skills.module', () => ({ SkillsModule: class SkillsModule {} }));
jest.mock('../skills/skill-file-content-reader.service', () => ({
    SkillFileContentReaderService: class SkillFileContentReaderService {},
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
    TaskAgentReviewService,
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
import { ConversationsModule, ConversationMessageService } from '@ever-works/agent/conversations';
import { BrowserAutomationFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import { InboxModule as AgentInboxModule, InboxService } from '@ever-works/agent/inbox';
import { PullRequestGateService } from '@ever-works/agent/policy';
import { WorkRepository } from '@ever-works/agent/database';
import { SafetyGateService, SafetyModule } from '@ever-works/agent/safety';

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
            // Reviewer agent stage (slice AD, EW-811) — backs
            // `submitTaskReview`, the ONE way a review run records a
            // verdict. Appended LAST: this array is positional and the
            // container passes it positionally to `useFactory`, so this
            // assertion is what stops a future slice inserting in the
            // middle and silently rebinding every service after it.
            TaskAgentReviewService,
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
    });

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

    /**
     * Named Conversations — `AgentRunService.finalize()` stores a Conversation
     * reply through this port before it marks the run completed. Unbound (or
     * not exported from this @Global() module), the @Optional() injection
     * resolves to `undefined` and the run completes before its reply is
     * stored — a failed store would then lose the reply for good.
     */
    it('binds + exports AGENT_RUN_CONVERSATION_REPLY_POSTER to the Conversation reply record', async () => {
        expect(meta('imports')).toContain(ConversationsModule);
        const factory = findProvider('AGENT_RUN_CONVERSATION_REPLY_POSTER');
        expect(factory?.inject).toEqual([ConversationMessageService]);
        expect(meta('exports')).toContain('AGENT_RUN_CONVERSATION_REPLY_POSTER');

        const messages = { recordAgentReply: jest.fn().mockResolvedValue({ id: 'reply-1' }) };
        const poster = factory?.useFactory?.(messages) as {
            postReply: (input: Record<string, string>) => Promise<{ messageId: string }>;
        };
        await expect(
            poster.postReply({
                runId: 'r1',
                userId: 'u1',
                agentId: 'a1',
                conversationMessageId: 'm1',
                body: 'Here you go.',
            }),
        ).resolves.toEqual({ messageId: 'reply-1' });
        expect(messages.recordAgentReply).toHaveBeenCalledWith({
            runId: 'r1',
            userId: 'u1',
            agentId: 'a1',
            replyToMessageId: 'm1',
            body: 'Here you go.',
        });
    });

    it('binds + exports SKILL_FILE_CONTENT_READER — without it getSkillFile refuses every read', () => {
        const provider = (meta('providers') as Array<{ provide?: unknown }>).find(
            (p) => p && typeof p === 'object' && p.provide === 'SKILL_FILE_CONTENT_READER',
        );
        expect(provider).toBeDefined();
        expect(meta('exports')).toContain('SKILL_FILE_CONTENT_READER');
    });

    /**
     * Panic controls (EW-778) — the dispatch gate reads the GLOBAL STOP
     * FLAG through `@Optional() @Inject(RUN_KILL_SWITCH)`. Unbound, or
     * bound but not exported from this @Global() module, it resolves to
     * `undefined` and every new run sails through a set flag: the switch
     * would exist, be flipped, be audited — and stop nothing.
     */
    it('binds + exports RUN_KILL_SWITCH to the fleet kill-switch service', () => {
        const provider = (
            meta('providers') as Array<{ provide?: unknown; useExisting?: unknown }>
        ).find((p) => p && typeof p === 'object' && p.provide === 'RUN_KILL_SWITCH');
        expect(provider).toBeDefined();
        expect((provider?.useExisting as { name?: string })?.name).toBe('FleetKillSwitchService');
        expect(meta('exports')).toContain('RUN_KILL_SWITCH');
    });

    /**
     * Safety rails (AW-24) — `AgentRunService.invokeTool` is the one place
     * every tool call converges, and it reads the gate through
     * `@Optional() @Inject(SAFETY_GATE)`. `@Global()` publishes only
     * EXPORTED providers, so a binding left out of `exports` resolves to
     * `undefined` and every rail goes dark: the trust ladder would be
     * stored, rendered and audited, and would stop nothing. This is the
     * same failure RUN_KILL_SWITCH's pin above exists to catch.
     */
    it('binds + exports SAFETY_GATE to the safety gate service', () => {
        expect(meta('imports')).toContain(SafetyModule);
        const provider = (
            meta('providers') as Array<{ provide?: unknown; useExisting?: unknown }>
        ).find((p) => p && typeof p === 'object' && p.provide === 'SAFETY_GATE');
        expect(provider).toBeDefined();
        expect(provider?.useExisting).toBe(SafetyGateService);
        expect(meta('exports')).toContain('SAFETY_GATE');
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

    it('binds the reviewer-agent verdict service (unbound, submitTaskReview is not offered)', () => {
        // Reviewer agent stage (slice AD, EW-811). Without this binding
        // `buildAgentTaskTools` omits `submitTaskReview` entirely, every
        // dispatched review run has no way to record a verdict, and the
        // approver rows this slice exists to write stay `pending`
        // forever — a dead seam that costs a model run per review.
        const factory = findProvider(AGENT_DOMAIN_TOOL_SOURCES);
        const bundle = factory?.useFactory?.(
            ...(factory.inject ?? []).map((_, index) => ({ stub: index })),
        ) as { tasks?: Record<string, unknown> };
        expect(bundle?.tasks?.agentReviews).toBeDefined();
        // Positional proof: the LAST injected service is the one that
        // lands here, so an insertion anywhere earlier is caught.
        expect(bundle?.tasks?.agentReviews).toEqual({
            stub: (factory?.inject ?? []).length - 1,
        });
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
        return factory?.useFactory?.(
            git,
            { findById: jest.fn() },
            gate,
            {
                // APW-08 P0 — the adapter now resolves provider + owner + repo
                // from the Work before it opens anything, so the fixture has to
                // be a Work that HAS them. A Work without a git provider is a
                // refusal (see the fail-closed specs below), not a `''` target.
                findById: jest.fn().mockResolvedValue({
                    id: 'work-1',
                    kind: 'website',
                    checksPolicy: 'required',
                    gitProvider: 'github',
                    getRepoOwner: () => 'acme',
                    getWebsiteRepo: () => 'acme-website',
                }),
            },
            {
                resolve: jest.fn().mockResolvedValue({
                    policy: { protectedBranches: ['main', 'master', 'develop', 'stage'] },
                    source: 'default',
                    chain: [],
                }),
            },
        ) as OpenPrFacade;
    };

    const makeGit = () => ({
        getRepoDir: jest.fn().mockResolvedValue('/tmp/work-1'),
        // APW-08 P0 — `openPullRequest` now resolves the base branch from the
        // Work's repository when the caller omits it, so the facade it calls
        // has to answer that question. An explicit `base` still bypasses both.
        getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
        getMainBranch: jest.fn().mockResolvedValue('main'),
        createPullRequest: jest.fn().mockResolvedValue({ number: 12, url: 'https://pr/12' }),
    });

    it('injects the PR gate and the Work repository alongside the git facade', () => {
        expect(findProvider(AGENT_GIT_FACADE)?.inject).toEqual([
            GitFacadeService,
            AgentRepository,
            PullRequestGateService,
            WorkRepository,
            // APW-08 P0 — APPENDED so the adapter can refuse a protected
            // release branch from the Work's EFFECTIVE merge policy rather
            // than from a second, hand-rolled list. Positional, like every
            // argument above it.
            MergePolicyService,
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

/**
 * Agent email (AW-05) — the `sendEmail` / `messageAgent` tools are the
 * Agent writing, so the adapter marks them `origin: 'agent'` (the send path
 * then applies the Agent's approve-before-send mode) and turns a held draft
 * into a result the model can read instead of a provider id.
 */
describe('api-side AgentsModule — AGENT_EMAIL_FACADE approve-before-send', () => {
    type EmailFacade = {
        sendEmail: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
        messageAgent: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const build = (sendMessage: jest.Mock) =>
        findProvider('AGENT_EMAIL_FACADE')?.useFactory?.(
            { sendMessage },
            { findByAgent: jest.fn().mockResolvedValue([{ emailAddressId: 'addr-2' }]) },
            { findById: jest.fn().mockResolvedValue({ id: 'addr-2', address: 'peer@x.com' }) },
            { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-2' }) },
        ) as EmailFacade;

    it('sends as the Agent and passes a real send through unchanged', async () => {
        const sendMessage = jest.fn().mockResolvedValue({
            messageRef: 'ref',
            providerMessageId: 'pm-1',
            accepted: ['ada@x.com'],
            rejected: [],
        });
        const result = await build(sendMessage).sendEmail({
            userId: 'user-1',
            agentId: 'agent-1',
            to: ['ada@x.com'],
            subject: 'Hi',
            bodyText: 'Hello',
        });
        expect(sendMessage).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({ agentId: 'agent-1', to: ['ada@x.com'] }),
            { origin: 'agent' },
        );
        expect(result).toEqual({
            providerMessageId: 'pm-1',
            accepted: ['ada@x.com'],
            rejected: [],
        });
    });

    it('tells the model a held message was not sent and must not be resent', async () => {
        const sendMessage = jest.fn().mockResolvedValue({
            messageRef: 'ref',
            providerMessageId: '',
            accepted: [],
            rejected: [],
            held: true,
            messageId: 'm-1',
        });
        const result = await build(sendMessage).sendEmail({
            userId: 'user-1',
            agentId: 'agent-1',
            to: ['ada@x.com'],
            subject: 'Hi',
            bodyText: 'Hello',
        });
        expect(result).toMatchObject({ held: true, messageId: 'm-1', providerMessageId: '' });
        expect(String(result.note)).toMatch(/Do not send it again/);
        // Approval does not guarantee delivery — a send limit can still refuse it.
        expect(String(result.note)).toMatch(/subject to send limits/);
        expect(String(result.note)).not.toMatch(/will go out/);
    });

    it('holds an agent-to-agent message the same way', async () => {
        const sendMessage = jest.fn().mockResolvedValue({
            messageRef: 'ref',
            providerMessageId: '',
            accepted: [],
            rejected: [],
            held: true,
            messageId: 'm-2',
        });
        const result = await build(sendMessage).messageAgent({
            userId: 'user-1',
            fromAgentId: 'agent-1',
            targetAgentId: 'agent-2',
            subject: 'Sync',
            body: 'Ready?',
        });
        expect(sendMessage).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({ agentId: 'agent-1', to: ['peer@x.com'] }),
            { origin: 'agent' },
        );
        expect(result).toMatchObject({ held: true, messageId: 'm-2', targetAddress: 'peer@x.com' });
    });
});

/**
 * APW-08 P0 — the Agent-facing git tools resolve the provider, owner, repo
 * and branch from the Work's OWN repository, and a push to a protected
 * release branch is impossible.
 *
 * Before this, `commitToRepo` hardcoded `providerId = 'github'`, committed
 * on whatever branch the clone happened to be on, and then RETURNED
 * `branch ?? 'main'` — a branch it had not committed to; `openPullRequest`
 * hardcoded `'github'` too and passed `owner: ''` / `repo: ''` to
 * `createPullRequest`, which is not a pull request target at all. These
 * specs pin the replacement: resolve from the Work (the same source
 * `work.getRepoOwner('website')` / `work.getWebsiteRepo()` /
 * `work.gitProvider` the rest of the platform reads), thread the branch
 * into the commit, refuse the protected release branches BEFORE any git
 * operation, and fail CLOSED — never back to `'github'`, `''` or `'main'`.
 */
describe('api-side AgentsModule — AGENT_GIT_FACADE Work repository resolution (APW-08 P0)', () => {
    const WORK_ID = 'work-1';
    const WORK_DIR = '/tmp/ever-works/work-1';

    /** A non-GitHub provider id, so "resolved from the Work" is observable. */
    const WORK_PROVIDER = 'gitlab';

    type GitTools = CommitFacade & PrFacade;

    type CommitFacade = {
        commitToRepo: (input: Record<string, unknown>) => Promise<{
            sha: string | null;
            branch: string;
            filesChanged: number;
        }>;
    };

    type PrFacade = {
        openPullRequest: (input: Record<string, unknown>) => Promise<{
            number: number;
            url: string;
            state: string;
        }>;
    };

    interface WorkOverrides {
        kind?: string;
        gitProvider?: string;
        owner?: string;
        websiteRepo?: string;
        dataRepo?: string;
    }

    interface Harness {
        facade: GitTools;
        git: ReturnType<typeof makeGit>;
        works: { findById: jest.Mock };
        mergePolicy: { resolve: jest.Mock };
        prGate: { assertAllowed: jest.Mock };
    }

    const PLATFORM_POLICY = { protectedBranches: ['main', 'master', 'develop', 'stage'] };

    const makeWork = (overrides: WorkOverrides = {}) => {
        const owner = overrides.owner ?? 'acme';
        return {
            id: WORK_ID,
            kind: overrides.kind ?? 'website',
            gitProvider: overrides.gitProvider ?? WORK_PROVIDER,
            checksPolicy: 'off',
            getRepoOwner: jest.fn(() => owner),
            getWebsiteRepo: jest.fn(() => overrides.websiteRepo ?? 'acme-website'),
            getDataRepo: jest.fn(() => overrides.dataRepo ?? 'acme-data'),
        };
    };

    const makeGit = () => ({
        getRepoDir: jest.fn().mockResolvedValue(WORK_DIR),
        getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
        getMainBranch: jest.fn().mockResolvedValue(null),
        switchBranch: jest.fn().mockResolvedValue('feature/x'),
        commit: jest.fn().mockResolvedValue('sha-1'),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequest: jest
            .fn()
            .mockResolvedValue({ number: 7, url: 'https://git.test/pr/7', state: 'open' }),
    });

    const build = (
        options: {
            work?: unknown;
            git?: ReturnType<typeof makeGit>;
            protectedBranches?: string[];
        } = {},
    ): Harness => {
        const git = options.git ?? makeGit();
        const works = {
            findById: jest
                .fn()
                .mockResolvedValue(options.work === undefined ? makeWork() : options.work),
        };
        const mergePolicy = {
            resolve: jest.fn().mockResolvedValue({
                policy: {
                    protectedBranches:
                        options.protectedBranches ?? PLATFORM_POLICY.protectedBranches,
                },
                source: 'default',
                chain: [],
            }),
        };
        const prGate = { assertAllowed: jest.fn().mockResolvedValue({ allowed: true }) };
        const facade = findProvider(AGENT_GIT_FACADE)?.useFactory?.(
            git,
            { findById: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Ada', slug: 'ada' }) },
            prGate,
            works,
            mergePolicy,
        ) as GitTools;
        return { facade, git, works, mergePolicy, prGate };
    };

    const commitInput = (extra: Record<string, unknown> = {}) => ({
        userId: 'user-1',
        agentId: 'agent-1',
        workId: WORK_ID,
        message: 'Add the pricing page',
        ...extra,
    });

    const prInput = (extra: Record<string, unknown> = {}) => ({
        userId: 'user-1',
        agentId: 'agent-1',
        workId: WORK_ID,
        title: 'Add pricing',
        body: 'Because the page was missing.',
        head: 'feature/pricing',
        ...extra,
    });

    describe('commitToRepo', () => {
        it("uses the Work's OWN provider id — never the 'github' literal", async () => {
            const { facade, git } = build();
            await facade.commitToRepo(commitInput({ branch: 'feature/pricing' }));

            expect(git.commit).toHaveBeenCalledTimes(1);
            expect(git.commit.mock.calls[0][0]).toBe(WORK_PROVIDER);
            // The literal is gone from the whole call chain, not just one hop.
            expect(JSON.stringify(git.commit.mock.calls)).not.toContain('github');

            expect(git.getRepoDir).toHaveBeenCalledWith(
                'work',
                WORK_ID,
                expect.objectContaining({ providerId: WORK_PROVIDER }),
            );
            // …and the empty provider that used to reach `getRepoDir` is gone too.
            expect(git.getRepoDir.mock.calls[0][2].providerId).not.toBe('');

            expect(git.push).toHaveBeenCalledWith(
                { dir: WORK_DIR, force: false },
                expect.objectContaining({ providerId: WORK_PROVIDER }),
            );
        });

        it('threads the branch into the commit AND returns that same branch', async () => {
            const { facade, git } = build();
            const result = await facade.commitToRepo(commitInput({ branch: 'feature/pricing' }));

            expect(git.switchBranch).toHaveBeenCalledWith(
                WORK_PROVIDER,
                WORK_DIR,
                'feature/pricing',
                true,
            );
            expect(git.commit).toHaveBeenCalledWith(
                WORK_PROVIDER,
                WORK_DIR,
                'Add the pricing page',
                expect.objectContaining({ name: 'Ada' }),
            );
            // The switch happens BEFORE the commit: the commit lands on the
            // branch we report, instead of the message merely claiming so.
            expect(git.switchBranch.mock.invocationCallOrder[0]).toBeLessThan(
                git.commit.mock.invocationCallOrder[0],
            );
            expect(result.branch).toBe('feature/pricing');
            // An explicit branch needs no default-branch lookup.
            expect(git.getRepository).not.toHaveBeenCalled();
        });

        it("resolves the Work's default branch when the caller supplies none — never assumes 'main'", async () => {
            const git = makeGit();
            git.getRepository.mockResolvedValue({ defaultBranch: 'trunk' });
            const { facade } = build({ git });

            const result = await facade.commitToRepo(commitInput());

            expect(git.getRepository).toHaveBeenCalledWith(
                'acme',
                'acme-website',
                expect.objectContaining({ providerId: WORK_PROVIDER, workId: WORK_ID }),
            );
            expect(git.switchBranch).toHaveBeenCalledWith(WORK_PROVIDER, WORK_DIR, 'trunk', true);
            expect(result.branch).toBe('trunk');
        });

        it.each(['main', 'master', 'stage', 'MAIN', 'Master', 'STAGE', 'refs/heads/main'])(
            'refuses the protected release branch %s BEFORE any git operation runs',
            async (branch) => {
                const { facade, git } = build();

                const attempt = facade.commitToRepo(commitInput({ branch }));
                await expect(attempt).rejects.toThrow(/protected/i);
                await expect(attempt).rejects.toThrow(branch);

                expect(git.getRepoDir).not.toHaveBeenCalled();
                expect(git.switchBranch).not.toHaveBeenCalled();
                expect(git.commit).not.toHaveBeenCalled();
                expect(git.push).not.toHaveBeenCalled();
            },
        );

        it("honours the platform's modelled protectedBranches, not just the built-in list", async () => {
            const { facade, git, mergePolicy } = build({
                protectedBranches: ['develop', 'release/frozen'],
            });

            const attempt = facade.commitToRepo(commitInput({ branch: 'release/frozen' }));
            await expect(attempt).rejects.toThrow(/protected/i);
            await expect(attempt).rejects.toThrow('release/frozen');

            expect(mergePolicy.resolve).toHaveBeenCalledWith(
                expect.objectContaining({ workId: WORK_ID }),
            );
            expect(git.commit).not.toHaveBeenCalled();
            expect(git.push).not.toHaveBeenCalled();
        });

        it("refuses the Work's own default branch when the policy protects it", async () => {
            const git = makeGit();
            git.getRepository.mockResolvedValue({ defaultBranch: 'develop' });
            const { facade } = build({ git });

            const attempt = facade.commitToRepo(commitInput());
            await expect(attempt).rejects.toThrow(/protected/i);
            await expect(attempt).rejects.toThrow('develop');

            // The refusal still lands before anything is staged, committed or pushed.
            expect(git.switchBranch).not.toHaveBeenCalled();
            expect(git.commit).not.toHaveBeenCalled();
            expect(git.push).not.toHaveBeenCalled();
        });

        it('fails closed when the Work has no git provider configured', async () => {
            const { facade, git } = build({ work: makeWork({ gitProvider: '' }) });

            await expect(facade.commitToRepo(commitInput({ branch: 'feature/x' }))).rejects.toThrow(
                /git provider/i,
            );
            expect(git.getRepoDir).not.toHaveBeenCalled();
            expect(git.commit).not.toHaveBeenCalled();
        });

        it('fails closed when the Work cannot be found', async () => {
            const { facade, git } = build({ work: null });

            await expect(facade.commitToRepo(commitInput({ branch: 'feature/x' }))).rejects.toThrow(
                WORK_ID,
            );
            expect(git.getRepoDir).not.toHaveBeenCalled();
            expect(git.commit).not.toHaveBeenCalled();
        });

        it('fails closed when owner/repo cannot be resolved — never an empty-string target', async () => {
            const { facade, git } = build({ work: makeWork({ owner: '', websiteRepo: '' }) });

            await expect(facade.commitToRepo(commitInput({ branch: 'feature/x' }))).rejects.toThrow(
                /owner|repositor/i,
            );
            expect(git.getRepoDir).not.toHaveBeenCalled();
            expect(git.commit).not.toHaveBeenCalled();
        });

        it("fails closed when the Work's default branch cannot be resolved", async () => {
            const git = makeGit();
            git.getRepository.mockResolvedValue(null);
            git.getMainBranch.mockResolvedValue(null);
            const { facade } = build({ git });

            await expect(facade.commitToRepo(commitInput())).rejects.toThrow(/default branch/i);
            expect(git.commit).not.toHaveBeenCalled();
            expect(git.push).not.toHaveBeenCalled();
        });

        it('still does not swallow a push failure', async () => {
            const git = makeGit();
            git.push.mockRejectedValue(new Error('remote rejected the ref'));
            const { facade } = build({ git });

            await expect(facade.commitToRepo(commitInput({ branch: 'feature/x' }))).rejects.toThrow(
                /push failed/,
            );
        });
    });

    describe('openPullRequest', () => {
        it("passes the Work's REAL owner and repo — never empty strings", async () => {
            const { facade, git } = build();

            await facade.openPullRequest(prInput());

            expect(git.createPullRequest).toHaveBeenCalledTimes(1);
            const [prOptions, facadeOptions] = git.createPullRequest.mock.calls[0];
            expect(prOptions.owner).toBe('acme');
            expect(prOptions.repo).toBe('acme-website');
            expect(prOptions.owner).not.toBe('');
            expect(prOptions.repo).not.toBe('');
            expect(facadeOptions.providerId).toBe(WORK_PROVIDER);
        });

        it("defaults the base branch to the Work's default branch and keeps an explicit base", async () => {
            const git = makeGit();
            git.getRepository.mockResolvedValue({ defaultBranch: 'trunk' });
            const { facade } = build({ git });

            await facade.openPullRequest(prInput());
            expect(git.createPullRequest.mock.calls[0][0].base).toBe('trunk');

            git.createPullRequest.mockClear();
            await facade.openPullRequest(prInput({ base: 'release/next' }));
            expect(git.createPullRequest.mock.calls[0][0].base).toBe('release/next');
        });

        it('fails closed when owner/repo cannot be resolved', async () => {
            const { facade, git } = build({ work: makeWork({ owner: '', websiteRepo: '' }) });

            await expect(facade.openPullRequest(prInput())).rejects.toThrow(/owner|repositor/i);
            expect(git.createPullRequest).not.toHaveBeenCalled();
        });

        it('fails closed when the Work has no git provider configured', async () => {
            const { facade, git } = build({ work: makeWork({ gitProvider: '' }) });

            await expect(facade.openPullRequest(prInput())).rejects.toThrow(/git provider/i);
            expect(git.createPullRequest).not.toHaveBeenCalled();
        });
    });

    describe('regression guards', () => {
        it('still succeeds when a caller supplies a providerId explicitly (legacy path)', async () => {
            const { facade, git } = build();

            const result = await facade.commitToRepo(
                commitInput({ branch: 'feature/pricing', providerId: 'github' }),
            );

            expect(git.commit.mock.calls[0][0]).toBe('github');
            expect(result.branch).toBe('feature/pricing');
            expect(git.push).toHaveBeenCalledTimes(1);
        });

        it("keeps the `repo` Work kind's guarantee: its repository is the data repo, not a website repo", async () => {
            const { facade, git } = build({
                work: makeWork({ kind: 'repo', websiteRepo: 'must-not-be-used' }),
            });

            await facade.openPullRequest(prInput());

            expect(git.createPullRequest.mock.calls[0][0].repo).toBe('acme-data');
        });
    });
});
