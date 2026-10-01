import {
    APP_BUILD_EVENT_NAMES,
    APP_BUILD_STATUS_EVENT_MAP,
    APP_BUILD_STATUSES,
    appBuildEventNameForStatus,
    type AppBuildEventPayload,
    type AppBuildStatus,
} from '@ever-works/contracts';
import { BaseEvent } from '../base';
import {
    APP_BUILD_EVENT_CLASSES,
    AppBuildCancelledEvent,
    AppBuildFailedEvent,
    AppBuildQueuedEvent,
    AppBuildStartedEvent,
    AppBuildSucceededEvent,
    type AppBuildEventClass,
} from '../app-build.events';
import * as eventsBarrel from '../index';

/**
 * APW-05 T17 — `APW05-G05`: the five `app.build.*` names are unique and dotted,
 * and the explicit status → event map of plan §7.8 is total.
 *
 * The companion suite (`../events.spec.ts`) pins the barrel's runtime surface;
 * this one owns the Build family itself, so a change to a wire name fails here
 * with the name in the message rather than as a diff in a sorted list.
 */

const payload: AppBuildEventPayload = {
    workId: 'w1',
    userId: 'u1',
    buildId: 'b1',
    number: 14,
    status: 'queued',
    trigger: 'push',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    pullRequestNumber: null,
    deployable: false,
    notDeployableReason: null,
    imageDigest: null,
    failureClass: null,
    cancelReason: null,
};

const CLASSES: ReadonlyArray<[AppBuildEventClass, string]> = [
    [AppBuildQueuedEvent, 'app.build.queued'],
    [AppBuildStartedEvent, 'app.build.started'],
    [AppBuildSucceededEvent, 'app.build.succeeded'],
    [AppBuildFailedEvent, 'app.build.failed'],
    [AppBuildCancelledEvent, 'app.build.cancelled'],
];

describe('app.build.* events (APW-05 plan §7.8)', () => {
    describe('the five names', () => {
        it.each(CLASSES)('%p is named %s', (EventClass, name) => {
            expect(EventClass.EVENT_NAME).toBe(name);
        });

        it('are unique', () => {
            const names = CLASSES.map(([EventClass]) => EventClass.EVENT_NAME);
            expect(new Set(names).size).toBe(names.length);
            expect(names).toHaveLength(5);
        });

        it('are dotted and lower-case, matching the wire convention', () => {
            for (const [EventClass] of CLASSES) {
                expect(EventClass.EVENT_NAME).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
                expect(EventClass.EVENT_NAME.startsWith('app.build.')).toBe(true);
            }
        });

        it('are exactly the names CONTRACTS §6 publishes, in order', () => {
            expect(CLASSES.map(([EventClass]) => EventClass.EVENT_NAME)).toEqual([
                ...APP_BUILD_EVENT_NAMES,
            ]);
        });

        it('carry the payload positionally and extend BaseEvent', () => {
            for (const [EventClass] of CLASSES) {
                const event = new EventClass(payload);
                expect(event).toBeInstanceOf(BaseEvent);
                expect(event.payload).toBe(payload);
            }
        });

        it('are distinct classes (instanceof discriminates them)', () => {
            const queued = new AppBuildQueuedEvent(payload);
            expect(queued).not.toBeInstanceOf(AppBuildStartedEvent);
            expect(queued).not.toBeInstanceOf(AppBuildSucceededEvent);
            expect(new AppBuildFailedEvent(payload)).not.toBeInstanceOf(AppBuildCancelledEvent);
        });
    });

    describe('the explicit status → event map', () => {
        it('maps every status, and blocked to nothing at all', () => {
            expect(APP_BUILD_STATUS_EVENT_MAP).toEqual({
                queued: 'app.build.queued',
                running: 'app.build.started',
                succeeded: 'app.build.succeeded',
                failed: 'app.build.failed',
                cancelled: 'app.build.cancelled',
                blocked: null,
            });
        });

        it('is total over APP_BUILD_STATUSES — no status is left undecided', () => {
            for (const status of APP_BUILD_STATUSES) {
                expect(
                    Object.prototype.hasOwnProperty.call(APP_BUILD_STATUS_EVENT_MAP, status),
                ).toBe(true);
            }
            expect(Object.keys(APP_BUILD_STATUS_EVENT_MAP)).toHaveLength(APP_BUILD_STATUSES.length);
        });

        it('agrees with the class map, status for status', () => {
            for (const status of APP_BUILD_STATUSES) {
                const EventClass = APP_BUILD_EVENT_CLASSES[status];
                const name = appBuildEventNameForStatus(status);
                if (name === null) {
                    expect(EventClass).toBeNull();
                    expect(status).toBe('blocked');
                    continue;
                }
                expect(EventClass).not.toBeNull();
                expect((EventClass as AppBuildEventClass).EVENT_NAME).toBe(name);
            }
        });

        it('publishes nothing for blocked — it is not a CONTRACTS §6 name', () => {
            expect(appBuildEventNameForStatus('blocked')).toBeNull();
            expect(APP_BUILD_EVENT_CLASSES.blocked).toBeNull();
            expect(APP_BUILD_EVENT_NAMES).not.toContain('app.build.blocked');
        });

        it('rides the status rather than a template, so every mapped name is a real class', () => {
            const mapped = Object.values(APP_BUILD_EVENT_CLASSES).filter(
                (value): value is AppBuildEventClass => value !== null,
            );
            expect(mapped).toHaveLength(5);
            for (const status of APP_BUILD_STATUSES as readonly AppBuildStatus[]) {
                const EventClass = APP_BUILD_EVENT_CLASSES[status];
                if (EventClass) expect(mapped).toContain(EventClass);
            }
        });
    });

    describe('barrel re-exports', () => {
        it('exposes every class and the map from @ever-works/agent/events', () => {
            for (const [EventClass] of CLASSES) {
                expect(eventsBarrel[EventClass.name as keyof typeof eventsBarrel]).toBe(EventClass);
            }
            expect(eventsBarrel.APP_BUILD_EVENT_CLASSES).toBe(APP_BUILD_EVENT_CLASSES);
        });
    });
});
