import { DirectoryScheduleCadence } from '@ever-works/contracts/api';
import { WorksConfigService } from '../services/works-config.service';

describe('WorksConfigService', () => {
    const service = new WorksConfigService({} as any);

    it('parses a minimal works.yml config', () => {
        const result = service.parse(`
name: Compare Cloud Pricing
initial_prompt: Compare cloud pricing across storage and compute services
model: openai/gpt-4.1
website_repo: ever-works/compare-cloud-pricing
schedule: weekly
providers:
  ai: openrouter
  pipeline: agent-pipeline
agents:
  - name: comparer
    prompt: Refresh pricing deltas
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
        expect(result.additionalAgentsCount).toBe(1);
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
            getFileContent: jest
                .fn()
                .mockRejectedValueOnce(new Error('not found'))
                .mockRejectedValueOnce(new Error('not found'))
                .mockRejectedValueOnce(new Error('not found'))
                .mockResolvedValueOnce({
                    content: 'initial_prompt: Build everything\n',
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
        expect(gitFacade.getFileContent).toHaveBeenLastCalledWith(
            'Ntermast',
            'Compare-Cloud-Pricing',
            'works_config/works.yaml',
            {
                token: 'token',
                providerId: 'github',
            },
        );
    });

    it('throws the actual parse error when a works config file exists but is invalid', async () => {
        const gitFacade = {
            getFileContent: jest.fn().mockResolvedValueOnce({
                content: 'name: Compare Cloud Pricing\n  initial_prompt: broken\n',
            }),
        };

        const loader = new WorksConfigService(gitFacade as any);

        await expect(
            loader.loadFromRepository('Ntermast', 'Compare-Cloud-Pricing', 'github', 'token'),
        ).rejects.toThrow('Invalid works config at works.yml:');
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
