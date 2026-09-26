/**
 * Retired built-in website-template rows (templates-catalog spec FR-5 c/e).
 *
 * A row is RETIRED, not deactivated, when website-template discovery finds
 * that the repository behind it is an App Blueprint (e.g. ever-works/cal-template):
 * a repository named like a website template that generates an App Work.
 *
 * - The row stays `isActive: true`, so the website resolver keeps resolving it
 *   for every Work that names it and every Work inheriting a user default set
 *   to it. Nothing that already uses the row changes.
 * - It is never listed in a template picker, and no path accepts it as a NEW
 *   selection (Work create, the Work settings update, the template switch, the
 *   user default, the fork).
 * - A user default saved on it before it was retired is not NEWLY inherited
 *   either (FR-5 f): a new Work that names no template is pinned to the
 *   template a user with no saved default gets, the listing reports that
 *   template as the default, and an existing Work cannot move to "use my
 *   default" onto the row. Works already inheriting it keep doing so.
 *
 * Retiring therefore needs no usage count and has no race: deactivating a row
 * in use broke its Works, and a count-then-deactivate left a window in which a
 * Work could land on a row that was about to stop resolving.
 *
 * The marker lives in the row's existing `metadata` JSON column (no schema
 * change): `retiredReason` plus an informational `retiredAt` timestamp. Only
 * discovery writes it, and only on discovered built-in rows; curated
 * `WEBSITE_TEMPLATES` rows and user-created templates are never retired.
 */

/** Why a row was retired. The only reason today. */
export type TemplateRetirementReason = 'app_blueprint';

const RETIRED_REASON_KEY = 'retiredReason';
const RETIRED_AT_KEY = 'retiredAt';
const RETIREMENT_REASONS: readonly TemplateRetirementReason[] = ['app_blueprint'];
const RETIREMENT_EXPLANATIONS: Record<TemplateRetirementReason, string> = {
    app_blueprint:
        'is an App Blueprint, not a website template. Choose a website template, or create an App Work ' +
        'from the Blueprint instead.',
};

type WithMetadata = { metadata?: Record<string, unknown> | null };

/** The retirement reason recorded on a row, or `null` for a row that is not retired. */
export function getTemplateRetirementReason(
    template: WithMetadata,
): TemplateRetirementReason | null {
    const reason = template.metadata?.[RETIRED_REASON_KEY];
    return RETIREMENT_REASONS.includes(reason as TemplateRetirementReason)
        ? (reason as TemplateRetirementReason)
        : null;
}

export function isRetiredTemplate(template: WithMetadata): boolean {
    return getTemplateRetirementReason(template) !== null;
}

/** `metadata` with the retirement marker added; every existing key is kept. */
export function withTemplateRetirement(
    metadata: Record<string, unknown> | null | undefined,
    reason: TemplateRetirementReason,
    retiredAt: Date = new Date(),
): Record<string, unknown> {
    return {
        ...(metadata ?? {}),
        [RETIRED_REASON_KEY]: reason,
        [RETIRED_AT_KEY]: retiredAt.toISOString(),
    };
}

/** Just the retirement marker of a row (empty for a row that is not retired). */
export function pickTemplateRetirement(template: WithMetadata): Record<string, unknown> {
    if (!isRetiredTemplate(template)) {
        return {};
    }
    const marker: Record<string, unknown> = {
        [RETIRED_REASON_KEY]: template.metadata?.[RETIRED_REASON_KEY],
    };
    if (template.metadata?.[RETIRED_AT_KEY] !== undefined) {
        marker[RETIRED_AT_KEY] = template.metadata[RETIRED_AT_KEY];
    }
    return marker;
}

type RetiredTemplateRef = {
    id: string;
    repositoryOwner?: string | null;
    repositoryName?: string | null;
};

function describeRepository(template: RetiredTemplateRef): string {
    return template.repositoryOwner && template.repositoryName
        ? ` (${template.repositoryOwner}/${template.repositoryName})`
        : '';
}

/**
 * The 400 message for an attempt to newly select a retired row. Shared by
 * every guarded write path so the refusal reads the same everywhere.
 */
export function retiredTemplateSelectionMessage(
    template: RetiredTemplateRef,
    reason: TemplateRetirementReason,
): string {
    return `Template "${template.id}"${describeRepository(template)} ${RETIREMENT_EXPLANATIONS[reason]}`;
}

const DEFAULT_INHERITANCE_EXPLANATIONS: Record<TemplateRetirementReason, string> = {
    app_blueprint:
        'is an App Blueprint, not a website template, so a Work cannot newly inherit it. Choose a ' +
        'website template for this Work, or set a website template as your default first.',
};

/**
 * The 400 message for pointing an existing Work at "use my default" (no
 * website template of its own) while the user's saved default is a retired
 * row (templates-catalog FR-5 f). The caller never named the row, so the
 * message says it is the DEFAULT that cannot be inherited.
 */
export function retiredDefaultInheritanceMessage(
    template: RetiredTemplateRef,
    reason: TemplateRetirementReason,
): string {
    return (
        `Your default website template "${template.id}"${describeRepository(template)} ` +
        DEFAULT_INHERITANCE_EXPLANATIONS[reason]
    );
}
