import {
    itemDataSchema,
    itemDataWithCategoriesAndTagsSchema,
    extractedItemsSchema,
    extractedItemsSchemaWithTags,
    promptUnderstandingAssessmentSchema,
    itemBadgesSchema,
    itemDataWithBadgesSchema,
} from './item-extraction.schemas';

/**
 * Pins the AI-output zod schemas used by the items-generator pipeline.
 * These schemas are the wire-format contract between LangChain's
 * structured-output mode and downstream code that reads `name`/`source_url`/
 * `images`/etc. — flipping a `.nullable()` or default would silently break
 * existing AI prompts whose models return null for missing fields, OR force
 * downstream code into defensive `??` everywhere.
 *
 * The suite asserts:
 *   1. Required fields fail validation when missing.
 *   2. Optional fields that may be `null` (most of them) accept `null`
 *      AND omitted-as-undefined.
 *   3. Defaults (`featured`, `images`) are applied at parse time so that
 *      downstream readers can rely on `.featured` being a boolean and
 *      `.images` being an array, never `undefined`.
 *   4. The two `extractedItems*` envelopes only accept array-shaped `items`.
 *   5. The `itemBadgesSchema` record allows arbitrary keys but each value
 *      must conform to the badge sub-schema OR be null.
 */
describe('item-extraction schemas', () => {
    describe('itemDataSchema', () => {
        // The schema marks source_url/brand/brand_logo_url as `.nullable()`
        // but NOT `.optional()` — they MUST be explicitly null when the AI
        // doesn't have a value. featured + images use `.default()` so they
        // CAN be omitted (undefined → default applies). Pinning this exact
        // boundary because LangChain structured-output mode honours it.
        const minimalPayload = {
            name: 'A',
            description: 'd',
            source_url: null,
            brand: null,
            brand_logo_url: null,
        };

        it('accepts a minimal payload (required null-or-string fields explicitly null)', () => {
            const result = itemDataSchema.safeParse(minimalPayload);
            expect(result.success).toBe(true);
            if (result.success) {
                // Defaults fire when featured/images are omitted
                expect(result.data.featured).toBe(false);
                expect(result.data.images).toEqual([]);
            }
        });

        it('rejects payloads missing the required `name` field', () => {
            const { name: _name, ...rest } = minimalPayload;
            const result = itemDataSchema.safeParse(rest);
            expect(result.success).toBe(false);
        });

        it('rejects payloads missing the required `description` field', () => {
            const { description: _description, ...rest } = minimalPayload;
            const result = itemDataSchema.safeParse(rest);
            expect(result.success).toBe(false);
        });

        it('rejects payloads missing `source_url` entirely (must be null, not omitted)', () => {
            const { source_url: _source_url, ...rest } = minimalPayload;
            const result = itemDataSchema.safeParse(rest);
            expect(result.success).toBe(false);
        });

        it('rejects payloads missing `brand` entirely', () => {
            const { brand: _brand, ...rest } = minimalPayload;
            const result = itemDataSchema.safeParse(rest);
            expect(result.success).toBe(false);
        });

        it('rejects payloads missing `brand_logo_url` entirely', () => {
            const { brand_logo_url: _brand_logo_url, ...rest } = minimalPayload;
            const result = itemDataSchema.safeParse(rest);
            expect(result.success).toBe(false);
        });

        it('rejects non-string `name`', () => {
            const result = itemDataSchema.safeParse({ ...minimalPayload, name: 123 });
            expect(result.success).toBe(false);
        });

        it('accepts `source_url` as a real string (no URL-format validation — pinned)', () => {
            // The schema does NOT call `.url()` — the AI is allowed to return
            // any string and downstream code is expected to validate. Pinning
            // this so a future tightening doesn't break old prompts.
            const result = itemDataSchema.safeParse({
                ...minimalPayload,
                source_url: 'not-actually-a-url',
            });
            expect(result.success).toBe(true);
        });

        it('coerces missing `featured` to `false` via the default', () => {
            const result = itemDataSchema.safeParse(minimalPayload);
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.featured).toBe(false);
        });

        it('accepts `featured: null`', () => {
            const result = itemDataSchema.safeParse({ ...minimalPayload, featured: null });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.featured).toBeNull();
        });

        it('preserves `featured: true` when explicitly set', () => {
            const result = itemDataSchema.safeParse({ ...minimalPayload, featured: true });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.featured).toBe(true);
        });

        it('accepts `brand` and `brand_logo_url` as real strings', () => {
            const result = itemDataSchema.safeParse({
                ...minimalPayload,
                brand: 'Acme',
                brand_logo_url: 'https://acme.test/logo.png',
            });
            expect(result.success).toBe(true);
        });

        it('accepts `images: null` (different from default empty array — null preserved as-is)', () => {
            const result = itemDataSchema.safeParse({ ...minimalPayload, images: null });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.images).toBeNull();
        });

        it('coerces missing `images` to `[]` via the default', () => {
            const result = itemDataSchema.safeParse(minimalPayload);
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.images).toEqual([]);
        });

        it('accepts a non-empty images array of strings', () => {
            const result = itemDataSchema.safeParse({
                ...minimalPayload,
                images: ['https://a.test/1.png', 'https://a.test/2.png'],
            });
            expect(result.success).toBe(true);
        });

        it('rejects images entries that are non-string (defensive against tool-call confusion)', () => {
            const result = itemDataSchema.safeParse({
                ...minimalPayload,
                images: [123, 'ok'],
            });
            expect(result.success).toBe(false);
        });
    });

    describe('itemDataWithCategoriesAndTagsSchema', () => {
        const minimalCatTags = {
            name: 'A',
            description: 'd',
            source_url: null,
            brand: null,
            brand_logo_url: null,
            slug: 'a',
            category: 'Monitoring',
            tags: ['real-time', 'open-source'],
        };

        it('requires the additional category + tags + slug fields', () => {
            const result = itemDataWithCategoriesAndTagsSchema.safeParse({
                name: 'A',
                description: 'd',
                source_url: null,
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(false);
        });

        it('accepts a complete payload', () => {
            const result = itemDataWithCategoriesAndTagsSchema.safeParse(minimalCatTags);
            expect(result.success).toBe(true);
        });

        it('rejects when `tags` is not an array', () => {
            const result = itemDataWithCategoriesAndTagsSchema.safeParse({
                ...minimalCatTags,
                tags: 'real-time',
            });
            expect(result.success).toBe(false);
        });

        it('rejects when `category` is null (required string, NOT nullable — different from base)', () => {
            const result = itemDataWithCategoriesAndTagsSchema.safeParse({
                ...minimalCatTags,
                category: null,
            });
            expect(result.success).toBe(false);
        });

        it('inherits the base schema defaults for `featured` and `images`', () => {
            const result = itemDataWithCategoriesAndTagsSchema.safeParse(minimalCatTags);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.featured).toBe(false);
                expect(result.data.images).toEqual([]);
            }
        });
    });

    describe('extractedItemsSchema (envelope around itemDataSchema[])', () => {
        const validItem = {
            name: 'A',
            description: 'd',
            source_url: null,
            brand: null,
            brand_logo_url: null,
        };

        it('accepts an empty items array', () => {
            const result = extractedItemsSchema.safeParse({ items: [] });
            expect(result.success).toBe(true);
        });

        it('accepts a populated items array', () => {
            const result = extractedItemsSchema.safeParse({
                items: [validItem, { ...validItem, name: 'B' }],
            });
            expect(result.success).toBe(true);
        });

        it('rejects when `items` is missing', () => {
            const result = extractedItemsSchema.safeParse({});
            expect(result.success).toBe(false);
        });

        it('rejects when `items` is not an array', () => {
            const result = extractedItemsSchema.safeParse({ items: validItem });
            expect(result.success).toBe(false);
        });

        it('rejects when ANY item in the array fails validation', () => {
            const result = extractedItemsSchema.safeParse({
                items: [
                    validItem,
                    { name: 'B' /* missing description and other required fields */ },
                ],
            });
            expect(result.success).toBe(false);
        });
    });

    describe('extractedItemsSchemaWithTags (envelope around itemDataWithCategoriesAndTagsSchema[])', () => {
        it('accepts a fully-populated array', () => {
            const result = extractedItemsSchemaWithTags.safeParse({
                items: [
                    {
                        name: 'A',
                        description: 'd',
                        source_url: null,
                        brand: null,
                        brand_logo_url: null,
                        slug: 'a',
                        category: 'Monitoring',
                        tags: ['x'],
                    },
                ],
            });
            expect(result.success).toBe(true);
        });

        it('rejects items missing slug/category/tags', () => {
            const result = extractedItemsSchemaWithTags.safeParse({
                items: [
                    {
                        name: 'A',
                        description: 'd',
                        source_url: null,
                        brand: null,
                        brand_logo_url: null,
                    },
                ],
            });
            expect(result.success).toBe(false);
        });
    });

    describe('promptUnderstandingAssessmentSchema', () => {
        it('accepts the can_proceed:true happy path with null reason and clarifications', () => {
            const result = promptUnderstandingAssessmentSchema.safeParse({
                can_proceed: true,
                reason_if_cannot_proceed: null,
                suggested_clarifications: null,
            });
            expect(result.success).toBe(true);
        });

        it('accepts the can_proceed:false rejection with reason + clarifications', () => {
            const result = promptUnderstandingAssessmentSchema.safeParse({
                can_proceed: false,
                reason_if_cannot_proceed: 'Prompt is too vague',
                suggested_clarifications: ['What category?', 'What language?'],
            });
            expect(result.success).toBe(true);
        });

        it('rejects when can_proceed is missing (required boolean)', () => {
            const result = promptUnderstandingAssessmentSchema.safeParse({
                reason_if_cannot_proceed: null,
                suggested_clarifications: null,
            });
            expect(result.success).toBe(false);
        });

        it('rejects when can_proceed is non-boolean', () => {
            const result = promptUnderstandingAssessmentSchema.safeParse({
                can_proceed: 'yes',
                reason_if_cannot_proceed: null,
                suggested_clarifications: null,
            });
            expect(result.success).toBe(false);
        });

        it('rejects when reason_if_cannot_proceed is missing entirely (must be string-or-null)', () => {
            // The field is required — `.nullable()` allows null but not undefined.
            const result = promptUnderstandingAssessmentSchema.safeParse({
                can_proceed: false,
                suggested_clarifications: null,
            });
            expect(result.success).toBe(false);
        });

        it('rejects suggested_clarifications when not array-shaped', () => {
            const result = promptUnderstandingAssessmentSchema.safeParse({
                can_proceed: false,
                reason_if_cannot_proceed: 'x',
                suggested_clarifications: 'not-an-array',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('itemBadgesSchema (record of nullable badge entries)', () => {
        it('accepts an empty record', () => {
            const result = itemBadgesSchema.safeParse({});
            expect(result.success).toBe(true);
        });

        it('accepts arbitrary keys with valid badge values', () => {
            const result = itemBadgesSchema.safeParse({
                license: { value: 'MIT', evaluated_at: null, details: null },
                stars: { value: '10k', evaluated_at: '2026-01-01', details: 'GitHub stargazers' },
            });
            expect(result.success).toBe(true);
        });

        it('accepts null as a value for a key (badge slot intentionally cleared)', () => {
            const result = itemBadgesSchema.safeParse({ license: null });
            expect(result.success).toBe(true);
        });

        it('rejects badge entries missing the required `value` field', () => {
            const result = itemBadgesSchema.safeParse({
                license: { evaluated_at: null, details: null },
            });
            expect(result.success).toBe(false);
        });

        it('rejects when value is non-string', () => {
            const result = itemBadgesSchema.safeParse({
                license: { value: 1, evaluated_at: null, details: null },
            });
            expect(result.success).toBe(false);
        });

        it('rejects when evaluated_at or details is missing entirely (must be string-or-null)', () => {
            const r1 = itemBadgesSchema.safeParse({
                license: { value: 'MIT', details: null },
            });
            expect(r1.success).toBe(false);
            const r2 = itemBadgesSchema.safeParse({
                license: { value: 'MIT', evaluated_at: null },
            });
            expect(r2.success).toBe(false);
        });
    });

    describe('itemDataWithBadgesSchema', () => {
        it('accepts a minimal payload with badges:null', () => {
            const result = itemDataWithBadgesSchema.safeParse({
                name: 'A',
                description: 'd',
                source_url: null,
                badges: null,
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(true);
        });

        it('accepts a payload with a populated badges record', () => {
            const result = itemDataWithBadgesSchema.safeParse({
                name: 'A',
                description: 'd',
                source_url: 'https://a.test',
                badges: {
                    license: { value: 'MIT', evaluated_at: null, details: null },
                },
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(true);
        });

        it('coerces missing `featured` to false (default applies in this schema too)', () => {
            const result = itemDataWithBadgesSchema.safeParse({
                name: 'A',
                description: 'd',
                source_url: null,
                badges: null,
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.featured).toBe(false);
        });

        it('coerces missing `images` to [] via default', () => {
            const result = itemDataWithBadgesSchema.safeParse({
                name: 'A',
                description: 'd',
                source_url: null,
                badges: null,
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.images).toEqual([]);
        });

        it('rejects malformed badge values inside an otherwise-valid payload', () => {
            const result = itemDataWithBadgesSchema.safeParse({
                name: 'A',
                description: 'd',
                source_url: null,
                badges: {
                    license: { value: 1 /* non-string */, evaluated_at: null, details: null },
                },
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(false);
        });

        it('rejects when `name` is missing (still requires the base fields)', () => {
            const result = itemDataWithBadgesSchema.safeParse({
                description: 'd',
                source_url: null,
                badges: null,
                brand: null,
                brand_logo_url: null,
            });
            expect(result.success).toBe(false);
        });
    });
});
