import { AppDeployDeploymentStoreAdapter } from '../app-deploy-deployment.store';
import type { AppDeployRowDraft } from '../app-deploy-request.service';
import type { WorkDeploymentRepository } from '../../database/repositories/work-deployment.repository';

/**
 * APW-06 T16 — `APP_DEPLOY_DEPLOYMENT_STORE` over `WorkDeploymentRepository`.
 *
 * The four members are small, and three of them are the reason this is an
 * adapter rather than a `useExisting` alias. Each has one property worth
 * protecting:
 *
 *   - `create` writes the four App facts the draft carries. Before T16's columns
 *     existed, TypeORM dropped all four silently — a row that said nothing about
 *     which Build ran, which cluster it went to, or why;
 *   - `markSuperseded` **merges** `supersededBy` into `appRender` rather than
 *     replacing it. Replacing loses the namespace and spec commit of the
 *     Deployment that was replaced, which is the row an owner opens to ask what
 *     happened;
 *   - `findById` narrows to the five fields the queue decision reads;
 *   - the two best-effort members resolve on failure, because the caller already
 *     has a `deploymentId` and a status to return by then.
 */

const DRAFT: AppDeployRowDraft = {
    id: 'd-1',
    workId: 'w-1',
    state: 'INITIALIZING',
    provider: 'k8s',
    triggerSource: 'manual',
    appTrigger: 'build',
    buildId: 'b-1',
    appTarget: 'your-cluster',
    commitSha: 'a'.repeat(40),
    branch: 'main',
    triggeredByUserId: 'u-1',
    appRender: { specCommitSha: 'a'.repeat(40), namespace: 'ew-app-demo' },
};

type RepoMock = {
    create: jest.Mock;
    findById: jest.Mock;
    update: jest.Mock;
    markTerminal: jest.Mock;
};

function repo(overrides: Partial<RepoMock> = {}): RepoMock {
    return {
        create: jest.fn(async (input: { id?: string }) => ({ ...input, id: input.id ?? 'd-1' })),
        findById: jest.fn(async () => null),
        update: jest.fn(async () => undefined),
        markTerminal: jest.fn(async () => undefined),
        ...overrides,
    };
}

function store(mock: RepoMock): AppDeployDeploymentStoreAdapter {
    return new AppDeployDeploymentStoreAdapter(mock as unknown as WorkDeploymentRepository);
}

describe('AppDeployDeploymentStoreAdapter.create (§2.2 step 4)', () => {
    it('writes the four App facts the draft carries', async () => {
        const mock = repo();

        await store(mock).create(DRAFT);

        expect(mock.create).toHaveBeenCalledWith(
            expect.objectContaining({
                buildId: 'b-1',
                appTarget: 'your-cluster',
                appTrigger: 'build',
                appRender: { specCommitSha: 'a'.repeat(40), namespace: 'ew-app-demo' },
            }),
        );
    });

    it('writes BOTH trigger columns — they are different facts', async () => {
        // `triggerSource` is the pre-existing two-value enum every Work kind
        // uses; `appTrigger` is FR-23's five-value source. Collapsing them would
        // make `manual` and `build` indistinguishable on the history row.
        const mock = repo();

        await store(mock).create(DRAFT);

        const row = mock.create.mock.calls[0][0];
        expect(row.triggerSource).toBe('manual');
        expect(row.appTrigger).toBe('build');
    });

    it('answers the id the repository STORED, not the one we sent', async () => {
        // The draft mints its own id so the row and the deploy lock share an
        // identity. Echoing the draft's id would paper over a repository that
        // ignored it, and the lock would then reference a row that is not there.
        const mock = repo({ create: jest.fn(async () => ({ id: 'd-different' })) });

        expect(await store(mock).create(DRAFT)).toEqual({ id: 'd-different' });
    });

    it('omits the optional columns it has no value for, rather than writing null', async () => {
        const mock = repo();

        await store(mock).create({
            ...DRAFT,
            commitSha: null,
            branch: null,
            triggeredByUserId: null,
        });

        const row = mock.create.mock.calls[0][0];
        expect(row).not.toHaveProperty('commitSha');
        expect(row).not.toHaveProperty('branch');
        expect(row).not.toHaveProperty('triggeredByUserId');
    });

    it('THROWS with no repository — a row that was not created is not a Deployment', async () => {
        // The one member that does not degrade quietly. The request service's
        // own guard reports it; a resolved promise here would hand the caller a
        // deploymentId for a row that does not exist.
        const empty = new AppDeployDeploymentStoreAdapter(undefined);

        await expect(empty.create(DRAFT)).rejects.toThrow(/store unavailable/i);
    });
});

