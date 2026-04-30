jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/data-generator/data-repository', () => ({
    DataRepository: class DataRepository {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('../source-repo-analyzer.service', () => ({
    SourceRepoAnalyzerService: class SourceRepoAnalyzerService {},
}));

import { ImportExecutorService } from '../import-executor.service';

describe('ImportExecutorService', () => {
    const createService = () => {
        const dataGenerator = {
            initialize: jest.fn().mockResolvedValue({
                success: true,
                stats: { totalItemsCount: 0, newItemsCount: 0, updatedItemsCount: 0 },
            }),
        };
        const markdownGenerator = { initialize: jest.fn().mockResolvedValue(undefined) };
        const websiteGenerator = { initialize: jest.fn().mockResolvedValue(undefined) };
        const worksConfigService = {
            loadFromRepository: jest.fn(),
        };

        const deps = [
            {},
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            {},
            worksConfigService,
        ] as unknown as ConstructorParameters<typeof ImportExecutorService>;

        return {
            service: new ImportExecutorService(...deps),
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            worksConfigService,
        };
    };

    const directory = {
        id: 'dir-1',
        name: 'Compare Cloud Pricing',
        slug: 'compare-cloud-pricing',
    } as any;

    const user = { id: 'user-1' } as any;

    it('passes the full works.yml config to data generation for awesome README imports', async () => {
        const { service, dataGenerator } = createService();
        const worksConfig = {
            initialPrompt: 'Build a directory from the awesome list',
            model: 'openai/gpt-5.1',
            scheduleCadence: 'weekly',
            providers: {
                ai: 'openai',
                pipeline: 'agent-pipeline',
            },
        } as any;

        await service.importFromAwesomeReadme({
            directory,
            user,
            sourceUrl: 'https://github.com/ever-works/awesome-cloud',
            worksConfig,
        });

        expect(dataGenerator.initialize).toHaveBeenCalledWith(
            directory,
            user,
            expect.objectContaining({
                model: worksConfig.model,
                providers: expect.objectContaining(worksConfig.providers),
            }),
            { worksConfig },
        );
    });

    it('passes the resolved works.yml config to data generation for config-only imports', async () => {
        const { service, dataGenerator } = createService();
        const worksConfig = {
            initialPrompt: 'Build a cloud pricing directory',
            model: 'openai/gpt-5.1',
            scheduleCadence: 'daily',
            providers: {
                ai: 'openai',
                pipeline: 'agent-pipeline',
            },
        } as any;

        await service.importFromWorksConfig({
            directory,
            user,
            source: { owner: 'ever-works', repo: 'compare-cloud-pricing' },
            worksConfig,
        });

        expect(dataGenerator.initialize).toHaveBeenCalledWith(
            directory,
            user,
            expect.objectContaining({
                prompt: worksConfig.initialPrompt,
                model: worksConfig.model,
                providers: worksConfig.providers,
            }),
            { worksConfig },
        );
    });
});
