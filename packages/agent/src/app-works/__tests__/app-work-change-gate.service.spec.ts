import type { AppSpec } from '@ever-works/contracts';

import { AppChangeGuard, APP_SPEC_PATH } from '../app-change-guard';
import { AppWorkChangeGateService } from '../app-work-change-gate.service';
import {
    AppSpecUnreadableError,
    DEFAULT_SIZE_GUIDANCE,
    type AppWorkRules,
    type AppWorkRulesService,
} from '../app-work-rules.service';
import type { AppSpecService } from '../../app-spec/app-spec.service';
import type { GitFacadeService } from '../../facades/git.facade';
import type { AppWorkChangeGateInput } from '../../tasks-domain/app-work-change-gate.port';

/**
 * APW-08 T17 — the change gate: every read the guard needs, and what each read
 * failing MEANS.
 *
 * The guard is REAL here (it is pure); only the I/O is doubled. Three things
 * this file exists to pin:
 *
 *   1. the rules commit is the base branch's tip, read by the platform — the
 *      input has no field through which a caller could name another;
 *   2. nothing escapes: every failure is a refusal that says what failed;
 *   3. the branch's `.works/works.yml` is read three different ways, and an
 *      UNREADABLE spec is not reported as a DELETED one.
 */

const BASE_TIP = 'a'.repeat(40);
const WORK = { id: 'w-1', kind: 'app' } as never;

function rules(overrides: Partial<AppWorkRules> = {}): AppWorkRules {
    return Object.freeze({
        sourceBranch: 'production',
        checks: [],
        protectedPaths: [],
        humanMergePaths: [],
        instructionFiles: [],
        sizeGuidance: DEFAULT_SIZE_GUIDANCE,
        ...overrides,
    });
}

function diff(
    files: { path: string; status?: string; previousPath?: string; additions?: number }[],
) {
    return {
        files: files.map((f) => ({ status: 'modified', additions: 1, deletions: 0, ...f })),
        truncated: false,
        totalFiles: files.length,
        totalAdditions: files.length,
        totalDeletions: 0,
        patchBytes: 0,
    };
}

function harness() {
    const m = {
        resolve: jest.fn(async (_work: unknown, _sha: string) => rules()),
        getLatestCommit: jest.fn(async (..._args: unknown[]) => ({ sha: BASE_TIP })),
        getCompareDiff: jest.fn(async (..._args: unknown[]) => diff([{ path: 'src/app.ts' }])),
        getFileContent: jest.fn(
            async (..._args: unknown[]): Promise<{ content: string; encoding: string } | null> => ({
                content: 'spec: {}',
                encoding: 'utf-8',
            }),
        ),
        getEffectiveSpec: jest.fn(async (..._args: unknown[]) => ({
            status: 'valid',
            spec: { source: { relation: 'fork', branch: 'production' } } as AppSpec,
        })),
        parseDraft: jest.fn(async (..._args: unknown[]) => ({
            status: 'valid',
            spec: { source: { relation: 'fork', branch: 'production' } } as AppSpec | null,
        })),
    };
    const gate = new AppWorkChangeGateService(
        { resolve: m.resolve } as unknown as AppWorkRulesService,
        new AppChangeGuard(),
        {
            getEffectiveSpec: m.getEffectiveSpec,
            parseDraft: m.parseDraft,
        } as unknown as AppSpecService,
        {
            getLatestCommit: m.getLatestCommit,
            getCompareDiff: m.getCompareDiff,
            getFileContent: m.getFileContent,
        } as unknown as GitFacadeService,
    );
    return { gate, m };
}

function input(overrides: Partial<AppWorkChangeGateInput> = {}): AppWorkChangeGateInput {
    return {
        work: WORK,
        taskLabels: [],
        owner: 'acme',
        repo: 'their-app',
        gitOptions: { userId: 'u-1', providerId: 'github', workId: 'w-1' },
        baseRef: 'production',
        branch: 'ever-works/task/x',
        ...overrides,
    };
}

