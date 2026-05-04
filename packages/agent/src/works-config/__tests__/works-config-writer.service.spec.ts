import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { WorksConfigService } from '../services/works-config.service';
import { WorksConfigWriterService } from '../services/works-config-writer.service';

describe('WorksConfigWriterService', () => {
    const createDirectory = () =>
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

    it('writes generation state to works.yaml without using data config parsing', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory: createDirectory(),
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

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

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

    it('preserves unknown existing works.yaml fields while updating managed fields', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yaml'),
            ['custom_field: keep-me', 'initial_prompt: Old prompt', ''].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory: createDirectory(),
            dataRepository: { dir: repoDir } as any,
            request: {
                prompt: 'New prompt',
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

        expect(written.custom_field).toBe('keep-me');
        expect(written.initial_prompt).toBe('New prompt');

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('migrates legacy config.yaml fields into works.yaml without continuing to write config.yaml', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'config.yaml'),
            ['company_name: Legacy Directory', 'settings:', '  categories_enabled: false', ''].join(
                '\n',
            ),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory: createDirectory(),
            dataRepository: { dir: repoDir } as any,
            request: {
                prompt: 'New prompt',
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

        expect(written).toMatchObject({
            company_name: 'Legacy Directory',
            settings: {
                categories_enabled: false,
            },
            initial_prompt: 'New prompt',
        });
        await expect(fs.access(path.join(repoDir, 'config.yaml'))).rejects.toMatchObject({
            code: 'ENOENT',
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('overlays existing works config fields on top of legacy config fields when writing', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await Promise.all([
            fs.writeFile(
                path.join(repoDir, 'config.yaml'),
                ['company_name: Legacy Directory', 'settings:', '  categories_enabled: false', ''].join(
                    '\n',
                ),
                'utf-8',
            ),
            fs.writeFile(
                path.join(repoDir, 'works.yml'),
                ['company_name: Works Directory', 'settings:', '  tags_enabled: false', ''].join(
                    '\n',
                ),
                'utf-8',
            ),
        ]);

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory: createDirectory(),
            dataRepository: { dir: repoDir } as any,
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

        expect(written).toMatchObject({
            company_name: 'Works Directory',
            settings: {
                categories_enabled: false,
                tags_enabled: false,
            },
        });
        await expect(fs.access(path.join(repoDir, 'config.yaml'))).rejects.toMatchObject({
            code: 'ENOENT',
        });

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('preserves existing managed fields when a sync does not provide replacements', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yaml'),
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
            directory: createDirectory(),
            dataRepository: { dir: repoDir } as any,
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

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
            path.join(repoDir, 'works.yaml'),
            ['providers:', '  ai: openai', '  pipeline: agent-pipeline', ''].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory: createDirectory(),
            dataRepository: { dir: repoDir } as any,
            request: {
                providers: null,
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

        expect(written.providers).toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('removes stale model when a projection explicitly clears it', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await fs.writeFile(
            path.join(repoDir, 'works.yaml'),
            ['model: openai/gpt-5.1', ''].join('\n'),
            'utf-8',
        );

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory: createDirectory(),
            dataRepository: { dir: repoDir } as any,
            request: {
                model: null,
            },
        });

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

        expect(written.model).toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('writes imported works.yaml-only state before schedule is applied to the directory', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        const directory = {
            ...createDirectory(),
            scheduledUpdatesEnabled: false,
            scheduledCadence: null,
        };
        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            directory,
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

        const written = yaml.parse(await fs.readFile(path.join(repoDir, 'works.yaml'), 'utf-8'));

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
