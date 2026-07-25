import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import {
    DEFAULT_GATE_ATTEMPTS,
    MAX_GATE_ATTEMPTS,
    MIN_GATE_ATTEMPTS,
    resolveAcceptanceChecks,
    resolveChecksPolicy,
    resolveMaxGateAttempts,
} from '../task-gates';

function check(overrides: Partial<TaskAcceptanceCheck> & { id: string }): TaskAcceptanceCheck {
    return {
        name: overrides.id,
        kind: 'custom',
        command: `echo ${overrides.id}`,
        required: true,
        ...overrides,
    };
}

describe('resolveAcceptanceChecks', () => {
    it('returns [] when neither the Task nor the Work declares anything', () => {
        expect(resolveAcceptanceChecks(null, null)).toEqual([]);
        expect(
            resolveAcceptanceChecks({ acceptanceChecks: null }, { checkDefaults: null }),
        ).toEqual([]);
    });

    it('falls back to the Work defaults when the Task declares nothing', () => {
        const build = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        const test = check({ id: 'test', kind: 'test', command: 'pnpm test' });
        expect(
            resolveAcceptanceChecks({ acceptanceChecks: null }, { checkDefaults: [build, test] }),
        ).toEqual([build, test]);
    });

    it('uses the Task checks when the Work has no defaults', () => {
        const lint = check({ id: 'lint', kind: 'lint', command: 'pnpm lint' });
        expect(
            resolveAcceptanceChecks({ acceptanceChecks: [lint] }, { checkDefaults: null }),
        ).toEqual([lint]);
    });

    it('a same-id Task check overrides the Work default wholesale, keeping its position', () => {
        const defaultBuild = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        const test = check({ id: 'test', kind: 'test', command: 'pnpm test' });
        const overriddenBuild = check({
            id: 'build',
            kind: 'build',
            command: 'pnpm build --filter=web',
            required: false,
        });

        const resolved = resolveAcceptanceChecks(
            { acceptanceChecks: [overriddenBuild] },
            { checkDefaults: [defaultBuild, test] },
        );
        // Override replaces in place — Work-default ordering is preserved.
        expect(resolved).toEqual([overriddenBuild, test]);
    });

    it('a Task-only check is appended after the inherited defaults', () => {
        const build = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        const smoke = check({ id: 'smoke', command: 'pnpm smoke' });
        expect(
            resolveAcceptanceChecks({ acceptanceChecks: [smoke] }, { checkDefaults: [build] }),
        ).toEqual([build, smoke]);
    });

    it('a disabled Task entry suppresses the inherited default without redeclaring the rest', () => {
        const build = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        const test = check({ id: 'test', kind: 'test', command: 'pnpm test' });
        const suppression = check({ id: 'test', disabled: true });

        expect(
            resolveAcceptanceChecks(
                { acceptanceChecks: [suppression] },
                { checkDefaults: [build, test] },
            ),
        ).toEqual([build]);
    });

    it('filters disabled entries from Work defaults and from Task-declared checks alike', () => {
        const activeDefault = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        const disabledDefault = check({ id: 'lint', kind: 'lint', disabled: true });
        const disabledOwn = check({ id: 'smoke', disabled: true });

        expect(
            resolveAcceptanceChecks(null, { checkDefaults: [activeDefault, disabledDefault] }),
        ).toEqual([activeDefault]);
        expect(
            resolveAcceptanceChecks(
                { acceptanceChecks: [disabledOwn] },
                { checkDefaults: [activeDefault] },
            ),
        ).toEqual([activeDefault]);
    });

    it('an EMPTY Task array keeps the inherited defaults (only `null` and suppressions detach)', () => {
        const build = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        expect(
            resolveAcceptanceChecks({ acceptanceChecks: [] }, { checkDefaults: [build] }),
        ).toEqual([build]);
    });

    it('tolerates malformed simple-json content (non-array values, id-less entries)', () => {
        const build = check({ id: 'build', kind: 'build', command: 'pnpm build' });
        expect(
            resolveAcceptanceChecks(
                { acceptanceChecks: 'not-an-array' as unknown as TaskAcceptanceCheck[] },
                { checkDefaults: [build] },
            ),
        ).toEqual([build]);
        expect(
            resolveAcceptanceChecks(
                { acceptanceChecks: [{} as TaskAcceptanceCheck] },
                { checkDefaults: [build] },
            ),
        ).toEqual([build]);
    });
});

describe('resolveChecksPolicy', () => {
    it("defaults to 'off' for a missing Work or unset column", () => {
        expect(resolveChecksPolicy(null)).toBe('off');
        expect(resolveChecksPolicy(undefined)).toBe('off');
        expect(resolveChecksPolicy({})).toBe('off');
    });

    it('passes through every known policy value', () => {
        expect(resolveChecksPolicy({ checksPolicy: 'off' })).toBe('off');
        expect(resolveChecksPolicy({ checksPolicy: 'warn' })).toBe('warn');
        expect(resolveChecksPolicy({ checksPolicy: 'required' })).toBe('required');
    });

    it("resolves an unrecognized value to 'off' — never toward blocking", () => {
        expect(resolveChecksPolicy({ checksPolicy: 'block-everything' as unknown as 'off' })).toBe(
            'off',
        );
    });
});

describe('resolveMaxGateAttempts', () => {
    it('prefers the Task value over the Work value', () => {
        expect(resolveMaxGateAttempts({ maxGateAttempts: 3 }, { maxGateAttempts: 5 })).toBe(3);
    });

    it('falls back to the Work value, then to the default of 2', () => {
        expect(resolveMaxGateAttempts({ maxGateAttempts: null }, { maxGateAttempts: 4 })).toBe(4);
        expect(resolveMaxGateAttempts(null, null)).toBe(DEFAULT_GATE_ATTEMPTS);
        expect(resolveMaxGateAttempts({ maxGateAttempts: null }, {})).toBe(DEFAULT_GATE_ATTEMPTS);
    });

    it('clamps below-range and above-range values into 1..5', () => {
        expect(resolveMaxGateAttempts({ maxGateAttempts: 0 }, null)).toBe(MIN_GATE_ATTEMPTS);
        expect(resolveMaxGateAttempts({ maxGateAttempts: -7 }, null)).toBe(MIN_GATE_ATTEMPTS);
        expect(resolveMaxGateAttempts({ maxGateAttempts: 99 }, null)).toBe(MAX_GATE_ATTEMPTS);
        expect(resolveMaxGateAttempts(null, { maxGateAttempts: 42 })).toBe(MAX_GATE_ATTEMPTS);
    });

    it('normalizes non-integer and non-finite values instead of propagating them', () => {
        expect(resolveMaxGateAttempts({ maxGateAttempts: 3.9 }, null)).toBe(3);
        expect(resolveMaxGateAttempts({ maxGateAttempts: Number.NaN }, null)).toBe(
            DEFAULT_GATE_ATTEMPTS,
        );
        expect(resolveMaxGateAttempts({ maxGateAttempts: Number.POSITIVE_INFINITY }, null)).toBe(
            DEFAULT_GATE_ATTEMPTS,
        );
    });
});
