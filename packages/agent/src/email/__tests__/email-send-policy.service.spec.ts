import { NotFoundException } from '@nestjs/common';
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
    // Ceilings are opt-in: every operator switch starts unset in each test.
    'EMAIL_SEND_CAP_INBOX_PER_MINUTE',
    'EMAIL_SEND_CAP_INBOX_RECIPIENTS_PER_5_MINUTES',
    'EMAIL_SEND_CAP_RECIPIENTS_PER_MESSAGE',
    'EMAIL_SEND_CAP_WORKSPACE_DAILY',
    'EMAIL_SEND_CAP_WORKSPACE_MONTHLY',
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
    const organizations: {
        findOne: jest.Mock;
        update: jest.Mock;
        manager: {
            connection: { options: { type: string } };
            transaction: jest.Mock;
            getRepository: jest.Mock;
        };
    } = {
        findOne: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue(undefined),
        // The organization-policy write runs in a transaction; this one runs
        // the work on the same mocked repository.
        manager: {
            connection: { options: { type: 'postgres' } },
            transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) =>
                work(organizations.manager),
            ),
            getRepository: jest.fn(() => organizations),
        },
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
            // The operator turned the account-wide daily ceiling on.
            process.env.EMAIL_SEND_CAP_WORKSPACE_DAILY = '500';
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
            const { service, inboxes } = makeHarness();
            // The Agent has settings, so its per-message limit is in force
            // (the recommended 50, nothing else being set).
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'auto-send' });
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

    describe('opt-in ceilings — unconfigured = unchanged', () => {
        const DAY_MS = 24 * 3600 * 1000;

        it('enforces and counts nothing when no source is configured, however much was sent', async () => {
            const { service, messages } = makeHarness();
            messages.countOutboundSentSince.mockResolvedValue(1_000_000);
            const to = Array.from({ length: 500 }, (_, i) => `r${i}@example.com`);

            await expect(service.assertSendAllowed(attempt({ to }))).resolves.toBeUndefined();
            await expect(
                service.assertSendAllowed(attempt({ origin: 'human', to })),
            ).resolves.toBeUndefined();
            await expect(service.admitSend(attempt({ to }))).resolves.toEqual({
                reservedMessageId: null,
            });
            // Not a large sentinel compared against a count: no count at all.
            expect(messages.countOutboundSentSince).not.toHaveBeenCalled();
        });

        it('treats an organization policy that sets no caps as no ceiling source', async () => {
            const { service, agents, organizations, messages } = makeHarness();
            agents.findOne.mockResolvedValue({
                id: 'agent-1',
                userId: 'user-1',
                organizationId: 'org-1',
            });
            organizations.findOne.mockResolvedValue({
                id: 'org-1',
                emailSendPolicy: { defaultMode: 'auto-send', caps: {} },
            });
            messages.countOutboundSentSince.mockResolvedValue(1_000_000);
            await expect(service.assertSendAllowed(attempt())).resolves.toBeUndefined();
            const policy = await service.resolvePolicy('user-1', 'agent-1');
            expect(policy.configured).toBe(false);
            expect(Object.values(policy.caps).every((cap) => cap === null)).toBe(true);
            expect(Object.values(policy.sources).every((s) => s === 'unconfigured')).toBe(true);
        });

        it('OPERATOR: an EMAIL_SEND_CAP_* variable turns that ceiling on platform-wide', async () => {
            process.env.EMAIL_SEND_CAP_INBOX_DAILY = '40';
            const { service, messages } = makeHarness();
            messages.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.agentId && NOW.getTime() - since.getTime() === DAY_MS ? 40 : 0,
            );
            await expect(service.assertSendAllowed(attempt())).rejects.toMatchObject({
                details: { limitKind: 'inboxDaily', cap: 40, scope: 'inbox' },
            });
            const policy = await service.resolvePolicy('user-1', 'agent-1');
            expect(policy.sources.inboxDailySends).toBe('platform');
            expect(policy.sources.workspaceDailySends).toBe('unconfigured');
        });

        it('ORGANIZATION: its caps are enforced for its Agents with nothing set by the operator', async () => {
            const { service, agents, organizations, messages } = makeHarness();
            agents.findOne.mockResolvedValue({
                id: 'agent-1',
                userId: 'user-1',
                organizationId: 'org-1',
            });
            organizations.findOne.mockResolvedValue({
                id: 'org-1',
                emailSendPolicy: { caps: { workspaceDailySends: 12 } },
            });
            messages.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.userId && NOW.getTime() - since.getTime() === DAY_MS ? 12 : 0,
            );
            await expect(service.assertSendAllowed(attempt())).rejects.toMatchObject({
                details: { limitKind: 'workspaceDaily', cap: 12, scope: 'workspace' },
            });
        });

        it('AGENT SETTINGS: a settings row enforces the recommended per-Agent limits it leaves unset', async () => {
            const { service, inboxes, messages } = makeHarness();
            inboxes.findByAgentForUser.mockResolvedValue({ id: 'inbox-1', mode: 'auto-send' });
            messages.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.agentId && NOW.getTime() - since.getTime() === 60_000 ? 10 : 0,
            );
            await expect(service.assertSendAllowed(attempt())).rejects.toMatchObject({
                details: { limitKind: 'inboxBurst', cap: 10 },
            });
            const policy = await service.resolvePolicy('user-1', 'agent-1');
            expect(policy.sources.inboxBurstSends).toBe('recommended');
            // An Agent's settings never switch the account-wide ceilings on.
            expect(policy.caps.workspaceDailySends).toBeNull();
            expect(policy.sources.workspaceDailySends).toBe('unconfigured');
        });

        it('reports an unconfigured Agent on the meter: no caps, every window unconfigured', async () => {
            const { service, messages } = makeHarness();
            messages.countOutboundSentSince.mockResolvedValue(3);
            const meter = await service.getMeter('user-1', 'agent-1');
            expect(meter.enforced).toBe(true);
            expect(meter.limitsConfigured).toBe(false);
            expect(meter.windows.every((w) => w.cap === null && w.source === 'unconfigured')).toBe(
                true,
            );
            // Usage is still shown.
            expect(meter.windows.find((w) => w.kind === 'inboxDaily')?.used).toBe(3);
        });
    });

    describe('admitSend — count and reservation under one lock', () => {
        const ROW = {
            userId: 'user-1',
            agentId: 'agent-1',
            taskId: null,
            emailAddressId: 'addr-1',
            pluginId: 'pending',
            from: 'nova@agents.example.com',
            toAddresses: ['ada@example.com'],
            ccAddresses: null,
            bccAddresses: null,
            subject: 'Quarterly numbers',
            bodyText: 'Attached.',
            bodyHtml: null,
            metadata: null,
            messageRef: 'ref-1',
        };

        function withLock(harness: ReturnType<typeof makeHarness>) {
            const scoped = {
                countOutboundSentSince: jest.fn().mockResolvedValue(0),
                listOutboundRecipientsSince: jest.fn().mockResolvedValue([]),
                save: jest.fn(async (row: Record<string, unknown>) => ({ id: 'res-1', ...row })),
                transitionStatus: jest.fn().mockResolvedValue(1),
            };
            const events: string[] = [];
            const lock = jest.fn(async (keys: unknown, fn: (m: unknown) => Promise<unknown>) => {
                events.push('lock');
                try {
                    return await fn(scoped);
                } finally {
                    events.push('release');
                }
            });
            Object.assign(harness.messages, { withSendAdmissionLock: lock });
            return { scoped, lock, events };
        }

        it('does not lock or reserve when no source is configured', async () => {
            const harness = makeHarness();
            const { lock, scoped } = withLock(harness);
            await expect(
                harness.service.admitSend(attempt(), { kind: 'message', row: ROW }),
            ).resolves.toEqual({ reservedMessageId: null });
            expect(lock).not.toHaveBeenCalled();
            expect(scoped.save).not.toHaveBeenCalled();
        });

        it('counts on the locked transaction and writes the reservation before the lock is released', async () => {
            const harness = makeHarness();
            harness.inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'auto-send',
            });
            const { lock, scoped, events } = withLock(harness);
            scoped.save.mockImplementation(async (row: Record<string, unknown>) => {
                events.push('reserve');
                return { id: 'res-1', ...row };
            });

            const admission = await harness.service.admitSend(attempt(), {
                kind: 'message',
                row: ROW,
            });

            expect(admission).toEqual({ reservedMessageId: 'res-1' });
            // Per-Agent windows only — no account ceiling is configured.
            expect(lock).toHaveBeenCalledWith(
                { agentId: 'agent-1', userId: null },
                expect.any(Function),
            );
            expect(events).toEqual(['lock', 'reserve', 'release']);
            expect(scoped.countOutboundSentSince).toHaveBeenCalled();
            expect(harness.messages.countOutboundSentSince).not.toHaveBeenCalled();
            expect(scoped.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    direction: 'outbound',
                    status: 'sending',
                    sentAt: NOW,
                    providerMessageId: null,
                    toAddresses: ['ada@example.com'],
                }),
            );
        });

        it('takes the account key too when an account-wide ceiling applies', async () => {
            process.env.EMAIL_SEND_CAP_WORKSPACE_MONTHLY = '900';
            const harness = makeHarness();
            harness.inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'auto-send',
            });
            const { lock } = withLock(harness);
            await harness.service.admitSend(attempt(), { kind: 'message', row: ROW });
            expect(lock).toHaveBeenCalledWith(
                { agentId: 'agent-1', userId: 'user-1' },
                expect.any(Function),
            );
        });

        it('reserves nothing and refuses with the structured 429 when the locked count is at the cap', async () => {
            const harness = makeHarness();
            harness.inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'auto-send',
                dailySendCap: 2,
            });
            const { scoped } = withLock(harness);
            scoped.countOutboundSentSince.mockImplementation(async (filter, since: Date) =>
                filter.agentId && NOW.getTime() - since.getTime() === 24 * 3600 * 1000 ? 2 : 0,
            );

            const error = await harness.service
                .admitSend(attempt(), { kind: 'message', row: ROW })
                .catch((e) => e);

            expect(error).toBeInstanceOf(EmailSendCapExceededException);
            expect(error.getStatus()).toBe(429);
            expect(error.getResponse()).toMatchObject({
                details: { limitKind: 'inboxDaily', used: 2, cap: 2 },
            });
            expect(scoped.save).not.toHaveBeenCalled();
        });

        it('stamps an approved draft as the reservation, and refuses if it changed hands', async () => {
            const harness = makeHarness();
            harness.inboxes.findByAgentForUser.mockResolvedValue({
                id: 'inbox-1',
                mode: 'draft-review',
            });
            harness.messages.findByIdAndUserId.mockResolvedValue({
                id: 'draft-1',
                direction: 'outbound',
                agentId: 'agent-1',
                status: 'sending',
                approvedById: 'user-1',
                approvalId: null,
                subject: 'Quarterly numbers',
                toAddresses: ['ada@example.com'],
            });
            const { scoped } = withLock(harness);

            await expect(
                harness.service.admitSend(attempt({ draftMessageId: 'draft-1' }), {
                    kind: 'draft',
                }),
            ).resolves.toEqual({ reservedMessageId: 'draft-1' });
            expect(scoped.transitionStatus).toHaveBeenCalledWith(
                'draft-1',
                ['sending'],
                'sending',
                {
                    sentAt: NOW,
                },
            );
            expect(scoped.save).not.toHaveBeenCalled();

            scoped.transitionStatus.mockResolvedValue(0);
            await expect(
                harness.service.admitSend(attempt({ draftMessageId: 'draft-1' }), {
                    kind: 'draft',
                }),
            ).rejects.toMatchObject({ code: 'draft-not-approved' });
        });

        it('checks a per-message-only ceiling without counting or locking', async () => {
            const harness = makeHarness();
            harness.agents.findOne.mockResolvedValue({
                id: 'agent-1',
                userId: 'user-1',
                organizationId: 'org-1',
            });
            harness.organizations.findOne.mockResolvedValue({
                id: 'org-1',
                emailSendPolicy: { caps: { recipientsPerMessage: 3 } },
            });
            const { lock } = withLock(harness);
            const to = ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'];
            await expect(
                harness.service.admitSend(attempt({ to }), { kind: 'message', row: ROW }),
            ).rejects.toMatchObject({ details: { limitKind: 'recipientsPerMessage', cap: 3 } });
            await expect(
                harness.service.admitSend(attempt({ to: ['a@x.io'] }), {
                    kind: 'message',
                    row: ROW,
                }),
            ).resolves.toEqual({ reservedMessageId: null });
            expect(lock).not.toHaveBeenCalled();
        });
    });

    describe('meter', () => {
        it('reports every window with its ceiling, source and live pause', async () => {
            // Operator-configured platform ceilings, beside the Agent's own.
            process.env.EMAIL_SEND_CAP_INBOX_RECIPIENTS_PER_5_MINUTES = '20';
            process.env.EMAIL_SEND_CAP_WORKSPACE_MONTHLY = '10000';
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

        it("refuses another account's Agent before counting anything (usage windows are keyed on the Agent alone)", async () => {
            const { service, agents, messages } = makeHarness();
            agents.findOne.mockResolvedValue(null);

            await expect(service.getMeter('user-2', 'agent-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );

            expect(agents.findOne).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 'agent-1', userId: 'user-2' } }),
            );
            expect(messages.countOutboundSentSince).not.toHaveBeenCalled();
            expect(messages.listOutboundRecipientsSince).not.toHaveBeenCalled();
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

        it('reads, merges and writes inside one transaction, holding a row lock on Postgres', async () => {
            const { service, organizations } = makeHarness();
            const order: string[] = [];
            organizations.manager.transaction.mockImplementation(
                async (work: (manager: unknown) => Promise<unknown>) => {
                    order.push('begin');
                    try {
                        return await work(organizations.manager);
                    } finally {
                        order.push('commit');
                    }
                },
            );
            organizations.findOne.mockImplementation(async () => {
                order.push('read');
                return { id: 'org-1', emailSendPolicy: null };
            });
            organizations.update.mockImplementation(async () => {
                order.push('write');
            });

            await service.updateOrganizationPolicy('org-1', { defaultMode: 'draft-review' });

            expect(order).toEqual(['begin', 'read', 'write', 'commit']);
            expect(organizations.findOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'org-1' },
                    lock: { mode: 'pessimistic_write' },
                }),
            );
        });

        it('asks for no row lock on SQLite, which has none (its single writer serializes)', async () => {
            const { service, organizations } = makeHarness();
            organizations.manager.connection.options.type = 'better-sqlite3';

            await service.updateOrganizationPolicy('org-1', { defaultMode: 'auto-send' });

            expect(organizations.manager.transaction).toHaveBeenCalledTimes(1);
            expect(organizations.findOne.mock.calls[0][0]).not.toHaveProperty('lock');
        });

        describe('two administrators patching at once', () => {
            /**
             * A stored organization row, and a transaction whose
             * `pessimistic_write` read is a real row lock held until the
             * transaction ends — the database behaviour the service relies on.
             */
            function concurrentHarness(options: { honourLock: boolean }) {
                const harness = makeHarness();
                const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
                let stored: unknown = { caps: { inboxDailySends: 40 } };
                let held: Promise<void> | null = null;
                harness.organizations.manager.transaction.mockImplementation(
                    async (work: (manager: unknown) => Promise<unknown>) => {
                        let release: (() => void) | null = null;
                        const repository = {
                            findOne: async (args: { lock?: unknown }) => {
                                if (args.lock && options.honourLock) {
                                    while (held) await held;
                                    held = new Promise<void>((resolve) => {
                                        release = () => {
                                            held = null;
                                            resolve();
                                        };
                                    });
                                }
                                await tick();
                                return { id: 'org-1', emailSendPolicy: stored };
                            },
                            update: async (
                                _where: unknown,
                                patch: { emailSendPolicy: unknown },
                            ) => {
                                await tick();
                                stored = patch.emailSendPolicy;
                            },
                        };
                        try {
                            return await work({
                                connection: harness.organizations.manager.connection,
                                getRepository: () => repository,
                            });
                        } finally {
                            (release as (() => void) | null)?.();
                        }
                    },
                );
                return { ...harness, read: () => stored };
            }

            it('keeps both changes: the second merge starts from the first write', async () => {
                const { service, read } = concurrentHarness({ honourLock: true });

                await Promise.all([
                    service.updateOrganizationPolicy('org-1', { defaultMode: 'draft-review' }),
                    service.updateOrganizationPolicy('org-1', {
                        caps: { workspaceDailySends: 300 },
                    }),
                ]);

                expect(read()).toEqual({
                    defaultMode: 'draft-review',
                    caps: { inboxDailySends: 40, workspaceDailySends: 300 },
                });
            });

            it('CONTROL: without the row lock the same two patches lose one of them', async () => {
                const { service, read } = concurrentHarness({ honourLock: false });

                await Promise.all([
                    service.updateOrganizationPolicy('org-1', { defaultMode: 'draft-review' }),
                    service.updateOrganizationPolicy('org-1', {
                        caps: { workspaceDailySends: 300 },
                    }),
                ]);

                // If this ever keeps both, the test above proves nothing.
                expect(read()).not.toEqual({
                    defaultMode: 'draft-review',
                    caps: { inboxDailySends: 40, workspaceDailySends: 300 },
                });
            });
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
