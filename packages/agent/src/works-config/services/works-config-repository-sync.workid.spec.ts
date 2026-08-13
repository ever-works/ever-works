import { WorksConfigRepositorySyncService } from './works-config-repository-sync.service';

/**
 * Guard: every git-facade call from the config sync must carry `workId`.
 *
 * `GitFacade.resolveToken` short-circuits to the platform PAT via
 * `tryResolveEverWorksGitPlatformToken`, whose first line is
 * `if (!options.workId) return null`. Without the id it cannot look the Work up
 * to see that `storageProvider === 'ever-works-git'`, so the short-circuit
 * never fires and the facade falls through to a per-user credential lookup.
 *
 * That is exactly what broke Work creation on production for managed storage:
 *
 *     NoGitCredentialsError: No connected account found for user <id>
 *     with provider github
 *     -> API surfaced 400 "Repository not found"
 *
 * A user on managed storage has no personal GitHub connection BY DESIGN, so
 * this failed for every such user while the repo sat in the platform org.
 *
 * This asserts on the OPTIONS OBJECT handed to the facade rather than on the
 * outcome, because the outcome depends on a real token: a test that mocked the
 * facade to succeed would pass whether or not `workId` was threaded through —
 * which is precisely how the omission survived. The facade is mocked here only
 * to record its arguments.
 */
describe('WorksConfigRepositorySyncService — workId reaches the git facade', () => {
    const WORK_ID = 'work-123';
    const USER_ID = 'user-456';

    /** Calls that resolve a token and therefore need `workId`. */
    const TOKEN_RESOLVING_CALLS = ['cloneOrPull', 'pull', 'push'] as const;

    function build() {
        const calls: Record<string, unknown[][]> = {};
        const record =
            (name: string) =>
            (...args: unknown[]) => {
                (calls[name] ||= []).push(args);
                if (name === 'cloneOrPull') return Promise.resolve('/tmp/repo');
                if (name === 'getStatus') return Promise.resolve([{ path: '.works/works.yml' }]);
                return Promise.resolve(undefined);
            };

        const gitFacade = {
            cloneOrPull: jest.fn(record('cloneOrPull')),
            getStatus: jest.fn(record('getStatus')),
            addAll: jest.fn(record('addAll')),
            commit: jest.fn(record('commit')),
            pull: jest.fn(record('pull')),
            push: jest.fn(record('push')),
        };

        const work = {
            id: WORK_ID,
            gitProvider: 'github',
            storageProvider: 'ever-works-git',
            user: { id: USER_ID },
            getRepoOwner: () => 'ever-works-cloud',
            getDataRepo: () => 'probe-data',
            resolveCommitter: () => ({ name: 'x', email: 'x@example.com' }),
        };

        // Constructor order is (workRepository, gitFacade, projection, writer,
        // eventEmitter?). Getting projection/writer the wrong way round makes
        // the flow throw before it reaches `push`, which reads as "push was
        // never called" rather than as a wiring mistake — worth naming.
        const service = new WorksConfigRepositorySyncService(
            { findById: jest.fn().mockResolvedValue(work) } as never,
            gitFacade as never,
            { buildWriteRequest: jest.fn().mockResolvedValue({}) } as never,
            { writeToDataRepository: jest.fn().mockResolvedValue(undefined) } as never,
            undefined as never,
        );

        return { service, gitFacade, calls };
    }

    it('passes workId on every call that resolves a token', async () => {
        const { service, calls } = build();

        await service
            .syncWork({ workId: WORK_ID, userId: USER_ID, reason: 'test' } as never)
            .catch(() => undefined);

        for (const name of TOKEN_RESOLVING_CALLS) {
            const invocations = calls[name] || [];

            // Control: the call must actually have happened, otherwise "no
            // missing workId" would be vacuously true.
            // jest expect() takes no message arg; the failure names the call via the loop.
            expect({ call: name, invocations: invocations.length }).toEqual({
                call: name,
                invocations: invocations.length,
            });
            expect(invocations.length).toBeGreaterThan(0);

            for (const args of invocations) {
                const opts = args.find(
                    (a) => a && typeof a === 'object' && 'providerId' in (a as object),
                ) as { workId?: string } | undefined;

                expect(opts).toBeDefined();
                expect({ call: name, workId: opts!.workId }).toEqual({
                    call: name,
                    workId: WORK_ID,
                });
            }
        }
    });
});
