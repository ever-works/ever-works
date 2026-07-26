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
}));
jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
    AgentEmailAssignmentRepository: class AgentEmailAssignmentRepository {},
    TenantEmailAddressRepository: class TenantEmailAddressRepository {},
    NotificationChannelRepository: class NotificationChannelRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    FacadesModule: class FacadesModule {},
    NotificationChannelFacadeService: class NotificationChannelFacadeService {},
    SearchFacadeService: class SearchFacadeService {},
    ScreenshotFacadeService: class ScreenshotFacadeService {},
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
import { PolicyModule, MergePolicyService } from '@ever-works/agent/policy';
import { WorkOwnershipService } from '@ever-works/agent/services';
import {
    TasksService,
    TaskChatService,
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, AGENT_DOMAIN_TOOL_SOURCES } from '@ever-works/agent/agents';

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
    });

    it('binds AGENT_DOMAIN_TOOL_SOURCES — without it every domain tool is dead code', () => {
        expect(findProvider(AGENT_DOMAIN_TOOL_SOURCES)).toBeDefined();
    });

    it('injects exactly the services the six descriptor factories need', () => {
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
        ]);
    });

    it('provides WorkOwnershipService locally but does NOT export it from this @Global module', () => {
        expect(meta('providers')).toContain(WorkOwnershipService);
        expect(meta('exports')).not.toContain(WorkOwnershipService);
    });

    it('exports the token so the agent-side @Optional() injection resolves', () => {
        expect(meta('exports')).toContain(AGENT_DOMAIN_TOOL_SOURCES);
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
            'prReview',
            'mergePolicy',
        ]);
    });
});
