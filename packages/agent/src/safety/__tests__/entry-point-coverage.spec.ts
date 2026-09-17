import { LADDERED_CATEGORIES, type ActionCategory } from '@ever-works/contracts';
import { ENTRY_POINT_CATEGORY } from '../action-category';

/**
 * A rung that governs nothing is a setting that lies.
 *
 * This spec fails if a laddered category has no registered entry point at
 * all — which is what would happen if a category were added to the taxonomy
 * and nobody wired the action it is supposed to govern.
 */
describe('entry-point coverage', () => {
    const covered = new Set<ActionCategory>(Object.values(ENTRY_POINT_CATEGORY));

    it('gives every laddered category at least one entry point', () => {
        const uncovered = LADDERED_CATEGORIES.filter((category) => !covered.has(category));
        expect(uncovered).toEqual([]);
    });

    it('covers reading inside the workspace too, even though it is not laddered', () => {
        // `read.internal` carries no rung (FR-2) but must still classify, or
        // every internal read would count as unclassified.
        expect(covered.has('read.internal')).toBe(true);
    });

    it('reaches the categories the tool loop actually converges on', () => {
        // The tool choke point is what makes FR-14 satisfiable, so the tool
        // names themselves — not just the facade ids — have to be registered.
        const toolEntries = Object.entries(ENTRY_POINT_CATEGORY).filter(
            ([id]) => !id.startsWith('facade:'),
        );
        const toolCategories = new Set(toolEntries.map(([, category]) => category));
        for (const category of [
            'read.external',
            'write.internal',
            'message.internal',
            'message.external',
            'publish.external',
            'agent.fanout',
        ] as ActionCategory[]) {
            expect(toolCategories.has(category)).toBe(true);
        }
    });

    it('keeps money unreachable', () => {
        // FR-12: no mechanism by which an agent executes a purchase. The one
        // registered id is a placeholder that no call site passes, and this
        // assertion is what keeps it that way.
        const moneyEntries = Object.entries(ENTRY_POINT_CATEGORY).filter(
            ([, category]) => category === 'spend.commitment',
        );
        expect(moneyEntries.map(([id]) => id)).toEqual(['facade:never-purchase']);
    });
});
