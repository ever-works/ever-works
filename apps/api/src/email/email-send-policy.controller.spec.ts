// Stub the agent subpaths + auth barrel so the transitive database config
// (api-only `@src/config`) is never pulled into this controller test.
jest.mock('@ever-works/agent/email', () => ({
    AgentInboxService: class AgentInboxService {},
    EmailSendPolicyService: class EmailSendPolicyService {},
    toAgentInboxDto: (row: { id: string; agentId: string; mode: string }) => ({
        id: row.id,
        agentId: row.agentId,
        mode: row.mode,
    }),
}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        email: {
            sendCaps: {
                isEnforced: () => true,
                getPlatformCaps: () => ({ inboxDailySends: 100 }),
                getConfiguredPlatformCaps: () => ({}),
            },
            getDefaultAgentMode: () => 'auto-send',
        },
    },
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
import { ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { EmailSendPolicyController } from './email-send-policy.controller';
import {
    UpdateAgentInboxDto,
    UpdateOrganizationEmailSendPolicyDto,
} from './dto/email-send-policy.dto';

/**
 * Agent email (AW-05) — policy routes. Enforcement is tested where it
 * lives (the facade gate, in packages/agent); this suite pins ownership,
 * the organization authorization split, the idempotent upsert and the DTO
 * rules that keep "inherit" and "no ceiling" distinct.
 */
describe('EmailSendPolicyController', () => {
    const auth = { userId: 'user-1' } as never;
    let inboxes: Record<string, jest.Mock>;
    let policy: Record<string, jest.Mock>;
    let membership: { ensureMember: jest.Mock; ensureAdmin: jest.Mock };
    let scope: { getOrganizationId: jest.Mock };
    let controller: EmailSendPolicyController;
    const meter = { agentId: 'agent-1', enforced: true, mode: 'draft-review', windows: [] };

    beforeEach(() => {
        inboxes = {
            list: jest
                .fn()
                .mockResolvedValue([{ id: 'inbox-1', agentId: 'agent-1', mode: 'draft-review' }]),
            findForAgent: jest.fn().mockResolvedValue(null),
            ensure: jest.fn().mockResolvedValue({
                inbox: { id: 'inbox-1', agentId: 'agent-1', mode: 'draft-review' },
                created: true,
            }),
            update: jest
                .fn()
                .mockResolvedValue({ id: 'inbox-1', agentId: 'agent-1', mode: 'auto-send' }),
        };
        policy = {
            getMeter: jest.fn().mockResolvedValue(meter),
            readOrganizationPolicy: jest.fn().mockResolvedValue(null),
            updateOrganizationPolicy: jest.fn().mockImplementation(async (_id, patch) => patch),
        };
        membership = {
            ensureMember: jest.fn().mockResolvedValue({ id: 'org-1' }),
            ensureAdmin: jest.fn().mockResolvedValue({ id: 'org-1' }),
        };
        scope = { getOrganizationId: jest.fn().mockReturnValue('org-1') };
        controller = new EmailSendPolicyController(
            inboxes as never,
            policy as never,
            membership as never,
            scope as never,
        );
    });

    describe('Agent settings', () => {
        it('lists only the caller’s inbox settings', async () => {
            await expect(controller.listInboxes(auth)).resolves.toEqual({
                inboxes: [{ id: 'inbox-1', agentId: 'agent-1', mode: 'draft-review' }],
            });
            expect(inboxes.list).toHaveBeenCalledWith('user-1');
        });

        it('reads settings and the live meter for an owned Agent with no settings yet', async () => {
            await expect(controller.getAgentSendPolicy(auth, 'agent-1')).resolves.toEqual({
                inbox: null,
                meter,
            });
            expect(inboxes.findForAgent).toHaveBeenCalledWith('user-1', 'agent-1');
        });

        it('answers a foreign Agent with the 404 a missing one gets, before reading any usage', async () => {
            inboxes.findForAgent.mockRejectedValue(new NotFoundException('Agent not found'));
            await expect(controller.getAgentSendPolicy(auth, 'agent-x')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(policy.getMeter).not.toHaveBeenCalled();
        });

        it('creates settings on the first write and does not apply the patch twice', async () => {
            const body = Object.assign(new UpdateAgentInboxDto(), { dailySendCap: 20 });
            const res = await controller.upsertAgentInbox(auth, 'agent-1', body);
            expect(inboxes.ensure).toHaveBeenCalledWith('user-1', 'agent-1', { dailySendCap: 20 });
            expect(inboxes.update).not.toHaveBeenCalled();
            expect(res).toMatchObject({ created: true, meter });
        });

        it('updates existing settings, passing null (inherit) and 0 (no ceiling) through as given', async () => {
            inboxes.ensure.mockResolvedValue({
                inbox: { id: 'inbox-1', agentId: 'agent-1', mode: 'draft-review' },
                created: false,
            });
            const body = Object.assign(new UpdateAgentInboxDto(), {
                mode: 'auto-send',
                dailySendCap: 0,
                burstSendCap: null,
            });
            const res = await controller.upsertAgentInbox(auth, 'agent-1', body);
            expect(inboxes.update).toHaveBeenCalledWith('user-1', 'inbox-1', {
                mode: 'auto-send',
                dailySendCap: 0,
                burstSendCap: null,
            });
            expect(res).toMatchObject({ created: false, inbox: { mode: 'auto-send' } });
        });
    });

    describe('organization policy', () => {
        it('reads the active organization as a member, with the platform defaults beside it', async () => {
            const res = await controller.getOrganizationPolicy(auth);
            expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'user-1');
            expect(membership.ensureAdmin).not.toHaveBeenCalled();
            expect(res).toEqual({
                organizationId: 'org-1',
                policy: null,
                platform: {
                    enforced: true,
                    caps: { inboxDailySends: 100 },
                    defaultMode: 'auto-send',
                    // Opt-in: the operator configured nothing, so nothing is
                    // enforced platform-wide; the recommended numbers ride along.
                    configuredCaps: {},
                    recommendedCaps: {
                        inboxDailySends: 100,
                        inboxBurstSends: 10,
                        inboxBurstRecipients: 20,
                        recipientsPerMessage: 50,
                        workspaceDailySends: 500,
                        workspaceMonthlySends: 10_000,
                    },
                },
            });
        });

        it('requires an organization admin to change the policy', async () => {
            membership.ensureAdmin.mockRejectedValue(new ForbiddenException());
            const body = Object.assign(new UpdateOrganizationEmailSendPolicyDto(), {
                defaultMode: 'draft-review',
            });
            await expect(controller.updateOrganizationPolicy(auth, body)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(policy.updateOrganizationPolicy).not.toHaveBeenCalled();
        });

        it('writes only the fields sent', async () => {
            const body = Object.assign(new UpdateOrganizationEmailSendPolicyDto(), {
                caps: { workspaceDailySends: 0 },
            });
            await controller.updateOrganizationPolicy(auth, body);
            expect(policy.updateOrganizationPolicy).toHaveBeenCalledWith('org-1', {
                caps: { workspaceDailySends: 0 },
            });
        });

        it('answers 404 when the session has no active organization', async () => {
            scope.getOrganizationId.mockReturnValue(null);
            await expect(controller.getOrganizationPolicy(auth)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('DTO validation', () => {
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        });
        const validate = (metatype: unknown, value: unknown) =>
            pipe.transform(value, { type: 'body', metatype: metatype as never });

        it('accepts null (inherit) and 0 (no ceiling) on an Agent ceiling', async () => {
            await expect(
                validate(UpdateAgentInboxDto, { dailySendCap: 0, burstSendCap: null }),
            ).resolves.toMatchObject({ dailySendCap: 0, burstSendCap: null });
        });

        it.each([
            [{ dailySendCap: -1 }],
            [{ dailySendCap: 2.5 }],
            [{ dailySendCap: 1_000_001 }],
            [{ mode: 'whenever' }],
            [{ emailAddressId: 'not-a-uuid' }],
            [{ state: 'active' }],
        ])('rejects %j', async (body) => {
            await expect(validate(UpdateAgentInboxDto, body)).rejects.toBeDefined();
        });

        it('validates nested organization ceilings', async () => {
            await expect(
                validate(UpdateOrganizationEmailSendPolicyDto, {
                    caps: { workspaceMonthlySends: -3 },
                }),
            ).rejects.toBeDefined();
            await expect(
                validate(UpdateOrganizationEmailSendPolicyDto, {
                    defaultMode: 'draft-review',
                    caps: { workspaceMonthlySends: 0, inboxDailySends: null },
                }),
            ).resolves.toBeDefined();
        });
    });
});
