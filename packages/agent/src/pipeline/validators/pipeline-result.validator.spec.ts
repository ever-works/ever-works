import { validatePipelineResult, validatePipelineResultOrThrow } from './pipeline-result.validator';

const buildValidResult = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    outputs: {
        items: [],
        categories: [],
        tags: [],
        collections: [],
        brands: [],
    },
    stepsCompleted: 0,
    totalSteps: 0,
    state: {
        isRunning: false,
        isCancelled: false,
        completedSteps: [],
        failedSteps: [],
    },
    duration: 0,
    ...overrides,
});

describe('validatePipelineResult', () => {
    describe('top-level guards', () => {
        it('rejects null with a single "must be an object" error and short-circuits', () => {
            const v = validatePipelineResult(null);
            expect(v.valid).toBe(false);
            expect(v.errors).toEqual(['Result must be an object']);
            expect(v.result).toBeUndefined();
        });

        it('rejects undefined with the same single error', () => {
            const v = validatePipelineResult(undefined);
            expect(v.valid).toBe(false);
            expect(v.errors).toEqual(['Result must be an object']);
            expect(v.result).toBeUndefined();
        });

        it('rejects primitives (string/number/boolean) with the same single error', () => {
            for (const value of ['hello', 42, true, false, 0, '']) {
                const v = validatePipelineResult(value);
                expect(v.valid).toBe(false);
                expect(v.errors).toEqual(['Result must be an object']);
            }
        });

        it('does NOT reject arrays at the top-level guard (typeof [] === "object") — they fall through to per-field validation', () => {
            const v = validatePipelineResult([]);
            expect(v.valid).toBe(false);
            // Top-level guard does NOT fire because typeof [] === 'object' and [] !== null.
            // Instead, every per-field check runs and reports a missing field.
            expect(v.errors).not.toContain('Result must be an object');
            // success/outputs/stepsCompleted/totalSteps/duration all missing → 5 errors.
            expect(v.errors).toEqual(
                expect.arrayContaining([
                    'Missing or invalid "success" field (expected boolean)',
                    'Missing or invalid "outputs" field (expected object)',
                    'Missing or invalid "stepsCompleted" field (expected number)',
                    'Missing or invalid "totalSteps" field (expected number)',
                    'Missing or invalid "duration" field (expected number)',
                ]),
            );
        });
    });

    describe('happy path', () => {
        it('returns valid with empty errors and the original result reference for a fully-populated payload', () => {
            const payload = buildValidResult();
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
            expect(v.errors).toEqual([]);
            // The function returns the input by identity on success — pinned so a
            // future "always clone" refactor breaks loudly.
            expect(v.result).toBe(payload);
        });

        it('accepts state omitted entirely (state is optional)', () => {
            const payload = buildValidResult();
            delete (payload as Record<string, unknown>).state;
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
            expect(v.errors).toEqual([]);
        });

        it('accepts an Error instance for "error"', () => {
            const payload = buildValidResult({ error: new Error('boom') });
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
            expect(v.errors).toEqual([]);
        });

        it('accepts a string for "error"', () => {
            const payload = buildValidResult({ error: 'something went wrong' });
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
            expect(v.errors).toEqual([]);
        });

        it('accepts a string for "failedStep"', () => {
            const payload = buildValidResult({ failedStep: 'step-3' });
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
            expect(v.errors).toEqual([]);
        });
    });

    describe('"success" field', () => {
        it('rejects missing success with the documented message', () => {
            const payload = buildValidResult();
            delete (payload as Record<string, unknown>).success;
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(false);
            expect(v.errors).toContain('Missing or invalid "success" field (expected boolean)');
        });

        it('rejects non-boolean success (string)', () => {
            const v = validatePipelineResult(buildValidResult({ success: 'true' }));
            expect(v.errors).toContain('Missing or invalid "success" field (expected boolean)');
        });

        it('rejects non-boolean success (number 0/1 — strict typeof check)', () => {
            // Pin the strict-typeof contract: `1` and `0` are NOT coerced to boolean.
            expect(validatePipelineResult(buildValidResult({ success: 1 })).valid).toBe(false);
            expect(validatePipelineResult(buildValidResult({ success: 0 })).valid).toBe(false);
        });

        it('accepts both true and false as valid', () => {
            expect(validatePipelineResult(buildValidResult({ success: true })).valid).toBe(true);
            expect(validatePipelineResult(buildValidResult({ success: false })).valid).toBe(true);
        });
    });

    describe('"outputs" field', () => {
        it('rejects missing outputs with the documented message AND skips per-array checks', () => {
            const payload = buildValidResult();
            delete (payload as Record<string, unknown>).outputs;
            const v = validatePipelineResult(payload);
            expect(v.errors).toContain('Missing or invalid "outputs" field (expected object)');
            // Per-array checks are inside the else branch so they MUST NOT run when outputs is missing.
            expect(v.errors).not.toContain(
                'Missing or invalid "outputs.items" field (expected array)',
            );
        });

        it('rejects null outputs (typeof null === "object" but the explicit `=== null` guard fires)', () => {
            const v = validatePipelineResult(buildValidResult({ outputs: null }));
            expect(v.errors).toContain('Missing or invalid "outputs" field (expected object)');
            expect(v.errors).not.toContain(
                'Missing or invalid "outputs.items" field (expected array)',
            );
        });

        it('rejects non-object outputs (string)', () => {
            const v = validatePipelineResult(buildValidResult({ outputs: 'oops' }));
            expect(v.errors).toContain('Missing or invalid "outputs" field (expected object)');
        });

        it.each([
            ['items', 'Missing or invalid "outputs.items" field (expected array)'],
            ['categories', 'Missing or invalid "outputs.categories" field (expected array)'],
            ['tags', 'Missing or invalid "outputs.tags" field (expected array)'],
            ['collections', 'Missing or invalid "outputs.collections" field (expected array)'],
            ['brands', 'Missing or invalid "outputs.brands" field (expected array)'],
        ])('flags missing outputs.%s with the documented message', (field, message) => {
            const payload = buildValidResult();
            delete (payload.outputs as Record<string, unknown>)[field];
            const v = validatePipelineResult(payload);
            expect(v.errors).toContain(message);
        });

        it.each([['items'], ['categories'], ['tags'], ['collections'], ['brands']])(
            'flags non-array outputs.%s (object substituted)',
            (field) => {
                const payload = buildValidResult();
                (payload.outputs as Record<string, unknown>)[field] = { not: 'an array' };
                const v = validatePipelineResult(payload);
                expect(v.errors).toContain(
                    `Missing or invalid "outputs.${field}" field (expected array)`,
                );
            },
        );

        it('reports ALL five outputs.* errors when every array is missing (no early-exit)', () => {
            const payload = buildValidResult({ outputs: {} });
            const v = validatePipelineResult(payload);
            expect(v.errors).toEqual(
                expect.arrayContaining([
                    'Missing or invalid "outputs.items" field (expected array)',
                    'Missing or invalid "outputs.categories" field (expected array)',
                    'Missing or invalid "outputs.tags" field (expected array)',
                    'Missing or invalid "outputs.collections" field (expected array)',
                    'Missing or invalid "outputs.brands" field (expected array)',
                ]),
            );
        });

        it('accepts populated arrays inside outputs.*', () => {
            const payload = buildValidResult({
                outputs: {
                    items: [{ id: 'a' }],
                    categories: ['c1'],
                    tags: ['t1', 't2'],
                    collections: [{}],
                    brands: [],
                },
            });
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
        });
    });

    describe('"stepsCompleted" / "totalSteps" / "duration"', () => {
        it.each([
            ['stepsCompleted', 'Missing or invalid "stepsCompleted" field (expected number)'],
            ['totalSteps', 'Missing or invalid "totalSteps" field (expected number)'],
            ['duration', 'Missing or invalid "duration" field (expected number)'],
        ])('rejects missing %s', (field, message) => {
            const payload = buildValidResult();
            delete (payload as Record<string, unknown>)[field];
            const v = validatePipelineResult(payload);
            expect(v.errors).toContain(message);
        });

        it('accepts NaN for numeric fields (typeof NaN === "number") — pinned so a Number.isFinite tightening would be deliberate', () => {
            // Documents the current contract: NaN slips through because `typeof NaN === 'number'`.
            const v = validatePipelineResult(buildValidResult({ stepsCompleted: NaN }));
            expect(v.valid).toBe(true);
        });

        it('accepts negative numbers (no range check by design)', () => {
            const v = validatePipelineResult(
                buildValidResult({ stepsCompleted: -5, totalSteps: -1, duration: -10 }),
            );
            expect(v.valid).toBe(true);
        });

        it('rejects string-shaped numeric fields', () => {
            const v = validatePipelineResult(buildValidResult({ duration: '100' }));
            expect(v.errors).toContain('Missing or invalid "duration" field (expected number)');
        });
    });

    describe('"state" field', () => {
        it('flags "state" provided but non-object (string)', () => {
            const v = validatePipelineResult(buildValidResult({ state: 'oops' }));
            expect(v.errors).toContain('Invalid "state" field (expected object)');
        });

        it('flags "state" provided but null (the inner branch swallows it via the `=== null` guard)', () => {
            // typeof null === 'object' but the explicit `r.state !== null` short-circuit fires at the
            // OUTER guard, so this lands in the "Invalid state field" branch — NOT the inner branch.
            const v = validatePipelineResult(buildValidResult({ state: null }));
            expect(v.errors).toContain('Invalid "state" field (expected object)');
            // Inner per-field errors must NOT have run.
            expect(v.errors).not.toContain(
                'Missing or invalid "state.isRunning" field (expected boolean)',
            );
        });

        it('does NOT flag state when omitted entirely (it is optional)', () => {
            const payload = buildValidResult();
            delete (payload as Record<string, unknown>).state;
            const v = validatePipelineResult(payload);
            expect(v.errors).not.toContain('Invalid "state" field (expected object)');
            expect(v.errors).not.toContain(
                'Missing or invalid "state.isRunning" field (expected boolean)',
            );
        });

        it.each([
            ['isRunning', 'Missing or invalid "state.isRunning" field (expected boolean)', true],
            [
                'isCancelled',
                'Missing or invalid "state.isCancelled" field (expected boolean)',
                true,
            ],
            [
                'completedSteps',
                'Missing or invalid "state.completedSteps" field (expected array)',
                false,
            ],
            ['failedSteps', 'Missing or invalid "state.failedSteps" field (expected array)', false],
        ])('flags missing state.%s', (field, message) => {
            const payload = buildValidResult();
            delete (payload.state as Record<string, unknown>)[field];
            const v = validatePipelineResult(payload);
            expect(v.errors).toContain(message);
        });

        it('flags non-boolean state.isRunning / isCancelled', () => {
            const payload = buildValidResult({
                state: {
                    isRunning: 'no',
                    isCancelled: 1,
                    completedSteps: [],
                    failedSteps: [],
                },
            });
            const v = validatePipelineResult(payload);
            expect(v.errors).toContain(
                'Missing or invalid "state.isRunning" field (expected boolean)',
            );
            expect(v.errors).toContain(
                'Missing or invalid "state.isCancelled" field (expected boolean)',
            );
        });

        it('flags non-array state.completedSteps / failedSteps', () => {
            const payload = buildValidResult({
                state: {
                    isRunning: false,
                    isCancelled: false,
                    completedSteps: { 0: 'a' },
                    failedSteps: 'oops',
                },
            });
            const v = validatePipelineResult(payload);
            expect(v.errors).toContain(
                'Missing or invalid "state.completedSteps" field (expected array)',
            );
            expect(v.errors).toContain(
                'Missing or invalid "state.failedSteps" field (expected array)',
            );
        });

        it('accepts state with extra fields (the validator ignores unknown keys)', () => {
            const payload = buildValidResult({
                state: {
                    isRunning: false,
                    isCancelled: true,
                    completedSteps: ['s1'],
                    failedSteps: [],
                    extraKey: 'tolerated',
                },
            });
            const v = validatePipelineResult(payload);
            expect(v.valid).toBe(true);
        });
    });

    describe('"error" field', () => {
        it('does NOT flag error when omitted entirely', () => {
            const payload = buildValidResult();
            const v = validatePipelineResult(payload);
            expect(v.errors).not.toContain('Invalid "error" field (expected string or Error)');
        });

        it('flags error when provided as number', () => {
            const v = validatePipelineResult(buildValidResult({ error: 42 }));
            expect(v.errors).toContain('Invalid "error" field (expected string or Error)');
        });

        it('flags error when provided as plain object (not an Error instance)', () => {
            const v = validatePipelineResult(buildValidResult({ error: { message: 'boom' } }));
            expect(v.errors).toContain('Invalid "error" field (expected string or Error)');
        });

        it('accepts error subclasses (TypeError instanceof Error)', () => {
            const v = validatePipelineResult(buildValidResult({ error: new TypeError('boom') }));
            expect(v.valid).toBe(true);
        });

        it('flags error when null is passed (null is not undefined, not Error, not string)', () => {
            // The check is `!== undefined && typeof !== 'string' && !(instanceof Error)`, so null fires.
            const v = validatePipelineResult(buildValidResult({ error: null }));
            expect(v.errors).toContain('Invalid "error" field (expected string or Error)');
        });
    });

    describe('"failedStep" field', () => {
        it('does NOT flag failedStep when omitted entirely', () => {
            const v = validatePipelineResult(buildValidResult());
            expect(v.errors).not.toContain('Invalid "failedStep" field (expected string)');
        });

        it('flags non-string failedStep (number)', () => {
            const v = validatePipelineResult(buildValidResult({ failedStep: 3 }));
            expect(v.errors).toContain('Invalid "failedStep" field (expected string)');
        });

        it('flags failedStep when null is passed (null !== undefined and typeof null !== "string")', () => {
            const v = validatePipelineResult(buildValidResult({ failedStep: null }));
            expect(v.errors).toContain('Invalid "failedStep" field (expected string)');
        });

        it('accepts an empty string for failedStep', () => {
            const v = validatePipelineResult(buildValidResult({ failedStep: '' }));
            expect(v.valid).toBe(true);
        });
    });

    describe('return shape', () => {
        it('returns result === undefined when invalid (errors present)', () => {
            const v = validatePipelineResult({ success: 'oops' });
            expect(v.valid).toBe(false);
            expect(v.result).toBeUndefined();
        });

        it('aggregates ALL errors instead of stopping at the first one', () => {
            // Provide a mostly-empty payload to trigger many independent error branches simultaneously.
            const v = validatePipelineResult({});
            expect(v.valid).toBe(false);
            // Five top-level errors must all show up: success, outputs, stepsCompleted, totalSteps, duration.
            expect(v.errors.length).toBeGreaterThanOrEqual(5);
        });

        it('keeps errors[] empty for a fully-valid payload', () => {
            const v = validatePipelineResult(buildValidResult());
            expect(v.errors).toEqual([]);
        });
    });
});

