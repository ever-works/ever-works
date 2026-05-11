import {
    validatePipelineResult,
    validatePipelineResultOrThrow,
} from '../validators/pipeline-result.validator';

const validResult = () => ({
    success: true,
    outputs: {
        items: [],
        categories: [],
        tags: [],
        collections: [],
        brands: [],
    },
    stepsCompleted: 5,
    totalSteps: 5,
    state: {
        isRunning: false,
        isCancelled: false,
        completedSteps: [],
        failedSteps: [],
    },
    duration: 1234,
});

describe('validatePipelineResult', () => {
    describe('non-object inputs (short-circuit)', () => {
        it.each<[string, unknown]>([
            ['null', null],
            ['undefined', undefined],
            ['string', 'not an object'],
            ['number', 42],
            ['boolean', true],
        ])(
            'rejects %s with the single error "Result must be an object" (no other errors accumulated)',
            (_label, input) => {
                const result = validatePipelineResult(input);

                expect(result).toEqual({
                    valid: false,
                    errors: ['Result must be an object'],
                });
                // Pin: result field is omitted on the short-circuit path
                expect(result.result).toBeUndefined();
            },
        );
    });

    describe('happy path', () => {
        it('accepts a fully-populated result with valid: true and result echoed verbatim', () => {
            const input = validResult();
            const validation = validatePipelineResult(input);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toEqual([]);
            // Pin: same object reference is forwarded as result on success
            expect(validation.result).toBe(input);
        });

        it('omits the result field when invalid (errors > 0 → result: undefined)', () => {
            const validation = validatePipelineResult({});
            expect(validation.valid).toBe(false);
            expect(validation.result).toBeUndefined();
        });
    });

    describe('top-level scalar fields', () => {
        it('rejects non-boolean success', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                success: 'true',
            });
            expect(validation.errors).toContain(
                'Missing or invalid "success" field (expected boolean)',
            );
        });

        it('rejects missing success', () => {
            const r = validResult() as Partial<ReturnType<typeof validResult>>;
            delete r.success;
            const validation = validatePipelineResult(r);
            expect(validation.errors).toContain(
                'Missing or invalid "success" field (expected boolean)',
            );
        });

        it('accepts success: false (the boolean check is type-only, not truthiness)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                success: false,
            });
            expect(validation.valid).toBe(true);
        });

        it('rejects non-number stepsCompleted', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                stepsCompleted: '5',
            });
            expect(validation.errors).toContain(
                'Missing or invalid "stepsCompleted" field (expected number)',
            );
        });

        it('rejects missing stepsCompleted', () => {
            const r = validResult() as Partial<ReturnType<typeof validResult>>;
            delete r.stepsCompleted;
            const validation = validatePipelineResult(r);
            expect(validation.errors).toContain(
                'Missing or invalid "stepsCompleted" field (expected number)',
            );
        });

        it('accepts stepsCompleted: 0 (zero is a valid number — not a falsy guard)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                stepsCompleted: 0,
            });
            expect(validation.valid).toBe(true);
        });

        it('accepts negative stepsCompleted (no range validation, just typeof)', () => {
            // Pin: the validator does NOT bound-check; a future refactor that
            // adds `>= 0` would have to update this assertion deliberately.
            const validation = validatePipelineResult({
                ...validResult(),
                stepsCompleted: -1,
            });
            expect(validation.valid).toBe(true);
        });

        it('rejects non-number totalSteps', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                totalSteps: null,
            });
            expect(validation.errors).toContain(
                'Missing or invalid "totalSteps" field (expected number)',
            );
        });

        it('rejects non-number duration (treated as required because the validator does NOT branch on undefined)', () => {
            // Pinned: the JSDoc calls `duration` "Optional fields validation"
            // but the implementation rejects `undefined` because it uses
            // `typeof !== 'number'`. Pin the actual behaviour so the
            // doc-vs-impl mismatch is observable.
            const r = validResult() as Partial<ReturnType<typeof validResult>>;
            delete r.duration;
            const validation = validatePipelineResult(r);
            expect(validation.errors).toContain(
                'Missing or invalid "duration" field (expected number)',
            );
        });
    });

    describe('outputs object', () => {
        it('rejects non-object outputs (string)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                outputs: 'not-object',
            });
            expect(validation.errors).toContain(
                'Missing or invalid "outputs" field (expected object)',
            );
        });

        it('rejects null outputs', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                outputs: null,
            });
            expect(validation.errors).toContain(
                'Missing or invalid "outputs" field (expected object)',
            );
        });

        it('does NOT cascade child-field errors when outputs is missing-or-non-object (else-branch guard)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                outputs: null,
            });
            // Pin: the children are only validated when outputs is itself a
            // non-null object. Otherwise the validator emits the single
            // "Missing or invalid 'outputs'" error and skips the per-array
            // checks. Avoids duplicate noise when the upstream caller is
            // already obviously misshapen.
            expect(validation.errors).not.toContain(
                'Missing or invalid "outputs.items" field (expected array)',
            );
        });

        it.each(['items', 'categories', 'tags', 'collections', 'brands'])(
            'rejects non-array outputs.%s',
            (field) => {
                const validation = validatePipelineResult({
                    ...validResult(),
                    outputs: { ...validResult().outputs, [field]: 'not-array' },
                });
                expect(validation.errors).toContain(
                    `Missing or invalid "outputs.${field}" field (expected array)`,
                );
            },
        );

        it.each(['items', 'categories', 'tags', 'collections', 'brands'])(
            'rejects missing outputs.%s',
            (field) => {
                const outputs = { ...validResult().outputs } as Record<string, unknown>;
                delete outputs[field];
                const validation = validatePipelineResult({
                    ...validResult(),
                    outputs,
                });
                expect(validation.errors).toContain(
                    `Missing or invalid "outputs.${field}" field (expected array)`,
                );
            },
        );

        it('accepts empty arrays for all five output fields', () => {
            const validation = validatePipelineResult(validResult());
            expect(validation.valid).toBe(true);
        });
    });

    describe('state object (optional)', () => {
        it('accepts a result without state field (undefined branch — state is optional)', () => {
            const r = validResult() as Partial<ReturnType<typeof validResult>>;
            delete r.state;
            const validation = validatePipelineResult(r);
            expect(validation.valid).toBe(true);
        });

        it('rejects state explicitly set to null (typeof null === "object" so the secondary null guard fires)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                state: null,
            });
            expect(validation.errors).toContain('Invalid "state" field (expected object)');
        });

        it('rejects state set to a non-object scalar', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                state: 'running',
            });
            expect(validation.errors).toContain('Invalid "state" field (expected object)');
        });

        it.each(['isRunning', 'isCancelled'])(
            'when state is an object, rejects non-boolean state.%s',
            (field) => {
                const validation = validatePipelineResult({
                    ...validResult(),
                    state: { ...validResult().state, [field]: 'true' },
                });
                expect(validation.errors).toContain(
                    `Missing or invalid "state.${field}" field (expected boolean)`,
                );
            },
        );

        it.each(['completedSteps', 'failedSteps'])(
            'when state is an object, rejects non-array state.%s',
            (field) => {
                const validation = validatePipelineResult({
                    ...validResult(),
                    state: { ...validResult().state, [field]: 'not-array' },
                });
                expect(validation.errors).toContain(
                    `Missing or invalid "state.${field}" field (expected array)`,
                );
            },
        );

        it('does NOT validate child fields when state is missing entirely (vs explicitly-null)', () => {
            // Pin the "missing-state" vs "null-state" distinction: missing is
            // a clean pass (the field is documented optional), null is an
            // error AND skips child checks.
            const r = validResult() as Partial<ReturnType<typeof validResult>>;
            delete r.state;
            const validation = validatePipelineResult(r);
            expect(validation.errors).toEqual([]);
        });
    });

    describe('optional error / failedStep fields', () => {
        it('accepts result without error/failedStep (undefined → skipped)', () => {
            const validation = validatePipelineResult(validResult());
            expect(validation.valid).toBe(true);
        });

        it('accepts a string error', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                error: 'pipeline failed',
            });
            expect(validation.valid).toBe(true);
        });

        it('accepts an Error instance for error (instanceof Error branch)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                error: new Error('boom'),
            });
            expect(validation.valid).toBe(true);
        });

        it('rejects a non-string non-Error error (e.g. plain object)', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                error: { message: 'not an Error instance' },
            });
            expect(validation.errors).toContain('Invalid "error" field (expected string or Error)');
        });

        it('rejects a number error', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                error: 500,
            });
            expect(validation.errors).toContain('Invalid "error" field (expected string or Error)');
        });

        it('accepts a string failedStep', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                failedStep: 'step-3',
            });
            expect(validation.valid).toBe(true);
        });

        it('rejects a non-string failedStep', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                failedStep: 3,
            });
            expect(validation.errors).toContain('Invalid "failedStep" field (expected string)');
        });
    });

    describe('error accumulation', () => {
        it('accumulates multiple top-level errors in declaration order', () => {
            const validation = validatePipelineResult({
                success: 'true',
                outputs: {
                    items: 'not-array',
                    categories: [],
                    tags: [],
                    collections: [],
                    brands: [],
                },
                stepsCompleted: '5',
                totalSteps: null,
                duration: 'long',
            });

            expect(validation.valid).toBe(false);
            // Pin the documented order: success → outputs.items → stepsCompleted →
            // totalSteps → duration. The order is observable in the array, so
            // a refactor that re-orders the validation block changes test
            // output deliberately.
            expect(validation.errors[0]).toBe(
                'Missing or invalid "success" field (expected boolean)',
            );
            expect(validation.errors[1]).toBe(
                'Missing or invalid "outputs.items" field (expected array)',
            );
            expect(validation.errors[2]).toBe(
                'Missing or invalid "stepsCompleted" field (expected number)',
            );
            expect(validation.errors[3]).toBe(
                'Missing or invalid "totalSteps" field (expected number)',
            );
            expect(validation.errors[4]).toBe(
                'Missing or invalid "duration" field (expected number)',
            );
        });

        it('accumulates outputs child errors for ALL missing arrays in declaration order', () => {
            const validation = validatePipelineResult({
                ...validResult(),
                outputs: {},
            });

            // Pin all five child-array errors are accumulated, in declaration order.
            expect(validation.errors).toEqual([
                'Missing or invalid "outputs.items" field (expected array)',
                'Missing or invalid "outputs.categories" field (expected array)',
                'Missing or invalid "outputs.tags" field (expected array)',
                'Missing or invalid "outputs.collections" field (expected array)',
                'Missing or invalid "outputs.brands" field (expected array)',
            ]);
        });
    });
});

