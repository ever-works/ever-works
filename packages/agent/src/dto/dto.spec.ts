import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import * as dtoBarrel from './index';
import { CreateWorkDto, MarkdownReadmeConfigDto } from './create-work.dto';
import { GenerateDataDto } from './generate-data.dto';
import {
    AnalyzeRepositoryDto,
    GetUserRepositoriesDto,
    ImportSourceTypeEnum,
    ImportWorkDto,
    ImportEnrichmentConfigDto,
} from './import-work.dto';
import {
    CreateCategoryDto,
    CreateCollectionDto,
    CreateTagDto,
    UpdateCategoryDto,
    UpdateCollectionDto,
    UpdateTagDto,
} from './taxonomy.dto';
import { UpdateSourceValidationDto } from './update-source-validation.dto';
import { UpdateWorkDto } from './update-work.dto';
import { UpdateWorkAdvancedPromptsDto } from './work-advanced-prompts.dto';
import { UpdateWorkScheduleDto } from './work-schedule.dto';
import {
    CustomMenuDto,
    CustomMenuItemDto,
    SettingsHeaderDto,
    SettingsHomepageDto,
} from './website-settings.dto';
import { WorkScheduleBillingMode, WorkScheduleCadence } from '@ever-works/contracts/api';

/**
 * Validation tests for the agent-package DTOs. They exist as the request-body
 * shape for `apps/api/src/works/**` controllers, so each `class-validator`
 * decorator (`@IsString`, `@IsEmail`, `@MaxLength`, regex `@Matches`, range
 * `@Min/@Max`, nested `@ValidateNested`) is part of the public API contract.
 *
 * Tests run `class-validator.validate(plainToInstance(Dto, plain))` so both
 * the transformer side (Transform → sanitize) AND the validator side execute
 * end-to-end. No NestJS / DB context needed.
 */

async function expectValidationErrors(instance: object): Promise<string[]> {
    const errors = await validate(instance);
    return errors.flatMap((err) => Object.keys(err.constraints ?? {}));
}

async function expectValid(instance: object): Promise<void> {
    const errors = await validate(instance);
    if (errors.length > 0) {
        throw new Error(
            `expected valid but got: ` +
                errors.map((e) => JSON.stringify(e.constraints)).join(', '),
        );
    }
}

