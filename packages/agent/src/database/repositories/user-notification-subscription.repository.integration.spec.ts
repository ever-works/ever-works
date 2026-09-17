import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { NotificationEventType } from '../../entities/notification-event-type.entity';
import { UserNotificationSubscription } from '../../entities/user-notification-subscription.entity';
import { UserNotificationPreference } from '../../entities/user-notification-preference.entity';
import { UserNotificationSubscriptionService } from '../../notifications/user-notification-subscription.service';
import { NotificationEventTypeRepository } from './notification-event-type.repository';
import { UserNotificationPreferenceRepository } from './user-notification-preference.repository';
import { UserNotificationSubscriptionRepository } from './user-notification-subscription.repository';

/**
 * Attention controls (AW-13) — stored notification choices executed against a
 * real in-memory sqlite schema, with the real repositories and the real
 * resolver, so the `origin` marker and the quiet-hours opt-in are exercised
 * end to end rather than mocked.
 *
 * The properties that matter:
 *
 *  - a row stored before AW-13 (no marker) and a row written through the API
 *    path (no marker) behave exactly as before: an empty list falls back to
 *    the defaults, and the notification keeps reaching the bell;
 *  - only a choice written with the matrix marker is taken literally;
 *  - the marker always describes the latest write;
 *  - quiet hours keep deferring an event AW-13 marked urgent unless the
 *    person opted in, and the opt-in defaults to off.
 */
