import * as tasksBarrel from '../index';
import { TASKS_BARREL_RUNTIME_SYMBOLS } from '../_tasks-symbols';
import {
    DISPATCHER_SYMBOLS,
    buildJobRuntimeProviders,
    type JobRuntimeProviderRegistry,
    InMemoryJobRuntimeProviderRegistry,
} from '../job-runtime.providers';
import {
    APP_SPEC_EVALUATE_DISPATCHER,
    type AppSpecEvaluateDispatcher,
} from '../app-spec-evaluate-dispatcher';
import type { AppSpecEvaluatePayload } from '../app-spec-evaluate.types';
import {
    APP_SPEC_EVALUATE_JOB_ID,
    APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS,
    AppSpecEvaluatePayloadError,
    hasInProcessFallback,
    parseAppSpecEvaluatePayload,
    runAppSpecEvaluateJob,
} from '../app-works-jobs';

/**
 * APW-03 T13 — the `app-spec-evaluate` dispatcher, its payload and the
 * runtime-neutral handler every provider registers.
 *
 * `tasks.md:316-319` fixes what this spec must prove:
 *
 * > the symbol is `Symbol(...)`, listed in the barrel inventory and in
 * > `DISPATCHER_SYMBOLS`; `tasks.spec.ts` and `job-runtime.providers.spec.ts` pass
 * > after recounting. **Done when**: a `null` dispatch runs the handler
 * > in-process for this job only.
 *
 * So the last case here is the one that matters: `null` means "no runtime is
 * configured — run it now" for this job id, and for no other App Works job (plan
 * §6.1:661-662). The end-to-end half — that `AppSpecService.requestEvaluation`
 * actually runs it and writes the state — is in
 * `app-spec/__tests__/app-spec.service.spec.ts`.
 */
