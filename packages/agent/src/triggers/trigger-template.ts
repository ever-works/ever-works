/**
 * Safe `{{…}}` placeholder substitution for trigger task templates —
 * pure string work, no eval, single-pass (a value that itself contains
 * `{{event.kind}}`-looking text is inserted verbatim, never re-expanded).
 *
 * Grammar: `{{ <path> }}` where `<path>` is either
 *   - `trigger.name`,
 *   - `event.<field>` with `<field>` in {@link TEMPLATE_EVENT_FIELDS}, or
 *   - `event.payload.<key>` — one TOP-LEVEL payload key ([A-Za-z0-9_-]+).
 *
 * Rendering an unknown-but-well-formed path yields the empty string
 * (an event without that field is normal); a MALFORMED path is a
 * template-authoring error surfaced at save time by
 * {@link findInvalidTemplatePlaceholders}.
 */

export const TEMPLATE_EVENT_FIELDS = [
    'id',
    'source',
    'kind',
    'title',
    'actorName',
    'sourceUrl',
    'subjectType',
    'subjectExternalId',
    'occurredAt',
    'workId',
] as const;

export type TemplateEventField = (typeof TEMPLATE_EVENT_FIELDS)[number];

/** The event projection templates can reference. All fields optional. */
export interface TriggerTemplateEvent {
    id?: string;
    source?: string;
    kind?: string;
    title?: string | null;
    actorName?: string | null;
    sourceUrl?: string | null;
    subjectType?: string | null;
    subjectExternalId?: string | null;
    occurredAt?: Date | string | null;
    workId?: string | null;
    payload?: Record<string, unknown> | null;
}

export interface TriggerTemplateContext {
    trigger: { name: string };
    event?: TriggerTemplateEvent | null;
}

/** Any `{{ … }}` occurrence, lazily matched. */
const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const PAYLOAD_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Cap a single substituted value so one payload field can't explode a title. */
const MAX_VALUE_LENGTH = 500;

function isValidPath(path: string): boolean {
    if (path === 'trigger.name') return true;
    if (path.startsWith('event.payload.')) {
        return PAYLOAD_KEY_RE.test(path.slice('event.payload.'.length));
    }
    if (path.startsWith('event.')) {
        return (TEMPLATE_EVENT_FIELDS as readonly string[]).includes(path.slice('event.'.length));
    }
    return false;
}

function stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    }
    if (typeof value === 'string') return value.slice(0, MAX_VALUE_LENGTH);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'function' || typeof value === 'symbol') return '';
    try {
        const json = JSON.stringify(value);
        return typeof json === 'string' ? json.slice(0, MAX_VALUE_LENGTH) : '';
    } catch {
        return '';
    }
}

function resolvePath(path: string, context: TriggerTemplateContext): unknown {
    if (path === 'trigger.name') return context.trigger.name;
    const event = context.event;
    if (!event) return '';
    if (path.startsWith('event.payload.')) {
        const key = path.slice('event.payload.'.length);
        const payload = event.payload;
        if (!payload || typeof payload !== 'object') return '';
        // Own-property only — `constructor` & friends must never resolve
        // through the prototype chain.
        if (!Object.prototype.hasOwnProperty.call(payload, key)) return '';
        return (payload as Record<string, unknown>)[key];
    }
    return event[path.slice('event.'.length) as TemplateEventField];
}

/**
 * Render `template` against `context`. Well-formed-but-unknown paths →
 * empty string; malformed placeholders are left verbatim (they were
 * rejected at save time; leaving them visible beats silently eating
 * text at fire time).
 */
export function renderTriggerTemplate(template: string, context: TriggerTemplateContext): string {
    return template.replace(PLACEHOLDER_RE, (match: string, rawPath: string) => {
        const path = rawPath.trim();
        if (!isValidPath(path)) return match;
        return stringifyValue(resolvePath(path, context));
    });
}

/**
 * Every `{{…}}` occurrence whose path is not in the allowed grammar —
 * used by save-time validation so authoring mistakes 400 instead of
 * silently rendering to nothing. Returns the offending placeholder
 * texts verbatim (deduplicated, insertion order).
 */
export function findInvalidTemplatePlaceholders(template: string): string[] {
    const invalid = new Set<string>();
    for (const match of template.matchAll(PLACEHOLDER_RE)) {
        const path = (match[1] ?? '').trim();
        if (!isValidPath(path)) {
            invalid.add(match[0]);
        }
    }
    return [...invalid];
}
