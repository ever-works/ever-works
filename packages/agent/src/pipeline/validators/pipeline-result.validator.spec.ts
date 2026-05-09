import { validatePipelineResult, validatePipelineResultOrThrow } from './pipeline-result.validator';

function buildValidResult(overrides: Record<string, unknown> = {}) {
    return {
        success: true,
        outputs: {
            items: [],
            categories: [],
            tags: [],
            collections: [],
            brands: [],
        },
        stepsCompleted: 3,
        totalSteps: 5,
        state: {
            isRunning: false,
            isCancelled: false,
            completedSteps: [],
            failedSteps: [],
        },
        duration: 1234,
        ...overrides,
    };
}

describe('validatePipelineResult', () => {
    describe('non-object inputs', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
            ['number', 42],
            ['string', 'hello'],
            ['boolean', true],
        ])('rejects %s with single "Result must be an object" error', (_label, value) => {
            const result = validatePipelineResult(value);
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual(['Result must be an object']);
            expect(result.result).toBeUndefined();
        });

        it('does NOT short-circuit on arrays — they are typeof "object" so they fall through to the per-field checks (and produce a list of field errors instead of a single envelope error)', () => {
            // typeof [] === 'object' && [] !== null, so the early return does not fire.
            // Arrays then fail per-field checks one-by-one. This pins the documented
            // (slightly surprising) behaviour so a future refactor that adds an
            // explicit `Array.isArray` short-circuit breaks loudly.
            const result = validatePipelineResult([]);
            expect(result.valid).toBe(false);
            expect(result.errors).not.toEqual(['Result must be an object']);
            expect(result.errors.length).toBeGreaterThan(1);
        });
    });

    describe('happy path', () => {
        it('accepts a fully-populated valid result with no errors', () => {
            const input = buildValidResult();
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
            expect(result.result).toBe(input);
        });

        it('accepts an "in-flight" result (state.isRunning=true)', () => {
            const input = buildValidResult({
                state: {
                    isRunning: true,
                    isCancelled: false,
                    completedSteps: ['s1'],
                    failedSteps: [],
                },
            });
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('accepts a cancelled result (state.isCancelled=true)', () => {
            const input = buildValidResult({
                state: { isRunning: false, isCancelled: true, completedSteps: [], failedSteps: [] },
            });
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('accepts a failed result with success=false', () => {
            const input = buildValidResult({ success: false });
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });
    });

    describe('"success" field', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['number', 1],
            ['string', 'true'],
            ['object', {}],
        ])('rejects success=%s with documented error', (_label, value) => {
            const input = buildValidResult();
            (input as Record<string, unknown>).success = value;
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain(
                'Missing or invalid "success" field (expected boolean)',
            );
        });
    });

    describe('"outputs" field', () => {
        it('rejects missing outputs with single envelope error and no nested array errors', () => {
            const input: Record<string, unknown> = buildValidResult();
            delete input.outputs;
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing or invalid "outputs" field (expected object)');
            // The nested checks short-circuit when outputs is not a non-null object,
            // so we should NOT see five additional "outputs.items/categories/..." errors.
            expect(result.errors).not.toContain(
                'Missing or invalid "outputs.items" field (expected array)',
            );
            expect(result.errors).not.toContain(
                'Missing or invalid "outputs.categories" field (expected array)',
            );
        });

        it('rejects null outputs with single envelope error', () => {
            const result = validatePipelineResult(buildValidResult({ outputs: null }));
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing or invalid "outputs" field (expected object)');
            expect(result.errors).not.toContain(
                'Missing or invalid "outputs.items" field (expected array)',
            );
        });

        it('rejects non-object outputs (string)', () => {
            const result = validatePipelineResult(buildValidResult({ outputs: 'not-an-object' }));
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing or invalid "outputs" field (expected object)');
        });

        it.each([
            ['items', 'Missing or invalid "outputs.items" field (expected array)'],
            ['categories', 'Missing or invalid "outputs.categories" field (expected array)'],
            ['tags', 'Missing or invalid "outputs.tags" field (expected array)'],
            ['collections', 'Missing or invalid "outputs.collections" field (expected array)'],
            ['brands', 'Missing or invalid "outputs.brands" field (expected array)'],
        ])('rejects missing outputs.%s', (field, expectedError) => {
            const input = buildValidResult();
            delete (input.outputs as Record<string, unknown>)[field];
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain(expectedError);
        });

        it.each([['items'], ['categories'], ['tags'], ['collections'], ['brands']])(
            'rejects non-array outputs.%s (object instead of array)',
            (field) => {
                const input = buildValidResult();
                (input.outputs as Record<string, unknown>)[field] = { not: 'an-array' };
                const result = validatePipelineResult(input);
                expect(result.valid).toBe(false);
                expect(result.errors).toContain(
                    `Missing or invalid "outputs.${field}" field (expected array)`,
                );
            },
        );

        it('reports ALL five missing array fields when outputs is an empty object', () => {
            const result = validatePipelineResult(buildValidResult({ outputs: {} }));
            expect(result.valid).toBe(false);
            expect(result.errors).toContain(
                'Missing or invalid "outputs.items" field (expected array)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "outputs.categories" field (expected array)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "outputs.tags" field (expected array)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "outputs.collections" field (expected array)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "outputs.brands" field (expected array)',
            );
        });

        it('accepts outputs with extra unknown keys (forward-compatible — does not over-validate)', () => {
            const input = buildValidResult();
            (input.outputs as Record<string, unknown>).futureField = ['anything'];
            const result = validatePipelineResult(input);
            expect(result.valid).toBe(true);
        });
    });

    describe('"stepsCompleted" / "totalSteps" fields', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['string', '3'],
            ['NaN does NOT trigger', NaN], // typeof NaN === 'number', so NaN passes the check
        ])('stepsCompleted=%s', (label, value) => {
            const input = buildValidResult();
            (input as Record<string, unknown>).stepsCompleted = value;
            const result = validatePipelineResult(input);
            if (label === 'NaN does NOT trigger') {
                // typeof NaN === 'number' — pinned because a switch to Number.isFinite
                // would change behaviour and we want that change to be deliberate.
                expect(result.errors).not.toContain(
                    'Missing or invalid "stepsCompleted" field (expected number)',
                );
            } else {
                expect(result.errors).toContain(
                    'Missing or invalid "stepsCompleted" field (expected number)',
                );
            }
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['string', '5'],
        ])('rejects totalSteps=%s', (_label, value) => {
            const input = buildValidResult();
            (input as Record<string, unknown>).totalSteps = value;
            const result = validatePipelineResult(input);
            expect(result.errors).toContain(
                'Missing or invalid "totalSteps" field (expected number)',
            );
        });
    });

    describe('"state" field', () => {
        it('accepts state===undefined (entirely absent state object)', () => {
            const input = buildValidResult();
            delete (input as Record<string, unknown>).state;
            const result = validatePipelineResult(input);
            // Per the source: `if (r.state !== undefined && (typeof r.state !== 'object' || r.state === null))` —
            // so undefined skips both branches and produces no state-related errors.
            expect(result.errors.filter((e) => e.includes('"state'))).toEqual([]);
            expect(result.valid).toBe(true);
        });

        it('rejects state===null with single envelope error (and no nested boolean/array errors)', () => {
            const result = validatePipelineResult(buildValidResult({ state: null }));
            expect(result.errors).toContain('Invalid "state" field (expected object)');
            // Source: the else-if branch only runs when state is a non-null object,
            // so null skips the per-field checks.
            expect(result.errors).not.toContain(
                'Missing or invalid "state.isRunning" field (expected boolean)',
            );
        });

        it('rejects state===number with single envelope error', () => {
            const result = validatePipelineResult(buildValidResult({ state: 42 }));
            expect(result.errors).toContain('Invalid "state" field (expected object)');
        });

        it('rejects state===string with single envelope error', () => {
            const result = validatePipelineResult(buildValidResult({ state: 'running' }));
            expect(result.errors).toContain('Invalid "state" field (expected object)');
        });

        it.each([
            ['isRunning', 'Missing or invalid "state.isRunning" field (expected boolean)'],
            ['isCancelled', 'Missing or invalid "state.isCancelled" field (expected boolean)'],
        ])('rejects missing state.%s', (field, expectedError) => {
            const input = buildValidResult();
            delete (input.state as Record<string, unknown>)[field];
            const result = validatePipelineResult(input);
            expect(result.errors).toContain(expectedError);
        });

        it.each([
            ['completedSteps', 'Missing or invalid "state.completedSteps" field (expected array)'],
            ['failedSteps', 'Missing or invalid "state.failedSteps" field (expected array)'],
        ])('rejects missing state.%s', (field, expectedError) => {
            const input = buildValidResult();
            delete (input.state as Record<string, unknown>)[field];
            const result = validatePipelineResult(input);
            expect(result.errors).toContain(expectedError);
        });

        it.each([
            ['isRunning', 'true', 'Missing or invalid "state.isRunning" field (expected boolean)'],
            ['isCancelled', 1, 'Missing or invalid "state.isCancelled" field (expected boolean)'],
        ])('rejects non-boolean state.%s', (field, value, expectedError) => {
            const input = buildValidResult();
            (input.state as Record<string, unknown>)[field] = value;
            const result = validatePipelineResult(input);
            expect(result.errors).toContain(expectedError);
        });

        it.each([
            ['completedSteps', 'Missing or invalid "state.completedSteps" field (expected array)'],
            ['failedSteps', 'Missing or invalid "state.failedSteps" field (expected array)'],
        ])('rejects non-array state.%s (string)', (field, expectedError) => {
            const input = buildValidResult();
            (input.state as Record<string, unknown>)[field] = 'step1,step2';
            const result = validatePipelineResult(input);
            expect(result.errors).toContain(expectedError);
        });

        it('reports ALL four missing state fields when state is an empty object', () => {
            const result = validatePipelineResult(buildValidResult({ state: {} }));
            expect(result.errors).toContain(
                'Missing or invalid "state.isRunning" field (expected boolean)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "state.isCancelled" field (expected boolean)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "state.completedSteps" field (expected array)',
            );
            expect(result.errors).toContain(
                'Missing or invalid "state.failedSteps" field (expected array)',
            );
        });
    });

    describe('"duration" field (NOT optional in implementation)', () => {
        // NOTE: the source-level comment says "Optional fields validation" above this
        // block, but the actual code does NOT gate on `r.duration !== undefined` —
        // it unconditionally requires `typeof r.duration === 'number'`. That makes
        // duration effectively REQUIRED. Pinned here so a future "make duration
        // truly optional" refactor breaks loudly.
        it('rejects missing duration', () => {
            const input = buildValidResult();
            delete (input as Record<string, unknown>).duration;
            const result = validatePipelineResult(input);
            expect(result.errors).toContain(
                'Missing or invalid "duration" field (expected number)',
            );
            expect(result.valid).toBe(false);
        });

        it('rejects duration===undefined explicitly', () => {
            const result = validatePipelineResult(buildValidResult({ duration: undefined }));
            expect(result.errors).toContain(
                'Missing or invalid "duration" field (expected number)',
            );
        });

        it('rejects duration===null', () => {
            const result = validatePipelineResult(buildValidResult({ duration: null }));
            expect(result.errors).toContain(
                'Missing or invalid "duration" field (expected number)',
            );
        });

        it('rejects duration as a string', () => {
            const result = validatePipelineResult(buildValidResult({ duration: '1234' }));
            expect(result.errors).toContain(
                'Missing or invalid "duration" field (expected number)',
            );
        });

        it('accepts duration=0', () => {
            const result = validatePipelineResult(buildValidResult({ duration: 0 }));
            expect(result.valid).toBe(true);
        });

        it('accepts negative duration (no range check)', () => {
            // Pinned: there is no `>= 0` guard, so a negative duration passes.
            // Useful to know if a regression accidentally introduces such a guard.
            const result = validatePipelineResult(buildValidResult({ duration: -1 }));
            expect(result.valid).toBe(true);
        });
    });

    describe('"error" field (truly optional)', () => {
        it('accepts error===undefined', () => {
            const result = validatePipelineResult(buildValidResult({ error: undefined }));
            expect(result.valid).toBe(true);
        });

        it('accepts error as a string', () => {
            const result = validatePipelineResult(
                buildValidResult({ error: 'something went wrong' }),
            );
            expect(result.valid).toBe(true);
        });

        it('accepts error as an Error instance', () => {
            const result = validatePipelineResult(buildValidResult({ error: new Error('boom') }));
            expect(result.valid).toBe(true);
        });

        it('accepts error as a TypeError (Error subclass — instanceof Error check)', () => {
            const result = validatePipelineResult(
                buildValidResult({ error: new TypeError('bad type') }),
            );
            expect(result.valid).toBe(true);
        });

        it('rejects error as a number', () => {
            const result = validatePipelineResult(buildValidResult({ error: 42 }));
            expect(result.errors).toContain('Invalid "error" field (expected string or Error)');
        });

        it('rejects error as a plain object', () => {
            const result = validatePipelineResult(buildValidResult({ error: { message: 'oops' } }));
            expect(result.errors).toContain('Invalid "error" field (expected string or Error)');
        });

        it('rejects error===null (null is NOT undefined and is not a string and is not instanceof Error)', () => {
            const result = validatePipelineResult(buildValidResult({ error: null }));
            expect(result.errors).toContain('Invalid "error" field (expected string or Error)');
        });
    });

    describe('"failedStep" field (truly optional)', () => {
        it('accepts failedStep===undefined', () => {
            const result = validatePipelineResult(buildValidResult({ failedStep: undefined }));
            expect(result.valid).toBe(true);
        });

        it('accepts failedStep as a string', () => {
            const result = validatePipelineResult(
                buildValidResult({ failedStep: 'fetch-content' }),
            );
            expect(result.valid).toBe(true);
        });

        it('rejects failedStep as a number', () => {
            const result = validatePipelineResult(buildValidResult({ failedStep: 3 }));
            expect(result.errors).toContain('Invalid "failedStep" field (expected string)');
        });

        it('rejects failedStep===null', () => {
            const result = validatePipelineResult(buildValidResult({ failedStep: null }));
            expect(result.errors).toContain('Invalid "failedStep" field (expected string)');
        });
    });

    describe('result envelope shape', () => {
        it('result.result is the same reference as the input on success (no clone)', () => {
            const input = buildValidResult();
            const out = validatePipelineResult(input);
            expect(out.result).toBe(input);
        });

        it('result.result is undefined when validation fails', () => {
            const out = validatePipelineResult(buildValidResult({ success: 'not-a-bool' }));
            expect(out.valid).toBe(false);
            expect(out.result).toBeUndefined();
        });

        it('errors array order is stable: success, outputs, stepsCompleted, totalSteps, state, duration, error, failedStep', () => {
            // Build a result where every field is invalid.
            const input = {
                success: 'no',
                outputs: 'bad',
                stepsCompleted: 'a',
                totalSteps: 'b',
                state: 123,
                duration: 'd',
                error: 5,
                failedStep: 9,
            };
            const out = validatePipelineResult(input);
            expect(out.valid).toBe(false);
            const errMessages = out.errors;
            // Find indices to assert the documented order (matches the order of checks
            // in the source). A reorder of the validator must update this test.
            const successIdx = errMessages.findIndex((e) =>
                e.startsWith('Missing or invalid "success"'),
            );
            const outputsIdx = errMessages.findIndex((e) =>
                e.startsWith('Missing or invalid "outputs"'),
            );
            const stepsIdx = errMessages.findIndex((e) =>
                e.startsWith('Missing or invalid "stepsCompleted"'),
            );
            const totalIdx = errMessages.findIndex((e) =>
                e.startsWith('Missing or invalid "totalSteps"'),
            );
            const stateIdx = errMessages.findIndex((e) => e.startsWith('Invalid "state"'));
            const durIdx = errMessages.findIndex((e) =>
                e.startsWith('Missing or invalid "duration"'),
            );
            const errIdx = errMessages.findIndex((e) => e.startsWith('Invalid "error"'));
            const failedStepIdx = errMessages.findIndex((e) =>
                e.startsWith('Invalid "failedStep"'),
            );

            expect(successIdx).toBeGreaterThanOrEqual(0);
            expect(outputsIdx).toBeGreaterThan(successIdx);
            expect(stepsIdx).toBeGreaterThan(outputsIdx);
            expect(totalIdx).toBeGreaterThan(stepsIdx);
            expect(stateIdx).toBeGreaterThan(totalIdx);
            expect(durIdx).toBeGreaterThan(stateIdx);
            expect(errIdx).toBeGreaterThan(durIdx);
            expect(failedStepIdx).toBeGreaterThan(errIdx);
        });
    });
});

