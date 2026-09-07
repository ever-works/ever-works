import { FleetJobCompletedEvent } from '@ever-works/agent/events';
import type { FleetJobView } from '@ever-works/contracts';
import { ReleaseVerificationListener } from './release-verification.listener';

/**
 * Post-deploy verification (self-build slice AJ, EW-809) — the TRUST
 * BOUNDARY.
 *
 * `FleetJobCompletedEvent.result` is whatever a node PUT on
 * `POST /api/fleet/jobs/:id/complete` — untrusted data from somebody's PC
 * — and this listener is the single place it becomes the boolean the
 * verification state machine acts on. Get it wrong in the permissive
 * direction and a human is told a broken production deployment is healthy,
 * or a failure is "confirmed" that never happened.
 *
 * So the shape of this file is a long list of things that are NOT a pass.
 */
describe('ReleaseVerificationListener', () => {
    function build() {
        const verification = { onBrowserCheckCompleted: jest.fn().mockResolvedValue(undefined) };
        return {
            listener: new ReleaseVerificationListener(verification as never),
            verification,
        };
    }

    function job(overrides: Partial<FleetJobView> = {}): FleetJobView {
        return {
            id: 'job-1',
            kind: 'browser-check',
            status: 'done',
            nodeId: 'node-1',
            requiredCapabilities: ['browser'],
            payload: { url: 'https://api.ever.works/api/version' },
            leaseExpiresAt: null,
            attempts: 1,
            maxAttempts: 1,
            createdAt: null,
            startedAt: null,
            completedAt: null,
            leaseGeneration: 1,
            ...overrides,
        } as FleetJobView;
    }

    function event(
        overrides: {
            job?: Partial<FleetJobView>;
            result?: Record<string, unknown> | null;
            error?: string | null;
            source?: 'node-report' | 'lease-exhausted' | 'cancelled' | 'queue-expired';
        } = {},
    ): FleetJobCompletedEvent {
        return new FleetJobCompletedEvent(
            job(overrides.job),
            'user-1',
            overrides.source ?? 'node-report',
            'node-1',
            overrides.result ?? null,
            overrides.error ?? null,
        );
    }

    /** What `ok` the listener derived, for one event. */
    async function verdictFor(e: FleetJobCompletedEvent): Promise<boolean | 'not-called'> {
        const { listener, verification } = build();
        await listener.onCompleted(e);
        if (verification.onBrowserCheckCompleted.mock.calls.length === 0) return 'not-called';
        return verification.onBrowserCheckCompleted.mock.calls[0][1] as boolean;
    }

    describe('what it looks at', () => {
        it('ignores every job kind but browser-check', async () => {
            for (const kind of ['agent-task', 'acceptance-checks'] as const) {
                expect(await verdictFor(event({ job: { kind } }))).toBe('not-called');
            }
        });

        it('routes a browser-check by its JOB ID, not by anything in the payload', async () => {
            // The promotion row is what points at the job; the payload is an
            // echo of what we sent and proves nothing about whose check it is.
            const { listener, verification } = build();

            await listener.onCompleted(event({ job: { id: 'job-77' }, result: { ok: true } }));

            expect(verification.onBrowserCheckCompleted).toHaveBeenCalledTimes(1);
            expect(verification.onBrowserCheckCompleted.mock.calls[0][0]).toBe('job-77');
        });
    });

    describe('what counts as a pass', () => {
        it('passes on a done job whose executor said ok', async () => {
            expect(
                await verdictFor(
                    event({ result: { ok: true, domBytes: 4096, title: 'Ever Works' } }),
                ),
            ).toBe(true);
        });

        it.each([
            ['ok is false', { ok: false }],
            ['ok is absent', { domBytes: 4096 }],
            ['ok is the STRING "true"', { ok: 'true' }],
            ['ok is the number 1', { ok: 1 }],
            ['ok is an object', { ok: {} }],
            ['ok is null', { ok: null }],
            ['the result is empty', {}],
        ])('is NOT a pass when %s', async (_label, result) => {
            // Strict `=== true`. Every coercion here would be a node
            // talking a green verdict out of the platform.
            expect(await verdictFor(event({ result: result as never }))).toBe(false);
        });

        it('is NOT a pass when the job settled with no result at all', async () => {
            expect(await verdictFor(event({ result: null }))).toBe(false);
        });

        it('is NOT a pass when the job FAILED, whatever the result says', async () => {
            // A node can report `ok: true` on a failed job. The job status
            // is the platform's own record and wins.
            expect(
                await verdictFor(
                    event({ job: { status: 'failed' }, result: { ok: true }, error: 'boom' }),
                ),
            ).toBe(false);
        });

        it.each([
            ['the lease was exhausted', 'lease-exhausted' as const],
            ['an operator cancelled it', 'cancelled' as const],
            ['the queue SLA expired it — no browser node ever took it', 'queue-expired' as const],
        ])('is NOT a pass when %s', async (_label, source) => {
            // Three ways a check can fail to HAPPEN. Each has to reach the
            // state machine, or a verification hangs until its deadline for
            // a reason nobody recorded — and none of them is evidence that
            // the deployment is fine.
            expect(
                await verdictFor(
                    event({ job: { status: 'failed' }, source, error: 'queued-max-age-exceeded' }),
                ),
            ).toBe(false);
        });
    });

    describe('the reading it passes on', () => {
        it('quotes the node error when there is one', async () => {
            const { listener, verification } = build();

            await listener.onCompleted(
                event({ job: { status: 'failed' }, error: 'No executor registered' }),
            );

            expect(verification.onBrowserCheckCompleted.mock.calls[0][2]).toContain(
                'No executor registered',
            );
        });

        it('describes a failed check with the executor’s own reason', async () => {
            const { listener, verification } = build();

            await listener.onCompleted(
                event({ result: { ok: false, error: 'expected text not found in DOM' } }),
            );

            expect(verification.onBrowserCheckCompleted.mock.calls[0][2]).toContain(
                'expected text not found in DOM',
            );
        });

        it('says so plainly when a job settled with nothing to read', async () => {
            const { listener, verification } = build();

            await listener.onCompleted(event({ result: null, source: 'lease-exhausted' }));

            expect(verification.onBrowserCheckCompleted.mock.calls[0][2]).toMatch(/no result/i);
        });
    });

    it('never throws out of the event handler', async () => {
        // An emitter has no caller to report to, and an unhandled rejection
        // in a Nest event handler takes the process down.
        const { listener, verification } = build();
        verification.onBrowserCheckCompleted.mockRejectedValue(new Error('database down'));

        await expect(
            listener.onCompleted(event({ result: { ok: true } })),
        ).resolves.toBeUndefined();
    });

    it('survives a malformed event with no job', async () => {
        const { listener, verification } = build();

        await expect(
            listener.onCompleted({ job: null } as unknown as FleetJobCompletedEvent),
        ).resolves.toBeUndefined();
        expect(verification.onBrowserCheckCompleted).not.toHaveBeenCalled();
    });
});
