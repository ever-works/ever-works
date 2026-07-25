/**
 * Wave 11 — pure helpers for the ProfileStep's "suggested agents"
 * block. Kept free of React / server-only imports so both the client
 * step component and unit tests can use them directly.
 *
 * Agent templates (`GET /api/agents/templates`) carry display-cased
 * `suggestedRoles` hints such as 'Marketing' or 'Founder/CEO'; the
 * onboarding profile stores kebab-case ROLE_OPTIONS ids such as
 * 'marketing' or 'founder-ceo'. `normalizeRoleTag` folds both into the
 * same kebab-case space so the client-side filter can intersect them.
 */

/** Minimal structural slice of an agent template the suggestions UI needs. */
export interface SuggestableAgentTemplate {
    readonly slug: string;
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly suggestedRoles: readonly string[];
}

/**
 * Roles whose selection reveals the suggested-agents block. The Wave 10
 * prebuilt catalog is go-to-market focused, so only these roles have
 * high-signal matches today; other roles simply see no block.
 */
export const SUGGESTION_TRIGGER_ROLES: readonly string[] = ['marketing', 'sales', 'founder-ceo'];

/** Fold a role tag ('Founder/CEO', 'Marketing', 'founder-ceo') to a kebab-case id. */
export function normalizeRoleTag(tag: string): string {
    return tag
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** True when at least one selected role is a suggestion trigger. */
export function shouldShowSuggestions(selectedRoles: readonly string[]): boolean {
    return selectedRoles.some((role) => SUGGESTION_TRIGGER_ROLES.includes(normalizeRoleTag(role)));
}

/**
 * Client-side filter: templates whose `suggestedRoles` intersect the
 * selected roles (after normalisation), capped at `max` (default 3 —
 * the block shows 2-3 cards). Catalog order is preserved.
 */
export function filterSuggestedTemplates<T extends SuggestableAgentTemplate>(
    templates: readonly T[],
    selectedRoles: readonly string[],
    max = 3,
): T[] {
    const selected = new Set(selectedRoles.map(normalizeRoleTag));
    return templates
        .filter((template) =>
            template.suggestedRoles.some((role) => selected.has(normalizeRoleTag(role))),
        )
        .slice(0, Math.max(0, max));
}
