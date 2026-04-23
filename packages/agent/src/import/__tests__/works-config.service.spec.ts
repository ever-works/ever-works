import { DirectoryScheduleCadence } from '@ever-works/contracts/api';
import { WorksConfigService } from '../works-config.service';

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
});