describe('validatePipelineResultOrThrow', () => {
    it('returns the validated result when valid (same reference passthrough)', () => {
        const input = validResult();
        const out = validatePipelineResultOrThrow(input);
        expect(out).toBe(input);
    });

    it('throws "Invalid pipeline result: <errors-joined-with-semicolon-and-space>" when no pluginId', () => {
        expect(() => validatePipelineResultOrThrow({})).toThrow(/^Invalid pipeline result: /);
    });

    it('joins multiple errors with "; " in the thrown message', () => {
        try {
            validatePipelineResultOrThrow({ success: 'true', outputs: null });
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            const message = (err as Error).message;
            // Pin the join separator and the no-plugin prefix shape.
            expect(message).toMatch(/^Invalid pipeline result: /);
            expect(message).toContain('; ');
            return;
        }
        throw new Error('expected validatePipelineResultOrThrow to throw');
    });

    it('interpolates pluginId into the thrown message when supplied (single-quoted)', () => {
        expect(() => validatePipelineResultOrThrow({}, 'standard-pipeline')).toThrow(
            /^Invalid pipeline result from plugin 'standard-pipeline': /,
        );
    });

    it('omits the " from plugin" segment when pluginId is empty-string (falsy guard)', () => {
        // Pin: the implementation uses `pluginId ? ...` so empty-string is
        // treated as "no plugin". A switch to `pluginId !== undefined` would
        // change this behaviour deliberately.
        expect(() => validatePipelineResultOrThrow({}, '')).toThrow(/^Invalid pipeline result: /);
    });

    it('throws an Error instance (not a string) — caller code uses instanceof checks', () => {
        try {
            validatePipelineResultOrThrow({});
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            return;
        }
        throw new Error('expected validatePipelineResultOrThrow to throw');
    });
});
