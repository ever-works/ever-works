jest.mock('@ever-works/agent/model-routing', () => ({
    ModelPolicyService: class ModelPolicyService {},
}));
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));
jest.mock('../scope/scope-context.service', () => ({
    ScopeContextService: class ScopeContextService {},
}));

import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { ModelPoliciesController } from './model-policies.controller';
import { UpsertModelPolicyDto } from './dto/upsert-model-policy.dto';
import { ModelWorkspaceAccessService } from './model-workspace-access.service';

/**
 * Model accounts (AW-16) — the model ladder routes. The ladder itself is
 * tested in packages/agent; this suite pins authorization, that absent and
 * null mean different things on the way to the service, the schedule
 * vocabulary, and every bound the DTO enforces.
 */
describe('ModelPoliciesController', () => {
    const auth = { userId: 'user-1' } as never;
    const AGENT = '22222222-2222-4222-8222-222222222222';
    let service: Record<string, jest.Mock>;
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };
    let controller: ModelPoliciesController;
    const orgScope = { userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' };

    beforeEach(() => {
        service = {
            get: jest.fn().mockResolvedValue(null),
            put: jest.fn().mockResolvedValue({ policy: {}, removedFromFallbacks: [] }),
            remove: jest.fn().mockResolvedValue(undefined),
            resolve: jest
                .fn()
                .mockResolvedValue({ primaryModel: { value: null, source: 'default' } }),
        };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({}),
            ensureAdmin: jest.fn().mockResolvedValue({}),
        };
        const scope = {
            getOrganizationId: jest.fn().mockReturnValue('org-1'),
            getTenantId: jest.fn().mockReturnValue('tenant-1'),
        };
        controller = new ModelPoliciesController(
            service as never,
            new ModelWorkspaceAccessService(scope as never, membership as never),
        );
    });

    it('reads as a member and returns null when nothing is set', async () => {
        await expect(controller.getWorkspace(auth)).resolves.toEqual({ policy: null });
        expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'user-1');
        expect(service.get).toHaveBeenCalledWith(orgScope, { type: 'workspace' });
    });

    it('requires an admin to change any scope', async () => {
        membership.ensureAdmin.mockRejectedValue(new ForbiddenException());
        const body = Object.assign(new UpsertModelPolicyDto(), { reasoningEffort: 'high' });
        await expect(controller.putWorkspace(auth, body)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        await expect(controller.putAgent(auth, AGENT, body)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        await expect(controller.deleteAgent(auth, AGENT)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        await expect(
            controller.putSchedule(auth, 'agent_heartbeat', AGENT, body),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.put).not.toHaveBeenCalled();
        expect(service.remove).not.toHaveBeenCalled();
    });

    it('sends only the fields present, keeping null (inherit) apart from absent (leave)', async () => {
        const body = Object.assign(new UpsertModelPolicyDto(), {
            primaryModel: null,
            reasoningEffort: 'low',
        });
        await controller.putAgent(auth, AGENT, body);
        expect(service.put).toHaveBeenCalledWith(
            orgScope,
            { type: 'agent', agentId: AGENT },
            { primaryModel: null, reasoningEffort: 'low' },
        );
    });

    it('addresses a schedule by its source and owner, refusing an unknown source', async () => {
        const body = Object.assign(new UpsertModelPolicyDto(), {
            primaryModel: { providerPluginId: 'provider-a', modelId: 'fast' },
            runTimeoutSeconds: 2700,
        });
        await controller.putSchedule(auth, 'agent_heartbeat', AGENT, body);
        expect(service.put).toHaveBeenCalledWith(
            orgScope,
            { type: 'schedule', source: 'agent_heartbeat', ownerId: AGENT },
            {
                primaryModel: { providerPluginId: 'provider-a', modelId: 'fast' },
                runTimeoutSeconds: 2700,
            },
        );
        await expect(controller.getSchedule(auth, 'cron', AGENT)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('resolves for an Agent and a schedule key', async () => {
        await controller.resolved(auth, AGENT, `agent_heartbeat:${AGENT}`);
        expect(service.resolve).toHaveBeenCalledWith(orgScope, {
            agentId: AGENT,
            scheduleId: `agent_heartbeat:${AGENT}`,
        });
        await controller.resolved(auth);
        expect(service.resolve).toHaveBeenLastCalledWith(orgScope, {
            agentId: null,
            scheduleId: null,
        });
    });

    describe('DTO validation', () => {
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        });
        const validate = (value: unknown) =>
            pipe.transform(value, { type: 'body', metatype: UpsertModelPolicyDto as never });
        const entry = (modelId: string, providerPluginId = 'provider-a') => ({
            providerPluginId,
            modelId,
        });

        it('accepts a full policy and the inherit markers', async () => {
            await expect(
                validate({
                    primaryModel: entry('big'),
                    fallbackModels: [entry('fast'), entry('big', 'gateway')],
                    reasoningEffort: 'minimal',
                    runTimeoutSeconds: 7200,
                    attemptTimeoutSeconds: 15,
                }),
            ).resolves.toBeInstanceOf(UpsertModelPolicyDto);
            await expect(
                validate({ primaryModel: null, fallbackModels: [], reasoningEffort: null }),
            ).resolves.toMatchObject({ primaryModel: null, fallbackModels: [] });
        });

        it.each([
            [
                'a fourth fallback',
                { fallbackModels: [entry('1'), entry('2'), entry('3'), entry('4')] },
            ],
            [
                'the primary in its own chain',
                { primaryModel: entry('big'), fallbackModels: [entry('big')] },
            ],
            ['a duplicate entry', { fallbackModels: [entry('fast'), entry('fast')] }],
            ['a 30-second run timeout', { runTimeoutSeconds: 30 }],
            ['a 3-hour run timeout', { runTimeoutSeconds: 10_800 }],
            ['a fractional timeout', { runTimeoutSeconds: 90.5 }],
            ['a 10-second attempt timeout', { attemptTimeoutSeconds: 10 }],
            ['an unknown effort', { reasoningEffort: 'extreme' }],
            [
                'a chain entry without a model',
                { fallbackModels: [{ providerPluginId: 'provider-a' }] },
            ],
            ['an unknown field', { scopeType: 'workspace' }],
        ])('rejects %s', async (_label, body) => {
            await expect(validate(body)).rejects.toBeDefined();
        });
    });
});
