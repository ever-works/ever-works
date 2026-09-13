import { EmailApprovalRequiredException } from '../email-approval-required.exception';
import { EmailSendCapExceededException } from '../email-send-cap-exceeded.exception';
import { EmailSendPolicyService, normalizeOrganizationPolicy } from '../email-send-policy.service';
import type { EmailSendAttempt } from '../email-send-policy.port';

/**
 * Agent email (AW-05) — the gate every send passes before a provider is
 * touched. Repositories are mocked; the clock is frozen. The pure ceiling
 * arithmetic has its own suite in `@ever-works/contracts`; this one proves
 * the gate reads the right rows, in the right scopes, and refuses with the
 * right shape.
 */
const NOW = new Date('2026-09-14T12:00:00.000Z');

const ENV_KEYS = [
    'EMAIL_SEND_CAPS_ENFORCEMENT',
    'EMAIL_SEND_CAP_INBOX_DAILY',
    'EMAIL_DEFAULT_AGENT_SEND_MODE',
];

function makeHarness() {
    const inboxes = {
        findByAgentForUser: jest.fn().mockResolvedValue(null),
        setCapPausedUntil: jest.fn().mockResolvedValue(undefined),
    };
    const messages = {
        countOutboundSentSince: jest.fn().mockResolvedValue(0),
        listOutboundSentAtSince: jest.fn().mockResolvedValue([]),
        listOutboundRecipientsSince: jest.fn().mockResolvedValue([]),
        findByIdAndUserId: jest.fn().mockResolvedValue(null),
    };
    const agents = {
        findOne: jest
            .fn()
            .mockResolvedValue({ id: 'agent-1', userId: 'user-1', organizationId: null }),
    };
    const organizations = {
        findOne: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue(undefined),
    };
    const proposals = {
        findOne: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'approved' }),
    };
    const service = new EmailSendPolicyService(
        inboxes as never,
        messages as never,
        agents as never,
        organizations as never,
        proposals as never,
    );
    jest.spyOn(service as unknown as { now: () => Date }, 'now').mockReturnValue(NOW);
    return { service, inboxes, messages, agents, organizations, proposals };
}

function attempt(overrides: Partial<EmailSendAttempt> = {}): EmailSendAttempt {
    return {
        userId: 'user-1',
        agentId: 'agent-1',
        origin: 'agent',
        to: ['ada@example.com'],
        subject: 'Quarterly numbers',
        ...overrides,
    };
}

