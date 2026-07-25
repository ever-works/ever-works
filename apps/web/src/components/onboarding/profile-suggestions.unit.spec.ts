import { describe, expect, it } from 'vitest';
import {
    filterSuggestedTemplates,
    normalizeRoleTag,
    shouldShowSuggestions,
    type SuggestableAgentTemplate,
} from './profile-suggestions';

/**
 * Wave 11 — the ProfileStep's suggested-agents helpers. The Wave 10
 * template catalog tags templates with display-cased roles such as
 * 'Founder/CEO'; the wizard stores kebab-case ROLE_OPTIONS ids such as
 * 'founder-ceo'. These specs pin the normalisation bridge + filter.
 */

function template(slug: string, suggestedRoles: string[]): SuggestableAgentTemplate {
    return {
        slug,
        name: slug,
        title: `${slug} title`,
        description: `${slug} description`,
        suggestedRoles,
    };
}

const CATALOG: SuggestableAgentTemplate[] = [
    template('content-marketer', ['Marketing', 'Founder/CEO']),
    template('seo-auditor', ['Marketing', 'Engineering']),
    template('lead-researcher', ['Sales', 'Founder/CEO']),
    template('outreach-drafter', ['Sales']),
    template('social-scheduler', ['Marketing']),
    template('competitive-analyst', ['Marketing', 'Product', 'Founder/CEO']),
];

describe('normalizeRoleTag', () => {
    it('folds display-cased catalog tags onto kebab-case profile ids', () => {
        expect(normalizeRoleTag('Founder/CEO')).toBe('founder-ceo');
        expect(normalizeRoleTag('Marketing')).toBe('marketing');
        expect(normalizeRoleTag('founder-ceo')).toBe('founder-ceo');
    });
});

describe('shouldShowSuggestions', () => {
    it('is true only when a trigger role (marketing/sales/founder-ceo) is selected', () => {
        expect(shouldShowSuggestions(['marketing'])).toBe(true);
        expect(shouldShowSuggestions(['sales', 'engineering'])).toBe(true);
        expect(shouldShowSuggestions(['founder-ceo'])).toBe(true);
        expect(shouldShowSuggestions(['engineering', 'legal'])).toBe(false);
        expect(shouldShowSuggestions([])).toBe(false);
    });
});

describe('filterSuggestedTemplates', () => {
    it('returns templates whose suggestedRoles intersect the selection, capped at 3', () => {
        const marketing = filterSuggestedTemplates(CATALOG, ['marketing']);
        expect(marketing.map((t) => t.slug)).toEqual([
            'content-marketer',
            'seo-auditor',
            'social-scheduler',
        ]);
        expect(marketing.length).toBeLessThanOrEqual(3);
    });

    it('matches founder-ceo against display-cased Founder/CEO tags', () => {
        const founder = filterSuggestedTemplates(CATALOG, ['founder-ceo']);
        expect(founder.map((t) => t.slug)).toEqual([
            'content-marketer',
            'lead-researcher',
            'competitive-analyst',
        ]);
    });

    it('returns an empty list when no selected role matches the catalog', () => {
        expect(filterSuggestedTemplates(CATALOG, ['legal'])).toEqual([]);
        expect(filterSuggestedTemplates(CATALOG, [])).toEqual([]);
    });

    it('honours a custom cap', () => {
        expect(filterSuggestedTemplates(CATALOG, ['marketing'], 2)).toHaveLength(2);
        expect(filterSuggestedTemplates(CATALOG, ['marketing'], 0)).toEqual([]);
    });
});
