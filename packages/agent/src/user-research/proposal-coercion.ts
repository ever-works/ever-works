import { slugifyText } from '../utils/text.utils';
import {
    workProposalSchema,
    type PermissiveWorkProposalDraft,
    type WorkProposalDraft,
} from './schemas';

const SUGGESTED_FIELD_TYPES = ['string', 'url', 'image', 'number', 'enum', 'markdown'] as const;
type SuggestedFieldType = (typeof SUGGESTED_FIELD_TYPES)[number];

const TITLE_MIN = 8;
const TITLE_MAX = 80;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 280;
const REASONING_MAX = 280;
const CATEGORIES_MIN = 2;
const CATEGORIES_MAX = 8;
const FIELDS_MAX = 10;
const PLUGINS_MAX = 5;

function stringValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function clipMax(s: string, max: number): string {
    return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/** Strip anything the strict slug regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` rejects. */
function tightenSlug(slug: string): string {
    return slug
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function safeSlug(input: string, fallback?: string): string {
    const slug = tightenSlug(slugifyText(input || ''));
    if (slug.length > 0) return slug;
    return fallback ? tightenSlug(slugifyText(fallback)) : '';
}

const FIELD_TYPE_ALIASES: Record<string, SuggestedFieldType> = {
    text: 'string',
    str: 'string',
    string: 'string',
    url: 'url',
    link: 'url',
    img: 'image',
    image: 'image',
    photo: 'image',
    num: 'number',
    int: 'number',
    integer: 'number',
    float: 'number',
    number: 'number',
    enum: 'enum',
    select: 'enum',
    md: 'markdown',
    markdown: 'markdown',
};

function coerceFieldType(raw: string): SuggestedFieldType | null {
    const key = raw.trim().toLowerCase();
    return FIELD_TYPE_ALIASES[key] ?? null;
}

/**
 * Coerce a loose, LLM-shaped proposal into the strict on-disk shape.
 * Slugifies anything slug-like, clips long strings, filters bad enums.
 * Returns null when the draft has no salvageable content (e.g. blank title
 * or fewer than 2 valid categories — both are hard DB requirements).
 */
export function coerceWorkProposal(draft: PermissiveWorkProposalDraft): WorkProposalDraft | null {
    const title = clipMax(stringValue(draft.title).trim(), TITLE_MAX);
    if (title.length < TITLE_MIN) return null;

    const description = clipMax(stringValue(draft.description).trim(), DESCRIPTION_MAX);
    if (description.length < DESCRIPTION_MIN) return null;

    // Slug derived from the LLM hint, falling back to the title so we never
    // bail on a missing/garbled slug.
    const slugSuggestion = safeSlug(stringValue(draft.slugSuggestion), title);
    if (slugSuggestion.length === 0) return null;

    const suggestedCategories = arrayValue(draft.suggestedCategories)
        .map((raw) => {
            const c = objectValue(raw);
            const name = stringValue(c.name).trim();
            const slug = safeSlug(stringValue(c.slug) || name, name);
            return slug.length > 0 ? { name: name || slug, slug } : null;
        })
        .filter((c): c is { name: string; slug: string } => c !== null)
        .slice(0, CATEGORIES_MAX);
    if (suggestedCategories.length < CATEGORIES_MIN) return null;

    const suggestedFields = arrayValue(draft.suggestedFields)
        .map((raw) => {
            const f = objectValue(raw);
            const type = coerceFieldType(stringValue(f.type));
            return type ? { name: stringValue(f.name).trim() || type, type } : null;
        })
        .filter((f): f is { name: string; type: SuggestedFieldType } => f !== null)
        .slice(0, FIELDS_MAX);

    const recommendedPlugins = arrayValue(draft.recommendedPlugins)
        .map((raw) => objectValue(raw))
        .filter((p) => stringValue(p.pluginId).trim().length > 0)
        .map((p) => ({
            pluginId: stringValue(p.pluginId).trim(),
            reason: stringValue(p.reason).trim(),
        }))
        .slice(0, PLUGINS_MAX);

    const reasoning = clipMax(stringValue(draft.reasoning).trim(), REASONING_MAX);

    const candidate = {
        title,
        description,
        slugSuggestion,
        suggestedCategories,
        suggestedFields,
        recommendedPlugins,
        reasoning,
    };

    // Final guard: if our coercion still produced something that fails the
    // strict schema (e.g. clip-then-trim took us below TITLE_MIN), drop it.
    const result = workProposalSchema.safeParse(candidate);
    return result.success ? result.data : null;
}
