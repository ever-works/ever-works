import { WorkScheduleCadence } from '@ever-works/contracts/api';
import { WorksConfigService } from '../services/works-config.service';

describe('WorksConfigService', () => {
    const service = new WorksConfigService({} as any);

    it('parses a minimal .works/works.yml config', () => {
        const result = service.parse(`
name: Compare Cloud Pricing
initial_prompt: Compare cloud pricing across storage and compute services
model: openai/gpt-4.1
website_repo: ever-works/compare-cloud-pricing
schedule: weekly
providers:
  ai: openrouter
  pipeline: agent-pipeline
`);

        expect(result.name).toBe('Compare Cloud Pricing');
        expect(result.initialPrompt).toBe(
            'Compare cloud pricing across storage and compute services',
        );
        expect(result.model).toBe('openai/gpt-4.1');
        expect(result.websiteRepo).toBe('ever-works/compare-cloud-pricing');
        expect(result.scheduleCadence).toBe(WorkScheduleCadence.WEEKLY);
        expect(result.providers).toEqual({
            ai: 'openrouter',
            pipeline: 'agent-pipeline',
        });
    });

    it('parses a .works/works.yml with deployProvider: k8s', () => {
        const result = service.parse(`
name: My Site
deployProvider: k8s
`);

        expect(result.deployProvider).toBe('k8s');
    });

    it('parses a .works/works.yml with deployProvider: vercel (provider-agnostic)', () => {
        const result = service.parse(`
name: My Site
deployProvider: vercel
`);

        expect(result.deployProvider).toBe('vercel');
    });

    it('parses snake_case deploy_provider as well', () => {
        const result = service.parse(`
name: My Site
deploy_provider: k8s
`);

        expect(result.deployProvider).toBe('k8s');
    });

    it('returns undefined deployProvider when the field is empty or absent', () => {
        const empty = service.parse(`
name: My Site
deployProvider: '   '
`);
        expect(empty.deployProvider).toBeUndefined();

        const absent = service.parse(`
name: My Site
`);
        expect(absent.deployProvider).toBeUndefined();
    });

    it('supports object-based schedule config', () => {
        const result = service.parse(`
prompt: Keep this repo up to date
schedule:
  enabled: true
  cadence: every-12-hours
`);

        expect(result.initialPrompt).toBe('Keep this repo up to date');
        expect(result.scheduleCadence).toBe(WorkScheduleCadence.EVERY_12_HOURS);
    });

    it('loads works config from root .works/works.yml', async () => {
        const gitFacade = {
            getFileContent: jest.fn((_owner, _repo, filePath) => {
                if (filePath === '.works/works.yml') {
                    return Promise.resolve({
                        content: 'initial_prompt: Build everything\n',
                    });
                }

                return Promise.reject(new Error('not found'));
            }),
        };

        const loader = new WorksConfigService(gitFacade as any);
        const result = await loader.loadFromRepository(
            'Ntermast',
            'Compare-Cloud-Pricing',
            'github',
            'token',
        );

        expect(result).toMatchObject({
            initialPrompt: 'Build everything',
        });
        expect(gitFacade.getFileContent).toHaveBeenCalledWith(
            'Ntermast',
            'Compare-Cloud-Pricing',
            '.works/works.yml',
            {
                token: 'token',
                providerId: 'github',
            },
        );
    });

    it('throws the actual parse error when a works config file exists but is invalid', async () => {
        const gitFacade = {
            getFileContent: jest.fn((_owner, _repo, filePath) => {
                if (filePath === '.works/works.yml') {
                    return Promise.resolve({
                        content: 'name: Compare Cloud Pricing\n  initial_prompt: broken\n',
                    });
                }

                return Promise.reject(new Error('not found'));
            }),
        };

        const loader = new WorksConfigService(gitFacade as any);

        await expect(
            loader.loadFromRepository('Ntermast', 'Compare-Cloud-Pricing', 'github', 'token'),
        ).rejects.toThrow('Invalid works config at .works/works.yml:');
    });

    it('parses website_repo from a full GitHub URL', () => {
        const result = service.parse(`
initial_prompt: Compare managed databases
website_repo: https://github.com/Ntermast/Compare-Database-Pricing
`);

        expect(result.websiteRepositoryTarget).toEqual({
            owner: 'Ntermast',
            repo: 'Compare-Database-Pricing',
        });
    });
});
