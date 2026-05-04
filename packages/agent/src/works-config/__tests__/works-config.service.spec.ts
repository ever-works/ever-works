import { DirectoryScheduleCadence } from '@ever-works/contracts/api';
import { WorksConfigService } from '../services/works-config.service';

describe('WorksConfigService', () => {
    const service = new WorksConfigService({} as any);

    it('parses a minimal works.yaml config', () => {
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
        expect(result.scheduleCadence).toBe(DirectoryScheduleCadence.WEEKLY);
        expect(result.providers).toEqual({
            ai: 'openrouter',
            pipeline: 'agent-pipeline',
        });
    });

    it('supports object-based schedule config', () => {
        const result = service.parse(`
prompt: Keep this repo up to date
schedule:
  enabled: true
  cadence: every-12-hours
`);

        expect(result.initialPrompt).toBe('Keep this repo up to date');
        expect(result.scheduleCadence).toBe(DirectoryScheduleCadence.EVERY_12_HOURS);
    });

    it('loads works config from works_config/works.yaml when root file is absent', async () => {
        const gitFacade = {
            getFileContent: jest.fn((_owner, _repo, filePath) => {
                if (filePath === 'works_config/works.yaml') {
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
            'works_config/works.yaml',
            {
                token: 'token',
                providerId: 'github',
            },
        );
    });

    it('loads legacy config.yaml when works.yaml is absent', async () => {
        const gitFacade = {
            getFileContent: jest.fn((_owner, _repo, filePath) => {
                if (filePath === 'config.yaml') {
                    return Promise.resolve({
                        content: [
                            'metadata:',
                            '  initial_prompt: Import from legacy data config',
                            '  last_request_data:',
                            '    model: openai/gpt-4.1',
                            '    providers:',
                            '      ai: openrouter',
                            '      pipeline: agent-pipeline',
                            '',
                        ].join('\n'),
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
            initialPrompt: 'Import from legacy data config',
            model: 'openai/gpt-4.1',
            providers: {
                ai: 'openrouter',
                pipeline: 'agent-pipeline',
            },
        });
        expect(gitFacade.getFileContent).toHaveBeenCalledWith(
            'Ntermast',
            'Compare-Cloud-Pricing',
            'config.yaml',
            {
                token: 'token',
                providerId: 'github',
            },
        );
    });

    it('overlays works.yaml fields on top of legacy config.yaml fields', async () => {
        const gitFacade = {
            getFileContent: jest.fn((_owner, _repo, filePath) => {
                if (filePath === 'config.yaml') {
                    return Promise.resolve({
                        content: [
                            'company_name: Legacy Directory',
                            'metadata:',
                            '  initial_prompt: Legacy prompt',
                            '  last_request_data:',
                            '    model: legacy/model',
                            '    providers:',
                            '      ai: legacy-ai',
                            '',
                        ].join('\n'),
                    });
                }

                if (filePath === 'works.yaml') {
                    return Promise.resolve({
                        content: [
                            'name: Works Directory',
                            'initial_prompt: Works prompt',
                            'providers:',
                            '  pipeline: agent-pipeline',
                            '',
                        ].join('\n'),
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

        expect(result?.raw).toMatchObject({
            company_name: 'Legacy Directory',
            name: 'Works Directory',
        });
        expect(result).toMatchObject({
            name: 'Works Directory',
            initialPrompt: 'Works prompt',
            model: 'legacy/model',
            providers: {
                ai: 'legacy-ai',
                pipeline: 'agent-pipeline',
            },
        });
    });

    it('throws the actual parse error when a works config file exists but is invalid', async () => {
        const gitFacade = {
            getFileContent: jest.fn((_owner, _repo, filePath) => {
                if (filePath === 'works.yaml') {
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
        ).rejects.toThrow('Invalid works config at works.yaml:');
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
