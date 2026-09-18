import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { APP_ENV_SPEC_APPLIED_EVENT, AppEnvListener } from '../../app-env/app-env.listener';
import { AppEnvService } from '../../app-env/app-env.service';
import { AppDependenciesService } from '../../app-dependencies/app-dependencies.service';
import * as eventsBarrel from '../index';
import { AppSpecAppliedEvent, type AppSpecAppliedPayload } from '../app-spec-applied.event';
/**
 * APW-03 T12/T13 — `AppSpecAppliedEvent`, and the seam that makes APW-07 T15
 * provable end to end.
 *
 * Everything else in this programme's App Works work can be verified slice by
 * slice; the emit side of `app.spec.applied` cannot. APW-07 T15's listener
 * (`packages/agent/src/app-env/app-env.listener.ts`) shipped while this file did
 * not exist, subscribing through its own documented **provisional** constant, and
 * its spec can only prove that it answers a string it defines itself. This spec
 * closes that: the real event class is emitted on a real `EventEmitter2`, through
 * a real Nest module, and the real listener handles it.
 *
 * Four things are pinned here, each one a way the two halves can drift apart:
 *
 * | Pin | Failure it prevents |
 * | --- | ------------------- |
 * | `EVENT_NAME` is the literal `'app.spec.applied'` | a typo silently disconnects emitter from subscriber |
 * | `EVENT_NAME === APP_ENV_SPEC_APPLIED_EVENT` (T15's constant) | the two epics publishing two names for one event |
 * | the payload carries exactly `{ workId, commitSha, previousCommitSha, specHash, addedDependencies, changedEnvNames, changedBlocks }` | APW-05/06/07/08 destructuring a field that moved |
 * | a real `AppSpecAppliedEvent` reaches `AppEnvListener.handleAppSpecApplied` | "the listener is wired" being a claim, not a fact |
 */
