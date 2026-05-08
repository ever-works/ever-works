import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { WorksConfigService } from '../services/works-config.service';
import { WorksConfigWriterService } from '../services/works-config-writer.service';

describe('WorksConfigWriterService', () => {
    const writeExistingConfig = async (repoDir: string, content: string | string[]) => {
        await fs.mkdir(path.join(repoDir, '.works'), { recursive: true });
        await fs.writeFile(
            path.join(repoDir, '.works/works.yml'),
            Array.isArray(content) ? content.join('\n') : content,
            'utf-8',
        );
    };

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

    it('writes generation state to .works/works.yml without using data config parsing', async () => {
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

        const written = yaml.parse(
            await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        );

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

    it('preserves unknown existing .works/works.yml fields while updating managed fields', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await writeExistingConfig(repoDir, [
            'custom_field: keep-me',
            'initial_prompt: Old prompt',
            '',
        ]);

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                prompt: 'New prompt',
            },
        });

        const written = yaml.parse(
            await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        );

        expect(written.custom_field).toBe('keep-me');
        expect(written.initial_prompt).toBe('New prompt');

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('preserves existing managed fields when a sync does not provide replacements', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await writeExistingConfig(repoDir, [
            'initial_prompt: Existing prompt',
            'model: openai/gpt-5.1',
            'providers:',
            '  ai: openai',
            '  pipeline: agent-pipeline',
            'website_repo: ever-works/custom-website',
            '',
        ]);

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
        });

        const written = yaml.parse(
            await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        );

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
        await writeExistingConfig(repoDir, [
            'providers:',
            '  ai: openai',
            '  pipeline: agent-pipeline',
            '',
        ]);

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                providers: null,
            },
        });

        const written = yaml.parse(
            await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        );

        expect(written.providers).toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('removes stale model when a projection explicitly clears it', async () => {
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-'));
        await writeExistingConfig(repoDir, ['model: openai/gpt-5.1', '']);

        const service = new WorksConfigWriterService(new WorksConfigService({} as any));

        await service.writeToDataRepository({
            work: createWork(),
            dataRepository: { dir: repoDir } as any,
            request: {
                model: null,
            },
        });

        const written = yaml.parse(
            await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        );

        expect(written.model).toBeUndefined();

        await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('writes imported .works/works.yml-only state before schedule is applied to the work', async () => {
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

        const written = yaml.parse(
            await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
        );

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

    describe('deployProvider field (provider-agnostic)', () => {
        it('writes deployProvider when provided in the request', async () => {
            const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-deploy-'));
            const service = new WorksConfigWriterService(new WorksConfigService({} as any));

            await service.writeToDataRepository({
                work: createWork(),
                dataRepository: { dir: repoDir } as any,
                request: { deployProvider: 'k8s' },
            });

            const written = yaml.parse(
                await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
            );
            expect(written.deployProvider).toBe('k8s');

            await fs.rm(repoDir, { recursive: true, force: true });
        });

        it('preserves existing .works/works.yml deployProvider when no override', async () => {
            const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-deploy-'));
            await writeExistingConfig(repoDir, 'deployProvider: vercel\n');

            const service = new WorksConfigWriterService(new WorksConfigService({} as any));
            await service.writeToDataRepository({
                work: createWork(),
                dataRepository: { dir: repoDir } as any,
            });

            const written = yaml.parse(
                await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
            );
            expect(written.deployProvider).toBe('vercel');

            await fs.rm(repoDir, { recursive: true, force: true });
        });

        it('falls back to work.deployProvider when YAML and request are silent', async () => {
            const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-deploy-'));
            const service = new WorksConfigWriterService(new WorksConfigService({} as any));
            const work = { ...createWork(), deployProvider: 'k8s' };

            await service.writeToDataRepository({
                work,
                dataRepository: { dir: repoDir } as any,
            });

            const written = yaml.parse(
                await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
            );
            expect(written.deployProvider).toBe('k8s');

            await fs.rm(repoDir, { recursive: true, force: true });
        });

        it('clears deployProvider when request explicitly passes null', async () => {
            const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-deploy-'));
            await writeExistingConfig(repoDir, 'deployProvider: vercel\n');

            const service = new WorksConfigWriterService(new WorksConfigService({} as any));
            await service.writeToDataRepository({
                work: createWork(),
                dataRepository: { dir: repoDir } as any,
                request: { deployProvider: null },
            });

            const written = yaml.parse(
                await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
            );
            expect(written.deployProvider).toBeUndefined();

            await fs.rm(repoDir, { recursive: true, force: true });
        });

        it('imported .works/works.yml deployProvider beats the work entity value', async () => {
            const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'works-config-writer-deploy-'));
            const service = new WorksConfigWriterService(new WorksConfigService({} as any));
            const work = { ...createWork(), deployProvider: 'vercel' };

            await service.writeToDataRepository({
                work,
                dataRepository: { dir: repoDir } as any,
                importedWorksConfig: { deployProvider: 'k8s' } as any,
            });

            const written = yaml.parse(
                await fs.readFile(path.join(repoDir, '.works/works.yml'), 'utf-8'),
            );
            // Provider-agnostic: imported value wins over work entity, just
            // like other works-config fields. (Spec FR-18 — data repo is
            // source of truth.)
            expect(written.deployProvider).toBe('k8s');

            await fs.rm(repoDir, { recursive: true, force: true });
        });
    });
});
