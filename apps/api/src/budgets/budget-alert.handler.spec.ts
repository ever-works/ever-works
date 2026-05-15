jest.mock('@ever-works/agent/notifications', () => ({}));
jest.mock('@ever-works/agent/budgets', () => ({
    BudgetThresholdCrossedEvent: { EVENT_NAME: 'budget.threshold-crossed' },
}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/monitoring', () => ({}));
jest.mock('@src/mail/mail.service', () => ({}));

import { BudgetAlertHandler } from './budget-alert.handler';
import type { NotificationService } from '@ever-works/agent/notifications';
import type { UserRepository } from '@ever-works/agent/database';
import type { AnalyticsService } from '@ever-works/monitoring';
import type { MailService } from '@src/mail/mail.service';

/**
 * EW-602 — BudgetAlertHandler subscribes to BudgetThresholdCrossedEvent
 * and fans out into three channels:
 *   1. NotificationService.notifyBudgetThresholdCrossed (in-app)
 *   2. AnalyticsService.track('budget_threshold_crossed') (PostHog)
 *   3. MailService.sendBudgetAlertEmail (email, opt-out aware)
 *
 * Each channel is wrapped in its own try/catch so a failure in one
 * (e.g. mail) cannot starve the others. Email delivery is suppressed
 * when User.email is missing or User.emailBudgetAlerts === false.
 */

function makeEvent(overrides: Partial<any> = {}) {
    return {
        workId: 'work-1',
        userId: 'user-1',
        budget: {
            id: 'budget-1',
            scope: 'global',
            pluginId: null,
            work: { name: 'Acme Directory' },
            ...(overrides.budget ?? {}),
        },
        threshold: '90',
        currentSpendCents: 9000,
        capCents: 10_000,
        currency: 'usd',
        capability: 'ai',
        periodStart: new Date('2026-05-01T00:00:00Z'),
        ...overrides,
    } as any;
}

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
    const userRepository = {
        findById: jest.fn().mockResolvedValue({
            id: 'user-1',
            username: 'alice',
            email: 'alice@example.com',
            emailBudgetAlerts: true,
        }),
        ...(overrides.userRepository ?? {}),
    } as unknown as jest.Mocked<UserRepository>;

    const notificationService = {
        notifyBudgetThresholdCrossed: jest.fn().mockResolvedValue(undefined),
        ...(overrides.notificationService ?? {}),
    } as unknown as jest.Mocked<NotificationService>;

    const mailService = {
        sendBudgetAlertEmail: jest.fn().mockResolvedValue(undefined),
        ...(overrides.mailService ?? {}),
    } as unknown as jest.Mocked<MailService>;

    const analytics = {
        track: jest.fn(),
        ...(overrides.analytics ?? {}),
    } as unknown as jest.Mocked<AnalyticsService>;

    const handler = new BudgetAlertHandler(
        userRepository,
        notificationService,
        mailService,
        analytics,
    );
    const warnSpy = jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = jest
        .spyOn((handler as any).logger, 'debug')
        .mockImplementation(() => undefined);
    return {
        handler,
        userRepository,
        notificationService,
        mailService,
        analytics,
        warnSpy,
        debugSpy,
    };
}

afterEach(() => jest.restoreAllMocks());

describe('BudgetAlertHandler.handle — happy path', () => {
    it('fans out to in-app notification, analytics, and email when user has opted in', async () => {
        const { handler, notificationService, analytics, mailService } = makeDeps();
        await handler.handle(makeEvent());

        expect(notificationService.notifyBudgetThresholdCrossed).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                workId: 'work-1',
                budgetId: 'budget-1',
                threshold: '90',
                scope: 'global',
                pluginId: null,
                currentSpendCents: 9000,
                capCents: 10_000,
                currency: 'usd',
            }),
        );
        expect(analytics.track).toHaveBeenCalledWith(
            'user-1',
            'budget_threshold_crossed',
            expect.objectContaining({
                workId: 'work-1',
                budgetId: 'budget-1',
                threshold: '90',
                capability: 'ai',
            }),
        );
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalledWith(
            'alice@example.com',
            'alice',
            expect.objectContaining({
                workName: 'Acme Directory',
                scopeLabel: 'directory-wide',
                threshold: '90',
                capability: 'ai',
                periodLabel: expect.stringMatching(/May/),
                settingsUrl: expect.stringContaining('/works/work-1/settings/budgets-usage'),
            }),
        );
    });

    it('uses plugin-scoped scopeLabel when budget.scope = plugin', async () => {
        const { handler, mailService } = makeDeps();
        await handler.handle(
            makeEvent({
                budget: { id: 'b1', scope: 'plugin', pluginId: 'openai', work: { name: 'X' } },
            }),
        );
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalledWith(
            'alice@example.com',
            'alice',
            expect.objectContaining({
                scopeLabel: "plugin 'openai'",
                pluginId: 'openai',
            }),
        );
    });

    it('falls back to workId when budget.work.name is missing', async () => {
        const { handler, mailService } = makeDeps();
        await handler.handle(
            makeEvent({
                budget: { id: 'b1', scope: 'global', pluginId: null, work: undefined },
            }),
        );
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalledWith(
            'alice@example.com',
            'alice',
            expect.objectContaining({ workName: 'work-1' }),
        );
    });

    it('uses recipient name fallback "there" when user has no username', async () => {
        const { handler, mailService } = makeDeps({
            userRepository: {
                findById: jest.fn().mockResolvedValue({
                    id: 'user-1',
                    username: null,
                    email: 'alice@example.com',
                    emailBudgetAlerts: true,
                }),
            },
        });
        await handler.handle(makeEvent());
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalledWith(
            'alice@example.com',
            'there',
            expect.any(Object),
        );
    });
});

