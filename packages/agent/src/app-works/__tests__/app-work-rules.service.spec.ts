import type { AppSpec } from '@ever-works/contracts';

import {
    AppSpecUnreadableError,
    AppWorkRulesService,
    DEFAULT_SIZE_GUIDANCE,
    MAX_CHECKS,
    MAX_INSTRUCTION_FILES,
    MAX_SIZE_GUIDANCE,
    MIN_SIZE_GUIDANCE,
} from '../app-work-rules.service';
import type { AppSpecService } from '../../app-spec/app-spec.service';

/**
 * APW-08 T10 — the rules one evolve run is governed by.
 *
 * Two properties carry the security of the whole loop, and they are the first
 * two blocks below:
 *
 *   1. the spec is read at the **base** commit. Reading the head would let a run
 *      edit `.works/works.yml` to remove a protected path and then be judged by
 *      its own edit;
 *   2. an unreadable spec **throws**. A run with no rules is a run with no
 *      protected paths, which is the failure this epic exists to prevent — so
 *      there is no `null` return for a caller to carry on past.
 *
 * The rest is caps, defaults and freezing: unglamorous, and the reason three
 * consumers of these rules cannot come to disagree.
 */

const WORK = { id: '11111111-1111-4111-8111-111111111111', taskIsolationBaseBranch: 'production' };
const BASE = 'a'.repeat(40);

function spec(overrides: Partial<AppSpec> = {}): AppSpec {
    return { kind: 'app', ...overrides } as AppSpec;
}

function specs(read: { status: string; spec: AppSpec | null } | null): AppSpecService & {
    getEffectiveSpec: jest.Mock;
} {
    return {
        getEffectiveSpec: jest.fn(async () => read),
    } as unknown as AppSpecService & { getEffectiveSpec: jest.Mock };
}

function service(read: { status: string; spec: AppSpec | null } | null) {
    const source = specs(read);
    return { rules: new AppWorkRulesService(source), source };
}

describe('AppWorkRulesService — where the rules are read from', () => {
    it('reads the spec AT THE BASE COMMIT, never the head', async () => {
        const { rules, source } = service({ status: 'valid', spec: spec() });

        await rules.resolve(WORK, BASE);

        expect(source.getEffectiveSpec).toHaveBeenCalledWith(WORK.id, BASE);
    });

    it('refuses when there is no base commit rather than reading the effective spec', async () => {
        // A caller with no base commit has not isolated the Task yet. Falling
        // back to the head here is the exact hole this file is built to close.
        const { rules, source } = service({ status: 'valid', spec: spec() });

        await expect(rules.resolve(WORK, '')).rejects.toBeInstanceOf(AppSpecUnreadableError);
        await expect(rules.resolve(WORK, '   ')).rejects.toBeInstanceOf(AppSpecUnreadableError);
        expect(source.getEffectiveSpec).not.toHaveBeenCalled();
    });

    it('trims the commit it is handed', async () => {
        const { rules, source } = service({ status: 'valid', spec: spec() });

        await rules.resolve(WORK, `  ${BASE}  `);

        expect(source.getEffectiveSpec).toHaveBeenCalledWith(WORK.id, BASE);
    });
});

describe('AppWorkRulesService — an unreadable spec is a refusal', () => {
    it('throws for every status that is not usable, naming the BRANCH', async () => {
        for (const status of ['invalid', 'missing', 'unreadable', 'no_state']) {
            const { rules } = service({ status, spec: spec() });

            const error = await rules.resolve(WORK, BASE).catch((e) => e);
            expect(error).toBeInstanceOf(AppSpecUnreadableError);
            // A member can check out a branch; they cannot check out a commit
            // they have never seen.
            expect(String(error.message)).toContain('production');
            expect(error.status).toBe(status);
        }
    });

    it('accepts valid_with_warnings — warnings do not stop a run', async () => {
        const { rules } = service({ status: 'valid_with_warnings', spec: spec() });

        await expect(rules.resolve(WORK, BASE)).resolves.toBeDefined();
    });

    it('throws for a usable status with no spec, and for no state at all', async () => {
        await expect(
            service({ status: 'valid', spec: null }).rules.resolve(WORK, BASE),
        ).rejects.toBeInstanceOf(AppSpecUnreadableError);
        await expect(service(null).rules.resolve(WORK, BASE)).rejects.toBeInstanceOf(
            AppSpecUnreadableError,
        );
    });

    it('throws when APW-03 is not bound at all, with a message about the SPEC', async () => {
        const rules = new AppWorkRulesService(undefined);

        const error = await rules.resolve(WORK, BASE).catch((e) => e);
        expect(error).toBeInstanceOf(AppSpecUnreadableError);
        expect(String(error.message)).toContain('could not be read');
    });

    it('names a sensible branch when the Work has none recorded', async () => {
        const { rules } = service({ status: 'invalid', spec: spec() });

        const error = await rules
            .resolve({ id: WORK.id, taskIsolationBaseBranch: null }, BASE)
            .catch((e) => e);
        expect(String(error.message)).toContain('the base branch');
    });
});

