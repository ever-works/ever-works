import { Test } from '@nestjs/testing';
import {
    NotificationEventTypeRepository,
    OrganizationNotificationDefaultRepository,
    OrganizationRepository,
    UserNotificationCategoryMuteRepository,
    UserNotificationPreferenceRepository,
    UserNotificationSubscriptionRepository,
    UserRepository,
} from '@src/database';
import { UserNotificationSubscriptionService } from '../user-notification-subscription.service';
import { NotificationService, NOTIFICATION_FANOUT_EVENT } from '../notification.service';
import { NotificationCategory, NotificationType } from '../../entities/notification.types';

/**
 * Attention controls (AW-13) — routing behaviour the notification matrix
 * depends on: an explicit "nothing" saved in the matrix sticks, the built-in
 * email target survives the whole chain, every event can be muted, and a user
 * who turned in-app off in the matrix gets the record written silently instead
 * of not at all.
 *
 * And what must NOT change for anyone who never used the matrix: a stored row
 * without the matrix marker (stored before AW-13, or through the API / chat
 * assistant) keeps falling back to the defaults when empty and keeps reaching
 * the bell, and quiet hours keep deferring every event they deferred before.
 */
describe('UserNotificationSubscriptionService — attention controls', () => {
    let service: UserNotificationSubscriptionService;
    let eventTypes: { findByKey: jest.Mock };
    let subscriptions: { findForEvent: jest.Mock };
    let preferences: { findByUser: jest.Mock };
    let mutes: { isMuted: jest.Mock };
    let orgDefaults: { findByOrg: jest.Mock };
    let organizations: { findByTenantId: jest.Mock };
    let users: { findById: jest.Mock };

    beforeEach(async () => {
        eventTypes = { findByKey: jest.fn() };
        subscriptions = { findForEvent: jest.fn().mockResolvedValue(null) };
        preferences = { findByUser: jest.fn().mockResolvedValue(null) };
        mutes = { isMuted: jest.fn().mockResolvedValue(false) };
        orgDefaults = { findByOrg: jest.fn().mockResolvedValue(null) };
        organizations = { findByTenantId: jest.fn().mockResolvedValue([{ id: 'org-1' }]) };
        users = { findById: jest.fn().mockResolvedValue({ id: 'u', tenantId: 't-1' }) };
        const moduleRef = await Test.createTestingModule({
            providers: [
                UserNotificationSubscriptionService,
                { provide: NotificationEventTypeRepository, useValue: eventTypes },
                { provide: UserNotificationSubscriptionRepository, useValue: subscriptions },
                { provide: UserNotificationPreferenceRepository, useValue: preferences },
                { provide: UserNotificationCategoryMuteRepository, useValue: mutes },
                { provide: OrganizationNotificationDefaultRepository, useValue: orgDefaults },
                { provide: OrganizationRepository, useValue: organizations },
                { provide: UserRepository, useValue: users },
            ],
        }).compile();
        service = moduleRef.get(UserNotificationSubscriptionService);
    });

    const escalation = {
        key: 'agent_run_escalated',
        category: 'agent',
        urgent: true,
        defaultChannels: ['in-app', 'email'],
    };

    describe('an explicit empty selection saved in the matrix', () => {
        it('resolves to no targets instead of falling back to the defaults', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: [], origin: 'matrix' });
            await expect(service.resolvePlan('u', 'agent_run_escalated')).resolves.toEqual({
                immediate: [],
                deferred: [],
            });
        });

        it('also wins over an organisation default', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: [], origin: 'matrix' });
            orgDefaults.findByOrg.mockResolvedValue({
                defaults: { agent_run_escalated: ['in-app', 'ch-org'] },
            });
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([]);
            expect(orgDefaults.findByOrg).not.toHaveBeenCalled();
        });

        it('treats a row with a missing list as empty, not as "no choice"', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: null, origin: 'matrix' });
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([]);
        });
    });

    describe('an empty selection without the matrix marker (stored before AW-13, or via the API / chat assistant)', () => {
        it('falls back to the event defaults for external targets, exactly as before', async () => {
            eventTypes.findByKey.mockResolvedValue({
                key: 'generation_error',
                category: 'generation',
                urgent: false,
                defaultChannels: ['in-app', 'ch-default'],
            });
            subscriptions.findForEvent.mockResolvedValue({ channelIds: [], origin: null });
            await expect(service.resolvePlan('u', 'generation_error')).resolves.toEqual({
                immediate: ['in-app', 'ch-default'],
                deferred: [],
            });
        });

        it('falls back to the organisation default before the event default', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: [] });
            orgDefaults.findByOrg.mockResolvedValue({
                defaults: { agent_run_escalated: ['in-app', 'ch-org'] },
            });
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([
                'in-app',
                'ch-org',
            ]);
        });

        it('treats a missing list as "no choice" too', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: null });
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([
                'in-app',
                'email',
            ]);
        });

        it('still uses a non-empty list as stored', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['ch-1'], origin: null });
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([
                'ch-1',
            ]);
        });
    });

    describe('the built-in email target', () => {
        it('survives the whole chain from the event defaults', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([
                'in-app',
                'email',
            ]);
        });

        it('survives from a stored selection', async () => {
            eventTypes.findByKey.mockResolvedValue({ ...escalation, urgent: false });
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['email'] });
            await expect(service.resolveChannels('u', 'agent_run_escalated')).resolves.toEqual([
                'email',
            ]);
        });

        it('is deferred by quiet hours for a non-urgent event, with in-app still immediate', async () => {
            eventTypes.findByKey.mockResolvedValue({
                key: 'generation_error',
                category: 'generation',
                urgent: false,
                defaultChannels: ['in-app'],
            });
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'email'] });
            preferences.findByUser.mockResolvedValue({
                quietHoursStart: '00:00:00',
                quietHoursEnd: '23:59:59',
                timezone: 'UTC',
            });
            const plan = await service.resolvePlan('u', 'generation_error');
            expect(plan.immediate).toEqual(['in-app']);
            expect(plan.deferred).toEqual(['email']);
            expect(typeof plan.deferUntil).toBe('string');
        });

        it('is never deferred by quiet hours for an urgent event the person let through', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            preferences.findByUser.mockResolvedValue({
                quietHoursStart: '00:00:00',
                quietHoursEnd: '23:59:59',
                timezone: 'UTC',
                urgentBypassesQuietHours: true,
            });
            await expect(service.resolvePlan('u', 'agent_run_escalated')).resolves.toEqual({
                immediate: ['in-app', 'email'],
                deferred: [],
            });
        });
    });

    describe('quiet hours keep deferring what they deferred before AW-13', () => {
        const allDay = {
            quietHoursStart: '00:00:00',
            quietHoursEnd: '23:59:59',
            timezone: 'UTC',
        };

        it.each([
            'agent_run_escalated',
            'inbox_approval_requested',
            'inbox_escalation',
            'mission_blocked',
        ])('defers %s by default, although AW-13 marks it urgent', async (key) => {
            eventTypes.findByKey.mockResolvedValue({
                key,
                category: 'agent',
                urgent: true,
                defaultChannels: ['in-app', 'email'],
                source: 'core',
            });
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'ch-1'] });
            preferences.findByUser.mockResolvedValue({ ...allDay });
            const plan = await service.resolvePlan('u', key);
            expect(plan.immediate).toEqual(['in-app']);
            expect(plan.deferred).toEqual(['ch-1']);
            expect(typeof plan.deferUntil).toBe('string');
        });

        it('also defers when the opt-in is explicitly off', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            preferences.findByUser.mockResolvedValue({
                ...allDay,
                urgentBypassesQuietHours: false,
            });
            const plan = await service.resolvePlan('u', 'agent_run_escalated');
            expect(plan.immediate).toEqual(['in-app']);
            expect(plan.deferred).toEqual(['email']);
        });

        it.each(['ai_credits_depleted', 'git_auth_expired', 'inbox_question'])(
            'lets %s through without any opt-in, as before',
            async (key) => {
                eventTypes.findByKey.mockResolvedValue({
                    key,
                    category: 'agent',
                    urgent: true,
                    defaultChannels: ['in-app'],
                    source: 'core',
                });
                subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'ch-1'] });
                preferences.findByUser.mockResolvedValue({ ...allDay });
                await expect(service.resolvePlan('u', key)).resolves.toEqual({
                    immediate: ['in-app', 'ch-1'],
                    deferred: [],
                });
                expect(preferences.findByUser).not.toHaveBeenCalled();
            },
        );

        it('lets an urgent plugin event through without any opt-in, as before', async () => {
            eventTypes.findByKey.mockResolvedValue({
                key: 'agent_run_escalated',
                category: 'integrations',
                urgent: true,
                defaultChannels: ['in-app', 'ch-1'],
                source: 'plugin',
            });
            preferences.findByUser.mockResolvedValue({ ...allDay });
            await expect(service.resolvePlan('u', 'agent_run_escalated')).resolves.toEqual({
                immediate: ['in-app', 'ch-1'],
                deferred: [],
            });
        });

        it('never lets a non-urgent event through, even with the opt-in on', async () => {
            eventTypes.findByKey.mockResolvedValue({
                key: 'generation_error',
                category: 'generation',
                urgent: false,
                defaultChannels: ['in-app'],
            });
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'email'] });
            preferences.findByUser.mockResolvedValue({ ...allDay, urgentBypassesQuietHours: true });
            const plan = await service.resolvePlan('u', 'generation_error');
            expect(plan.immediate).toEqual(['in-app']);
            expect(plan.deferred).toEqual(['email']);
        });
    });

    it('mutes a row stored under an aliased category through the category it names', async () => {
        eventTypes.findByKey.mockResolvedValue({
            key: 'agent_run_finished',
            category: 'agents',
            urgent: false,
            defaultChannels: ['in-app'],
        });
        subscriptions.findForEvent.mockResolvedValue({ channelIds: ['in-app', 'ch-1'] });
        mutes.isMuted.mockImplementation(
            async (_u: string, category: string) => category === 'agent',
        );
        await expect(service.resolveChannels('u', 'agent_run_finished')).resolves.toEqual([
            'in-app',
        ]);
        expect(mutes.isMuted).toHaveBeenCalledWith('u', 'agent');
    });

    it('counts unregistered event keys and still falls back to in-app', async () => {
        eventTypes.findByKey.mockResolvedValue(null);
        await expect(service.resolveChannels('u', 'brand_new_key')).resolves.toEqual(['in-app']);
        await service.resolveChannels('u', 'brand_new_key');
        expect(service.getUnregisteredEventKeyCounts().get('brand_new_key')).toBe(2);
    });

    describe('isInAppSelected', () => {
        it('is true with no stored choice (today’s behaviour)', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(true);
        });

        it('is true for an organisation default that leaves in-app out — only the user’s own choice silences', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            orgDefaults.findByOrg.mockResolvedValue({
                defaults: { agent_run_escalated: ['email'] },
            });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(true);
        });

        it('is false when the user’s own matrix choice leaves in-app out, an empty choice included', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({
                channelIds: ['email'],
                origin: 'matrix',
            });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(false);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: [], origin: 'matrix' });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(false);
        });

        it('is true when a matrix choice keeps in-app', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({
                channelIds: ['email', 'in-app'],
                origin: 'matrix',
            });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(true);
        });

        it('is true for a stored row without the matrix marker that leaves in-app out, an empty one included — it keeps reaching the bell as before', async () => {
            eventTypes.findByKey.mockResolvedValue(escalation);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['email'] });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(true);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: [], origin: null });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(true);
            subscriptions.findForEvent.mockResolvedValue({ channelIds: ['ch-1'], origin: 'api' });
            await expect(service.isInAppSelected('u', 'agent_run_escalated')).resolves.toBe(true);
        });

        it('is true for an unknown event key', async () => {
            eventTypes.findByKey.mockResolvedValue(null);
            await expect(service.isInAppSelected('u', 'nope')).resolves.toBe(true);
        });
    });

    it('loads the organisation default map once for many events', async () => {
        orgDefaults.findByOrg.mockResolvedValue({ defaults: { a: ['in-app'] } });
        await expect(service.loadOrgDefaultMap('u')).resolves.toEqual({ a: ['in-app'] });
        organizations.findByTenantId.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]);
        await expect(service.loadOrgDefaultMap('u')).resolves.toBeUndefined();
    });
});

