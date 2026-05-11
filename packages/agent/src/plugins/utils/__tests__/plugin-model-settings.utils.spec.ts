import type { JsonSchema, ResolvedSettings, ResolvedSetting } from '@ever-works/plugin';
import { buildProviderModelSummaries } from '../plugin-model-settings.utils';

/**
 * `buildProviderModelSummaries` is consumed by `PluginOperationsService` and
 * `GeneratorFormSchemaService` to surface a per-provider list of "currently
 * selected" model values to the UI. The function:
 *
 *   1. Walks `schema.properties` and keeps entries with `x-widget: 'model-select'`.
 *   2. Sorts the entries by a fixed order (`defaultModel` → `simpleModel`
 *      → `mediumModel` → `complexModel` → `model`), pushing any unrecognised
 *      key to the end (preserving its source order via stable sort).
 *   3. Reads each setting from `resolved` (a `ResolvedSettings` map keyed by
 *      property name), trims the `value`, and skips empty/non-string values.
 *   4. Deduplicates by raw `value` (so picking the same model in `simpleModel`
 *      AND `mediumModel` collapses to a single summary — first key wins).
 *   5. Returns `undefined` when the schema has no model fields, AND when all
 *      model fields resolved to empty values (i.e. nothing to surface).
 *
 * Pinned here so silent regressions in any of those rules — order, trim,
 * dedup, undefined-on-empty — are caught.
 */

function buildSetting(value: unknown, source: ResolvedSetting['source'] = 'user'): ResolvedSetting {
    return {
        key: 'unused',
        value,
        source,
        isFallback: false,
    };
}

