import type { FleetTaskWorkspaceSpec } from '@ever-works/contracts';
import type { Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * Reading the commands a repository declares (EW-807), on the PLATFORM,
 * at plan time.
 *
 * Two properties are load-bearing here and nowhere else:
 *
 *  1. **The read is gated on the OWNER'S opt-in, before any network call.**
 *     A Work whose `repoDeclaredCommands` is absent or `off` — every Work
 *     that exists — never even fetches the file. So a repository cannot
 *     make a platform do work, or make a machine run a command, by
 *     writing to a file.
 *  2. **The read is at the workspace's BASE REF.** Not the default branch
 *     (which is what every other `.works/works.yml` read uses) and not
 *     the Task branch (which the model is about to write to). A run is
 *     judged by the config of the branch it started from.
 *
 * Everything else in this file is the refusal posture: an unreadable or
 * malformed declaration fails the plan rather than resolving to an empty
 * set, because an empty set is a green run that verified nothing.
 */

const workspace: FleetTaskWorkspaceSpec = {
    repositoryId: 'ever-works/ever-works',
    repoUrl: 'https://github.com/ever-works/ever-works.git',
    baseRef: 'develop',
    branch: 'task/tsk-9',
    mounts: [
        {
            repositoryId: 'ever-works/directory-web-template',
            repoUrl: 'https://github.com/ever-works/directory-web-template.git',
            baseRef: 'develop',
            branch: 'task/tsk-9',
            mountDir: 'template',
            writable: true,
        },
    ],
};

function makeTask(): Task {
    return {
        id: 'task-1',
        slug: 'TSK-9',
        userId: 'user-1',
        workId: 'work-1',
    } as unknown as Task;
}

function makeWork(repoDeclaredCommands: unknown) {
    return {
        id: 'work-1',
        gitProvider: 'github',
        repoDeclaredCommands,
        getRepoOwner: () => 'ever-works',
        getDataRepo: () => 'ever-works',
    };
}

const CONFIG = [
    'version: 2',
    'kind: repo',
    'spec:',
    '  kind: repo',
    '  tasks:',
    '    setup:',
    '      - pnpm install --frozen-lockfile',
    '    checks:',
    '      - pnpm lint',
    '      - command: pnpm test',
    '        mount: template',
    '        name: Template suite',
].join('\n');

describe('TaskWorkspaceService.readFleetRepoDeclaredCommands', () => {
    let works: { findById: jest.Mock };
    let gitFacade: { getFileContent: jest.Mock };

    const build = () =>
        new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            {} as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
            gitFacade as unknown as ServiceArgs[4],
        );

    const read = () =>
        build().readFleetRepoDeclaredCommands({ task: makeTask(), userId: 'user-1', workspace });

    beforeEach(() => {
        gitFacade = {
            getFileContent: jest.fn().mockResolvedValue({ content: CONFIG, encoding: 'utf8' }),
        };
        works = { findById: jest.fn().mockResolvedValue(makeWork({ mode: 'off', allow: [] })) };
    });

    it('never reads the file for a Work that has not opted in', async () => {
        for (const policy of [
            null,
            undefined,
            { mode: 'off', allow: ['pnpm test'] },
            'nonsense',
            [],
        ]) {
            works.findById.mockResolvedValue(makeWork(policy));
            expect(await read()).toEqual({ setup: [], checks: [] });
        }
        expect(gitFacade.getFileContent).not.toHaveBeenCalled();
    });

    it('reads at the workspace BASE REF, not the default branch and not the Task branch', async () => {
        works.findById.mockResolvedValue(
            makeWork({
                mode: 'allowlist',
                allow: ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm test'],
            }),
        );
        await read();
        expect(gitFacade.getFileContent).toHaveBeenCalledWith(
            'ever-works',
            'ever-works',
            '.works/works.yml',
            { userId: 'user-1', providerId: 'github', workId: 'work-1' },
            'develop',
        );
    });

    it('admits the allow-listed declarations as frozen setup steps and checks', async () => {
        works.findById.mockResolvedValue(
            makeWork({
                mode: 'allowlist',
                allow: ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm test'],
            }),
        );
        const admitted = await read();
        expect(admitted.setup.map((entry) => [entry.id, entry.command, entry.phase])).toEqual([
            ['repo/setup-1', 'pnpm install --frozen-lockfile', 'setup'],
        ]);
        expect(admitted.checks.map((entry) => [entry.id, entry.command, entry.mountDir])).toEqual([
            ['repo/check-1', 'pnpm lint', undefined],
            ['repo/check-2', 'pnpm test', 'template'],
        ]);
        expect(admitted.checks[1].name).toBe('Template suite');
    });

    it('REFUSES when the repository declares a command the allow-list does not carry', async () => {
        works.findById.mockResolvedValue(
            makeWork({ mode: 'allowlist', allow: ['pnpm install --frozen-lockfile', 'pnpm lint'] }),
        );
        await expect(read()).rejects.toThrowError(
            /'pnpm test', which is not on this Work's allow-list/,
        );
    });

    it('REFUSES a provider error instead of resolving to an empty set', async () => {
        works.findById.mockResolvedValue(makeWork({ mode: 'allowlist', allow: ['pnpm test'] }));
        gitFacade.getFileContent.mockRejectedValue(new Error('502 Bad Gateway'));
        // "We could not read the file that says how to verify this change,
        // so we verified it with nothing" is the silent fallback the slice
        // removes.
        await expect(read()).rejects.toThrowError(
            /Could not read \.works\/works\.yml .*502 Bad Gateway/,
        );
    });

    it('REFUSES a file that is not valid YAML, or is not a mapping', async () => {
        works.findById.mockResolvedValue(makeWork({ mode: 'allowlist', allow: ['pnpm test'] }));
        gitFacade.getFileContent.mockResolvedValue({
            content: 'spec: [unclosed',
            encoding: 'utf8',
        });
        await expect(read()).rejects.toThrowError(/is not valid YAML/);

        gitFacade.getFileContent.mockResolvedValue({ content: '- one\n- two\n', encoding: 'utf8' });
        await expect(read()).rejects.toThrowError(/must contain a YAML mapping at the root/);
    });

    it('REFUSES a malformed spec.tasks rather than grading nothing', async () => {
        works.findById.mockResolvedValue(makeWork({ mode: 'allowlist', allow: ['pnpm test'] }));
        gitFacade.getFileContent.mockResolvedValue({
            content: 'spec:\n  tasks:\n    checks: pnpm test\n',
            encoding: 'utf8',
        });
        await expect(read()).rejects.toThrowError(/spec\.tasks\.checks must be a list of commands/);
    });

    it('treats a repository with no config file, or one declaring nothing, as declaring nothing', async () => {
        works.findById.mockResolvedValue(makeWork({ mode: 'allowlist', allow: ['pnpm test'] }));
        gitFacade.getFileContent.mockResolvedValue(null);
        expect(await read()).toEqual({ setup: [], checks: [] });

        gitFacade.getFileContent.mockResolvedValue({
            content: 'name: Platform\nkind: repo\n',
            encoding: 'utf8',
        });
        expect(await read()).toEqual({ setup: [], checks: [] });
    });

    it('REFUSES a declaration naming a repository this Task does not mount', async () => {
        works.findById.mockResolvedValue(
            makeWork({
                mode: 'allowlist',
                allow: ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm test'],
            }),
        );
        const noMounts = { ...workspace, mounts: [] };
        await expect(
            build().readFleetRepoDeclaredCommands({
                task: makeTask(),
                userId: 'user-1',
                workspace: noMounts,
            }),
        ).rejects.toThrowError(/repository 'template', which this Task does not mount/);
    });

    /**
     * The last silent fallback on this read path. Control only reaches the
     * owner/repo lookup for a Work that OPTED IN — the policy gate and the
     * git-facade gate are already behind us — so an empty set here grades
     * the run by the owner's checks alone and reports it green having
     * verified less than the repository asked for. Every neighbouring
     * failure on this method throws; this one did not.
     */
    it('REFUSES when the opted-in Work has no resolvable repository coordinates', async () => {
        works.findById.mockResolvedValue({
            ...makeWork({ mode: 'allowlist', allow: ['pnpm test'] }),
            getRepoOwner: () => '',
            getDataRepo: () => 'ever-works',
        });
        await expect(read()).rejects.toThrowError(/repository coordinates do not resolve/);
        expect(gitFacade.getFileContent).not.toHaveBeenCalled();
    });

    it('REFUSES when the runtime has no git facade but the Work reads declarations', async () => {
        works.findById.mockResolvedValue(makeWork({ mode: 'allowlist', allow: ['pnpm test'] }));
        const service = new TaskWorkspaceService(
            works as unknown as ServiceArgs[0],
            {} as unknown as ServiceArgs[1],
            {} as unknown as ServiceArgs[2],
            {} as unknown as ServiceArgs[3],
        );
        await expect(
            service.readFleetRepoDeclaredCommands({
                task: makeTask(),
                userId: 'user-1',
                workspace,
            }),
        ).rejects.toThrowError(/no git facade is available/);
    });
});