describe('the rules commit — read by the platform, never supplied', () => {
    it('reads the base branch tip and judges by the rules AT that commit', async () => {
        const { gate, m } = harness();

        await gate.evaluate(input());

        expect(m.getLatestCommit).toHaveBeenCalledWith(
            'acme',
            'their-app',
            'production',
            expect.objectContaining({ workId: 'w-1' }),
        );
        expect(m.resolve).toHaveBeenCalledWith(WORK, BASE_TIP);
    });

    it('refuses when the base tip cannot be read, before reading any rules', async () => {
        const { gate, m } = harness();
        m.getLatestCommit.mockResolvedValue(null as never);

        const verdict = await gate.evaluate(input());

        expect(verdict.allowed).toBe(false);
        expect(m.resolve).not.toHaveBeenCalled();
    });

    it('compares the pushed branch against the base branch, capped at the policeable size', async () => {
        const { gate, m } = harness();

        await gate.evaluate(input());

        expect(m.getCompareDiff).toHaveBeenCalledWith(
            'acme',
            'their-app',
            'production',
            'ever-works/task/x',
            { maxFiles: 300 },
            expect.anything(),
        );
    });
});

describe('nothing escapes — every failure is a refusal that says so', () => {
    it('turns an unreadable spec into a refusal', async () => {
        const { gate, m } = harness();
        m.resolve.mockRejectedValue(new AppSpecUnreadableError('w-1', 'production', 'invalid'));

        const verdict = await gate.evaluate(input());

        expect(verdict).toMatchObject({ allowed: false });
        expect(verdict.allowed === false && verdict.message).toContain('could not be read');
    });

    it('turns a provider that cannot diff into a refusal', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockRejectedValue(new Error('getCompareDiff is not supported'));

        await expect(gate.evaluate(input())).resolves.toMatchObject({ allowed: false });
    });

    it('turns a failing base-tip read into a refusal', async () => {
        const { gate, m } = harness();
        m.getLatestCommit.mockRejectedValue(new Error('502'));

        await expect(gate.evaluate(input())).resolves.toMatchObject({ allowed: false });
    });
});

describe('the verdict', () => {
    it('allows a clean change', async () => {
        const { gate } = harness();

        await expect(gate.evaluate(input())).resolves.toEqual({ allowed: true, note: null });
    });

    it('carries the guard’s refusal and paths through', async () => {
        const { gate, m } = harness();
        m.resolve.mockResolvedValue(rules({ protectedPaths: ['infra/**'] }));
        m.getCompareDiff.mockResolvedValue(diff([{ path: 'infra/main.tf' }]));

        const verdict = await gate.evaluate(input());

        expect(verdict).toMatchObject({ allowed: false, paths: ['infra/main.tf'] });
    });

    it('carries the size note through on an allowed change', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: 'src/app.ts', additions: 700 }]));

        const verdict = await gate.evaluate(input());

        expect(verdict.allowed).toBe(true);
        expect(verdict.allowed === true && verdict.note).toContain('700');
    });
});

