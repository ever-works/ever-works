import { WORK_KINDS, WORK_KIND_CAPABILITIES } from '@ever-works/contracts';

import { Work } from '../../entities/work.entity';
import {
    findTaskForPullRequest,
    kindHasTaskRepository,
    requireTaskRepository,
    resolveTaskRepository,
    taskRepositoryFullName,
    taskRepositoryRole,
    type TaskRepositoryWork,
} from '../task-repository';

/**
 * The repository a Task acts on.
 *
 * Every Task path used to resolve it as the `data` role unconditionally. For an
 * App Work that is `${slug}-data` — a repository that does not exist, because
 * APW-01 records an App Work's code in the `website` role only and the
 * capability registry turns the `data` role OFF for `app`.
 *
 * Two properties carry this file, and the golden table below pins both:
 *
 *   1. every kind that HAS a data repository resolves exactly as before, down
 *      to calling `getRepoOwner()` with no argument;
 *   2. the answer comes from the registry, so it cannot drift from what the
 *      registry says a kind has.
 */

type Calls = { owner: unknown[][]; data: number; website: number };

function double(kind: string | null | undefined, opts: { withWebsite?: boolean } = {}) {
    const calls: Calls = { owner: [], data: 0, website: 0 };
    const work: TaskRepositoryWork = {
        kind,
        getRepoOwner: (...args: unknown[]) => {
            calls.owner.push(args);
            return args[0] === 'website' ? 'site-owner' : 'data-owner';
        },
        getDataRepo: () => {
            calls.data += 1;
            return 'the-data-repo';
        },
        ...(opts.withWebsite === false
            ? {}
            : {
                  getWebsiteRepo: () => {
                      calls.website += 1;
                      return 'the-work-repo';
                  },
              }),
    };
    return { work, calls };
}

describe('taskRepositoryRole — read from the capability registry', () => {
    it.each(WORK_KINDS.map((kind) => [kind]))('%s resolves as its registry entry says', (kind) => {
        const { repos } = WORK_KIND_CAPABILITIES[kind];
        const expected = repos.data ? 'data' : repos.website ? 'website' : 'data';

        expect(taskRepositoryRole(kind)).toBe(expected);
    });

    it('sends exactly ONE kind to the website role today: `app`', () => {
        // Pinned on purpose. A new kind that has only a Work Repository gets the
        // right answer from the registry without touching this file — but it
        // should still be a CONSCIOUS change, because every Task path moves
        // with it. This case is where that conversation starts.
        const websiteKinds = WORK_KINDS.filter((kind) => taskRepositoryRole(kind) === 'website');

        expect(websiteKinds).toEqual(['app']);
    });

    it('treats an unknown, blank or absent kind as the directory default — data', () => {
        for (const kind of ['something-new', '', '   ', null, undefined]) {
            expect(taskRepositoryRole(kind)).toBe('data');
        }
    });

    it('normalises case and whitespace the way the registry does', () => {
        expect(taskRepositoryRole(' APP ')).toBe('website');
    });
});

describe('resolveTaskRepository — the data branch is today’s call, verbatim', () => {
    it.each(
        // `app` reads its Work Repository; `project` (EW-P2-4) has no repository.
        WORK_KINDS.filter((kind) => kind !== 'app' && kind !== 'project').map((kind) => [kind]),
    )('%s: getRepoOwner() with NO argument, and getDataRepo()', (kind) => {
        const { work, calls } = double(kind);

        expect(resolveTaskRepository(work)).toEqual({
            role: 'data',
            owner: 'data-owner',
            repo: 'the-data-repo',
        });
        // Exactly the call every site made before this file existed. A
        // structural double implementing `getRepoOwner: () => 'x'` sees
        // the same thing it always saw.
        expect(calls.owner).toEqual([[]]);
        expect(calls.data).toBe(1);
        expect(calls.website).toBe(0);
    });

    it('keeps a Work with no `kind` on the data role', () => {
        const { work } = double(undefined);

        expect(resolveTaskRepository(work)?.role).toBe('data');
    });
});