describe('EmailSendPolicyService', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        jest.restoreAllMocks();
    });

    describe('approval gate', () => {
        it('lets an Agent with no inbox settings send, exactly as before', async () => {
            const { service } = makeHarness();
            await expect(service.assertSendAllowed(attempt())).resolves.toBeUndefined();
        });

        it("refuses an Agent's direct send when its inbox holds mail for review", async () => {
            const { service, inboxes, messages } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'draft-review' });

            const error = await service.assertSendAllowed(attempt()).catch((e) => e);

            expect(error).toBeInstanceOf(EmailApprovalRequiredException);
            expect(error.getStatus()).toBe(403);
            expect(error.getResponse()).toMatchObject({
                error: 'EmailApprovalRequired',
                details: { code: 'awaiting-approval', agentId: 'agent-1' },
            });
            // Refused before a single count query: nothing about usage matters.
            expect(messages.countOutboundSentSince).not.toHaveBeenCalled();
        });

        it("holds every Agent's mail when the operator makes draft review the default", async () => {
            process.env.EMAIL_DEFAULT_AGENT_SEND_MODE = 'draft-review';
            const { service } = makeHarness();
            await expect(service.assertSendAllowed(attempt())).rejects.toBeInstanceOf(
                EmailApprovalRequiredException,
            );
        });

        it("holds an organization's Agents when the organization says so, unless the inbox opts out", async () => {
            const { service, agents, organizations, inboxes } = makeHarness();
            agents.findOne.mockResolvedValue({
                id: 'agent-1',
                userId: 'user-1',
                organizationId: 'org-1',
            });
            organizations.findOne.mockResolvedValue({
                id: 'org-1',
                emailSendPolicy: { defaultMode: 'draft-review' },
            });
            await expect(service.assertSendAllowed(attempt())).rejects.toBeInstanceOf(
                EmailApprovalRequiredException,
            );

            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'auto-send' });
            await expect(service.assertSendAllowed(attempt())).resolves.toBeUndefined();
        });

        it('does not hold a person composing — the person is the approver', async () => {
            const { service, inboxes } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'draft-review' });
            await expect(
                service.assertSendAllowed(attempt({ origin: 'human' })),
            ).resolves.toBeUndefined();
        });

        it('releases a draft only when a person approved exactly that message', async () => {
            const { service, inboxes, messages } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'draft-review' });
            messages.findByIdAndUserId.mockResolvedValue({
                id: 'draft-1',
                direction: 'outbound',
                agentId: 'agent-1',
                status: 'sending',
                approvedById: 'user-1',
                approvalId: 'prop-1',
                subject: 'Quarterly numbers',
                toAddresses: ['Ada <ADA@example.com>'],
                ccAddresses: null,
                bccAddresses: null,
            });

            await expect(
                service.assertSendAllowed(attempt({ draftMessageId: 'draft-1' })),
            ).resolves.toBeUndefined();

            // …and not for a different recipient list than was approved.
            await expect(
                service.assertSendAllowed(
                    attempt({ draftMessageId: 'draft-1', to: ['someone-else@example.com'] }),
                ),
            ).rejects.toMatchObject({ code: 'draft-not-approved' });
            // …nor a changed subject.
            await expect(
                service.assertSendAllowed(attempt({ draftMessageId: 'draft-1', subject: 'Other' })),
            ).rejects.toMatchObject({ code: 'draft-not-approved' });
        });

        it.each([
            ['missing', null],
            ['not yet approved', { status: 'draft', approvedById: null }],
            ['approved by nobody', { status: 'sending', approvedById: null }],
            ["another Agent's", { status: 'sending', approvedById: 'user-1', agentId: 'agent-2' }],
            ['inbound', { status: 'sending', approvedById: 'user-1', direction: 'inbound' }],
        ])('refuses to release a %s draft', async (_label, patch) => {
            const { service, messages } = makeHarness();
            messages.findByIdAndUserId.mockResolvedValue(
                patch === null
                    ? null
                    : {
                          id: 'draft-1',
                          direction: 'outbound',
                          agentId: 'agent-1',
                          subject: 'Quarterly numbers',
                          toAddresses: ['ada@example.com'],
                          ...patch,
                      },
            );
            await expect(
                service.assertSendAllowed(attempt({ draftMessageId: 'draft-1' })),
            ).rejects.toBeInstanceOf(EmailApprovalRequiredException);
        });

        it('refuses a draft whose mirrored approval was not granted', async () => {
            const { service, messages, proposals } = makeHarness();
            messages.findByIdAndUserId.mockResolvedValue({
                id: 'draft-1',
                direction: 'outbound',
                agentId: 'agent-1',
                status: 'sending',
                approvedById: 'user-1',
                approvalId: 'prop-1',
                subject: 'Quarterly numbers',
                toAddresses: ['ada@example.com'],
            });
            proposals.findOne.mockResolvedValue({ id: 'prop-1', status: 'rejected' });
            await expect(
                service.assertSendAllowed(attempt({ draftMessageId: 'draft-1' })),
            ).rejects.toBeInstanceOf(EmailApprovalRequiredException);
        });

        it('gates nothing and counts nothing for unattributed platform mail', async () => {
            const { service, agents, messages } = makeHarness();
            await expect(
                service.assertSendAllowed(attempt({ userId: undefined, origin: undefined })),
            ).resolves.toBeUndefined();
            expect(agents.findOne).not.toHaveBeenCalled();
            expect(messages.countOutboundSentSince).not.toHaveBeenCalled();
        });
    });

    describe('send ceilings', () => {
        it('refuses the 101st send of a rolling day with when capacity returns, and records the pause', async () => {
            const { service, inboxes, messages } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'auto-send' });
            messages.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.agentId && NOW.getTime() - since.getTime() === 24 * 3600 * 1000 ? 100 : 0,
            );
            // The oldest send in the window went out 23h ago → frees in 1h.
            const sends = Array.from(
                { length: 100 },
                (_, i) => new Date(NOW.getTime() - 23 * 3600 * 1000 + i * 1000),
            );
            messages.listOutboundSentAtSince.mockResolvedValue(sends);

            const error = await service.assertSendAllowed(attempt()).catch((e) => e);

            expect(error).toBeInstanceOf(EmailSendCapExceededException);
            expect(error.getStatus()).toBe(429);
            expect(error.getResponse()).toMatchObject({
                error: 'EmailSendCapExceeded',
                details: {
                    scope: 'inbox',
                    limitKind: 'inboxDaily',
                    used: 100,
                    cap: 100,
                    windowSeconds: 86_400,
                    retryAfterSeconds: 3_600,
                    agentId: 'agent-1',
                },
            });
            // The per-Agent window was counted by Agent, not by account.
            expect(messages.listOutboundSentAtSince).toHaveBeenCalledWith(
                { agentId: 'agent-1' },
                expect.any(Date),
            );
            expect(inboxes.setCapPausedUntil).toHaveBeenCalledWith(
                'inbox-1',
                new Date(NOW.getTime() + 3_600 * 1000),
            );
        });

        it('applies the ceilings to a person composing too — there is no privileged bypass', async () => {
            const { service, messages } = makeHarness();
            messages.countOutboundSentSince.mockImplementation(async (filter) =>
                filter.userId ? 500 : 0,
            );
            await expect(
                service.assertSendAllowed(attempt({ origin: 'human' })),
            ).rejects.toMatchObject({
                details: { limitKind: 'workspaceDaily', scope: 'workspace' },
            });
        });

        it("uses the Agent's own ceiling over the organization's and the platform's", async () => {
            const { service, agents, organizations, inboxes, messages } = makeHarness();
            agents.findOne.mockResolvedValue({
                id: 'agent-1',
                userId: 'user-1',
                organizationId: 'org-1',
            });
            organizations.findOne.mockResolvedValue({
                id: 'org-1',
                emailSendPolicy: { caps: { inboxDailySends: 3 } },
            });
            messages.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.agentId && NOW.getTime() - since.getTime() === 24 * 3600 * 1000 ? 3 : 0,
            );
            await expect(service.assertSendAllowed(attempt())).rejects.toMatchObject({
                details: { limitKind: 'inboxDaily', cap: 3 },
            });

            // The inbox raises its own ceiling back up; the send now passes.
            inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'auto-send',
                dailySendCap: 50,
            });
            await expect(service.assertSendAllowed(attempt())).resolves.toBeUndefined();
        });

        it('lets an explicit 0 on the inbox mean no daily ceiling for that Agent', async () => {
            const { service, inboxes, messages } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'auto-send',
                dailySendCap: 0,
            });
            messages.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.agentId && NOW.getTime() - since.getTime() === 24 * 3600 * 1000 ? 5_000 : 0,
            );
            await expect(service.assertSendAllowed(attempt())).resolves.toBeUndefined();
        });

        it('restores the unrestricted behaviour when the operator turns ceilings off', async () => {
            process.env.EMAIL_SEND_CAPS_ENFORCEMENT = 'off';
            const { service, messages } = makeHarness();
            messages.countOutboundSentSince.mockResolvedValue(1_000_000);
            await expect(service.assertSendAllowed(attempt())).resolves.toBeUndefined();
            expect(messages.countOutboundSentSince).not.toHaveBeenCalled();
        });

        it('still holds Agent mail for review when ceilings are off', async () => {
            process.env.EMAIL_SEND_CAPS_ENFORCEMENT = 'off';
            const { service, inboxes } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'draft-review' });
            await expect(service.assertSendAllowed(attempt())).rejects.toBeInstanceOf(
                EmailApprovalRequiredException,
            );
        });

        it('refuses a message with too many recipients and says waiting will not help', async () => {
            const { service } = makeHarness();
            const to = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);
            const error = await service.assertSendAllowed(attempt({ to })).catch((e) => e);
            expect(error.getResponse()).toMatchObject({
                details: {
                    limitKind: 'recipientsPerMessage',
                    used: 51,
                    cap: 50,
                    retryAfterSeconds: 0,
                },
            });
            expect(error.message).toMatch(/Waiting will not help/);
        });

        it("never reads a foreign Agent's settings — it resolves as no Agent named", async () => {
            const { service, agents, inboxes } = makeHarness();
            agents.findOne.mockResolvedValue(null);
            const policy = await service.resolvePolicy('user-1', 'someone-elses-agent');
            expect(inboxes.findByAgentForUser).not.toHaveBeenCalled();
            expect(policy.inbox).toBeNull();
            expect(policy.modeSource).toBe('platform');
        });
    });

    describe('meter', () => {
        it('reports every window with its ceiling, source and live pause', async () => {
            const { service, inboxes, messages } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'draft-review',
                burstSendCap: 4,
                capPausedUntil: new Date(NOW.getTime() + 60_000),
            });
            messages.countOutboundSentSince.mockResolvedValue(2);
            messages.listOutboundRecipientsSince.mockResolvedValue(['a@x.io', 'A@x.io', 'b@x.io']);

            const meter = await service.getMeter('user-1', 'agent-1');

            expect(meter).toMatchObject({
                agentId: 'agent-1',
                enforced: true,
                mode: 'draft-review',
                modeSource: 'inbox',
                pausedUntil: new Date(NOW.getTime() + 60_000).toISOString(),
            });
            const byKind = Object.fromEntries(meter.windows.map((w) => [w.kind, w]));
            expect(byKind.inboxBurst).toMatchObject({ used: 2, cap: 4, source: 'inbox' });
            expect(byKind.inboxRecipients).toMatchObject({ used: 2, cap: 20, source: 'platform' });
            expect(byKind.workspaceMonthly).toMatchObject({
                cap: 10_000,
                windowSeconds: 2_592_000,
            });
        });

        it('shows no ceilings while enforcement is off', async () => {
            process.env.EMAIL_SEND_CAPS_ENFORCEMENT = 'off';
            const { service } = makeHarness();
            const meter = await service.getMeter('user-1', 'agent-1');
            expect(meter.enforced).toBe(false);
            expect(meter.windows.every((w) => w.cap === null)).toBe(true);
        });
    });

    describe('organization policy', () => {
        it('merges a patch field by field, and null clears a field back to inherit', async () => {
            const { service, organizations } = makeHarness();
            organizations.findOne.mockResolvedValue({
                id: 'org-1',
                emailSendPolicy: { defaultMode: 'draft-review', caps: { inboxDailySends: 40 } },
            });

            const stored = await service.updateOrganizationPolicy('org-1', {
                caps: { workspaceDailySends: 0, inboxDailySends: null },
            });

            expect(stored).toEqual({
                defaultMode: 'draft-review',
                caps: { workspaceDailySends: 0 },
            });
            expect(organizations.update).toHaveBeenCalledWith(
                { id: 'org-1' },
                { emailSendPolicy: stored },
            );
        });

        it('drops malformed stored values instead of lifting a ceiling', () => {
            expect(
                normalizeOrganizationPolicy({
                    defaultMode: 'yolo',
                    caps: { inboxDailySends: -5, workspaceDailySends: '10' },
                }),
            ).toBeNull();
            expect(normalizeOrganizationPolicy('nope')).toBeNull();
        });
    });
});