describe('buildProviderModelSummaries', () => {
    describe('schema-without-model-fields short-circuit', () => {
        it('returns undefined when schema is undefined', () => {
            expect(buildProviderModelSummaries(undefined, undefined)).toBeUndefined();
        });

        it('returns undefined when schema has no properties', () => {
            const schema: JsonSchema = { type: 'object' };
            expect(buildProviderModelSummaries(schema, {})).toBeUndefined();
        });

        it('returns undefined when no property has x-widget=model-select', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    apiKey: { type: 'string', 'x-widget': 'password' } as JsonSchema,
                    other: { type: 'string' } as JsonSchema,
                },
            };
            expect(buildProviderModelSummaries(schema, {})).toBeUndefined();
        });

        it('returns undefined when every model field resolved to empty values', () => {
            // Schema HAS model fields, but the resolved values are all empty
            // — the function should still return undefined, NOT [], because
            // the consumer treats "undefined" as "no models to surface".
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting(''),
                simpleModel: buildSetting('   '),
            };
            expect(buildProviderModelSummaries(schema, resolved)).toBeUndefined();
        });
    });

    describe('happy path — single field, single value', () => {
        it('returns a single summary with key/label/value/source/isWorkOverride', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default Model',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o', 'admin'),
            };
            expect(buildProviderModelSummaries(schema, resolved)).toEqual([
                {
                    key: 'defaultModel',
                    label: 'Default Model',
                    value: 'gpt-4o',
                    source: 'admin',
                    isWorkOverride: false,
                },
            ]);
        });

        it('isWorkOverride is true ONLY when source === "work"', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const sources: Array<ResolvedSetting['source']> = [
                'default',
                'env',
                'admin',
                'work',
                'user',
            ];
            for (const source of sources) {
                const resolved: ResolvedSettings = {
                    defaultModel: buildSetting('gpt-4o', source),
                };
                const result = buildProviderModelSummaries(schema, resolved)!;
                expect(result[0].isWorkOverride).toBe(source === 'work');
                expect(result[0].source).toBe(source);
            }
        });

        it('falls back to the property key when the schema has no title', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result[0].label).toBe('defaultModel');
        });

        it('treats an empty-string title as falsy and falls back to the key', () => {
            // `title || key` — an empty-string title is falsy in JS so the
            // key wins. Pinned so a future swap to `title ?? key` (which
            // would preserve `''`) is a deliberate change.
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: '',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o'),
            };
            expect(buildProviderModelSummaries(schema, resolved)![0].label).toBe('defaultModel');
        });
    });

    describe('value normalisation', () => {
        it('trims whitespace from the resolved value', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('  gpt-4o   '),
            };
            expect(buildProviderModelSummaries(schema, resolved)![0].value).toBe('gpt-4o');
        });

        it('skips fields whose resolved value is whitespace-only (post-trim empty)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('   '),
                simpleModel: buildSetting('claude-3-5-sonnet'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result).toHaveLength(1);
            expect(result[0].key).toBe('simpleModel');
        });

        it('skips fields whose resolved value is non-string (number/null/undefined)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    mediumModel: {
                        type: 'string',
                        title: 'Medium',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    complexModel: {
                        type: 'string',
                        title: 'Complex',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting(123),
                simpleModel: buildSetting(null),
                mediumModel: buildSetting('gpt-4o'),
                complexModel: buildSetting(undefined),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                key: 'mediumModel',
                label: 'Medium',
                value: 'gpt-4o',
                source: 'user',
                isWorkOverride: false,
            });
        });

        it('skips fields whose resolved entry is missing from the map (no setting)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            // Empty map — `setting?.value` is undefined.
            expect(buildProviderModelSummaries(schema, {})).toBeUndefined();
        });

        it('handles undefined resolved (no settings layer at all)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            // The `resolved` arg can be undefined when the consumer hasn't
            // resolved settings yet; pinned because the optional-chain
            // (`resolved?.[key]`) is the only thing keeping that path alive.
            expect(buildProviderModelSummaries(schema, undefined)).toBeUndefined();
        });

        it('preserves source even when value is sourced from "default"', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o', 'default'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result[0].source).toBe('default');
            expect(result[0].isWorkOverride).toBe(false);
        });

        it('source is undefined when the resolved entry has no source field', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            // Construct a malformed setting (missing `source`) to pin the
            // `setting?.source` optional-chain — the summary's `source`
            // becomes undefined and `isWorkOverride` is `false` because
            // `undefined === 'work'` is false.
            const resolved = {
                defaultModel: { key: 'unused', value: 'gpt-4o', isFallback: false },
            } as unknown as ResolvedSettings;
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result[0].source).toBeUndefined();
            expect(result[0].isWorkOverride).toBe(false);
        });
    });

    describe('deduplication by raw value (first occurrence wins)', () => {
        it('collapses two fields that resolved to the same model into one summary', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o'),
                simpleModel: buildSetting('gpt-4o'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result).toHaveLength(1);
            // First-occurrence-wins is determined by sort order, NOT object-
            // property order. `defaultModel` is FIRST in MODEL_FIELD_ORDER
            // so it always wins over `simpleModel`.
            expect(result[0].key).toBe('defaultModel');
        });

        it('dedup is case-sensitive (different case = different value)', () => {
            // The dedup is `Set<string>`-based, so `'gpt-4o'` and `'GPT-4o'`
            // are distinct. Pinned because this is the documented behaviour
            // (model IDs are case-sensitive identifiers).
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o'),
                simpleModel: buildSetting('GPT-4o'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result).toHaveLength(2);
        });

        it('dedup is by post-trim value (so leading/trailing whitespace does NOT bypass dedup)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                defaultModel: buildSetting('gpt-4o'),
                simpleModel: buildSetting('  gpt-4o  '),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result).toHaveLength(1);
            expect(result[0].value).toBe('gpt-4o');
        });
    });

    describe('field ordering — the MODEL_FIELD_ORDER contract', () => {
        it('sorts by the documented order: defaultModel < simpleModel < mediumModel < complexModel < model', () => {
            // Schema property iteration order in modern engines preserves
            // insertion, but we deliberately register the keys in REVERSE
            // order to prove the sort is doing the work.
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    model: {
                        type: 'string',
                        title: 'Model',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    complexModel: {
                        type: 'string',
                        title: 'Complex',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    mediumModel: {
                        type: 'string',
                        title: 'Medium',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    simpleModel: {
                        type: 'string',
                        title: 'Simple',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                model: buildSetting('m-5'),
                complexModel: buildSetting('m-4'),
                mediumModel: buildSetting('m-3'),
                simpleModel: buildSetting('m-2'),
                defaultModel: buildSetting('m-1'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result.map((r) => r.key)).toEqual([
                'defaultModel',
                'simpleModel',
                'mediumModel',
                'complexModel',
                'model',
            ]);
        });

        it('pushes unrecognised keys to the end (after the documented five)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    customModel: {
                        type: 'string',
                        title: 'Custom',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                customModel: buildSetting('custom-1'),
                defaultModel: buildSetting('default-1'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result.map((r) => r.key)).toEqual(['defaultModel', 'customModel']);
        });

        it('returns 0 (stable sort) when both keys are unrecognised — preserves insertion order', () => {
            // Both keys are unrecognised, so the sort returns 0 for the
            // pair and the original property order is preserved (stable
            // sort is guaranteed in Node 12+).
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    customA: {
                        type: 'string',
                        title: 'A',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    customB: {
                        type: 'string',
                        title: 'B',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                customA: buildSetting('a'),
                customB: buildSetting('b'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result.map((r) => r.key)).toEqual(['customA', 'customB']);
        });
    });

    describe('non-model-field filtering', () => {
        it('ignores schema properties whose x-widget is anything other than "model-select"', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    apiKey: {
                        type: 'string',
                        title: 'API key',
                        'x-widget': 'password',
                    } as JsonSchema,
                    defaultModel: {
                        type: 'string',
                        title: 'Default',
                        'x-widget': 'model-select',
                    } as JsonSchema,
                    notes: { type: 'string', title: 'Notes' } as JsonSchema,
                },
            };
            const resolved: ResolvedSettings = {
                apiKey: buildSetting('sk-secret'),
                defaultModel: buildSetting('gpt-4o'),
                notes: buildSetting('hello world'),
            };
            const result = buildProviderModelSummaries(schema, resolved)!;
            expect(result).toHaveLength(1);
            expect(result[0].key).toBe('defaultModel');
        });
    });
});