describe('resolveTaskRepository — an App Work’s Work Repository', () => {
    it('reads the website role for `app`', () => {
        const { work, calls } = double('app');

        expect(resolveTaskRepository(work)).toEqual({
            role: 'website',
            owner: 'site-owner',
            repo: 'the-work-repo',
        });
        expect(calls.owner).toEqual([['website']]);
        expect(calls.data).toBe(0);
    });

    it('falls back to data for a narrowed shape that cannot answer website', () => {
        // Several call sites hand in structural shapes rather than the entity.
        // One without `getWebsiteRepo` resolves as it did before this file.
        const { work } = double('app', { withWebsite: false });

        expect(resolveTaskRepository(work)?.role).toBe('data');
    });

    it('names the repository for copy', () => {
        expect(taskRepositoryFullName(double('app').work)).toBe('site-owner/the-work-repo');
        expect(taskRepositoryFullName(double('directory').work)).toBe('data-owner/the-data-repo');
    });
});

describe('against the real Work entity — the phantom repository this replaces', () => {
    /** An App Work exactly as APW-01 writes it: the `website` role, and only it. */
    function appWork(): Work {
        return Object.assign(new Work(), {
            id: 'w-app',
            slug: 'their-app',
            kind: 'app',
            owner: 'acme',
            sourceRepository: {
                url: 'https://github.com/acme/their-app',
                owner: 'acme',
                repo: 'their-app',
                type: 'app_fork',
                importedAt: new Date(),
                relatedRepositories: { website: { owner: 'acme', repo: 'their-app' } },
            },
        });
    }

    it('shows what getDataRepo() answered for an App Work: a repository that does not exist', () => {
        // Recorded so the reason for this file stays visible: `${slug}-data` is
        // `getDefaultRepositoryName('data')`'s fallback, and APW-01 never
        // writes a `data` entry for an App Work.
        expect(appWork().getDataRepo()).toBe('their-app-data');
    });

    it('resolves the App Work’s real repository instead', () => {
        expect(resolveTaskRepository(appWork())).toEqual({
            role: 'website',
            owner: 'acme',
            repo: 'their-app',
        });
    });

    it('leaves a directory Work on its data repository', () => {
        const directory = Object.assign(new Work(), {
            id: 'w-dir',
            slug: 'tools',
            kind: 'directory',
            owner: 'acme',
        });

        expect(resolveTaskRepository(directory)).toEqual({
            role: 'data',
            owner: 'acme',
            repo: directory.getDataRepo(),
        });
    });
});

/** EW-P2-4 — the repo-less Project kind: its Tasks run without a repository. */
describe('a Project Work has no Task repository', () => {
    it('only `project` has no Task repository', () => {
        expect(WORK_KINDS.filter((kind) => !kindHasTaskRepository(kind))).toEqual(['project']);
    });

    it('resolves to none — never the derived `${slug}-data` name', () => {
        const { work, calls } = double('project');
        expect(resolveTaskRepository(work)).toBeNull();
        expect(taskRepositoryFullName(work)).toBeNull();
        expect(calls.data).toBe(0);
        expect(calls.owner).toEqual([]);
    });

    it('requireTaskRepository refuses it with a 400 naming the kind and the action', () => {
        const { work } = double(' Project ');
        expect(() => requireTaskRepository(work, 'opening a pull request')).toThrow(
            /has no repository \(a " Project " Work\) — opening a pull request is not available/,
        );
        expect(requireTaskRepository(double('directory').work, 'x')).toEqual({
            role: 'data',
            owner: 'data-owner',
            repo: 'the-data-repo',
        });
    });

    it('findTaskForPullRequest never matches a Project Work through its derived names', async () => {
        const project = Object.assign(new Work(), {
            id: 'w-project',
            slug: 'relaunch',
            kind: 'project',
            owner: 'acme',
        });
        const lookup = jest.fn().mockResolvedValue({ id: 'task-1' });
        await expect(
            findTaskForPullRequest([project], 'acme', project.getDataRepo(), 7, lookup),
        ).resolves.toBeNull();
        expect(lookup).not.toHaveBeenCalled();
    });
});