describe('validatePipelineResultOrThrow', () => {
    it('returns the validated result on success (same reference)', () => {
        const input = buildValidResult();
        const out = validatePipelineResultOrThrow(input);
        expect(out).toBe(input);
    });

    it('returns the validated result on success even when an Error envelope is present', () => {
        // success=false alone is a perfectly valid PipelineResult shape (a failed run);
        // OrThrow only throws when the SHAPE is wrong, not when the run itself failed.
        const input = buildValidResult({ success: false, error: new Error('step failed') });
        const out = validatePipelineResultOrThrow(input);
        expect(out).toBe(input);
    });

    it('throws Error with no plugin id when omitted', () => {
        expect(() => validatePipelineResultOrThrow(null)).toThrow(
            /^Invalid pipeline result: Result must be an object$/,
        );
    });

    it('throws Error with plugin id segment when provided', () => {
        expect(() => validatePipelineResultOrThrow(null, 'standard-pipeline')).toThrow(
            /^Invalid pipeline result from plugin 'standard-pipeline': Result must be an object$/,
        );
    });

    it('joins multiple errors with "; " separator (matches source `errors.join("; ")`)', () => {
        // Build a result with TWO independent issues: missing success + missing duration.
        const input = buildValidResult();
        delete (input as Record<string, unknown>).success;
        delete (input as Record<string, unknown>).duration;
        try {
            validatePipelineResultOrThrow(input, 'p1');
            throw new Error('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain("from plugin 'p1':");
            expect(msg).toContain('Missing or invalid "success" field (expected boolean)');
            expect(msg).toContain('Missing or invalid "duration" field (expected number)');
            // Pin the documented separator.
            expect(msg).toMatch(/expected boolean\); /);
        }
    });

    it('handles empty-string plugin id as "no plugin" (truthy check `pluginId ? ... : ""`)', () => {
        // Empty string is falsy, so the prefix segment is omitted.
        expect(() => validatePipelineResultOrThrow(null, '')).toThrow(
            /^Invalid pipeline result: Result must be an object$/,
        );
    });

    it('treats whitespace-only plugin id as truthy and includes it verbatim (no trim)', () => {
        // Pinned: the implementation does NOT `.trim()` pluginId — it just checks truthiness.
        // A future "trim to no-op" refactor that changes behaviour will fail this test.
        expect(() => validatePipelineResultOrThrow(null, '   ')).toThrow(/from plugin '   ':/);
    });

    it('rethrows a fresh Error per call (not a singleton)', () => {
        let e1: Error | undefined;
        let e2: Error | undefined;
        try {
            validatePipelineResultOrThrow(null);
        } catch (err) {
            e1 = err as Error;
        }
        try {
            validatePipelineResultOrThrow(null);
        } catch (err) {
            e2 = err as Error;
        }
        expect(e1).toBeInstanceOf(Error);
        expect(e2).toBeInstanceOf(Error);
        expect(e1).not.toBe(e2);
    });
});