describe('UserNotificationSubscriptionRepository + resolver (integration)', () => {
    let dataSource: DataSource;
    let rows: Repository<UserNotificationSubscription>;
    let repository: UserNotificationSubscriptionRepository;
    let preferences: UserNotificationPreferenceRepository;
    let resolver: UserNotificationSubscriptionService;
    let userId: string;
    let otherUserId: string;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();

        rows = dataSource.getRepository(UserNotificationSubscription);
        repository = new UserNotificationSubscriptionRepository(rows);
        preferences = new UserNotificationPreferenceRepository(
            dataSource.getRepository(UserNotificationPreference),
        );
        const eventTypes = new NotificationEventTypeRepository(
            dataSource.getRepository(NotificationEventType),
        );
        resolver = new UserNotificationSubscriptionService(eventTypes, repository, preferences);

        const users = dataSource.getRepository(User);
        userId = (
            await users.save(
                users.create({
                    username: 'owner',
                    email: 'owner@example.com',
                    password: 'x',
                } as Partial<User>),
            )
        ).id;
        otherUserId = (
            await users.save(
                users.create({
                    username: 'stranger',
                    email: 'stranger@example.com',
                    password: 'x',
                } as Partial<User>),
            )
        ).id;

        await eventTypes.upsert({
            key: 'generation_error',
            category: 'generation',
            title: 'Generation failed',
            description: 'A generation run failed.',
            urgent: false,
            defaultChannels: ['in-app', 'email'],
            source: 'core',
        });
        await eventTypes.upsert({
            key: 'agent_run_escalated',
            category: 'agent',
            title: 'Agent needs a decision',
            description: 'A human decision is required.',
            urgent: true,
            defaultChannels: ['in-app', 'email'],
            source: 'core',
        });
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
        await dataSource.getRepository(UserNotificationPreference).clear();
    });

    /** A row exactly as it was stored before AW-13: no `origin` value at all. */
    async function insertPreAw13Row(owner: string, eventTypeKey: string, channelIds: string[]) {
        await dataSource.query(
            `INSERT INTO "user_notification_subscriptions" ("id", "userId", "eventTypeKey", "channelIds", "updatedAt") VALUES (?, ?, ?, ?, datetime('now'))`,
            [
                `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
                owner,
                eventTypeKey,
                JSON.stringify(channelIds),
            ],
        );
    }

    describe('a row stored before AW-13', () => {
        it('reads back with no marker', async () => {
            await insertPreAw13Row(userId, 'generation_error', []);
            const row = await repository.findForEvent(userId, 'generation_error');
            expect(row?.channelIds).toEqual([]);
            expect(row?.origin ?? null).toBeNull();
        });

        it('with an empty list still falls back to the event defaults and keeps the bell', async () => {
            await insertPreAw13Row(userId, 'generation_error', []);
            await expect(resolver.resolveChannels(userId, 'generation_error')).resolves.toEqual([
                'in-app',
                'email',
            ]);
            await expect(resolver.isInAppSelected(userId, 'generation_error')).resolves.toBe(true);
        });

        it('without in-app still reaches the bell, and still routes to what it names', async () => {
            await insertPreAw13Row(userId, 'generation_error', ['email']);
            await expect(resolver.resolveChannels(userId, 'generation_error')).resolves.toEqual([
                'email',
            ]);
            await expect(resolver.isInAppSelected(userId, 'generation_error')).resolves.toBe(true);
        });
    });

    describe('a write through the API path (no origin passed)', () => {
        it('stores no marker and keeps the pre-AW-13 meaning', async () => {
            await repository.upsert(userId, 'generation_error', []);
            expect((await repository.findForEvent(userId, 'generation_error'))?.origin).toBeNull();
            await expect(resolver.resolveChannels(userId, 'generation_error')).resolves.toEqual([
                'in-app',
                'email',
            ]);
            await expect(resolver.isInAppSelected(userId, 'generation_error')).resolves.toBe(true);
        });
    });

    describe('a choice saved in the matrix', () => {
        it('stores the marker and takes an empty list literally: nothing external, silent in-app', async () => {
            await repository.upsert(userId, 'generation_error', [], 'matrix');
            expect((await repository.findForEvent(userId, 'generation_error'))?.origin).toBe(
                'matrix',
            );
            await expect(resolver.resolveChannels(userId, 'generation_error')).resolves.toEqual([]);
            await expect(resolver.isInAppSelected(userId, 'generation_error')).resolves.toBe(false);
        });

        it('keeps the bell when it names in-app', async () => {
            await repository.upsert(userId, 'generation_error', ['in-app'], 'matrix');
            await expect(resolver.isInAppSelected(userId, 'generation_error')).resolves.toBe(true);
            await expect(resolver.resolveChannels(userId, 'generation_error')).resolves.toEqual([
                'in-app',
            ]);
        });

        it('is replaced, marker included, by a later write through the API path', async () => {
            await repository.upsert(userId, 'generation_error', [], 'matrix');
            await repository.upsert(userId, 'generation_error', []);
            const row = await repository.findForEvent(userId, 'generation_error');
            expect(row?.origin).toBeNull();
            expect(await rows.count({ where: { userId, eventTypeKey: 'generation_error' } })).toBe(
                1,
            );
            await expect(resolver.resolveChannels(userId, 'generation_error')).resolves.toEqual([
                'in-app',
                'email',
            ]);
        });

        it('marks a row that was stored before AW-13 once the person saves it in the matrix', async () => {
            await insertPreAw13Row(userId, 'generation_error', ['email']);
            await repository.upsert(userId, 'generation_error', ['email'], 'matrix');
            await expect(resolver.isInAppSelected(userId, 'generation_error')).resolves.toBe(false);
        });

        it('never touches another person’s row', async () => {
            await repository.upsert(otherUserId, 'generation_error', [], 'matrix');
            await repository.upsert(userId, 'generation_error', ['in-app']);
            expect((await repository.findForEvent(otherUserId, 'generation_error'))?.origin).toBe(
                'matrix',
            );
            expect((await repository.findForEvent(userId, 'generation_error'))?.origin).toBeNull();
        });
    });

    describe('quiet hours and the urgent opt-in', () => {
        const allDay = {
            quietHoursStart: '00:00:00',
            quietHoursEnd: '23:59:59',
            timezone: 'UTC',
        };

        it('defaults the opt-in to off on a new preference row', async () => {
            const saved = await preferences.upsert(userId, { ...allDay });
            expect(saved.urgentBypassesQuietHours).toBe(false);
            expect((await preferences.findByUser(userId))?.urgentBypassesQuietHours).toBe(false);
        });

        it('keeps deferring an event AW-13 marked urgent until the person opts in', async () => {
            await preferences.upsert(userId, { ...allDay });
            const deferred = await resolver.resolvePlan(userId, 'agent_run_escalated');
            expect(deferred.immediate).toEqual(['in-app']);
            expect(deferred.deferred).toEqual(['email']);

            await preferences.upsert(userId, { urgentBypassesQuietHours: true });
            expect((await preferences.findByUser(userId))?.quietHoursStart).toBe('00:00:00');
            await expect(resolver.resolvePlan(userId, 'agent_run_escalated')).resolves.toEqual({
                immediate: ['in-app', 'email'],
                deferred: [],
            });
        });
    });
});
