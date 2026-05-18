import * as tasksBarrel from './index';
import {
    WORK_GENERATION_DISPATCHER,
    type WorkGenerationDispatcher,
} from './work-generation-dispatcher';
import {
    WORK_GENERATION_MODE,
    type WorkGenerationMode,
    type WorkContextResponse,
    type WorkContextUserDto,
    type WorkGenerationPayload,
} from './work-generation.types';
import { WORK_IMPORT_DISPATCHER, type WorkImportDispatcher } from './work-import-dispatcher';
import {
    WorkImportErrorCode,
    type WorkImportPayload,
    type WorkImportMetrics,
    type WorkImportStats,
    type WorkImportResult,
} from './work-import.types';

/**
 * The agent's `tasks` submodule is a contracts-only surface: dispatcher
 * interfaces, DI tokens (`Symbol(...)` — process-local, NOT `Symbol.for`),
 * payload/result types and the `WorkImportErrorCode` enum that downstream
 * NestJS modules in `apps/api` and the Trigger.dev tasks in `packages/tasks`
 * import. Because the wire shape of these payloads + the EXACT enum string
 * literals are persisted in `WorkHistory.errorCode` rows + read by frontend
 * code, this suite pins:
 *   1. DI-symbol identity / description / process-local-ness so DI containers
 *      cannot accidentally collide via `Symbol.for(...)` registry sharing.
 *   2. `WORK_GENERATION_MODE` literal values + key-set + readonly-as-const.
 *   3. Every `WorkImportErrorCode` enum entry — value + uniqueness + count
 *      (so adding/removing one without bumping the spec is a noisy diff).
 *   4. The barrel re-exports everything callers depend on.
 *   5. Light type-level checks that the dispatcher interfaces match the
 *      documented signatures (compile-time + runtime mock implementation).
 *
 * No real Trigger.dev / NestJS / DB activity is exercised — those
 * end-to-end checks live in `packages/tasks/src/services/trigger.service.spec.ts`
 * and the `apps/api/test/` integration suites.
 */
