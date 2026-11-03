import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

import { WorksConfigProjectionService } from '../services/works-config-projection.service';
import { WorksConfigRepositorySyncService } from '../services/works-config-repository-sync.service';
import { WorksConfigService } from '../services/works-config.service';
import { WorksConfigWriterService } from '../services/works-config-writer.service';
import { WorksConfigSyncedEvent } from '@src/events';

jest.mock('@src/generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn(async (dir: string) => ({ dir })) },
}));

/**
 * EW-612 — end-to-end (unit-level) proof that flipping `deployProvider` in the
 * dashboard reaches `.works/works.yml` in the data repo.
 *
 * Everything below the git remote is REAL: the projection that turns a Work
 * row into a write request, and the writer that read-modify-writes the YAML.
 * Only the git facade and the two repositories the projection reads are
 * stubbed, so a regression in either the projection or the writer fails here.
 *
 * The bug this pins: the sync pipeline existed and was already triggered on a
 * dashboard `deployProvider` change, but the projection never carried the
 * column into the write request. The writer's precedence then resolved the
 * field from the EXISTING file — so every sync rewrote the old value, the
 * commit was a no-op, and the dashboard change silently never landed.
 */
describe('works.yml deployProvider auto-sync (EW-612)', () => {
    const committer = { name: 'User One', email: 'user@example.com' };

    let repoDir = '';

    const createWork = (deployProvider: string | null) =>
        ({
            id: 'dir-1',
            name: 'Compare Cloud Pricing',
            gitProvider: 'github',
            deployProvider,
            user: { id: 'owner-1' },
            getRepoOwner: jest.fn((role?: string) =>
                role === 'website' ? 'ever-works-web' : 'ever-works',
            ),
            getDataRepo: jest.fn().mockReturnValue('compare-cloud-pricing-data'),
            getMainRepo: jest.fn().mockReturnValue('compare-cloud-pricing'),
            getWebsiteRepo: jest.fn().mockReturnValue('compare-cloud-pricing-site'),
            resolveCommitter: jest.fn().mockReturnValue(committer),
        }) as any;

    const createService = (work: any) => {
        const workRepository = { findById: jest.fn().mockResolvedValue(work) };
        const gitFacade = {
            cloneOrPull: jest.fn().mockResolvedValue(repoDir),
            getStatus: jest.fn().mockResolvedValue([{ path: '.works/works.yml', status: '*modified' }]),
            addAll: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue('commit-sha'),
            pull: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
        };
        const projection = new WorksConfigProjectionService(
            { findByWorkId: jest.fn().mockResolvedValue(null) } as any,
            {
                findEnabledByWork: jest.fn().mockResolvedValue([]),
                findActiveByCapability: jest.fn().mockResolvedValue(null),
            } as any,
        );
        const writer = new WorksConfigWriterService(new WorksConfigService({} as any));
        const eventEmitter = { emit: jest.fn() };

        return {
            service: new WorksConfigRepositorySyncService(
                workRepository as any,
                gitFacade as any,
                projection,
                writer,
                eventEmitter as any,
            ),
            gitFacade,
            eventEmitter,
        };
    };

    const readWrittenConfig = async () =>
        yaml.parse(await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'));

    beforeEach(async () => {
        repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ew612-deploy-provider-'));
        await fs.mkdir(path.join(repoDir, '.works'), { recursive: true });
        await fs.writeFile(
            path.join(repoDir, '.works/works.yml'),
            [
                'name: Compare Cloud Pricing',
                'initial_prompt: Track cloud pricing',
                'deployProvider: vercel',
                'custom_key: keep-me',
                'nested:',
                '    keep: also-me',
                '',
            ].join('\n'),
            'utf-8',
        );
    });

    afterEach(async () => {
        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('rewrites .works/works.yml with the dashboard deployProvider and commits as the work owner', async () => {
        const work = createWork('k8s');
        const { service, gitFacade } = createService(work);

        await service.syncWork({
            workId: 'dir-1',
            userId: 'user-1',
            reason: 'provider_changed',
        });

        const written = await readWrittenConfig();
        expect(written.deployProvider).toBe('k8s');

        // AC: the commit identity is the work owner's, resolved through the
        // entity's own `resolveCommitter(user)` helper.
        expect(work.resolveCommitter).toHaveBeenCalledWith(work.user);
        expect(gitFacade.commit).toHaveBeenCalledWith(
            'github',
            repoDir,
            'sync .works/works.yml after provider_changed',
            committer,
        );
        expect(gitFacade.push).toHaveBeenCalledWith(
            { dir: repoDir },
            { userId: 'user-1', providerId: 'github', workId: 'dir-1' },
        );
    });

    it('preserves unrelated works.yml keys while swapping deployProvider', async () => {
        const { service } = createService(createWork('k8s'));

        await service.syncWork({
            workId: 'dir-1',
            userId: 'user-1',
            reason: 'provider_changed',
        });

        const written = await readWrittenConfig();
        expect(written).toMatchObject({
            name: 'Compare Cloud Pricing',
            initial_prompt: 'Track cloud pricing',
            deployProvider: 'k8s',
            custom_key: 'keep-me',
            nested: { keep: 'also-me' },
        });
        // Provider-agnostic: only the camelCase key is written, never a
        // duplicated snake_case alias the parser would re-apply later.
        expect(written.deploy_provider).toBeUndefined();
    });

    it('leaves the data-repo deployProvider untouched when the Work row has none', async () => {
        const { service } = createService(createWork(null));

        await service.syncWork({
            workId: 'dir-1',
            userId: 'user-1',
            reason: 'schedule_updated',
        });

        const written = await readWrittenConfig();
        expect(written.deployProvider).toBe('vercel');
    });

    it('records the sync so the user can audit it in the activity log', async () => {
        const { service, eventEmitter } = createService(createWork('k8s'));

        await service.syncWork({
            workId: 'dir-1',
            userId: 'user-1',
            reason: 'provider_changed',
        });

        expect(eventEmitter.emit).toHaveBeenCalledWith(
            WorksConfigSyncedEvent.EVENT_NAME,
            expect.objectContaining({
                workId: 'dir-1',
                userId: 'user-1',
                reason: 'provider_changed',
                repository: 'ever-works/compare-cloud-pricing-data',
                deployProvider: 'k8s',
            }),
        );
    });

    it('does not fail the caller (nor log a success) when the data repo is unavailable', async () => {
        const { service, gitFacade, eventEmitter } = createService(createWork('k8s'));
        gitFacade.cloneOrPull.mockRejectedValue(new Error('repository not found'));

        await expect(
            service.syncWork({
                workId: 'dir-1',
                userId: 'user-1',
                reason: 'provider_changed',
            }),
        ).resolves.toBeUndefined();

        expect(eventEmitter.emit).not.toHaveBeenCalledWith(
            WorksConfigSyncedEvent.EVENT_NAME,
            expect.anything(),
        );
    });
});
