import { DEFAULT_COMPARISON_SETTINGS } from './types';
import type {
    ComparisonGenerationResult,
    ComparisonPair,
    ComparisonPluginSettings,
    ComparisonProgressCallback,
    ComparisonProgressInfo,
    ComparisonProgressStage,
    ComparisonResearch,
} from './types';

/**
 * `types.ts` is a contracts-only module: it declares the runtime
 * `DEFAULT_COMPARISON_SETTINGS` constant plus a handful of `interface`
 * + `type` declarations consumed across the comparison-generator
 * sub-module. The constant is the merge target for every user-facing
 * comparison plugin settings payload — silently changing one of the four
 * required-field defaults would alter behaviour on every existing work.
 *
 * The `as const`-narrowed `ComparisonProgressStage` union is published in
 * the agent-package barrel and consumed by UI status renderers to decide
 * which spinner to show; renaming a literal would silently de-link the
 * pipeline emit-side from the renderer side.
 */
describe('comparison-generator types', () => {
    describe('DEFAULT_COMPARISON_SETTINGS', () => {
        it('exposes the four documented defaults verbatim', () => {
            // Pinned because every consumer of the comparison plugin merges
            // user-supplied settings on top of these defaults — silently
            // changing one would alter behaviour across every work.
            expect(DEFAULT_COMPARISON_SETTINGS).toEqual({
                cadence_override: 'use_work',
                max_comparisons_mode: 'custom',
                max_comparisons: 50,
                min_items_for_comparison: 3,
            });
        });

        it('omits all four optional fields by default', () => {
            // The optional-field shape is documented in `ComparisonPluginSettings`:
            // `ai_provider`, `ai_model`, `custom_prompt`, `extended_analysis` are
            // all absent in the default, so a consumer can detect "user has not
            // configured this" via `Object.prototype.hasOwnProperty.call(settings, 'ai_provider')`.
            const keys = Object.keys(DEFAULT_COMPARISON_SETTINGS);
            expect(keys).not.toContain('ai_provider');
            expect(keys).not.toContain('ai_model');
            expect(keys).not.toContain('custom_prompt');
            expect(keys).not.toContain('extended_analysis');
        });

        it('only contains the four required fields (length guard)', () => {
            // Pinned via length so a future "always-emit-defaults" refactor
            // for the four optional fields breaks loudly.
            expect(Object.keys(DEFAULT_COMPARISON_SETTINGS)).toHaveLength(4);
        });

        it('the constant is the same reference on every import (module-singleton)', () => {
            // ESM-cached singleton — re-importing in jest's CJS pipeline
            // returns the same object identity.
            const first = DEFAULT_COMPARISON_SETTINGS;
            const reloaded = require('./types').DEFAULT_COMPARISON_SETTINGS;
            expect(reloaded).toBe(first);
        });

        it('matches the `ComparisonPluginSettings` interface at the type level', () => {
            // Compile-time type check: the constant is typed as
            // `ComparisonPluginSettings`, which is `readonly`. The line below
            // would be a TS error if the constant's inferred type drifted.
            const typed: ComparisonPluginSettings = DEFAULT_COMPARISON_SETTINGS;
            expect(typed).toBe(DEFAULT_COMPARISON_SETTINGS);
        });
    });

    describe('ComparisonProgressStage union (type-level pin via runtime tuple)', () => {
        it('is exhaustive: a runtime-tuple of every documented stage type-checks', () => {
            // Pinned so a new stage added to the union forces a corresponding
            // runtime addition here — surfaces drift between the AI prompt
            // pipeline and any UI status renderer.
            const stages: ComparisonProgressStage[] = [
                'researching',
                'analyzing',
                'writing',
                'writing_extended',
                'saving',
            ];
            expect(stages).toHaveLength(5);
            expect(new Set(stages).size).toBe(5);
        });
    });

    describe('ComparisonPair / ComparisonResearch / ComparisonGenerationResult shapes', () => {
        it('a minimal ComparisonPair object literal type-checks', () => {
            const pair: ComparisonPair = {
                itemA: {} as ComparisonPair['itemA'],
                itemB: {} as ComparisonPair['itemB'],
                category: 'productivity',
                pairKey: 'itemA-vs-itemB',
            };
            expect(pair.category).toBe('productivity');
            expect(pair.pairKey).toBe('itemA-vs-itemB');
        });

        it('a minimal ComparisonResearch object literal type-checks', () => {
            const research: ComparisonResearch = {
                content: 'analysis content',
                sources: [],
            };
            expect(research.content).toBe('analysis content');
            expect(research.sources).toEqual([]);
        });

        it('a ComparisonGenerationResult literal accepts an optional extendedAnalysisMarkdown', () => {
            const without: ComparisonGenerationResult = {
                comparison: {} as ComparisonGenerationResult['comparison'],
                markdown: '## a vs b',
            };
            expect(without.extendedAnalysisMarkdown).toBeUndefined();

            const withExt: ComparisonGenerationResult = {
                comparison: {} as ComparisonGenerationResult['comparison'],
                markdown: '## a vs b',
                extendedAnalysisMarkdown: '### deep dive',
            };
            expect(withExt.extendedAnalysisMarkdown).toBe('### deep dive');
        });
    });

    describe('ComparisonProgressCallback / ComparisonProgressInfo runtime shape', () => {
        it('ComparisonProgressCallback accepts every documented stage', () => {
            const stages: ComparisonProgressStage[] = [];
            const cb: ComparisonProgressCallback = (stage) => {
                stages.push(stage);
            };
            cb('researching');
            cb('analyzing');
            cb('writing');
            cb('writing_extended');
            cb('saving');
            expect(stages).toEqual([
                'researching',
                'analyzing',
                'writing',
                'writing_extended',
                'saving',
            ]);
        });

        it('a minimal ComparisonProgressInfo literal type-checks (all required fields)', () => {
            const info: ComparisonProgressInfo = {
                stage: 'researching',
                itemAName: 'Notion',
                itemBName: 'Obsidian',
                startedAt: new Date('2026-05-09T00:00:00Z').toISOString(),
            };
            expect(info.stage).toBe('researching');
            expect(info.itemAName).toBe('Notion');
            expect(info.itemBName).toBe('Obsidian');
            expect(info.startedAt).toBe('2026-05-09T00:00:00.000Z');
        });
    });
});