describe('validatePipelineResultOrThrow', () => {
    it('returns the validated result when valid', () => {
        const payload = buildValidResult();
        const result = validatePipelineResultOrThrow(payload);
        expect(result).toBe(payload);
    });

    it('throws with the documented prefix and joined errors when invalid', () => {
        expect(() => validatePipelineResultOrThrow({ success: 'oops' })).toThrow(
            /^Invalid pipeline result: /,
        );
    });

    it('joins multiple errors with "; " in the thrown message', () => {
        let thrown: Error | undefined;
        try {
            validatePipelineResultOrThrow({});
        } catch (err) {
            thrown = err as Error;
        }
        expect(thrown).toBeInstanceOf(Error);
        // The thrown message contains a `; `-joined error list.
        expect(thrown!.message).toContain('Invalid pipeline result: ');
        expect(thrown!.message).toContain('; ');
        // It contains at least one of the documented per-field messages.
        expect(thrown!.message).toContain('"success" field');
    });

    it('embeds the plugin id in the message when provided', () => {
        expect(() => validatePipelineResultOrThrow(null, 'standard-pipeline')).toThrow(
            "Invalid pipeline result from plugin 'standard-pipeline': Result must be an object",
        );
    });

    it('omits the plugin id segment when pluginId is undefined', () => {
        expect(() => validatePipelineResultOrThrow(null)).toThrow(
            'Invalid pipeline result: Result must be an object',
        );
    });

    it('omits the plugin id segment when pluginId is the empty string (falsy)', () => {
        // The source uses `pluginId ? ... : ''`, so an empty string is treated like undefined.
        expect(() => validatePipelineResultOrThrow(null, '')).toThrow(
            'Invalid pipeline result: Result must be an object',
        );
    });

    it('does NOT throw for an otherwise-invalid payload that is rescued by the optional fields being absent', () => {
        // Specifically: a payload missing only optional fields like `state` is still valid.
        const payload = buildValidResult();
        delete (payload as Record<string, unknown>).state;
        expect(() => validatePipelineResultOrThrow(payload)).not.toThrow();
    });

    it('returns the same identity passed in on the success path (no clone)', () => {
        const payload = buildValidResult();
        expect(validatePipelineResultOrThrow(payload)).toBe(payload);
    });
});