describe('the branch’s .works/works.yml, three ways', () => {
    it('is not read at all when the diff does not touch it', async () => {
        const { gate, m } = harness();

        await gate.evaluate(input());

        expect(m.getEffectiveSpec).not.toHaveBeenCalled();
        expect(m.getFileContent).not.toHaveBeenCalled();
    });

    it('refuses a branch that DELETES the spec', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: APP_SPEC_PATH, status: 'removed' }]));

        const verdict = await gate.evaluate(input());

        expect(verdict.allowed).toBe(false);
        expect(m.getFileContent).not.toHaveBeenCalled();
    });

    it('refuses a branch that RENAMES the spec away', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(
            diff([{ path: 'docs/old-works.yml', status: 'renamed', previousPath: APP_SPEC_PATH }]),
        );

        await expect(gate.evaluate(input())).resolves.toMatchObject({ allowed: false });
    });

    it('calls an UNREADABLE spec unreadable — not deleted, not invalid', async () => {
        // `getFileContent` answers `null` for a provider that cannot read the
        // file as well as for one that found nothing. Reporting that as "your
        // change deleted the spec" sends a member looking for a deletion that
        // never happened.
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: APP_SPEC_PATH, status: 'modified' }]));
        m.getFileContent.mockResolvedValue(null);

        const verdict = await gate.evaluate(input());

        expect(verdict.allowed).toBe(false);
        const message = verdict.allowed === false ? verdict.message : '';
        expect(message).toContain('could not be read');
        expect(message).not.toContain('invalid');
    });

    it('reads the head spec from the BRANCH and parses it through APW-03', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: APP_SPEC_PATH, status: 'modified' }]));

        await gate.evaluate(input());

        expect(m.getFileContent).toHaveBeenCalledWith(
            'acme',
            'their-app',
            APP_SPEC_PATH,
            expect.anything(),
            'ever-works/task/x',
        );
        expect(m.parseDraft).toHaveBeenCalledWith('w-1', 'spec: {}');
        expect(m.getEffectiveSpec).toHaveBeenCalledWith('w-1', BASE_TIP);
    });

    it('refuses a head spec with errors — APW-03 answers it as a null spec', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: APP_SPEC_PATH, status: 'modified' }]));
        m.parseDraft.mockResolvedValue({ status: 'invalid', spec: null });

        const verdict = await gate.evaluate(input());

        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed === false && verdict.message).toContain('invalid');
    });

    it('refuses a change to a guarded block', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: APP_SPEC_PATH, status: 'modified' }]));
        m.parseDraft.mockResolvedValue({
            status: 'valid',
            spec: { source: { relation: 'fork', branch: 'somewhere-else' } } as AppSpec,
        });

        const verdict = await gate.evaluate(input());

        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed === false && verdict.message).toContain('source');
    });

    it('lets APW-04’s app-provision label past rule 4, and only rule 4', async () => {
        const { gate, m } = harness();
        m.getCompareDiff.mockResolvedValue(diff([{ path: APP_SPEC_PATH, status: 'modified' }]));
        m.parseDraft.mockResolvedValue({
            status: 'valid',
            spec: { source: { relation: 'fork', branch: 'somewhere-else' } } as AppSpec,
        });

        await expect(
            gate.evaluate(input({ taskLabels: ['app-provision'] })),
        ).resolves.toMatchObject({
            allowed: true,
        });
    });
});

describe('checkPaths — the pre-write question (FR-8)', () => {
    const pathsInput = (paths: string[]) => ({
        work: WORK,
        owner: 'acme',
        repo: 'their-app',
        gitOptions: { userId: 'u-1', providerId: 'github', workId: 'w-1' },
        baseRef: 'production',
        paths,
    });

    it('allows paths that match nothing, reading the rules at the base tip', async () => {
        const { gate, m } = harness();

        await expect(gate.checkPaths(pathsInput(['src/app.ts']))).resolves.toEqual({
            allowed: true,
            note: null,
        });
        expect(m.resolve).toHaveBeenCalledWith(WORK, BASE_TIP);
    });

    it('refuses a protected path and names it', async () => {
        const { gate, m } = harness();
        m.resolve.mockResolvedValue(rules({ protectedPaths: ['infra/**'] }));

        const verdict = await gate.checkPaths(pathsInput(['src/app.ts', 'infra/main.tf']));

        expect(verdict).toMatchObject({ allowed: false, paths: ['infra/main.tf'] });
    });

    it('refuses a workflow file whatever the spec says — a pushed workflow can RUN', async () => {
        const { gate } = harness();

        const verdict = await gate.checkPaths(pathsInput(['.github/workflows/ci.yml']));

        expect(verdict).toMatchObject({ allowed: false, paths: ['.github/workflows/ci.yml'] });
    });

    it('asks nothing of the provider for an empty list', async () => {
        const { gate, m } = harness();

        await expect(gate.checkPaths(pathsInput([]))).resolves.toMatchObject({ allowed: true });
        expect(m.getLatestCommit).not.toHaveBeenCalled();
    });

    it('refuses, and never throws, when the rules cannot be read', async () => {
        const { gate, m } = harness();
        m.resolve.mockRejectedValue(new AppSpecUnreadableError('w-1', 'production', 'invalid'));

        const verdict = await gate.checkPaths(pathsInput(['src/app.ts']));

        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed === false && verdict.message).toContain('could not be read');
    });

    it('refuses when the base tip cannot be read', async () => {
        const { gate, m } = harness();
        m.getLatestCommit.mockResolvedValue(null as never);

        await expect(gate.checkPaths(pathsInput(['src/app.ts']))).resolves.toMatchObject({
            allowed: false,
        });
        expect(m.resolve).not.toHaveBeenCalled();
    });
});