describe('BudgetAlertHandler.handle — email opt-out and skip cases', () => {
    it('skips email send when user.emailBudgetAlerts === false (other channels still fire)', async () => {
        const { handler, mailService, notificationService, analytics } = makeDeps({
            userRepository: {
                findById: jest.fn().mockResolvedValue({
                    id: 'user-1',
                    username: 'alice',
                    email: 'alice@example.com',
                    emailBudgetAlerts: false,
                }),
            },
        });
        await handler.handle(makeEvent());
        expect(mailService.sendBudgetAlertEmail).not.toHaveBeenCalled();
        expect(notificationService.notifyBudgetThresholdCrossed).toHaveBeenCalled();
        expect(analytics.track).toHaveBeenCalled();
    });

    it('skips email send when user has no email', async () => {
        const { handler, mailService } = makeDeps({
            userRepository: {
                findById: jest.fn().mockResolvedValue({
                    id: 'user-1',
                    username: 'alice',
                    email: null,
                    emailBudgetAlerts: true,
                }),
            },
        });
        await handler.handle(makeEvent());
        expect(mailService.sendBudgetAlertEmail).not.toHaveBeenCalled();
    });

    it('logs a warning + skips email when the user row is not found', async () => {
        const { handler, mailService, warnSpy } = makeDeps({
            userRepository: { findById: jest.fn().mockResolvedValue(null) },
        });
        await handler.handle(makeEvent());
        expect(mailService.sendBudgetAlertEmail).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('user user-1 not found'));
    });
});

describe('BudgetAlertHandler.handle — channel isolation (one failing channel does not block others)', () => {
    it('logs warning when notification channel throws but still emits analytics + email', async () => {
        const { handler, analytics, mailService, warnSpy } = makeDeps({
            notificationService: {
                notifyBudgetThresholdCrossed: jest.fn().mockRejectedValue(new Error('db')),
            },
        });
        await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
        expect(analytics.track).toHaveBeenCalled();
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to create in-app notification'),
        );
    });

    it('logs warning when analytics throws but still sends notification + email', async () => {
        const { handler, notificationService, mailService, warnSpy } = makeDeps({
            analytics: {
                track: jest.fn(() => {
                    throw new Error('posthog down');
                }),
            },
        });
        await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
        expect(notificationService.notifyBudgetThresholdCrossed).toHaveBeenCalled();
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to emit analytics event'),
        );
    });

    it('logs warning when email send throws and does NOT bubble', async () => {
        const { handler, warnSpy } = makeDeps({
            mailService: {
                sendBudgetAlertEmail: jest.fn().mockRejectedValue(new Error('smtp')),
            },
        });
        await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to send budget-alert email'),
        );
    });

    it('does not crash when AnalyticsService is undefined (optional dep)', async () => {
        const userRepository = {
            findById: jest.fn().mockResolvedValue({
                id: 'user-1',
                username: 'alice',
                email: 'alice@example.com',
                emailBudgetAlerts: true,
            }),
        } as any;
        const notificationService = {
            notifyBudgetThresholdCrossed: jest.fn().mockResolvedValue(undefined),
        } as any;
        const mailService = { sendBudgetAlertEmail: jest.fn().mockResolvedValue(undefined) } as any;
        const handler = new BudgetAlertHandler(
            userRepository,
            notificationService,
            mailService,
            undefined,
        );
        jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn((handler as any).logger, 'debug').mockImplementation(() => undefined);
        await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
        expect(notificationService.notifyBudgetThresholdCrossed).toHaveBeenCalled();
        expect(mailService.sendBudgetAlertEmail).toHaveBeenCalled();
    });
});