describe('agent/tasks submodule', () => {
    describe('DI tokens (process-local Symbol() — not Symbol.for)', () => {
        it('WORK_GENERATION_DISPATCHER is a Symbol with the documented description', () => {
            expect(typeof WORK_GENERATION_DISPATCHER).toBe('symbol');
            expect(WORK_GENERATION_DISPATCHER.description).toBe('WORK_GENERATION_DISPATCHER');
        });

        it('WORK_IMPORT_DISPATCHER is a Symbol with the documented description', () => {
            expect(typeof WORK_IMPORT_DISPATCHER).toBe('symbol');
            expect(WORK_IMPORT_DISPATCHER.description).toBe('WORK_IMPORT_DISPATCHER');
        });

        it('the two DI symbols are distinct from each other', () => {
            expect(WORK_GENERATION_DISPATCHER).not.toBe(WORK_IMPORT_DISPATCHER);
        });

        it('uses Symbol() — NOT Symbol.for() — so the registry cannot collide', () => {
            // Symbol.for(<key>) is registry-shared; calling it twice with the
            // same key returns the same symbol. Plain Symbol(<desc>) does not.
            // This guards against a future refactor swapping the two and
            // silently breaking DI-token isolation across worker processes.
            expect(WORK_GENERATION_DISPATCHER).not.toBe(Symbol.for('WORK_GENERATION_DISPATCHER'));
            expect(WORK_IMPORT_DISPATCHER).not.toBe(Symbol.for('WORK_IMPORT_DISPATCHER'));
        });

        it('re-importing the module returns the same singleton symbols (ESM module-cache pin)', () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const wgd = require('./work-generation-dispatcher').WORK_GENERATION_DISPATCHER;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const wid = require('./work-import-dispatcher').WORK_IMPORT_DISPATCHER;
            expect(wgd).toBe(WORK_GENERATION_DISPATCHER);
            expect(wid).toBe(WORK_IMPORT_DISPATCHER);
        });
    });

    describe('WORK_GENERATION_MODE constant', () => {
        it('pins both documented modes', () => {
            expect(WORK_GENERATION_MODE.CREATE).toBe('create');
            expect(WORK_GENERATION_MODE.UPDATE).toBe('update');
        });

        it('exposes exactly the two documented keys', () => {
            const keys = Object.keys(WORK_GENERATION_MODE).sort();
            expect(keys).toEqual(['CREATE', 'UPDATE']);
        });

        it('values are unique', () => {
            const values = Object.values(WORK_GENERATION_MODE);
            expect(new Set(values).size).toBe(values.length);
        });

        it('all values are non-empty lowercase strings (matches DB column convention)', () => {
            for (const value of Object.values(WORK_GENERATION_MODE)) {
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
                expect(value).toBe(value.toLowerCase());
            }
        });

        it('is `as const` — runtime + type-level narrowing matches', () => {
            // Without `as const`, TS would widen .CREATE to `string` and
            // `WorkGenerationMode` would degrade to `string`. We rely on
            // narrow string-literal typing in code that reads payloads.
            const mode: WorkGenerationMode = WORK_GENERATION_MODE.CREATE;
            const accepts: 'create' | 'update' = mode;
            expect(accepts).toBe('create');
        });
    });

    describe('WorkImportErrorCode enum', () => {
        it('pins every documented enum value', () => {
            expect(WorkImportErrorCode.INVALID_URL).toBe('INVALID_URL');
            expect(WorkImportErrorCode.REPO_NOT_FOUND).toBe('REPO_NOT_FOUND');
            expect(WorkImportErrorCode.REPO_ACCESS_DENIED).toBe('REPO_ACCESS_DENIED');
            expect(WorkImportErrorCode.UNSUPPORTED_FORMAT).toBe('UNSUPPORTED_FORMAT');
            expect(WorkImportErrorCode.PARSE_FAILED).toBe('PARSE_FAILED');
            expect(WorkImportErrorCode.CLONE_FAILED).toBe('CLONE_FAILED');
            expect(WorkImportErrorCode.CREATE_REPO_FAILED).toBe('CREATE_REPO_FAILED');
            expect(WorkImportErrorCode.GENERATION_FAILED).toBe('GENERATION_FAILED');
            expect(WorkImportErrorCode.ENRICHMENT_FAILED).toBe('ENRICHMENT_FAILED');
            expect(WorkImportErrorCode.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR');
        });

        it('exposes exactly 10 documented members', () => {
            // String enums emit only the named members on the object — no
            // numeric reverse-mapping like numeric enums. This count guards
            // against silent additions/removals.
            const keys = Object.keys(WorkImportErrorCode);
            expect(keys).toHaveLength(10);
        });

        it('every value is unique', () => {
            const values = Object.values(WorkImportErrorCode);
            expect(new Set(values).size).toBe(values.length);
        });

        it('every value is the SCREAMING_SNAKE_CASE form of its key (key === value)', () => {
            for (const [key, value] of Object.entries(WorkImportErrorCode)) {
                expect(key).toBe(value);
            }
        });
    });

    describe('WorkGenerationDispatcher contract', () => {
        it('matches the documented dispatch + cancel signature at runtime via a mock impl', async () => {
            const dispatchMock = jest.fn(async (_p: WorkGenerationPayload) => 'run-123');
            const cancelMock = jest.fn(async (_id: string) => true);
            const impl: WorkGenerationDispatcher = {
                dispatchWorkGeneration: dispatchMock,
                cancelWorkGeneration: cancelMock,
            };

            const payload: WorkGenerationPayload = {
                workId: 'w1',
                userId: 'u1',
                mode: 'create',
                dto: {} as WorkGenerationPayload['dto'],
                historyId: 'h1',
                historyStartedAt: '2026-05-08T00:00:00.000Z',
                triggerSource: 'user',
                scheduleId: undefined,
            };

            await expect(impl.dispatchWorkGeneration(payload)).resolves.toBe('run-123');
            await expect(impl.cancelWorkGeneration('run-123')).resolves.toBe(true);
            expect(dispatchMock).toHaveBeenCalledWith(payload);
            expect(cancelMock).toHaveBeenCalledWith('run-123');
        });

        it('dispatchWorkGeneration may resolve to null (failed/not-triggered branch)', async () => {
            const impl: WorkGenerationDispatcher = {
                dispatchWorkGeneration: async () => null,
                cancelWorkGeneration: async () => false,
            };
            await expect(
                impl.dispatchWorkGeneration({
                    workId: 'w',
                    userId: 'u',
                    mode: 'update',
                    dto: {} as WorkGenerationPayload['dto'],
                    historyId: 'h',
                }),
            ).resolves.toBeNull();
            await expect(impl.cancelWorkGeneration('run')).resolves.toBe(false);
        });
    });

    describe('WorkImportDispatcher contract', () => {
        it('matches the documented dispatch signature at runtime via a mock impl', async () => {
            const dispatchMock = jest.fn(async (_p: WorkImportPayload) => 'import-run-9');
            const impl: WorkImportDispatcher = { dispatchWorkImport: dispatchMock };

            const payload: WorkImportPayload = {
                workId: 'w1',
                userId: 'u1',
                sourceUrl: 'https://github.com/owner/repo',
                sourceOwner: 'owner',
                sourceRepo: 'repo',
                sourceType: 'github' as WorkImportPayload['sourceType'],
                historyId: 'h1',
                triggerSource: 'api',
                options: { createMissingRepos: true, enableSync: false },
            };

            await expect(impl.dispatchWorkImport(payload)).resolves.toBe('import-run-9');
            expect(dispatchMock).toHaveBeenCalledWith(payload);
        });

        it('dispatchWorkImport may resolve to null (failed/not-triggered branch)', async () => {
            const impl: WorkImportDispatcher = { dispatchWorkImport: async () => null };
            await expect(
                impl.dispatchWorkImport({
                    workId: 'w',
                    userId: 'u',
                    sourceUrl: 'https://x',
                    sourceOwner: 'o',
                    sourceRepo: 'r',
                    sourceType: 'github' as WorkImportPayload['sourceType'],
                    historyId: 'h',
                }),
            ).resolves.toBeNull();
        });
    });

    describe('payload/result type shapes (runtime exemplars)', () => {
        it('WorkContextResponse / WorkContextUserDto can be constructed without User.password', () => {
            // WorkContextUserDto = Omit<User, 'password'>. The test-time fake
            // is shaped to look like a User row missing the `password` column —
            // assigning a `password` field would compile-error.
            const user: WorkContextUserDto = {
                id: 'u1',
                email: 'u@example.com',
            } as unknown as WorkContextUserDto;
            const context: WorkContextResponse = {
                work: { id: 'w1', name: 'Work' } as WorkContextResponse['work'],
                user,
                gitToken: 'gho_xxx',
            };
            expect(context.user).toBe(user);
            expect(context.gitToken).toBe('gho_xxx');

            // gitToken is optional
            const contextNoToken: WorkContextResponse = { work: context.work, user };
            expect(contextNoToken.gitToken).toBeUndefined();
        });

        it('WorkImportMetrics / WorkImportStats / WorkImportResult shapes (success + error)', () => {
            const metrics: WorkImportMetrics = { total_tokens_used: 1234, total_cost: 0.0567 };
            const stats: WorkImportStats = {
                newItemsCount: 10,
                updatedItemsCount: 2,
                totalItemsCount: 12,
            };
            const okResult: WorkImportResult = {
                success: true,
                workId: 'w1',
                itemsImported: 10,
                categoriesImported: 1,
                tagsImported: 3,
                metrics,
                stats,
            };
            expect(okResult.success).toBe(true);
            expect(okResult.metrics).toBe(metrics);
            expect(okResult.stats).toBe(stats);

            const errResult: WorkImportResult = {
                success: false,
                workId: 'w1',
                error: 'boom',
                errorCode: WorkImportErrorCode.PARSE_FAILED,
            };
            expect(errResult.success).toBe(false);
            expect(errResult.errorCode).toBe('PARSE_FAILED');
        });

        it('WorkGenerationPayload `mode` field is constrained to the WORK_GENERATION_MODE values', () => {
            // Compile-time + runtime: only 'create' / 'update' should be assignable.
            const create: WorkGenerationPayload['mode'] = WORK_GENERATION_MODE.CREATE;
            const update: WorkGenerationPayload['mode'] = WORK_GENERATION_MODE.UPDATE;
            expect(create).toBe('create');
            expect(update).toBe('update');
        });
    });

    describe('barrel re-exports', () => {
        it('re-exports both DI tokens', () => {
            expect(tasksBarrel.WORK_GENERATION_DISPATCHER).toBe(WORK_GENERATION_DISPATCHER);
            expect(tasksBarrel.WORK_IMPORT_DISPATCHER).toBe(WORK_IMPORT_DISPATCHER);
        });

        it('re-exports the WORK_GENERATION_MODE constant', () => {
            expect(tasksBarrel.WORK_GENERATION_MODE).toBe(WORK_GENERATION_MODE);
        });

        it('re-exports the WorkImportErrorCode enum', () => {
            expect(tasksBarrel.WorkImportErrorCode).toBe(WorkImportErrorCode);
        });

        it('exposes the documented runtime symbols (no extras silently appearing)', () => {
            // Type-only exports (interfaces / types) erase at runtime so they
            // do not appear here. Anyone adding a new runtime export should
            // update this allow-list deliberately.
            const runtimeKeys = Object.keys(tasksBarrel).sort();
            expect(runtimeKeys).toEqual(
                [
                    'TEMPLATE_CUSTOMIZATION_DISPATCHER',
                    'WORK_GENERATION_DISPATCHER',
                    'WORK_GENERATION_MODE',
                    'WORK_IMPORT_DISPATCHER',
                    'WorkImportErrorCode',
                ].sort(),
            );
        });
    });
});
