import { buildImportGenerationDto } from './enrichment-prompt.utils';
import {
    CreateItemsGeneratorDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@src/items-generator/dto';
import type { Work } from '@src/entities/work.entity';

const makeWork = (overrides: Partial<Work> = {}): Work => {
    return {
        id: 'work-1',
        name: 'Awesome Tools',
        slug: 'awesome-tools',
        ...overrides,
    } as Work;
};

describe('buildImportGenerationDto', () => {
    it('returns a CreateItemsGeneratorDto instance', () => {
        const dto = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://github.com/example/awesome',
        });
        expect(dto).toBeInstanceOf(CreateItemsGeneratorDto);
    });

    it('uses work.name when present and falls back to work.slug otherwise', () => {
        const namedDto = buildImportGenerationDto({
            work: makeWork({ name: 'Awesome Tools' }),
            sourceUrl: 'https://x',
        });
        expect(namedDto.name).toBe('Awesome Tools');

        const slugDto = buildImportGenerationDto({
            work: makeWork({ name: undefined }),
            sourceUrl: 'https://x',
        });
        expect(slugDto.name).toBe('awesome-tools');
    });

    it('treats null work.name like undefined and falls back to slug', () => {
        // The source uses `work.name ?? work.slug` so a `null` should also
        // fall through to the slug — pin this so a future refactor to `||`
        // (which would also catch the empty string) is a deliberate change.
        const dto = buildImportGenerationDto({
            work: makeWork({ name: null as unknown as string }),
            sourceUrl: 'https://x',
        });
        expect(dto.name).toBe('awesome-tools');
    });

    it('preserves an empty-string work.name (??-not-||) — does NOT fall back to slug', () => {
        const dto = buildImportGenerationDto({
            work: makeWork({ name: '' }),
            sourceUrl: 'https://x',
        });
        expect(dto.name).toBe('');
    });

    it('hardcodes generation_method to CREATE_UPDATE and template-based website creation', () => {
        const dto = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://x',
        });
        expect(dto.generation_method).toBe(GenerationMethod.CREATE_UPDATE);
        expect(dto.website_repository_creation_method).toBe(
            WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
        );
    });

    it('defaults update_with_pull_request to false and accepts an explicit override', () => {
        expect(
            buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            }).update_with_pull_request,
        ).toBe(false);

        expect(
            buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                updateWithPullRequest: true,
            }).update_with_pull_request,
        ).toBe(true);

        expect(
            buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                updateWithPullRequest: false,
            }).update_with_pull_request,
        ).toBe(false);
    });

    it('forwards model verbatim (including undefined)', () => {
        const undefinedDto = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://x',
        });
        expect(undefinedDto.model).toBeUndefined();

        const explicitDto = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://x',
            model: 'gpt-5.1',
        });
        expect(explicitDto.model).toBe('gpt-5.1');
    });

    it('hardcodes pluginConfig defaults (target_items=500, max_pages_to_process=1000, capture_screenshots=true)', () => {
        const dto = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://x',
        });
        expect(dto.pluginConfig).toEqual({
            target_items: 500,
            max_pages_to_process: 1000,
            capture_screenshots: true,
        });
    });

    describe('providers', () => {
        it('falls back to the default agent-pipeline when no providers are passed', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            });
            expect(dto.providers).toEqual({ pipeline: 'agent-pipeline' });
        });

        it('preserves a caller-provided pipeline override', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                providers: { pipeline: 'standard-pipeline' },
            });
            expect(dto.providers?.pipeline).toBe('standard-pipeline');
        });

        it('uses the default pipeline when providers is passed but pipeline is undefined', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                providers: { search: 'tavily' } as never,
            });
            expect(dto.providers?.pipeline).toBe('agent-pipeline');
            // Other passed provider keys are merged through verbatim.
            expect((dto.providers as { search?: string }).search).toBe('tavily');
        });

        it('forwards every other provider key from the input verbatim', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                providers: {
                    search: 'tavily',
                    extract_content: 'firecrawl',
                    ai: 'openai',
                } as never,
            });
            expect(dto.providers).toEqual({
                pipeline: 'agent-pipeline',
                search: 'tavily',
                extract_content: 'firecrawl',
                ai: 'openai',
            });
        });
    });

    describe('prompt', () => {
        it('embeds the source URL in the opening line', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://github.com/example/awesome-list',
            });
            expect(dto.prompt).toContain(
                'Build a comprehensive work using this awesome list as your research starting point: https://github.com/example/awesome-list',
            );
        });

        it('uses the default expansion factor of 2.5 → max source pct 40', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            });
            expect(dto.prompt).toContain('Source items must represent at most 40% of the final');
        });

        it('rounds the maxSourcePct from a custom expansion factor (factor=4 → 25%)', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                expansionFactor: 4,
            });
            expect(dto.prompt).toContain('Source items must represent at most 25% of the final');
        });

        it('rounds the maxSourcePct from a non-integer expansion factor (factor=3 → 33%)', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
                expansionFactor: 3,
            });
            // Math.round(100/3) = 33
            expect(dto.prompt).toContain('Source items must represent at most 33% of the final');
        });

        it('contains all four documented step headers in order', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            });
            const prompt = dto.prompt as string;
            const step1 = prompt.indexOf('## Step 1 — Process source links');
            const step2 = prompt.indexOf('## Step 2 — Discover more items');
            const step3 = prompt.indexOf('## Step 3 — Enrich descriptions');
            const step4 = prompt.indexOf('## Step 4 — Build original taxonomy');
            expect(step1).toBeGreaterThanOrEqual(0);
            expect(step2).toBeGreaterThan(step1);
            expect(step3).toBeGreaterThan(step2);
            expect(step4).toBeGreaterThan(step3);
        });

        it('contains the legal-safety guidance about not copying descriptions', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            });
            expect(dto.prompt).toContain('Do NOT copy descriptions or metadata from the source');
            expect(dto.prompt).toContain('legally problematic');
        });

        it('contains the "do not stop early" directive at the end', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            });
            expect(dto.prompt?.trimEnd().endsWith('exhausted.')).toBe(true);
            expect(dto.prompt).toContain('Do not stop early');
        });

        it('contains the original-taxonomy 30% cap directive', () => {
            const dto = buildImportGenerationDto({
                work: makeWork(),
                sourceUrl: 'https://x',
            });
            expect(dto.prompt).toContain(
                "The source's categories/tags should be at most 30% of the final taxonomy.",
            );
        });
    });

    it('builds a fresh DTO instance per call (no shared mutable state across invocations)', () => {
        const a = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://a',
        });
        const b = buildImportGenerationDto({
            work: makeWork(),
            sourceUrl: 'https://b',
        });
        expect(a).not.toBe(b);
        expect(a.providers).not.toBe(b.providers);
        expect(a.pluginConfig).not.toBe(b.pluginConfig);
        expect(a.prompt).toContain('https://a');
        expect(b.prompt).toContain('https://b');
    });
});