describe('AppWorkRulesService — what it returns', () => {
    it('carries the spec’s rule blocks through', async () => {
        const { rules } = service({
            status: 'valid',
            spec: spec({
                source: { relation: 'fork', branch: 'production' },
                checks: [{ name: 'lint', command: 'pnpm lint' }],
                display: { protectedPaths: ['infra/**'] },
                agents: {
                    requireHumanMergePaths: ['Dockerfile'],
                    instructionFiles: ['AGENTS.md'],
                    maxPullRequestChangedLines: 900,
                },
            } as Partial<AppSpec>),
        });

        expect(await rules.resolve(WORK, BASE)).toEqual({
            sourceBranch: 'production',
            checks: [{ name: 'lint', command: 'pnpm lint' }],
            protectedPaths: ['infra/**'],
            humanMergePaths: ['Dockerfile'],
            instructionFiles: ['AGENTS.md'],
            sizeGuidance: 900,
        });
    });

    it('carries an absent source branch as null rather than guessing a default', async () => {
        // "the Work Repository's default when absent" — and this service does
        // not talk to a git provider, so a caller that knows the default must
        // not be handed a guess instead.
        const { rules } = service({
            status: 'valid',
            spec: spec({ source: { relation: 'fork' } }),
        });

        expect((await rules.resolve(WORK, BASE)).sourceBranch).toBeNull();
    });

    it('treats a blank source branch as absent', async () => {
        const { rules } = service({
            status: 'valid',
            spec: spec({ source: { relation: 'fork', branch: '   ' } }),
        });

        expect((await rules.resolve(WORK, BASE)).sourceBranch).toBeNull();
    });

    it('answers empty lists for a spec that declares no rules', async () => {
        const { rules } = service({ status: 'valid', spec: spec() });

        expect(await rules.resolve(WORK, BASE)).toEqual({
            sourceBranch: null,
            checks: [],
            protectedPaths: [],
            humanMergePaths: [],
            instructionFiles: [],
            sizeGuidance: DEFAULT_SIZE_GUIDANCE,
        });
    });
});

describe('AppWorkRulesService — the run’s budget', () => {
    it('truncates checks and instruction files from the FRONT', async () => {
        // A spec with more than a run can carry is not invalid; it just cannot
        // have all of them on every Task. Front-truncation keeps the order the
        // member wrote.
        const { rules } = service({
            status: 'valid',
            spec: spec({
                checks: Array.from({ length: MAX_CHECKS + 5 }, (_, i) => ({
                    name: `check-${i}`,
                    command: 'true',
                })),
                agents: {
                    instructionFiles: Array.from(
                        { length: MAX_INSTRUCTION_FILES + 5 },
                        (_, i) => `doc-${i}.md`,
                    ),
                },
            } as Partial<AppSpec>),
        });

        const resolved = await rules.resolve(WORK, BASE);
        expect(resolved.checks).toHaveLength(MAX_CHECKS);
        expect(resolved.checks[0].name).toBe('check-0');
        expect(resolved.instructionFiles).toHaveLength(MAX_INSTRUCTION_FILES);
        expect(resolved.instructionFiles[0]).toBe('doc-0.md');
    });

    it('clamps the size guidance to the spec’s own bounds', async () => {
        const at = async (value: unknown) =>
            (
                await service({
                    status: 'valid',
                    spec: spec({ agents: { maxPullRequestChangedLines: value } } as never),
                }).rules.resolve(WORK, BASE)
            ).sizeGuidance;

        expect(await at(10)).toBe(MIN_SIZE_GUIDANCE);
        expect(await at(9_000_000)).toBe(MAX_SIZE_GUIDANCE);
        expect(await at(700)).toBe(700);
        expect(await at(700.9)).toBe(700);
    });

    it('defaults a non-numeric guidance rather than clamping NaN', async () => {
        // `NaN` clamps to whichever bound the comparison falls through to, and
        // that is not a number anyone chose.
        for (const value of [undefined, null, 'lots', NaN, Infinity]) {
            const { rules } = service({
                status: 'valid',
                spec: spec({ agents: { maxPullRequestChangedLines: value } } as never),
            });
            expect((await rules.resolve(WORK, BASE)).sizeGuidance).toBe(DEFAULT_SIZE_GUIDANCE);
        }
    });
});

describe('AppWorkRulesService — frozen per run', () => {
    it('freezes the rules and every list in them', async () => {
        // A consumer that could push onto `protectedPaths` would change what a
        // sibling consumer sees, and the refusal would be unreproducible from
        // the spec alone.
        const { rules } = service({
            status: 'valid',
            spec: spec({ display: { protectedPaths: ['infra/**'] } } as Partial<AppSpec>),
        });

        const resolved = await rules.resolve(WORK, BASE);

        expect(Object.isFrozen(resolved)).toBe(true);
        expect(Object.isFrozen(resolved.protectedPaths)).toBe(true);
        expect(Object.isFrozen(resolved.checks)).toBe(true);
        expect(Object.isFrozen(resolved.humanMergePaths)).toBe(true);
        expect(Object.isFrozen(resolved.instructionFiles)).toBe(true);
    });

    it('copies the spec’s arrays, so mutating the spec cannot change decided rules', async () => {
        const protectedPaths = ['infra/**'];
        const { rules } = service({
            status: 'valid',
            spec: spec({ display: { protectedPaths } } as Partial<AppSpec>),
        });

        const resolved = await rules.resolve(WORK, BASE);
        protectedPaths.push('everything/**');

        expect(resolved.protectedPaths).toEqual(['infra/**']);
    });
});