describe('AppSpecAppliedEvent (APW-03 T12/T13 — the app.spec.applied seam)', () => {
    const WORK = '11111111-1111-4111-8111-111111111111';

    const PAYLOAD: AppSpecAppliedPayload = {
        workId: WORK,
        commitSha: 'a'.repeat(40),
        previousCommitSha: 'b'.repeat(40),
        specHash: 'c'.repeat(64),
        addedDependencies: ['postgres'],
        changedEnvNames: ['DATABASE_URL'],
        changedBlocks: ['build', 'env'],
    };

    describe('the wire name', () => {
        it('is the literal APW-03’s task text fixes', () => {
            expect(AppSpecAppliedEvent.EVENT_NAME).toBe('app.spec.applied');
        });

        it('is byte-identical to APW-07 T15’s provisional constant', () => {
            // The two-line swap on T15's side changes which expression is passed to
            // `@OnEvent`, never what it evaluates to. This assertion is what makes
            // that swap safe: if either side ever changes its spelling, one of the
            // two epics stops receiving the event and this line goes red first.
            expect(AppSpecAppliedEvent.EVENT_NAME).toBe(APP_ENV_SPEC_APPLIED_EVENT);
        });

        it('is exported from the events barrel', () => {
            expect(Object.keys(eventsBarrel)).toContain('AppSpecAppliedEvent');
            expect(eventsBarrel.AppSpecAppliedEvent).toBe(AppSpecAppliedEvent);
        });
    });

    describe('the payload', () => {
        it('carries the contract’s seven fields, by name, and nothing else', () => {
            const event = new AppSpecAppliedEvent(PAYLOAD);

            // CONTRACTS.md:327 / tasks.md:101-103 — the exact field set.
            expect(Object.keys(event.toPayload()).sort()).toEqual([
                'addedDependencies',
                'changedBlocks',
                'changedEnvNames',
                'commitSha',
                'previousCommitSha',
                'specHash',
                'workId',
            ]);
            expect(event.toPayload()).toEqual(PAYLOAD);
        });

        it('exposes every field as a property, so a subscriber can read `event.workId`', () => {
            const event = new AppSpecAppliedEvent(PAYLOAD);

            expect(event.workId).toBe(WORK);
            expect(event.commitSha).toBe(PAYLOAD.commitSha);
            expect(event.previousCommitSha).toBe(PAYLOAD.previousCommitSha);
            expect(event.specHash).toBe(PAYLOAD.specHash);
            expect(event.addedDependencies).toEqual(['postgres']);
            expect(event.changedEnvNames).toEqual(['DATABASE_URL']);
            expect(event.changedBlocks).toEqual(['build', 'env']);
        });

        it('defaults every collection rather than leaving it undefined', () => {
            const event = new AppSpecAppliedEvent({ workId: WORK } as AppSpecAppliedPayload);

            expect(event.commitSha).toBe('');
            expect(event.previousCommitSha).toBeNull();
            expect(event.specHash).toBe('');
            expect(event.addedDependencies).toEqual([]);
            expect(event.changedEnvNames).toEqual([]);
            expect(event.changedBlocks).toEqual([]);
        });

        it('carries names and hashes only — no value of any env entry (R8)', () => {
            const serialised = JSON.stringify(new AppSpecAppliedEvent(PAYLOAD).toPayload());

            expect(serialised).toContain('DATABASE_URL');
            expect(serialised).not.toContain('secret');
            expect(serialised).not.toContain('password');
        });
    });

    describe('the seam, through the framework — the real listener receives it', () => {
        it('reaches AppEnvListener.handleAppSpecApplied when the event class is emitted', async () => {
            const ensureGenerated = jest.fn(async () => ({ created: [], existing: [] }));
            const reconcile = jest.fn(async () => ({ kinds: [], refused: null }));
            const moduleRef = await Test.createTestingModule({
                imports: [EventEmitterModule.forRoot()],
                // A PROVIDER, because that is what Nest scans for `@OnEvent` metadata.
                providers: [
                    AppEnvListener,
                    { provide: AppEnvService, useValue: { ensureGenerated } },
                    { provide: AppDependenciesService, useValue: { reconcile } },
                ],
            }).compile();
            await moduleRef.init();

            try {
                const emitter = moduleRef.get(EventEmitter2);

                // The handler is `async: true`, so the emit returns true and the work
                // lands on the next turn of the loop.
                expect(
                    emitter.emit(AppSpecAppliedEvent.EVENT_NAME, new AppSpecAppliedEvent(PAYLOAD)),
                ).toBe(true);

                await waitFor(() => reconcile.mock.calls.length > 0);
                expect(ensureGenerated).toHaveBeenCalledWith(WORK);
                expect(reconcile).toHaveBeenCalledWith(WORK);
            } finally {
                await moduleRef.close();
            }
        });

        it('does not reach it for a neighbouring App-spec event name', async () => {
            const ensureGenerated = jest.fn(async () => ({ created: [], existing: [] }));
            const reconcile = jest.fn(async () => ({ kinds: [], refused: null }));
            const moduleRef = await Test.createTestingModule({
                imports: [EventEmitterModule.forRoot()],
                providers: [
                    AppEnvListener,
                    { provide: AppEnvService, useValue: { ensureGenerated } },
                    { provide: AppDependenciesService, useValue: { reconcile } },
                ],
            }).compile();
            await moduleRef.init();

            try {
                const emitter = moduleRef.get(EventEmitter2);
                // `app.spec.validated` is APW-03's own, different event: nothing is
                // generated and nothing reconciled by a name this listener does not own.
                expect(emitter.emit('app.spec.validated', new AppSpecAppliedEvent(PAYLOAD))).toBe(
                    false,
                );
                await new Promise((resolve) => setImmediate(resolve));
                expect(ensureGenerated).not.toHaveBeenCalled();
                expect(reconcile).not.toHaveBeenCalled();
            } finally {
                await moduleRef.close();
            }
        });
    });
});

/** Wait for a condition the framework's own async handler sets, with a bound. */
async function waitFor(condition: () => boolean, attempts = 50): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
}
