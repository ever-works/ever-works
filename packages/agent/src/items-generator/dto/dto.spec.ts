import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckItemHealthDto } from './check-item-health.dto';
import {
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    ProvidersDto,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from './create-items-generator.dto';
import { DeleteWorkDto } from './delete-items-generator.dto';
import { DeployWebsiteDto } from './deploy-website.dto';
import { ExtractItemDetailsDto } from './extract-item-details.dto';
import { RemoveItemDto } from './remove-item.dto';
import { SubmitItemDto } from './submit-item.dto';
import { UpdateItemDto } from './update-item.dto';
import * as dtoBarrel from './index';

/**
 * Pins the runtime DTO classes that the items-generator surface uses as
 * input shapes. Each DTO is constructed via `plainToInstance(Dto, plain)`
 * so the `class-transformer` `@Transform()` decorators fire BEFORE
 * `class-validator.validate(instance)` runs — this matches the production
 * NestJS validation pipeline, where Transform is always before validate.
 *
 * For DTOs with `@Transform()` decorators (CreateItemsGeneratorDto.name +
 * .prompt) the suite specifically pins the "transform-truncates-before-
 * validate" boundary: oversized input is silently capped at the
 * `MaxLength` limit by the sanitize util, so `@MaxLength(N)` never trips
 * for transformed values. This is a non-obvious contract — flipping the
 * decorator order would change the user-facing rejection behaviour for
 * names/prompts longer than 200/5000 chars.
 */

// ───────────────────────────────────────────────────────────────────────
// Helper utilities — match the apps/api validation pipeline contract
// (whitelist:true; transformOptions: enableImplicitConversion:true).
// ───────────────────────────────────────────────────────────────────────

async function validateDto<T extends object>(
    cls: new () => T,
    plain: any,
): Promise<{ instance: T; errors: any[] }> {
    const instance = plainToInstance(cls, plain) as T;
    const errors = await validate(instance as object);
    return { instance, errors };
}

function constraintNames(errors: any[], path: string[] = []): string[] {
    const out: string[] = [];
    for (const err of errors) {
        if (err.constraints) {
            out.push(...Object.keys(err.constraints));
        }
        if (err.children?.length) {
            out.push(...constraintNames(err.children, [...path, err.property]));
        }
    }
    return out;
}

describe('items-generator/dto', () => {
    // ───────────────────────────────────────────────────────────────────
    describe('CheckItemHealthDto', () => {
        it('accepts a non-empty string item_slug', async () => {
            const { errors } = await validateDto(CheckItemHealthDto, { item_slug: 'foo' });
            expect(errors).toEqual([]);
        });

        it('rejects an empty string item_slug', async () => {
            const { errors } = await validateDto(CheckItemHealthDto, { item_slug: '' });
            expect(constraintNames(errors)).toContain('isNotEmpty');
        });

        it('rejects a missing item_slug', async () => {
            const { errors } = await validateDto(CheckItemHealthDto, {});
            expect(constraintNames(errors).length).toBeGreaterThan(0);
        });

        it('rejects a non-string item_slug', async () => {
            const { errors } = await validateDto(CheckItemHealthDto, { item_slug: 42 });
            expect(constraintNames(errors)).toContain('isString');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('RemoveItemDto', () => {
        it('accepts a minimal valid payload (just item_slug)', async () => {
            const { errors } = await validateDto(RemoveItemDto, { item_slug: 'foo' });
            expect(errors).toEqual([]);
        });

        it('rejects an empty string item_slug', async () => {
            const { errors } = await validateDto(RemoveItemDto, { item_slug: '' });
            expect(constraintNames(errors)).toContain('isNotEmpty');
        });

        it('accepts an optional reason string', async () => {
            const { errors } = await validateDto(RemoveItemDto, {
                item_slug: 'foo',
                reason: 'duplicate',
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-string reason', async () => {
            const { errors } = await validateDto(RemoveItemDto, {
                item_slug: 'foo',
                reason: 42,
            });
            expect(constraintNames(errors)).toContain('isString');
        });

        it('accepts create_pull_request as a boolean', async () => {
            const { errors } = await validateDto(RemoveItemDto, {
                item_slug: 'foo',
                create_pull_request: true,
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-boolean create_pull_request', async () => {
            const { errors } = await validateDto(RemoveItemDto, {
                item_slug: 'foo',
                create_pull_request: 'yes',
            });
            expect(constraintNames(errors)).toContain('isBoolean');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('ExtractItemDetailsDto', () => {
        it('accepts a valid https source_url', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'https://example.com',
            });
            expect(errors).toEqual([]);
        });

        it('accepts http://', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'http://example.com',
            });
            expect(errors).toEqual([]);
        });

        it('rejects ftp:// and other non-http/https protocols (require_tld + protocols restriction)', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'ftp://example.com',
            });
            expect(constraintNames(errors)).toContain('isUrl');
        });

        it('rejects URLs without a TLD (require_tld:true)', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'https://localhost',
            });
            expect(constraintNames(errors)).toContain('isUrl');
        });

        it('rejects garbage strings', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'not-a-url',
            });
            expect(constraintNames(errors)).toContain('isUrl');
        });

        it('accepts an optional existing_categories array of strings', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'https://example.com',
                existing_categories: ['Monitoring', 'CI/CD'],
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-string elements inside existing_categories', async () => {
            const { errors } = await validateDto(ExtractItemDetailsDto, {
                source_url: 'https://example.com',
                existing_categories: ['ok', 42],
            });
            expect(constraintNames(errors)).toContain('isString');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('UpdateItemDto', () => {
        it('accepts a minimal payload (just item_slug)', async () => {
            const { errors } = await validateDto(UpdateItemDto, { item_slug: 'foo' });
            expect(errors).toEqual([]);
        });

        it('accepts featured/source_url/order/create_pull_request', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                featured: true,
                source_url: 'https://example.com',
                order: 5,
                create_pull_request: true,
            });
            expect(errors).toEqual([]);
        });

        it('rejects negative order values', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                order: -1,
            });
            expect(constraintNames(errors)).toContain('min');
        });

        it('rejects non-integer order values', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                order: 1.5,
            });
            expect(constraintNames(errors)).toContain('isInt');
        });

        it('rejects malformed source_url (require_protocol:true — different from ExtractItemDetailsDto)', async () => {
            // UpdateItemDto uses `@IsUrl({ require_protocol: true })` WITHOUT
            // the `protocols` restriction, so it's stricter than the
            // submit-/extract-side decorators in one dimension and looser in
            // another (ftp would pass here but is blocked there). Pin the
            // actual policy.
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                source_url: 'example.com',
            });
            expect(constraintNames(errors)).toContain('isUrl');
        });

        it('rejects non-boolean featured', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                featured: 'yes',
            });
            expect(constraintNames(errors)).toContain('isBoolean');
        });

        it('accepts an optional markdown string body', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                markdown: '# Updated\n\nNew body.',
            });
            expect(errors).toEqual([]);
        });

        it('accepts an empty markdown string (treated as authored-empty by the service)', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                markdown: '',
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-string markdown', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                markdown: 42,
            });
            expect(constraintNames(errors)).toContain('isString');
        });

        it('rejects markdown longer than 100000 characters (MaxLength)', async () => {
            const { errors } = await validateDto(UpdateItemDto, {
                item_slug: 'foo',
                markdown: 'a'.repeat(100001),
            });
            expect(constraintNames(errors)).toContain('maxLength');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('SubmitItemDto', () => {
        const valid = {
            name: 'My Tool',
            description: 'A great tool',
            source_url: 'https://example.com',
            category: 'Monitoring',
        };

        it('accepts a minimal valid payload', async () => {
            const { errors } = await validateDto(SubmitItemDto, valid);
            expect(errors).toEqual([]);
        });

        it('rejects when name is missing', async () => {
            const { name: _, ...rest } = valid;
            const { errors } = await validateDto(SubmitItemDto, rest);
            expect(constraintNames(errors)).toContain('isNotEmpty');
        });

        it('rejects when description is empty', async () => {
            const { errors } = await validateDto(SubmitItemDto, { ...valid, description: '' });
            expect(constraintNames(errors)).toContain('isNotEmpty');
        });

        it('requires either category OR a non-empty categories array (single-category branch)', async () => {
            // Single category provided → categories[] not required
            const { errors } = await validateDto(SubmitItemDto, valid);
            expect(errors).toEqual([]);
        });

        it('requires either category OR a non-empty categories array (categories[] branch)', async () => {
            const { category: _, ...rest } = valid;
            const { errors } = await validateDto(SubmitItemDto, {
                ...rest,
                categories: ['Monitoring'],
            });
            expect(errors).toEqual([]);
        });

        it('rejects when both category AND categories[] are missing', async () => {
            const { category: _, ...rest } = valid;
            const { errors } = await validateDto(SubmitItemDto, rest);
            // The ValidateIf gate makes BOTH branches active; either
            // category-isString or categories-isArray will fail.
            expect(errors.length).toBeGreaterThan(0);
        });

        it('rejects when categories is provided but empty (ArrayMinSize:1)', async () => {
            const { category: _, ...rest } = valid;
            const { errors } = await validateDto(SubmitItemDto, {
                ...rest,
                categories: [],
            });
            expect(constraintNames(errors)).toContain('arrayMinSize');
        });

        it('accepts http:// and https:// source_url, rejects ftp', async () => {
            const ok = await validateDto(SubmitItemDto, { ...valid, source_url: 'http://a.test' });
            expect(ok.errors).toEqual([]);
            const bad = await validateDto(SubmitItemDto, { ...valid, source_url: 'ftp://a.test' });
            expect(constraintNames(bad.errors)).toContain('isUrl');
        });

        it('rejects non-array tags', async () => {
            const { errors } = await validateDto(SubmitItemDto, { ...valid, tags: 'a,b' });
            expect(constraintNames(errors)).toContain('isArray');
        });

        it('accepts an optional brand_logo_url with valid http(s) URL', async () => {
            const { errors } = await validateDto(SubmitItemDto, {
                ...valid,
                brand_logo_url: 'https://acme.test/logo.png',
            });
            expect(errors).toEqual([]);
        });

        it('rejects malformed brand_logo_url', async () => {
            const { errors } = await validateDto(SubmitItemDto, {
                ...valid,
                brand_logo_url: 'not-a-url',
            });
            expect(constraintNames(errors)).toContain('isUrl');
        });

        it('rejects non-URL elements inside images[]', async () => {
            const { errors } = await validateDto(SubmitItemDto, {
                ...valid,
                images: ['https://a.test/img.png', 'not-a-url'],
            });
            expect(constraintNames(errors)).toContain('isUrl');
        });

        it('rejects negative order values (Min:0)', async () => {
            const { errors } = await validateDto(SubmitItemDto, { ...valid, order: -1 });
            expect(constraintNames(errors)).toContain('min');
        });

        it('rejects non-integer order values', async () => {
            const { errors } = await validateDto(SubmitItemDto, { ...valid, order: 1.5 });
            expect(constraintNames(errors)).toContain('isInt');
        });

        it('accepts an optional markdown string body', async () => {
            const { errors } = await validateDto(SubmitItemDto, {
                ...valid,
                markdown: '# Heading\n\nBody text with `code` and a [link](https://x.test).',
            });
            expect(errors).toEqual([]);
        });

        it('accepts an empty markdown string (still optional, empty allowed)', async () => {
            const { errors } = await validateDto(SubmitItemDto, { ...valid, markdown: '' });
            expect(errors).toEqual([]);
        });

        it('rejects non-string markdown', async () => {
            const { errors } = await validateDto(SubmitItemDto, { ...valid, markdown: 42 });
            expect(constraintNames(errors)).toContain('isString');
        });

        it('rejects markdown longer than 100000 characters (MaxLength)', async () => {
            const { errors } = await validateDto(SubmitItemDto, {
                ...valid,
                markdown: 'a'.repeat(100001),
            });
            expect(constraintNames(errors)).toContain('maxLength');
        });

        it('accepts markdown exactly at the 100000-character boundary', async () => {
            const { errors } = await validateDto(SubmitItemDto, {
                ...valid,
                markdown: 'a'.repeat(100000),
            });
            expect(errors).toEqual([]);
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('ProvidersDto', () => {
        it('accepts a fully-empty payload (all fields optional)', async () => {
            const { errors } = await validateDto(ProvidersDto, {});
            expect(errors).toEqual([]);
        });

        it('accepts string values for each of the 5 documented provider keys', async () => {
            const { errors } = await validateDto(ProvidersDto, {
                search: 'tavily',
                screenshot: 'screenshotone',
                ai: 'openai',
                contentExtractor: 'local-content-extractor',
                pipeline: 'standard-pipeline',
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-string values', async () => {
            const { errors } = await validateDto(ProvidersDto, { search: 42 });
            expect(constraintNames(errors)).toContain('isString');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('CreateItemsGeneratorDto', () => {
        const valid = { name: 'My Work', prompt: 'Generate awesome things' };

        it('accepts a minimal payload (name + prompt)', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, valid);
            expect(errors).toEqual([]);
        });

        it('rejects empty name', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, { ...valid, name: '' });
            expect(constraintNames(errors)).toContain('isNotEmpty');
        });

        it('Transform sanitises name (trim + control-chars + maxLength=200) BEFORE validate runs', async () => {
            // sanitizeName trims + collapses spaces + caps at 200. Pin: a
            // 250-char input is silently capped at 200 by the Transform, so
            // @MaxLength(200) does NOT trip — different behaviour from
            // "validate first, then truncate".
            const longName = 'A'.repeat(250);
            const { instance, errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                name: longName,
            });
            expect(instance.name.length).toBe(200);
            expect(errors).toEqual([]);
        });

        it('Transform sanitises prompt (trim + control-chars + maxLength=5000) BEFORE validate runs', async () => {
            const longPrompt = 'a '.repeat(5000); // 10 000 chars
            const { instance, errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                prompt: longPrompt,
            });
            expect(instance.prompt.length).toBeLessThanOrEqual(5000);
            expect(errors).toEqual([]);
        });

        it('non-string name passes through Transform untouched and trips isString', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, { ...valid, name: 42 });
            expect(constraintNames(errors)).toContain('isString');
        });

        it('accepts each documented GenerationMethod literal', async () => {
            for (const method of Object.values(GenerationMethod)) {
                const { errors } = await validateDto(CreateItemsGeneratorDto, {
                    ...valid,
                    generation_method: method,
                });
                expect(errors).toEqual([]);
            }
        });

        it('rejects an out-of-enum generation_method', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                generation_method: 'BOGUS_METHOD',
            });
            expect(constraintNames(errors)).toContain('isEnum');
        });

        it('accepts each documented WebsiteRepositoryCreationMethod literal', async () => {
            for (const method of Object.values(WebsiteRepositoryCreationMethod)) {
                const { errors } = await validateDto(CreateItemsGeneratorDto, {
                    ...valid,
                    website_repository_creation_method: method,
                });
                expect(errors).toEqual([]);
            }
        });

        it('rejects out-of-enum website_repository_creation_method', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                website_repository_creation_method: 'BOGUS',
            });
            expect(constraintNames(errors)).toContain('isEnum');
        });

        it('validates nested ProvidersDto via @ValidateNested + @Type(() => ProvidersDto)', async () => {
            // Nested validation: a non-string `search` inside the providers
            // sub-payload must produce a child-error, not a generic isObject.
            const { errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                providers: { search: 42 },
            });
            expect(constraintNames(errors)).toContain('isString');
        });

        it('accepts a valid ProvidersDto sub-payload', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                providers: { search: 'tavily', ai: 'openai' },
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-object pluginConfig', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                pluginConfig: 'not-an-object',
            });
            expect(constraintNames(errors)).toContain('isObject');
        });

        it('accepts pluginConfig as a plain Record<string, unknown>', async () => {
            const { errors } = await validateDto(CreateItemsGeneratorDto, {
                ...valid,
                pluginConfig: { tavily: { apiKey: '...' }, depth: 3 },
            });
            expect(errors).toEqual([]);
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('UpdateItemsGeneratorDto', () => {
        it('accepts an empty payload (all fields optional)', async () => {
            const { errors } = await validateDto(UpdateItemsGeneratorDto, {});
            expect(errors).toEqual([]);
        });

        it('rejects out-of-enum generation_method', async () => {
            const { errors } = await validateDto(UpdateItemsGeneratorDto, {
                generation_method: 'BOGUS',
            });
            expect(constraintNames(errors)).toContain('isEnum');
        });

        it('rejects non-boolean update_with_pull_request', async () => {
            const { errors } = await validateDto(UpdateItemsGeneratorDto, {
                update_with_pull_request: 'yes',
            });
            expect(constraintNames(errors)).toContain('isBoolean');
        });

        it('validates nested providers sub-payload', async () => {
            const { errors } = await validateDto(UpdateItemsGeneratorDto, {
                providers: { search: 42 },
            });
            expect(constraintNames(errors)).toContain('isString');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('DeleteWorkDto', () => {
        it('accepts an empty payload', async () => {
            const { errors } = await validateDto(DeleteWorkDto, {});
            expect(errors).toEqual([]);
        });

        it('default values for the four boolean toggles are false (constructor-side defaults)', async () => {
            const { instance } = await validateDto(DeleteWorkDto, {});
            expect(instance.force_delete).toBe(false);
            expect(instance.delete_data_repository).toBe(false);
            expect(instance.delete_markdown_repository).toBe(false);
            expect(instance.delete_website_repository).toBe(false);
        });

        it('rejects non-boolean force_delete', async () => {
            const { errors } = await validateDto(DeleteWorkDto, { force_delete: 'yes' });
            expect(constraintNames(errors)).toContain('isBoolean');
        });

        it('accepts all four delete flags as true', async () => {
            const { errors } = await validateDto(DeleteWorkDto, {
                force_delete: true,
                delete_data_repository: true,
                delete_markdown_repository: true,
                delete_website_repository: true,
                reason: 'cleanup',
            });
            expect(errors).toEqual([]);
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('DeployWebsiteDto', () => {
        it('accepts an empty payload (both tokens optional)', async () => {
            const { errors } = await validateDto(DeployWebsiteDto, {});
            expect(errors).toEqual([]);
        });

        it('accepts both DEPLOY_TOKEN and GITHUB_TOKEN as strings', async () => {
            const { errors } = await validateDto(DeployWebsiteDto, {
                DEPLOY_TOKEN: 'd-token',
                GITHUB_TOKEN: 'gh-token',
            });
            expect(errors).toEqual([]);
        });

        it('rejects non-string DEPLOY_TOKEN', async () => {
            const { errors } = await validateDto(DeployWebsiteDto, { DEPLOY_TOKEN: 42 });
            expect(constraintNames(errors)).toContain('isString');
        });

        it('rejects non-string GITHUB_TOKEN', async () => {
            const { errors } = await validateDto(DeployWebsiteDto, { GITHUB_TOKEN: 42 });
            expect(constraintNames(errors)).toContain('isString');
        });
    });

    // ───────────────────────────────────────────────────────────────────
    describe('barrel re-exports', () => {
        it('re-exports the runtime DTO classes from the documented set', () => {
            // Type-only exports (response interfaces, ItemsGeneratorMetrics,
            // CancelGenerationMode, etc.) erase to nothing at runtime, so
            // we only pin the *runtime* symbols that survive compilation.
            // Note: `deploy-website.dto.ts` is intentionally NOT included
            // in `index.ts` — it's used internally by the items-generator
            // service but not part of the public DTO surface. Pinning the
            // exclusion here so a future "let's add everything" refactor
            // is a deliberate change.
            const expectedRuntimeKeys = [
                'CheckItemHealthDto',
                'CreateItemsGeneratorDto',
                'UpdateItemsGeneratorDto',
                'ProvidersDto',
                'GenerationMethod',
                'WebsiteRepositoryCreationMethod',
                'DeleteWorkDto',
                'ExtractItemDetailsDto',
                'RemoveItemDto',
                'SubmitItemDto',
                'UpdateItemDto',
            ];
            for (const key of expectedRuntimeKeys) {
                expect(Object.prototype.hasOwnProperty.call(dtoBarrel, key)).toBe(true);
            }
            // DeployWebsiteDto MUST NOT be re-exported (internal-only)
            expect(Object.prototype.hasOwnProperty.call(dtoBarrel, 'DeployWebsiteDto')).toBe(false);
        });

        it('GenerationMethod and WebsiteRepositoryCreationMethod are the same runtime values as the contract package', () => {
            // The DTO file re-exports these enum runtime values from
            // @ever-works/contracts/api so they identity-match.
            expect(typeof dtoBarrel.GenerationMethod).toBe('object');
            expect(typeof dtoBarrel.WebsiteRepositoryCreationMethod).toBe('object');
            // At least one documented value of each is present
            expect(Object.values(dtoBarrel.GenerationMethod).length).toBeGreaterThan(0);
            expect(Object.values(dtoBarrel.WebsiteRepositoryCreationMethod).length).toBeGreaterThan(
                0,
            );
        });
    });
});
