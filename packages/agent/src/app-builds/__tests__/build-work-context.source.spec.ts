import { AppBuildWorkContextSource } from '../build-work-context.source';
import {
    AppBuildSpecReadSource,
    BUILDABLE_SPEC_STATUSES,
    isUsableStatus,
} from '../build-spec.source';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';
import type { AppSpecService } from '../../app-spec/app-spec.service';

/**
 * APW-05 — the two sources a Build cannot be requested without.
 *
 * Both are adapters rather than aliases, and both have one rule worth
 * protecting:
 *
 *   - `APP_BUILD_WORK_SOURCE` answers **all six facts or `null`**. A Build is a
 *     push to a member's repository; a context with one guessed field in it
 *     pushes the wrong thing, or pushes it to the wrong place, and neither
 *     failure looks like a bug from the outside;
 *   - `APP_BUILD_SPEC_SOURCE` collapses APW-03's six-value status to a boolean,
 *     and that collapse is the whole decision the file makes.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function works(work: unknown): WorkRepository {
    return { findById: jest.fn(async () => work) } as unknown as WorkRepository;
}

function specStates(trackedBranch: string | null): WorkAppSpecStateRepository {
    return {
        findByWorkId: jest.fn(async () => (trackedBranch === null ? null : { trackedBranch })),
    } as unknown as WorkAppSpecStateRepository;
}

function plugins(pluginId: string | null) {
    return { resolve: jest.fn(async () => (pluginId ? { pluginId } : null)) } as never;
}

const WORK = {
    id: WORK_ID,
    userId: USER_ID,
    sourceRepository: { owner: 'acme', repo: 'their-app' },
};

describe('AppBuildWorkContextSource', () => {
    it('assembles the six facts from their four owners', async () => {
        const source = new AppBuildWorkContextSource(
            works(WORK),
            specStates('main'),
            plugins('github-actions-build'),
        );

        expect(await source.read(WORK_ID)).toEqual({
            workId: WORK_ID,
            userId: USER_ID,
            trackedBranch: 'main',
            buildPluginId: 'github-actions-build',
            repositoryFullName: 'acme/their-app',
            repositoryVisibility: 'private',
        });
    });

    it('reports visibility as private, agreeing with upstream-build-facts.source', async () => {
        // Nothing in this tree records a repository's visibility. `private` is
        // the safe direction in both places it is read: the larger runner class
        // and a pull token. The two files must not disagree, because nothing
        // would notice if they did.
        const source = new AppBuildWorkContextSource(works(WORK), specStates('main'), plugins('p'));

        expect((await source.read(WORK_ID))?.repositoryVisibility).toBe('private');
    });

    it('answers null rather than DEFAULTING the tracked branch', async () => {
        // A Build dispatched on the wrong branch builds the wrong commit, and
        // "we assumed main" is not something a member can see or correct.
        const source = new AppBuildWorkContextSource(works(WORK), specStates(null), plugins('p'));

        expect(await source.read(WORK_ID)).toBeNull();
    });

    it('answers null for a blank tracked branch, not an empty string', async () => {
        const source = new AppBuildWorkContextSource(works(WORK), specStates('   '), plugins('p'));

        expect(await source.read(WORK_ID)).toBeNull();
    });

    it('answers null when the repository coordinates are absent', async () => {
        // Inventing `owner/repo` from the slug would dispatch a workflow at a
        // repository nobody asked about.
        const source = new AppBuildWorkContextSource(
            works({ ...WORK, sourceRepository: undefined }),
            specStates('main'),
            plugins('p'),
        );

        expect(await source.read(WORK_ID)).toBeNull();
    });

    it('answers null when no plugin will run the Build', async () => {
        // The resolver has already logged WHY — no registry, no plugin, no
        // credential — and a Build row naming no plugin cannot be dispatched.
        const source = new AppBuildWorkContextSource(
            works(WORK),
            specStates('main'),
            plugins(null),
        );

        expect(await source.read(WORK_ID)).toBeNull();
    });

    it('answers null for a Work that does not exist, and for one with no owner', async () => {
        expect(
            await new AppBuildWorkContextSource(works(null), specStates('main'), plugins('p')).read(
                WORK_ID,
            ),
        ).toBeNull();
        expect(
            await new AppBuildWorkContextSource(
                works({ ...WORK, userId: null }),
                specStates('main'),
                plugins('p'),
            ).read(WORK_ID),
        ).toBeNull();
    });

    it('survives an unbound spec-state repository without throwing', async () => {
        // The lazy `ModuleRef` lookup answers null in an injector that has none.
        const source = new AppBuildWorkContextSource(works(WORK), null, plugins('p'));

        expect(await source.read(WORK_ID)).toBeNull();
    });
});

describe('AppBuildSpecReadSource', () => {
    function specs(read: Record<string, unknown> | null): AppSpecService {
        return { getEffectiveSpec: jest.fn(async () => read) } as unknown as AppSpecService;
    }

    it('narrows the eleven-field read to the four §5.1 uses', async () => {
        const source = new AppBuildSpecReadSource(
            specs({
                status: 'valid',
                workId: WORK_ID,
                spec: { kind: 'app' },
                specHash: 'sha256:abc',
                commitSha: 'c'.repeat(40),
                issues: [],
                errorCount: 0,
                warningCount: 0,
                source: 'stored',
                error: null,
            }),
        );

        expect(await source.read(WORK_ID)).toEqual({
            spec: { kind: 'app' },
            commitSha: 'c'.repeat(40),
            specHash: 'sha256:abc',
            valid: true,
        });
    });

    it('treats valid_with_warnings as buildable — APW-03 has two statuses on purpose', async () => {
        const source = new AppBuildSpecReadSource(specs({ status: 'valid_with_warnings' }));

        expect((await source.read(WORK_ID))?.valid).toBe(true);
    });

    it('treats "could not tell" the same as "broken"', async () => {
        // `missing` and `unreadable` are not failures of the spec, but a Build
        // of a commit whose spec we could not read is a Build we cannot
        // describe. Refusing is the safe direction.
        for (const status of ['invalid', 'missing', 'unreadable', 'no_state', '', 'anything']) {
            const source = new AppBuildSpecReadSource(specs({ status }));
            expect((await source.read(WORK_ID))?.valid).toBe(false);
        }
    });

    it('passes the commit through so the spec is read AT the Build’s commit', async () => {
        const service = specs({ status: 'valid' });
        await new AppBuildSpecReadSource(service).read(WORK_ID, 'd'.repeat(40));

        expect(service.getEffectiveSpec).toHaveBeenCalledWith(WORK_ID, 'd'.repeat(40));
    });

    it('normalises an absent sha to null rather than undefined', async () => {
        const service = specs({ status: 'valid' });
        await new AppBuildSpecReadSource(service).read(WORK_ID);

        expect(service.getEffectiveSpec).toHaveBeenCalledWith(WORK_ID, null);
    });

    it('answers null only for a Work with no App spec state at all', async () => {
        expect(await new AppBuildSpecReadSource(specs(null)).read(WORK_ID)).toBeNull();
    });

    it('names the buildable statuses in one list', () => {
        expect([...BUILDABLE_SPEC_STATUSES]).toEqual(['valid', 'valid_with_warnings']);
        expect(isUsableStatus('valid')).toBe(true);
        expect(isUsableStatus(null)).toBe(false);
        expect(isUsableStatus(undefined)).toBe(false);
    });
});