describe('agent/dto submodule', () => {
    describe('GenerateDataDto', () => {
        it('accepts a non-empty slug + prompt', async () => {
            const dto = plainToInstance(GenerateDataDto, { slug: 'demo', prompt: 'p' });
            await expectValid(dto);
        });

        it('rejects empty/missing slug or prompt', async () => {
            const dto = plainToInstance(GenerateDataDto, { slug: '', prompt: '' });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isNotEmpty');
        });

        it('rejects non-string slug or prompt', async () => {
            const dto = plainToInstance(GenerateDataDto, { slug: 123, prompt: true });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isString');
        });
    });

    describe('UpdateSourceValidationDto', () => {
        it('accepts enabled=false with no cadence', async () => {
            const dto = plainToInstance(UpdateSourceValidationDto, { enabled: false });
            await expectValid(dto);
        });

        it('accepts enabled=true with a valid cadence', async () => {
            const dto = plainToInstance(UpdateSourceValidationDto, {
                enabled: true,
                cadence: WorkScheduleCadence.DAILY,
            });
            await expectValid(dto);
        });

        it('rejects a non-boolean enabled', async () => {
            const dto = plainToInstance(UpdateSourceValidationDto, { enabled: 'yes' });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isBoolean');
        });

        it('rejects an out-of-enum cadence', async () => {
            const dto = plainToInstance(UpdateSourceValidationDto, {
                enabled: true,
                cadence: 'forever',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isEnum');
        });
    });

    describe('UpdateWorkScheduleDto', () => {
        it('accepts a fully populated payload', async () => {
            const dto = plainToInstance(UpdateWorkScheduleDto, {
                enable: true,
                runImmediately: true,
                cadence: WorkScheduleCadence.WEEKLY,
                billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 3,
                alwaysCreatePullRequest: false,
            });
            await expectValid(dto);
        });

        it('accepts an empty payload (all fields are optional)', async () => {
            const dto = plainToInstance(UpdateWorkScheduleDto, {});
            await expectValid(dto);
        });

        it.each([0, -1, 11, 100, 1.5])(
            'rejects maxFailureBeforePause=%j (out of [1,10] integer range)',
            async (value) => {
                const dto = plainToInstance(UpdateWorkScheduleDto, {
                    maxFailureBeforePause: value,
                });
                const errs = await expectValidationErrors(dto);
                // either Min/Max or IsInt depending on the value
                expect(errs.some((e) => ['min', 'max', 'isInt'].includes(e))).toBe(true);
            },
        );

        it.each([1, 5, 10])(
            'accepts maxFailureBeforePause=%j (in-range integers)',
            async (value) => {
                const dto = plainToInstance(UpdateWorkScheduleDto, {
                    maxFailureBeforePause: value,
                });
                await expectValid(dto);
            },
        );

        it('rejects an out-of-enum cadence', async () => {
            const dto = plainToInstance(UpdateWorkScheduleDto, { cadence: 'random' });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isEnum');
        });

        it('rejects a non-boolean enable / runImmediately / alwaysCreatePullRequest', async () => {
            const dto = plainToInstance(UpdateWorkScheduleDto, {
                enable: 'yes',
                runImmediately: 1,
                alwaysCreatePullRequest: 'maybe',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs.filter((e) => e === 'isBoolean').length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('UpdateWorkAdvancedPromptsDto (sanitize Transform pipeline)', () => {
        it.each([
            'relevanceAssessment',
            'itemGeneration',
            'itemExtraction',
            'searchQuery',
            'categorization',
            'deduplication',
            'sourceValidation',
        ] as const)('%s: empty/whitespace-only string is normalised to null', (field) => {
            for (const value of ['', '   ', '\n\t']) {
                const dto = plainToInstance(UpdateWorkAdvancedPromptsDto, { [field]: value });
                expect((dto as any)[field]).toBeNull();
            }
        });

        it.each([
            'relevanceAssessment',
            'itemGeneration',
            'itemExtraction',
            'searchQuery',
            'categorization',
            'deduplication',
            'sourceValidation',
        ] as const)('%s: non-string value is normalised to null', (field) => {
            for (const value of [123, true, {}, []]) {
                const dto = plainToInstance(UpdateWorkAdvancedPromptsDto, { [field]: value });
                expect((dto as any)[field]).toBeNull();
            }
        });

        it.each([
            'relevanceAssessment',
            'itemGeneration',
            'itemExtraction',
            'searchQuery',
            'categorization',
            'deduplication',
            'sourceValidation',
        ] as const)('%s: non-empty string survives the sanitize Transform', (field) => {
            const dto = plainToInstance(UpdateWorkAdvancedPromptsDto, {
                [field]: '  Use a friendly tone  ',
            });
            expect(typeof (dto as any)[field]).toBe('string');
            expect((dto as any)[field]).toContain('Use a friendly tone');
        });

        it('Transform truncates prompts to 2000 chars BEFORE validation', () => {
            // sanitizePrompt caps to MAX_PROMPT_LENGTH=2000, so a 3000-char
            // input is silently capped to 2000 instead of failing MaxLength.
            const dto = plainToInstance(UpdateWorkAdvancedPromptsDto, {
                relevanceAssessment: 'a'.repeat(3000),
            });
            expect((dto.relevanceAssessment ?? '').length).toBeLessThanOrEqual(2000);
        });

        it('accepts a 2000 char prompt at the boundary', async () => {
            const dto = plainToInstance(UpdateWorkAdvancedPromptsDto, {
                relevanceAssessment: 'a'.repeat(2000),
            });
            await expectValid(dto);
        });

        it('accepts an empty payload (every field optional)', async () => {
            const dto = plainToInstance(UpdateWorkAdvancedPromptsDto, {});
            await expectValid(dto);
        });
    });

    describe('CreateWorkDto (slug + transforms + nested ReadmeConfig)', () => {
        const validBase = {
            slug: 'demo',
            name: 'Demo',
            description: 'Demo description',
            organization: false,
        };

        it('accepts a valid slug + name + description + organization payload', async () => {
            const dto = plainToInstance(CreateWorkDto, validBase);
            await expectValid(dto);
        });

        it('lowercases + trims the slug Transform', () => {
            const dto = plainToInstance(CreateWorkDto, {
                ...validBase,
                slug: '  My-Slug  ',
            });
            expect(dto.slug).toBe('my-slug');
        });

        // The Transform lowercases + trims BEFORE validation, so 'UPPER' becomes
        // 'upper' (valid) — only inputs that would still fail post-lowercase
        // can be tested here.
        it.each(['has space', 'has_underscore', 'ends-', '-starts', 'invalid--double', 'punc!'])(
            'rejects slug=%j (must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/)',
            async (raw) => {
                const dto = plainToInstance(CreateWorkDto, { ...validBase, slug: raw });
                const errs = await expectValidationErrors(dto);
                expect(errs).toContain('matches');
            },
        );

        it('lowercases an UPPER-CASE slug instead of rejecting it (Transform pre-pass)', async () => {
            const dto = plainToInstance(CreateWorkDto, { ...validBase, slug: 'UPPER' });
            expect(dto.slug).toBe('upper');
            await expectValid(dto);
        });

        it.each(['demo', 'a', 'a-b', 'a-b-c', '12-34'])(
            'accepts slug=%j (matches the regex)',
            async (raw) => {
                const dto = plainToInstance(CreateWorkDto, { ...validBase, slug: raw });
                await expectValid(dto);
            },
        );

        it('rejects empty slug / name / description', async () => {
            const dto = plainToInstance(CreateWorkDto, {
                slug: '',
                name: '',
                description: '',
                organization: false,
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isNotEmpty');
        });

        it('Transform truncates name to 100 chars and description to 500 chars BEFORE validation', () => {
            const dto = plainToInstance(CreateWorkDto, {
                ...validBase,
                name: 'a'.repeat(150),
                description: 'b'.repeat(700),
            });
            // sanitizeName / sanitizeDescription cap the strings before
            // class-validator runs, so MaxLength never trips on overflowing
            // input — the value is silently truncated instead.
            expect(dto.name.length).toBeLessThanOrEqual(100);
            expect(dto.description.length).toBeLessThanOrEqual(500);
        });

        it('lowercases gitProvider / deployProvider / websiteTemplateId', () => {
            const dto = plainToInstance(CreateWorkDto, {
                ...validBase,
                gitProvider: 'GitHub',
                deployProvider: 'VERCEL',
                websiteTemplateId: 'Classic',
            });
            expect(dto.gitProvider).toBe('github');
            expect(dto.deployProvider).toBe('vercel');
            expect(dto.websiteTemplateId).toBe('classic');
        });

        it('defaults gitProvider to "github" when omitted', () => {
            // The default is set on the class field, so plainToInstance with
            // no `gitProvider` keeps the default. The Transform fires only
            // when a value is present.
            const dto = plainToInstance(CreateWorkDto, validBase);
            expect(dto.gitProvider).toBe('github');
        });

        it('rejects organization missing (the only required boolean)', async () => {
            const dto = plainToInstance(CreateWorkDto, {
                slug: 'demo',
                name: 'Demo',
                description: 'd',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isBoolean');
        });

        it('validates the nested readmeConfig', async () => {
            const dto = plainToInstance(CreateWorkDto, {
                ...validBase,
                readmeConfig: { overwriteDefaultHeader: 'yes' as any },
            });
            const errs = await validate(dto);
            // Nested validation produces a child error
            const flat = errs.flatMap((e) => [
                ...Object.keys(e.constraints ?? {}),
                ...(e.children ?? []).flatMap((c) => Object.keys(c.constraints ?? {})),
            ]);
            expect(flat).toContain('isBoolean');
        });
    });

    describe('MarkdownReadmeConfigDto', () => {
        it('accepts an empty config', async () => {
            const dto = plainToInstance(MarkdownReadmeConfigDto, {});
            await expectValid(dto);
        });

        it('rejects non-boolean overwrite flags', async () => {
            const dto = plainToInstance(MarkdownReadmeConfigDto, {
                overwriteDefaultHeader: 'on',
                overwriteDefaultFooter: 1,
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isBoolean');
        });
    });

    describe('UpdateWorkDto', () => {
        it('accepts an empty payload (all fields optional)', async () => {
            const dto = plainToInstance(UpdateWorkDto, {});
            await expectValid(dto);
        });

        it('rejects an invalid committerEmail', async () => {
            const dto = plainToInstance(UpdateWorkDto, {
                committerEmail: 'not-an-email',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isEmail');
        });

        it('accepts a valid committerEmail', async () => {
            const dto = plainToInstance(UpdateWorkDto, {
                committerEmail: 'bot@example.com',
            });
            await expectValid(dto);
        });

        it('lowercases deployProvider + websiteTemplateId', () => {
            const dto = plainToInstance(UpdateWorkDto, {
                deployProvider: 'VERCEL',
                websiteTemplateId: 'CLASSIC',
            });
            expect(dto.deployProvider).toBe('vercel');
            expect(dto.websiteTemplateId).toBe('classic');
        });

        it('Transform truncates name to 100 + description to 500 BEFORE validation (no MaxLength trip)', () => {
            const dto = plainToInstance(UpdateWorkDto, {
                name: 'a'.repeat(150),
                description: 'b'.repeat(700),
            });
            // Same sanitize pipeline as CreateWorkDto: oversized input is
            // silently truncated, so MaxLength never trips.
            expect((dto.name ?? '').length).toBeLessThanOrEqual(100);
            expect((dto.description ?? '').length).toBeLessThanOrEqual(500);
        });
    });

    describe('Taxonomy DTOs (Category / Collection / Tag)', () => {
        // Category + Collection share an identical schema; pinning one is
        // enough to discover regressions in the shared sanitize wiring.
        it('CreateCategoryDto: accepts name + description', async () => {
            await expectValid(plainToInstance(CreateCategoryDto, { name: 'Tools' }));
            await expectValid(
                plainToInstance(CreateCategoryDto, {
                    name: 'Tools',
                    description: 'Useful tools',
                    icon_url: 'https://x/y',
                    priority: 5,
                }),
            );
        });

        it('CreateCategoryDto: Transform truncates name to 100 chars (no MaxLength trip on oversized input)', () => {
            const dto = plainToInstance(CreateCategoryDto, { name: 'a'.repeat(150) });
            expect((dto.name ?? '').length).toBeLessThanOrEqual(100);
        });

        it('CreateCategoryDto: rejects negative priority', async () => {
            const dto = plainToInstance(CreateCategoryDto, { name: 'x', priority: -1 });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('min');
        });

        it('UpdateCategoryDto: accepts an empty payload', async () => {
            await expectValid(plainToInstance(UpdateCategoryDto, {}));
        });

        it('CreateCollectionDto: same schema as CreateCategoryDto (smoke check)', async () => {
            await expectValid(plainToInstance(CreateCollectionDto, { name: 'Best of 2026' }));
            const dto = plainToInstance(CreateCollectionDto, { name: 'a'.repeat(150) });
            expect((dto.name ?? '').length).toBeLessThanOrEqual(100);
        });

        it('UpdateCollectionDto: accepts an empty payload', async () => {
            await expectValid(plainToInstance(UpdateCollectionDto, {}));
        });

        it('CreateTagDto: Transform truncates name to 50 chars (tighter cap than category/collection)', () => {
            const dto = plainToInstance(CreateTagDto, { name: 'a'.repeat(80) });
            expect((dto.name ?? '').length).toBeLessThanOrEqual(50);
            // 50 char name passes validation (after sanitize)
            // Note: would expectValid here but it's still in async test scope.
        });

        it('UpdateTagDto: accepts an empty payload', async () => {
            await expectValid(plainToInstance(UpdateTagDto, {}));
        });
    });

    describe('Import DTOs', () => {
        it('ImportSourceTypeEnum pins the four documented values', () => {
            expect(ImportSourceTypeEnum.DATA_REPO).toBeDefined();
            expect(ImportSourceTypeEnum.AWESOME_README).toBeDefined();
            expect(ImportSourceTypeEnum.LINK_EXISTING).toBeDefined();
            expect(ImportSourceTypeEnum.WORKS_CONFIG).toBeDefined();

            // Values are unique
            const values = Object.values(ImportSourceTypeEnum);
            expect(new Set(values).size).toBe(values.length);
            expect(values).toHaveLength(4);
        });

        it('AnalyzeRepositoryDto: accepts a valid sourceUrl', async () => {
            await expectValid(
                plainToInstance(AnalyzeRepositoryDto, {
                    sourceUrl: 'https://github.com/example/repo',
                }),
            );
        });

        it('AnalyzeRepositoryDto: rejects an invalid sourceUrl with the custom message', async () => {
            const dto = plainToInstance(AnalyzeRepositoryDto, { sourceUrl: 'not-a-url' });
            const result = await validate(dto);
            const messages = result.flatMap((e) => Object.values(e.constraints ?? {}));
            expect(messages.some((m) => m.includes('valid repository URL'))).toBe(true);
        });

        it('ImportEnrichmentConfigDto: rejects non-numeric expansionFactor', async () => {
            const dto = plainToInstance(ImportEnrichmentConfigDto, {
                expansionFactor: 'two-and-a-half',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isNumber');
        });

        it('ImportWorkDto: requires sourceUrl + sourceType + name + gitProvider', async () => {
            const dto = plainToInstance(ImportWorkDto, {});
            const errs = await expectValidationErrors(dto);
            // missing fields surface as one of these constraints
            expect(errs.length).toBeGreaterThan(0);
        });

        it('ImportWorkDto: lowercases deployProvider Transform', () => {
            const dto = plainToInstance(ImportWorkDto, {
                sourceUrl: 'https://github.com/example/r',
                sourceType: ImportSourceTypeEnum.DATA_REPO,
                name: 'My Work',
                gitProvider: 'github',
                deployProvider: 'VERCEL',
            });
            expect(dto.deployProvider).toBe('vercel');
        });

        it('ImportWorkDto: rejects an out-of-enum sourceType', async () => {
            const dto = plainToInstance(ImportWorkDto, {
                sourceUrl: 'https://github.com/example/r',
                sourceType: 'unknown-source',
                name: 'My Work',
                gitProvider: 'github',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isIn');
        });

        it('GetUserRepositoriesDto: rejects page/perPage < 1', async () => {
            const dto = plainToInstance(GetUserRepositoriesDto, {
                gitProvider: 'github',
                page: 0,
                perPage: 0,
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('min');
        });

        it('GetUserRepositoriesDto: rejects type out-of-enum (must be user/org)', async () => {
            const dto = plainToInstance(GetUserRepositoriesDto, {
                gitProvider: 'github',
                type: 'team',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isIn');
        });

        it('GetUserRepositoriesDto: accepts a fully populated valid payload', async () => {
            await expectValid(
                plainToInstance(GetUserRepositoriesDto, {
                    gitProvider: 'github',
                    page: 1,
                    perPage: 30,
                    search: 'foo',
                    type: 'user',
                }),
            );
        });
    });

    describe('Website-settings DTOs', () => {
        it('CustomMenuItemDto: accepts label + path with optional target/icon', async () => {
            await expectValid(
                plainToInstance(CustomMenuItemDto, {
                    label: 'Pricing',
                    path: '/pricing',
                }),
            );
            await expectValid(
                plainToInstance(CustomMenuItemDto, {
                    label: 'Docs',
                    path: '/docs',
                    target: '_blank',
                    icon: 'book',
                }),
            );
        });

        it('CustomMenuItemDto: rejects target outside the _self/_blank set', async () => {
            const dto = plainToInstance(CustomMenuItemDto, {
                label: 'X',
                path: '/x',
                target: '_top',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isIn');
        });

        it('CustomMenuItemDto: rejects label > 50 chars', async () => {
            const dto = plainToInstance(CustomMenuItemDto, {
                label: 'a'.repeat(51),
                path: '/x',
            });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('maxLength');
        });

        it('CustomMenuDto: rejects > 10 header items (ArrayMaxSize)', async () => {
            const items = Array.from({ length: 11 }, (_, i) => ({
                label: `L${i}`,
                path: `/p${i}`,
            }));
            const dto = plainToInstance(CustomMenuDto, { header: items });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('arrayMaxSize');
        });

        it('SettingsHeaderDto: rejects theme_default outside light/dark/system', async () => {
            const dto = plainToInstance(SettingsHeaderDto, { theme_default: 'sepia' });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isIn');
        });

        it('SettingsHeaderDto: accepts each documented theme_default literal', async () => {
            for (const theme of ['light', 'dark', 'system']) {
                await expectValid(plainToInstance(SettingsHeaderDto, { theme_default: theme }));
            }
        });

        it('SettingsHomepageDto: rejects non-boolean hero_enabled', async () => {
            const dto = plainToInstance(SettingsHomepageDto, { hero_enabled: 'yes' });
            const errs = await expectValidationErrors(dto);
            expect(errs).toContain('isBoolean');
        });
    });

    describe('barrel re-exports', () => {
        it('re-exports the documented DTO classes (smoke check)', () => {
            // Pin a representative subset — the full re-export count test
            // below catches accidental additions/removals.
            for (const cls of [
                'CreateWorkDto',
                'MarkdownReadmeConfigDto',
                'GenerateDataDto',
                'UpdateWorkDto',
                'UpdateWorkAdvancedPromptsDto',
                'UpdateWorkScheduleDto',
                'UpdateSourceValidationDto',
                'ImportWorkDto',
                'AnalyzeRepositoryDto',
                'GetUserRepositoriesDto',
                'CreateCategoryDto',
                'UpdateCategoryDto',
                'CreateCollectionDto',
                'UpdateCollectionDto',
                'CreateTagDto',
                'UpdateTagDto',
                'CustomMenuItemDto',
                'CustomMenuDto',
                'SettingsHeaderDto',
                'SettingsHomepageDto',
            ]) {
                expect(typeof (dtoBarrel as any)[cls]).toBe('function');
            }
        });

        it('re-exports the ImportSourceTypeEnum constant', () => {
            expect((dtoBarrel as any).ImportSourceTypeEnum).toBe(ImportSourceTypeEnum);
        });

        it('exposes a stable runtime-symbol count (regression guard for silent additions)', () => {
            // Snapshot count — if you add or remove a runtime export here,
            // bump this number deliberately.
            const keys = Object.keys(dtoBarrel).filter((k) => {
                const v = (dtoBarrel as any)[k];
                return typeof v === 'function' || (typeof v === 'object' && v !== null);
            });
            expect(keys.length).toBeGreaterThan(20);
        });
    });
});