describe('NotificationService — silent records and budget alert routing', () => {
    function build(resolver?: { isInAppSelected: jest.Mock }) {
        const repository = {
            findByDeduplicationKey: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockImplementation(async (dto) => ({ id: 'n1', ...dto })),
        };
        const emitter = { emit: jest.fn() };
        const service = new NotificationService(repository as any, emitter as any, resolver as any);
        return { service, repository, emitter };
    }

    const budgetArgs = {
        userId: 'u1',
        workId: 'w1',
        budgetId: 'b1',
        scope: 'global' as const,
        currentSpendCents: 900,
        capCents: 1000,
        currency: 'usd',
    };

    it('writes the row silently when the user turned in-app off for its event', async () => {
        const resolver = { isInAppSelected: jest.fn().mockResolvedValue(false) };
        const { service, repository } = build(resolver);
        await service.notifyGenerationAccountError('u1', 'w1', 'Acme', 'boom');
        expect(resolver.isInAppSelected).toHaveBeenCalledWith('u1', 'generation_error');
        expect(repository.create.mock.calls[0][0]).toMatchObject({
            eventKey: 'generation_error',
            isSilent: true,
        });
    });

    it('writes a normal row when in-app is selected', async () => {
        const resolver = { isInAppSelected: jest.fn().mockResolvedValue(true) };
        const { service, repository } = build(resolver);
        await service.notifyGenerationAccountError('u1', 'w1', 'Acme', 'boom');
        expect(repository.create.mock.calls[0][0].isSilent).toBeUndefined();
    });

    it('never writes a persistent notification silently', async () => {
        const resolver = { isInAppSelected: jest.fn().mockResolvedValue(false) };
        const { service, repository } = build(resolver);
        await service.notifyGitAuthExpired('u1', 'GitHub');
        expect(resolver.isInAppSelected).not.toHaveBeenCalled();
        expect(repository.create.mock.calls[0][0]).toMatchObject({ isPersistent: true });
        expect(repository.create.mock.calls[0][0].isSilent).toBeUndefined();
    });

    it('still writes the row when resolving the choice fails', async () => {
        const resolver = { isInAppSelected: jest.fn().mockRejectedValue(new Error('db down')) };
        const { service, repository } = build(resolver);
        await service.notifyAiProviderError('u1', 'openai', 'rate limited');
        expect(repository.create).toHaveBeenCalledTimes(1);
        expect(repository.create.mock.calls[0][0].isSilent).toBeUndefined();
    });

    it('keeps plain create() callers loud: no event key, no lookup', async () => {
        const resolver = { isInAppSelected: jest.fn().mockResolvedValue(false) };
        const { service, repository } = build(resolver);
        await service.create({
            userId: 'u1',
            type: NotificationType.INFO,
            category: NotificationCategory.TASK,
            title: 't',
            message: 'm',
        });
        expect(resolver.isInAppSelected).not.toHaveBeenCalled();
        expect(repository.create.mock.calls[0][0].isSilent).toBeUndefined();
    });

    it('flags a fan-out for a still-open, deduplicated notification', async () => {
        const { service, repository, emitter } = build();
        repository.findByDeduplicationKey.mockResolvedValue({ id: 'old', isDismissed: false });
        await service.notifyAiCreditsDepleted('u1', 'openai');
        expect(repository.create).not.toHaveBeenCalled();
        expect(emitter.emit.mock.calls[0][1]).toMatchObject({
            eventKey: 'ai_credits_depleted',
            deduplicated: true,
        });
    });

    it('does not flag a fan-out for a freshly written notification', async () => {
        const { service, emitter } = build();
        await service.notifyAiCreditsDepleted('u1', 'openai');
        expect(emitter.emit.mock.calls[0][1].deduplicated).toBe(false);
    });

    it.each([
        ['75', 'budget_threshold_warning', false],
        ['90', 'budget_threshold_warning', false],
        ['100', 'budget_threshold_reached', true],
        ['overage', 'budget_threshold_reached', true],
    ] as const)(
        'routes a %s%% budget crossing as %s (urgent=%s)',
        async (threshold, eventKey, urgent) => {
            const { service, repository, emitter } = build();
            await service.notifyBudgetThresholdCrossed({ ...budgetArgs, threshold });
            expect(repository.create.mock.calls[0][0]).toMatchObject({
                eventKey,
                category: NotificationCategory.AI_CREDITS,
                actionUrl: '/works/w1/settings/budgets-usage',
                deduplicationKey: `budget_b1_${threshold}`,
            });
            const [name, payload] = emitter.emit.mock.calls[0];
            expect(name).toBe(NOTIFICATION_FANOUT_EVENT);
            expect(payload).toMatchObject({
                userId: 'u1',
                eventKey,
                urgent,
                actionUrl: '/works/w1/settings/budgets-usage',
                actionLabel: 'Manage budgets',
            });
            expect(payload.message).toContain('900 / 1000 USD cents');
        },
    );
});