describe('app-works dispatchers (APW-03 T13)', () => {
    const PAYLOAD: AppSpecEvaluatePayload = {
        workId: '11111111-1111-4111-8111-111111111111',
        trigger: 'push',
        tenantId: null,
        organizationId: null,
        providerId: 'github',
        credentialVersion: 2,
    };

    describe('APP_SPEC_EVALUATE_DISPATCHER', () => {
        it('is a process-local Symbol with the documented description', () => {
            expect(typeof APP_SPEC_EVALUATE_DISPATCHER).toBe('symbol');
            expect(APP_SPEC_EVALUATE_DISPATCHER.description).toBe('APP_SPEC_EVALUATE_DISPATCHER');
        });

        it('is NOT registered via Symbol.for (two of the same name must never collide)', () => {
            expect(APP_SPEC_EVALUATE_DISPATCHER).not.toBe(
                Symbol.for('APP_SPEC_EVALUATE_DISPATCHER'),
            );
        });

        it('is the same singleton when re-imported (ESM module-cache pin)', () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const reimported =
                require('../app-spec-evaluate-dispatcher').APP_SPEC_EVALUATE_DISPATCHER;
            expect(reimported).toBe(APP_SPEC_EVALUATE_DISPATCHER);
        });

        it('is re-exported from the barrel and declared in the barrel inventory', () => {
            expect(tasksBarrel.APP_SPEC_EVALUATE_DISPATCHER).toBe(APP_SPEC_EVALUATE_DISPATCHER);
            expect([...TASKS_BARREL_RUNTIME_SYMBOLS]).toContain('APP_SPEC_EVALUATE_DISPATCHER');
        });

        it('is listed in DISPATCHER_SYMBOLS and bound by the provider factory', () => {
            expect([...DISPATCHER_SYMBOLS]).toContain(APP_SPEC_EVALUATE_DISPATCHER);

            const providers = buildJobRuntimeProviders({
                symbols: [APP_SPEC_EVALUATE_DISPATCHER],
            });
            expect(providers).toHaveLength(1);
            expect((providers[0] as { provide: symbol }).provide).toBe(
                APP_SPEC_EVALUATE_DISPATCHER,
            );
        });

        it('resolves the active runtime’s dispatchers view, and null when none is registered', () => {
            const registry: JobRuntimeProviderRegistry = new InMemoryJobRuntimeProviderRegistry();
            const provider = buildJobRuntimeProviders({
                symbols: [APP_SPEC_EVALUATE_DISPATCHER],
            })[0] as { useFactory: (registry: JobRuntimeProviderRegistry) => unknown };

            expect(provider.useFactory(registry)).toBeNull();

            const dispatchers = { dispatchAppSpecEvaluate: jest.fn() };
            registry.register({ dispatchers } as never);
            expect(provider.useFactory(registry)).toBe(dispatchers);
        });

        it('matches the documented `string | null` signature at runtime via a mock impl', async () => {
            const impl: AppSpecEvaluateDispatcher = {
                dispatchAppSpecEvaluate: async () => 'run-7',
            };
            await expect(impl.dispatchAppSpecEvaluate(PAYLOAD)).resolves.toBe('run-7');

            const none: AppSpecEvaluateDispatcher = {
                dispatchAppSpecEvaluate: async () => null,
            };
            await expect(none.dispatchAppSpecEvaluate(PAYLOAD)).resolves.toBeNull();
        });
    });

    describe('the job id and the in-process fallback list', () => {
        it('is the job id plan §6.1:650 fixes', () => {
            expect(APP_SPEC_EVALUATE_JOB_ID).toBe('app-spec-evaluate');
            expect(tasksBarrel.APP_SPEC_EVALUATE_JOB_ID).toBe(APP_SPEC_EVALUATE_JOB_ID);
        });

        it('covers app-spec-evaluate and NOTHING else — "for this job only"', () => {
            // The other three App Works jobs of plan §6.1 record
            // `dispatchUnavailable` in their own services instead; a fourth job
            // joining this list is a deliberate decision, not an accident.
            expect([...APP_WORKS_IN_PROCESS_FALLBACK_JOB_IDS]).toEqual(['app-spec-evaluate']);
            expect(hasInProcessFallback(APP_SPEC_EVALUATE_JOB_ID)).toBe(true);

            for (const sibling of [
                'app-license-evaluate',
                'app-blueprint-apply',
                'apps-catalog-refresh',
                'app-dependency-provision',
                '',
            ]) {
                expect(hasInProcessFallback(sibling)).toBe(false);
            }
        });
    });

    describe('parseAppSpecEvaluatePayload', () => {
        it('accepts the documented payload and normalises the absent binding fields to null', () => {
            expect(
                parseAppSpecEvaluatePayload({ workId: PAYLOAD.workId, trigger: 'manual' }),
            ).toEqual({
                workId: PAYLOAD.workId,
                trigger: 'manual',
                tenantId: null,
                organizationId: null,
                providerId: null,
                credentialVersion: null,
            });
        });

        it('keeps the four EW-742 binding fields when they are present', () => {
            expect(parseAppSpecEvaluatePayload(PAYLOAD)).toEqual(PAYLOAD);
        });

        it('trims the work id but refuses an empty one', () => {
            expect(
                parseAppSpecEvaluatePayload({ workId: `  ${PAYLOAD.workId}  `, trigger: 'push' })
                    .workId,
            ).toBe(PAYLOAD.workId);
            expect(() => parseAppSpecEvaluatePayload({ workId: '   ', trigger: 'push' })).toThrow(
                AppSpecEvaluatePayloadError,
            );
            expect(() => parseAppSpecEvaluatePayload({ trigger: 'push' })).toThrow(
                /Invalid payload\.workId/,
            );
        });

        it('refuses a trigger the state column cannot hold, naming the closed set', () => {
            expect(() =>
                parseAppSpecEvaluatePayload({ workId: PAYLOAD.workId, trigger: 'whenever' }),
            ).toThrow(AppSpecEvaluatePayloadError);
            expect(() =>
                parseAppSpecEvaluatePayload({ workId: PAYLOAD.workId, trigger: 'whenever' }),
            ).toThrow(/Invalid payload\.trigger/);
        });

        it('refuses a payload that is not an object at all', () => {
            expect(() => parseAppSpecEvaluatePayload(null)).toThrow(AppSpecEvaluatePayloadError);
            expect(() => parseAppSpecEvaluatePayload('app-spec-evaluate')).toThrow(
                AppSpecEvaluatePayloadError,
            );
        });
    });

    describe('runAppSpecEvaluateJob', () => {
        it('delegates to the target’s evaluate(workId) and returns its outcome', async () => {
            const evaluate = jest.fn(async () => ({ status: 'evaluated' }));

            const outcome = await runAppSpecEvaluateJob(PAYLOAD, { evaluate });

            expect(evaluate).toHaveBeenCalledTimes(1);
            expect(evaluate).toHaveBeenCalledWith(PAYLOAD.workId);
            expect(outcome).toEqual({ status: 'evaluated' });
        });

        it('refuses a malformed payload BEFORE the target is called', async () => {
            const evaluate = jest.fn(async () => ({ status: 'evaluated' }));

            await expect(
                runAppSpecEvaluateJob({ workId: '', trigger: 'push' }, { evaluate }),
            ).rejects.toThrow(AppSpecEvaluatePayloadError);
            expect(evaluate).not.toHaveBeenCalled();
        });

        it('propagates a target failure rather than reporting a success', async () => {
            const evaluate = jest.fn(async () => {
                throw new Error('store unavailable');
            });

            await expect(runAppSpecEvaluateJob(PAYLOAD, { evaluate })).rejects.toThrow(
                'store unavailable',
            );
        });
    });

    describe('a null dispatch runs the handler here — for this job only', () => {
        /** Exactly what `AppSpecService.dispatchOrRun` does, minus the Nest wiring. */
        async function dispatch(
            payload: AppSpecEvaluatePayload,
            runtime: AppSpecEvaluateDispatcher | null,
            target: { evaluate: (workId: string) => Promise<unknown> },
        ): Promise<{ runId: string | null; ranInProcess: boolean }> {
            if (runtime) {
                const runId = await runtime.dispatchAppSpecEvaluate(payload);
                if (runId) {
                    return { runId, ranInProcess: false };
                }
            }
            if (!hasInProcessFallback(APP_SPEC_EVALUATE_JOB_ID)) {
                return { runId: null, ranInProcess: false };
            }
            await runAppSpecEvaluateJob(payload, target);
            return { runId: null, ranInProcess: true };
        }

        it('runs the handler in-process when the runtime answers null', async () => {
            const evaluate = jest.fn(async () => ({ status: 'evaluated' }));

            const result = await dispatch(
                PAYLOAD,
                { dispatchAppSpecEvaluate: async () => null },
                {
                    evaluate,
                },
            );

            expect(result).toEqual({ runId: null, ranInProcess: true });
            expect(evaluate).toHaveBeenCalledWith(PAYLOAD.workId);
        });

        it('does NOT run the handler when the runtime accepted the job', async () => {
            const evaluate = jest.fn(async () => ({ status: 'evaluated' }));

            const result = await dispatch(
                PAYLOAD,
                { dispatchAppSpecEvaluate: async () => 'run-42' },
                { evaluate },
            );

            expect(result).toEqual({ runId: 'run-42', ranInProcess: false });
            expect(evaluate).not.toHaveBeenCalled();
        });
    });
});
