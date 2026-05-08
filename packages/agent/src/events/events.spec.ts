import * as eventsBarrel from './index';
import { BaseEvent } from './base';
import {
    DeploymentDispatchedEvent,
    DeploymentCompletedEvent,
    DeploymentFailedEvent,
    type DeploymentEventPayload,
} from './deployment.events';
import { WorkCreatedEvent } from './work-created.event';
import { WorkGenerationCompletedEvent } from './work-generation-completed.event';
import {
    WorksConfigSyncRequestedEvent,
    type WorksConfigSyncReason,
} from './works-config-sync-requested.event';
import { WorksConfigSyncFailedEvent } from './works-config-sync-failed.event';

/**
 * Mirrors the existing `apps/api/src/events/index.spec.ts` style: every
 * event class published by `@ever-works/agent/events` has its `EVENT_NAME`
 * wire-format string pinned, and every constructor positionally captures
 * its payload onto `readonly` fields. The activity-log + Sentry + worker
 * modules subscribe by these literal names — changing one without the
 * spec bump is a silent breakage.
 *
 * The same `BaseEvent` abstract is reused; `instanceof BaseEvent` is the
 * shared discriminator NestJS event-bus subscribers can rely on.
 */

// Minimal opaque stand-ins. Events store these as object refs without
// touching their fields.
const fakeWork = { id: 'w1', name: 'Demo Work', slug: 'demo-work' } as any;

