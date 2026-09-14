// Stub the agent barrels so importing the service does not pull the agent
// database module; the catalogue itself is the real one, so the groups and
// flags asserted below are the shipped ones.
jest.mock('@ever-works/agent/database', () => ({
    NotificationChannelRepository: class {},
    NotificationEventTypeRepository: class {},
    UserNotificationCategoryMuteRepository: class {},
    UserNotificationPreferenceRepository: class {},
    UserNotificationSubscriptionRepository: class {},
    UserRepository: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/notifications', () => ({
    ...jest.requireActual('../../../../packages/agent/src/notifications/core-event-catalogue'),
    UserNotificationSubscriptionService: class {},
}));
jest.mock('@src/mail/mail.service', () => ({ MailService: class {} }));

import { CORE_NOTIFICATION_EVENTS } from '@ever-works/agent/notifications';
import { NotificationMatrixService } from './notification-matrix.service';

function registryRows(overrides: Record<string, Partial<Record<string, unknown>>> = {}) {
    return CORE_NOTIFICATION_EVENTS.map((e) => ({
        key: e.key,
        category: e.category,
        title: e.title,
        description: e.description,
        urgent: e.urgent,
        defaultChannels: [...e.defaultChannels],
        source: 'core',
        pluginId: null,
        ...(overrides[e.key] ?? {}),
    }));
}