describe('AppDeployDeploymentStoreAdapter.findById', () => {
    it('narrows to the five fields the queue decision reads', async () => {
        const mock = repo({
            findById: jest.fn(async () => ({
                id: 'd-1',
                state: 'DEPLOYING',
                buildId: 'b-1',
                commitSha: 'c'.repeat(40),
                appTrigger: 'manual',
                // Everything below must NOT come through.
                website: 'https://example.test',
                lastError: 'something',
                work: { id: 'w-1' },
            })),
        });

        const facts = await store(mock).findById('d-1');

        expect(facts).toEqual({
            id: 'd-1',
            state: 'DEPLOYING',
            buildId: 'b-1',
            commitSha: 'c'.repeat(40),
            appTrigger: 'manual',
        });
    });

    it('answers null for a row that is not there, and for no repository', async () => {
        expect(await store(repo()).findById('nope')).toBeNull();
        expect(await new AppDeployDeploymentStoreAdapter(undefined).findById('d-1')).toBeNull();
    });
});

describe('AppDeployDeploymentStoreAdapter.markSuperseded (tasks.md:1155)', () => {
    it('MERGES supersededBy into appRender, keeping what is already there', async () => {
        // The property this adapter exists for. Replacing `appRender` loses the
        // namespace and spec commit of the Deployment that was replaced.
        const mock = repo({
            findById: jest.fn(async () => ({
                id: 'd-1',
                appRender: { namespace: 'ew-app-demo', specCommitSha: 'abc' },
            })),
        });

        await store(mock).markSuperseded('d-1', 'd-2');

        expect(mock.update).toHaveBeenCalledWith(
            'd-1',
            expect.objectContaining({
                state: 'SUPERSEDED',
                appRender: { namespace: 'ew-app-demo', specCommitSha: 'abc', supersededBy: 'd-2' },
            }),
        );
    });

    it('merges into an ABSENT appRender without throwing', async () => {
        const mock = repo({ findById: jest.fn(async () => ({ id: 'd-1', appRender: null })) });

        await store(mock).markSuperseded('d-1', 'd-2');

        expect(mock.update.mock.calls[0][1].appRender).toEqual({ supersededBy: 'd-2' });
    });

    it('writes nothing for a row that is not there', async () => {
        const mock = repo();

        await store(mock).markSuperseded('gone', 'd-2');

        expect(mock.update).not.toHaveBeenCalled();
    });

    it('RESOLVES when the write fails — the caller already answered', async () => {
        const mock = repo({
            findById: jest.fn(async () => ({ id: 'd-1', appRender: {} })),
            update: jest.fn(async () => {
                throw new Error('database gone');
            }),
        });

        await expect(store(mock).markSuperseded('d-1', 'd-2')).resolves.toBeUndefined();
    });
});

describe('AppDeployDeploymentStoreAdapter.markDispatchFailed', () => {
    it('ends the row at ERROR with the code in lastError', async () => {
        // Without this the row sits at INITIALIZING holding the deploy lock
        // until it goes stale 7 260 s later.
        const mock = repo();

        await store(mock).markDispatchFailed('d-1', 'dispatch_failed', 'the runtime refused');

        expect(mock.markTerminal).toHaveBeenCalledWith('d-1', 'ERROR', {
            lastError: 'dispatch_failed: the runtime refused',
        });
    });

    it('RESOLVES when the write fails', async () => {
        const mock = repo({
            markTerminal: jest.fn(async () => {
                throw new Error('database gone');
            }),
        });

        await expect(store(mock).markDispatchFailed('d-1', 'x', 'y')).resolves.toBeUndefined();
    });
});