describe('agent/events submodule', () => {
    describe('event-name registry (wire-format stability — do not change without spec bump)', () => {
        it('pins each event-name string to the documented value', () => {
            expect(WorkCreatedEvent.EVENT_NAME).toBe('work.created');
            expect(WorkGenerationCompletedEvent.EVENT_NAME).toBe('work.generation.completed');
            expect(WorksConfigSyncRequestedEvent.EVENT_NAME).toBe(
                'work.works_config.sync_requested',
            );
            expect(WorksConfigSyncFailedEvent.EVENT_NAME).toBe('work.works_config.sync_failed');
            expect(DeploymentDispatchedEvent.EVENT_NAME).toBe('deployment.dispatched');
            expect(DeploymentCompletedEvent.EVENT_NAME).toBe('deployment.completed');
            expect(DeploymentFailedEvent.EVENT_NAME).toBe('deployment.failed');
        });

        it('every event-name string is unique', () => {
            const names = [
                WorkCreatedEvent.EVENT_NAME,
                WorkGenerationCompletedEvent.EVENT_NAME,
                WorksConfigSyncRequestedEvent.EVENT_NAME,
                WorksConfigSyncFailedEvent.EVENT_NAME,
                DeploymentDispatchedEvent.EVENT_NAME,
                DeploymentCompletedEvent.EVENT_NAME,
                DeploymentFailedEvent.EVENT_NAME,
            ];
            expect(new Set(names).size).toBe(names.length);
        });

        it('every event-name uses the dotted namespace convention', () => {
            const names = [
                WorkCreatedEvent.EVENT_NAME,
                WorkGenerationCompletedEvent.EVENT_NAME,
                WorksConfigSyncRequestedEvent.EVENT_NAME,
                WorksConfigSyncFailedEvent.EVENT_NAME,
                DeploymentDispatchedEvent.EVENT_NAME,
                DeploymentCompletedEvent.EVENT_NAME,
                DeploymentFailedEvent.EVENT_NAME,
            ];
            for (const name of names) {
                expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
            }
        });
    });

    describe('BaseEvent abstract', () => {
        it('is a class function — direct instantiation is a TS-level constraint', () => {
            expect(typeof BaseEvent).toBe('function');
        });

        it('has a static EVENT_NAME slot reserved (subclasses set it)', () => {
            // The base declares `static EVENT_NAME: string` without a value.
            // Subclasses populate it; the base itself returns undefined.
            expect(BaseEvent.EVENT_NAME).toBeUndefined();
        });

        it('every published event class extends BaseEvent', () => {
            expect(new WorkCreatedEvent(fakeWork)).toBeInstanceOf(BaseEvent);
            expect(new WorkGenerationCompletedEvent(fakeWork)).toBeInstanceOf(BaseEvent);
            expect(
                new WorksConfigSyncRequestedEvent('w', 'u', 'schedule_updated'),
            ).toBeInstanceOf(BaseEvent);
            expect(
                new WorksConfigSyncFailedEvent(
                    'w',
                    'u',
                    'schedule_updated',
                    'org/repo',
                    'boom',
                ),
            ).toBeInstanceOf(BaseEvent);
            const payload: DeploymentEventPayload = {
                work: fakeWork,
                userId: 'u',
                providerId: 'vercel',
                providerName: 'Vercel',
            };
            expect(new DeploymentDispatchedEvent(payload)).toBeInstanceOf(BaseEvent);
            expect(new DeploymentCompletedEvent(payload)).toBeInstanceOf(BaseEvent);
            expect(
                new DeploymentFailedEvent({ ...payload, terminalState: 'ERROR' }),
            ).toBeInstanceOf(BaseEvent);
        });
    });

    describe('WorkCreatedEvent', () => {
        it('captures work as a readonly positional arg', () => {
            const evt = new WorkCreatedEvent(fakeWork);
            expect(evt.work).toBe(fakeWork);
        });
    });

    describe('WorkGenerationCompletedEvent', () => {
        it('captures work as a readonly positional arg', () => {
            const evt = new WorkGenerationCompletedEvent(fakeWork);
            expect(evt.work).toBe(fakeWork);
        });

        it('is distinct from WorkCreatedEvent (different class identity)', () => {
            const created = new WorkCreatedEvent(fakeWork);
            const completed = new WorkGenerationCompletedEvent(fakeWork);
            expect(completed).not.toBeInstanceOf(WorkCreatedEvent);
            expect(created).not.toBeInstanceOf(WorkGenerationCompletedEvent);
        });
    });

    describe('WorksConfigSyncRequestedEvent', () => {
        it('captures workId / userId / reason positionally', () => {
            const evt = new WorksConfigSyncRequestedEvent('w1', 'u1', 'schedule_updated');
            expect(evt.workId).toBe('w1');
            expect(evt.userId).toBe('u1');
            expect(evt.reason).toBe('schedule_updated');
        });

        it('accepts every documented `WorksConfigSyncReason` value', () => {
            const reasons: WorksConfigSyncReason[] = [
                'schedule_updated',
                'schedule_cancelled',
                'provider_changed',
                'pipeline_settings_changed',
            ];
            for (const reason of reasons) {
                const evt = new WorksConfigSyncRequestedEvent('w', 'u', reason);
                expect(evt.reason).toBe(reason);
            }
        });
    });

    describe('WorksConfigSyncFailedEvent', () => {
        it('captures workId / userId / reason / repository / errorMessage positionally', () => {
            const evt = new WorksConfigSyncFailedEvent(
                'w1',
                'u1',
                'provider_changed',
                'org/repo',
                'remote returned 500',
            );
            expect(evt.workId).toBe('w1');
            expect(evt.userId).toBe('u1');
            expect(evt.reason).toBe('provider_changed');
            expect(evt.repository).toBe('org/repo');
            expect(evt.errorMessage).toBe('remote returned 500');
        });

        it('shares the WorksConfigSyncReason union with the *Requested* event', () => {
            // Compile-time + runtime: a value valid for one is valid for the
            // other. If someone forks the union, this test fails first.
            const reason: WorksConfigSyncReason = 'pipeline_settings_changed';
            const requested = new WorksConfigSyncRequestedEvent('w', 'u', reason);
            const failed = new WorksConfigSyncFailedEvent('w', 'u', reason, 'r', 'e');
            expect(requested.reason).toBe(failed.reason);
        });
    });

    describe('Deployment events (Dispatched / Completed / Failed)', () => {
        const basePayload: DeploymentEventPayload = {
            work: fakeWork,
            userId: 'u1',
            providerId: 'vercel',
            providerName: 'Vercel',
        };

        it('DeploymentDispatchedEvent stores the base payload verbatim', () => {
            const evt = new DeploymentDispatchedEvent(basePayload);
            expect(evt.payload).toBe(basePayload);
            expect(evt.payload.work).toBe(fakeWork);
            expect(evt.payload.userId).toBe('u1');
            expect(evt.payload.providerId).toBe('vercel');
            expect(evt.payload.providerName).toBe('Vercel');
        });

        it('DeploymentCompletedEvent extends payload with optional `url`', () => {
            const completedNoUrl = new DeploymentCompletedEvent(basePayload);
            expect(completedNoUrl.payload.url).toBeUndefined();

            const completedWithUrl = new DeploymentCompletedEvent({
                ...basePayload,
                url: 'https://demo.vercel.app',
            });
            expect(completedWithUrl.payload.url).toBe('https://demo.vercel.app');
            expect(completedWithUrl.payload.providerId).toBe('vercel');
        });

        it('DeploymentFailedEvent requires `terminalState` and accepts every documented value', () => {
            const states: Array<'ERROR' | 'TIMEOUT' | 'CANCELED' | 'UNKNOWN'> = [
                'ERROR',
                'TIMEOUT',
                'CANCELED',
                'UNKNOWN',
            ];
            for (const terminalState of states) {
                const evt = new DeploymentFailedEvent({ ...basePayload, terminalState });
                expect(evt.payload.terminalState).toBe(terminalState);
                expect(evt.payload.error).toBeUndefined();
            }
        });

        it('DeploymentFailedEvent carries optional `error` string when supplied', () => {
            const evt = new DeploymentFailedEvent({
                ...basePayload,
                terminalState: 'ERROR',
                error: 'provider timed out polling READY',
            });
            expect(evt.payload.terminalState).toBe('ERROR');
            expect(evt.payload.error).toBe('provider timed out polling READY');
        });

        it('the three deployment classes are distinct (instanceof discriminates them)', () => {
            const dispatched = new DeploymentDispatchedEvent(basePayload);
            const completed = new DeploymentCompletedEvent(basePayload);
            const failed = new DeploymentFailedEvent({ ...basePayload, terminalState: 'ERROR' });
            expect(dispatched).not.toBeInstanceOf(DeploymentCompletedEvent);
            expect(dispatched).not.toBeInstanceOf(DeploymentFailedEvent);
            expect(completed).not.toBeInstanceOf(DeploymentDispatchedEvent);
            expect(completed).not.toBeInstanceOf(DeploymentFailedEvent);
            expect(failed).not.toBeInstanceOf(DeploymentDispatchedEvent);
            expect(failed).not.toBeInstanceOf(DeploymentCompletedEvent);
        });

        it('all three deployment events share the deployment.* event-name prefix', () => {
            for (const name of [
                DeploymentDispatchedEvent.EVENT_NAME,
                DeploymentCompletedEvent.EVENT_NAME,
                DeploymentFailedEvent.EVENT_NAME,
            ]) {
                expect(name.startsWith('deployment.')).toBe(true);
            }
        });
    });

    describe('barrel re-exports', () => {
        it('re-exports BaseEvent', () => {
            expect(eventsBarrel.BaseEvent).toBe(BaseEvent);
        });

        it('re-exports every published event class', () => {
            expect(eventsBarrel.WorkCreatedEvent).toBe(WorkCreatedEvent);
            expect(eventsBarrel.WorkGenerationCompletedEvent).toBe(WorkGenerationCompletedEvent);
            expect(eventsBarrel.WorksConfigSyncRequestedEvent).toBe(
                WorksConfigSyncRequestedEvent,
            );
            expect(eventsBarrel.WorksConfigSyncFailedEvent).toBe(WorksConfigSyncFailedEvent);
            expect(eventsBarrel.DeploymentDispatchedEvent).toBe(DeploymentDispatchedEvent);
            expect(eventsBarrel.DeploymentCompletedEvent).toBe(DeploymentCompletedEvent);
            expect(eventsBarrel.DeploymentFailedEvent).toBe(DeploymentFailedEvent);
        });

        it('exposes exactly the documented runtime symbols (no extras silently appearing)', () => {
            // Type-only exports (interfaces / type aliases) erase at runtime.
            // Adding a runtime export should be a deliberate update to this list.
            const runtimeKeys = Object.keys(eventsBarrel).sort();
            expect(runtimeKeys).toEqual(
                [
                    'BaseEvent',
                    'DeploymentCompletedEvent',
                    'DeploymentDispatchedEvent',
                    'DeploymentFailedEvent',
                    'WorkCreatedEvent',
                    'WorkGenerationCompletedEvent',
                    'WorksConfigSyncFailedEvent',
                    'WorksConfigSyncRequestedEvent',
                ].sort(),
            );
        });
    });
});
