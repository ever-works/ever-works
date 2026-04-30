import { mergeWorksConfigIntoDataConfig } from '../works-config-data';

describe('mergeWorksConfigIntoDataConfig', () => {
    it('stores works config generation state without overwriting existing import metadata', () => {
        const config = mergeWorksConfigIntoDataConfig(
            {
                metadata: {
                    initial_prompt: 'Existing prompt',
                },
            },
            'Cloud Pricing',
            {
                name: 'Cloud Pricing',
                initialPrompt: 'Build cloud pricing directory',
                model: 'gpt-5.2',
                providers: {
                    ai: 'openai',
                    pipeline: 'claude-code',
                },
            },
        );

        expect(config.metadata).toMatchObject({
            initial_prompt: 'Existing prompt',
            last_request_data: {
                name: 'Cloud Pricing',
                prompt: 'Build cloud pricing directory',
                model: 'gpt-5.2',
                providers: {
                    ai: 'openai',
                    pipeline: 'claude-code',
                },
                pluginConfig: {},
            },
        });
    });

    it('returns the original config when works config is not available', () => {
        const config = { metadata: { imported_from: 'source/repo' } };

        expect(mergeWorksConfigIntoDataConfig(config, 'Directory', null)).toBe(config);
    });
});
