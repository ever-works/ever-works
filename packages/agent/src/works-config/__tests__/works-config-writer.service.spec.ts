import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { WorksConfigService } from '../services/works-config.service';
import { WorksConfigWriterService } from '../services/works-config-writer.service';

describe('WorksConfigWriterService', () => {
    const createWork = () =>
        ({
            name: 'Compare Cloud Pricing',
            getRepoOwner: jest.fn((role?: string) =>
                role === 'website' ? 'ever-works-web' : 'ever-works',
            ),
            getDataRepo: jest.fn().mockReturnValue('compare-cloud-pricing-data'),
            getMainRepo: jest.fn().mockReturnValue('compare-cloud-pricing'),
            getWebsiteRepo: jest.fn().mockReturnValue('compare-cloud-pricing-site'),
            scheduledUpdatesEnabled: true,
            scheduledCadence: 'weekly',
        }) as any;

    it('writes generation state to works.yml without using data config parsing', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                name: 'Compare Cloud Pricing',
                prompt: 'Track cloud pricing',
                model: 'openai/gpt-5.1',
                providers: {
                    ai: 'openai',
                    pipeline: 'agent-pipeline',
                },
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8'));

        expect(written).toMatchObject({
            name: 'Compare Cloud Pricing',
            initial_prompt: 'Track cloud pricing',
            model: 'openai/gpt-5.1',
            providers: {
                ai: 'openai',
                pipeline: 'agent-pipeline',
            },
            website_repo: 'ever-works-web/compare-cloud-pricing-site',
            schedule: {
                enabled: true,
                cadence: 'weekly',
            },
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('preserves unknown existing works.yml fields while updating managed fields', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yml'),
            ['custom_field: keep-me', 'initial_prompt: Old prompt', ''].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                prompt: 'New prompt',
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8'));

        expect(written.custom_field).toBe('keep-me');
        expect(written.initial_prompt).toBe('New prompt');

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('preserves existing managed fields when a sync does not provide replacements', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yml'),
            [
                'initial_prompt: Existing prompt',
                'model: openai/gpt-5.1',
                'providers:',
                '  ai: openai',
                '  pipeline: agent-pipeline',
                'website_repo: ever-works/custom-website',
                '',
            ].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8'));

        expect(written).toMatchObject({
            initial_prompt: 'Existing prompt',
            model: 'openai/gpt-5.1',
            providers: {
                ai: 'openai',
                pipeline: 'agent-pipeline',
            },
            website_repo: 'ever-works-web/compare-cloud-pricing-site',
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('removes stale providers when a projection explicitly clears them', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yml'),
            ['providers:', '  ai: openai', '  pipeline: agent-pipeline', ''].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                providers: null,
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8'));

        expect(written.providers).toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('removes stale model when a projection explicitly clears it', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yml'),
            ['model: openai/gpt-5.1', ''].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                model: null,
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8'));

        expect(written.model).toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('writes imported works.yml-only state before schedule is applied to the work', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        const work = {
            ...createWork(),
            scheduledUpdatesEnabled: false,
            scheduledCadence: null,
        };
        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work,
            dataRepository: { dir: repoDir } as any,
            importedWorksConfig: {
                initialPrompt: 'Imported prompt',
                model: 'openai/gpt-5.1',
                scheduleCadence: 'daily' as any,
                providers: {
                    ai: 'openai',
                    pipeline: 'agent-pipeline',
                },
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yml'), 'utf-8'));

        expect(written).toMatchObject({
            initial_prompt: 'Imported prompt',
            model: 'openai/gpt-5.1',
            schedule: {
                enabled: true,
                cadence: 'daily',
            },
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });
});