describe('NotificationMatrixService', () => {
    let eventTypes: { findAll: jest.Mock };
    let subscriptions: { findByUser: jest.Mock; deleteForUser: jest.Mock };
    let preferences: { findByUser: jest.Mock };
    let mutes: { findActiveByUser: jest.Mock };
    let channels: { findAllByUser: jest.Mock };
    let users: { findById: jest.Mock };
    let resolver: { loadOrgDefaultMap: jest.Mock };
    let plugins: { get: jest.Mock };
    let emailSender: { availabilityFor: jest.Mock };

    function build(opts: { withEmailSender?: boolean; withResolver?: boolean } = {}) {
        return new NotificationMatrixService(
            eventTypes as never,
            subscriptions as never,
            preferences as never,
            mutes as never,
            channels as never,
            users as never,
            (opts.withResolver === false ? undefined : resolver) as never,
            plugins as never,
            (opts.withEmailSender === false ? undefined : emailSender) as never,
        );
    }

    beforeEach(() => {
        eventTypes = { findAll: jest.fn().mockResolvedValue(registryRows()) };
        subscriptions = {
            findByUser: jest.fn().mockResolvedValue([]),
            deleteForUser: jest.fn().mockResolvedValue(3),
        };
        preferences = { findByUser: jest.fn().mockResolvedValue(null) };
        mutes = { findActiveByUser: jest.fn().mockResolvedValue([]) };
        channels = { findAllByUser: jest.fn().mockResolvedValue([]) };
        users = {
            findById: jest.fn().mockResolvedValue({
                id: 'u1',
                email: 'a@b.c',
                emailVerified: true,
                emailBudgetAlerts: true,
            }),
        };
        resolver = { loadOrgDefaultMap: jest.fn().mockResolvedValue(undefined) };
        plugins = {
            get: jest.fn((id: string) =>
                id === 'slack-channel' ? { plugin: { name: 'Slack' } } : undefined,
            ),
        };
        emailSender = { availabilityFor: jest.fn().mockReturnValue('available') };
    });

    it('reads everything for the calling user in one pass', async () => {
        await build().getMatrix('u1');
        expect(subscriptions.findByUser).toHaveBeenCalledWith('u1');
        expect(preferences.findByUser).toHaveBeenCalledWith('u1');
        expect(mutes.findActiveByUser).toHaveBeenCalledWith('u1');
        expect(channels.findAllByUser).toHaveBeenCalledWith('u1');
        expect(users.findById).toHaveBeenCalledWith('u1');
        expect(resolver.loadOrgDefaultMap).toHaveBeenCalledWith('u1');
        expect(eventTypes.findAll).toHaveBeenCalledTimes(1);
    });

    it('returns all 23 core events grouped in page order, with the shipped defaults selected', async () => {
        const matrix = await build().getMatrix('u1');
        expect(matrix.events).toHaveLength(23);
        const groups = matrix.events.map((e) => e.group);
        expect(groups.indexOf('signals')).toBeGreaterThan(groups.lastIndexOf('needsYou'));
        expect(groups.indexOf('routine')).toBeGreaterThan(groups.lastIndexOf('signals'));
        expect(groups.at(-1)).toBe('digest');

        const escalation = matrix.events.find((e) => e.key === 'agent_run_escalated')!;
        expect(escalation).toMatchObject({
            group: 'needsYou',
            urgent: true,
            inAppLocked: true,
            explicit: false,
            selectedTargets: ['in-app', 'email'],
        });
        const finished = matrix.events.find((e) => e.key === 'agent_run_finished')!;
        expect(finished).toMatchObject({
            group: 'routine',
            alternativeSurface: 'liveFeedRunsHome',
            category: 'agents',
            muteCategory: 'agent',
        });
        const budget = matrix.events.find((e) => e.key === 'budget_threshold_warning')!;
        expect(budget).toMatchObject({ emailGovernedByProfile: true, group: 'signals' });
    });

    it('shows a stored choice, including an explicit empty one, instead of the defaults', async () => {
        subscriptions.findByUser.mockResolvedValue([
            { eventTypeKey: 'agent_run_escalated', channelIds: [] },
            { eventTypeKey: 'generation_error', channelIds: ['email', 'ch-1'] },
        ]);
        const matrix = await build().getMatrix('u1');
        expect(matrix.events.find((e) => e.key === 'agent_run_escalated')).toMatchObject({
            explicit: true,
            selectedTargets: [],
        });
        expect(matrix.events.find((e) => e.key === 'generation_error')).toMatchObject({
            explicit: true,
            selectedTargets: ['email', 'ch-1'],
        });
    });

    it('applies an organisation default between the user and the event default', async () => {
        resolver.loadOrgDefaultMap.mockResolvedValue({ generation_error: ['in-app', 'ch-org'] });
        const matrix = await build().getMatrix('u1');
        expect(matrix.events.find((e) => e.key === 'generation_error')?.selectedTargets).toEqual([
            'in-app',
            'ch-org',
        ]);
    });

    it('still renders when the organisation default lookup fails', async () => {
        resolver.loadOrgDefaultMap.mockRejectedValue(new Error('db'));
        const matrix = await build().getMatrix('u1');
        expect(matrix.events).toHaveLength(23);
    });

    it('lists in-app, email, then the user’s channels newest first — disabled ones greyed, labels from the registry', async () => {
        channels.findAllByUser.mockResolvedValue([
            {
                id: 'old',
                name: '#ops',
                pluginId: 'slack-channel',
                disabledAt: null,
                createdAt: new Date('2026-01-01'),
            },
            {
                id: 'new',
                name: 'Night shift',
                pluginId: 'unknown-plugin',
                disabledAt: new Date('2026-09-01'),
                createdAt: new Date('2026-09-01'),
            },
        ]);
        const matrix = await build().getMatrix('u1');
        expect(matrix.columns.map((c) => c.id)).toEqual(['in-app', 'email', 'new', 'old']);
        expect(matrix.columns[2]).toMatchObject({
            kind: 'channel',
            label: 'Night shift',
            providerLabel: null,
            disabled: true,
            disabledReason: 'channel-disabled',
        });
        expect(matrix.columns[3]).toMatchObject({
            label: '#ops',
            providerLabel: 'Slack',
            disabled: false,
        });
    });

    it.each([
        ['unverified', 'email-unverified'],
        ['not-configured', 'email-not-configured'],
    ] as const)('disables the email column when email is %s', async (availability, reason) => {
        emailSender.availabilityFor.mockReturnValue(availability);
        const matrix = await build().getMatrix('u1');
        expect(matrix.email.availability).toBe(availability);
        expect(matrix.columns[1]).toMatchObject({
            id: 'email',
            disabled: true,
            disabledReason: reason,
        });
    });

    it('treats email as not configured when no sender is bound', async () => {
        const matrix = await build({ withEmailSender: false }).getMatrix('u1');
        expect(matrix.email.availability).toBe('not-configured');
    });

    it('surfaces active mutes on the rows they reach, through category aliases', async () => {
        mutes.findActiveByUser.mockResolvedValue([
            { category: 'agent', mutedUntil: new Date('2026-09-15T18:00:00.000Z') },
        ]);
        const matrix = await build().getMatrix('u1');
        expect(matrix.events.find((e) => e.key === 'agent_run_finished')).toMatchObject({
            muted: true,
            mutedUntil: '2026-09-15T18:00:00.000Z',
        });
        expect(matrix.events.find((e) => e.key === 'generation_error')).toMatchObject({
            muted: false,
            mutedUntil: null,
        });
    });

    it('carries quiet hours, the profile budget-alert setting and the limits', async () => {
        preferences.findByUser.mockResolvedValue({
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'Europe/Sofia',
        });
        users.findById.mockResolvedValue({ id: 'u1', emailBudgetAlerts: false });
        const matrix = await build().getMatrix('u1');
        expect(matrix.quietHours).toEqual({
            start: '22:00',
            end: '07:00',
            timezone: 'Europe/Sofia',
        });
        expect(matrix.email.profileBudgetAlerts).toBe(false);
        expect(matrix.limits).toEqual({ maxTargets: 20, maxColumns: 6 });
        expect(matrix.budgets).toEqual([]);
    });

    it('includes a plugin-contributed event without any code change', async () => {
        eventTypes.findAll.mockResolvedValue([
            ...registryRows(),
            {
                key: 'acme-plugin:deploy_failed',
                category: 'integrations',
                title: 'Deploy failed',
                description: 'A deploy failed.',
                urgent: false,
                defaultChannels: ['in-app'],
                source: 'plugin',
                pluginId: 'acme-plugin',
            },
        ]);
        const matrix = await build().getMatrix('u1');
        expect(matrix.events.find((e) => e.key === 'acme-plugin:deploy_failed')).toMatchObject({
            group: 'signals',
            source: 'plugin',
            muteCategory: 'security',
            inAppLocked: false,
        });
    });

    it('returns an empty event list for an empty registry', async () => {
        eventTypes.findAll.mockResolvedValue([]);
        const matrix = await build().getMatrix('u1');
        expect(matrix.events).toEqual([]);
        expect(matrix.columns.map((c) => c.id)).toEqual(['in-app', 'email']);
    });

    it('resets only the caller’s choices, and reports how many changed', async () => {
        await expect(build().reset('u1', ['generation_error'])).resolves.toEqual({ changed: 3 });
        expect(subscriptions.deleteForUser).toHaveBeenCalledWith('u1', ['generation_error']);
        subscriptions.deleteForUser.mockResolvedValue(0);
        await expect(build().reset('u1')).resolves.toEqual({ changed: 0 });
        expect(subscriptions.deleteForUser).toHaveBeenLastCalledWith('u1', undefined);
    });
});
