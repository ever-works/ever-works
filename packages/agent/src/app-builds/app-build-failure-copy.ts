import {
    APP_BUILD_FAILURE_CLASSES,
    APP_BUILD_FAILURE_COPY_EN,
    type AppBuildFailureClass,
    type AppBuildFailureCopyEntry,
    type AppBuildFailureHandoff,
} from '@ever-works/contracts';

/**
 * APW-05 T17 — the failure copy of plan §5 (`plan.md:1225-1241`), FR-39,
 * ACC-05-19, `APW05-G12`.
 *
 * ## One template, three renderers
 *
 * The English title and suggestion per failure class live **once**, in
 * `APP_BUILD_FAILURE_COPY_EN` (`packages/contracts/src/apps/builds.ts:1030`), as
 * ICU-style `{param}` templates. Three things read them and none of them owns a
 * copy of its own:
 *
 *   1. the web's failure panel, through next-intl's
 *      `dashboard.workDetail.builds.failure.<class>.{title,suggestion}` leaves,
 *      whose parity with the templates a web test pins (`plan.md:1230-1231`);
 *   2. {@link AppBuildFailureCopy.forAgent} — the `AppBuildFailureHandoff` this
 *      epic hands to APW-08's delivery follow-up (T44), so the agent receives the
 *      same words the owner saw;
 *   3. the i18n key lookup the API publishes alongside a failed Build's detail.
 *
 * ## What this file maps, and what it refuses to invent
 *
 * The **keys** are `dashboard.workDetail.builds.failure.<class>.title` /
 * `.suggestion` (plan §8's leaf shape) and the **params** are the placeholders
 * the templates actually carry — `{memory}`/`{max}` for `outOfMemory`,
 * `{step}`/`{total}`/`{command}`/`{dockerfile}` for `dockerfileError`,
 * `{names}` for `missingBuildValue`, and so on. A class whose template has no
 * placeholder maps to `{}` rather than to a speculative empty string.
 *
 * A param whose value the Build row does not carry is **left out**, so the
 * template's placeholder survives into the rendered string and the gap is
 * visible; `failureDetail` is "names and numbers only" (`plan.md:352`) and this
 * file never reaches for anything it does not have.
 *
 * ## The excerpt is already redacted, and `untrusted` is a literal
 *
 * `forAgent` copies `failureExcerpt` verbatim (≤ 20 lines × ≤ 300 characters,
 * already through APW-07's redactor — `plan.md:1233-1237`) and sets
 * `untrusted: true`. **No consumer ever fetches or re-redacts build logs
 * itself** (FR-38), which is why this is the only place a hand-off is built.
 */

/** The i18n key namespace every failure leaf hangs under (plan §8). */
export const APP_BUILD_FAILURE_I18N_PREFIX = 'dashboard.workDetail.builds.failure';

/** The suffix of a class's title leaf. */
export const APP_BUILD_FAILURE_TITLE_SUFFIX = 'title';

/** The suffix of a class's suggestion leaf. */
export const APP_BUILD_FAILURE_SUGGESTION_SUFFIX = 'suggestion';

/** The fields `forAgent` reads off a Build: names, numbers and already-redacted lines. */
export interface AppBuildFailureSource {
    /** `work_builds.failureClass`; `null`/unknown is rendered as `unknown`. */
    readonly failureClass: AppBuildFailureClass | string | null;
    /** `work_builds.failureDetail` — `{ step?, total?, command?, names?, memory?, max? }`. */
    readonly failureDetail?: Record<string, unknown> | null;
    /** `work_builds.failureExcerpt` — already redacted, never re-fetched. */
    readonly failureExcerpt?: readonly string[] | null;
    /** `work_builds.logsUrl`. */
    readonly logsUrl?: string | null;
}

/** A `{param}` template rendered with the params it was given. */
export function renderAppBuildFailureTemplate(
    template: string,
    params: Readonly<Record<string, string | number>>,
): string {
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
        const value = params[name];
        return value === undefined ? whole : String(value);
    });
}

/** The copy entry (title + suggestion templates) of a class. */
export function appBuildFailureCopyFor(
    failureClass: AppBuildFailureClass | string | null,
): AppBuildFailureCopyEntry {
    const known = normaliseFailureClass(failureClass);
    return APP_BUILD_FAILURE_COPY_EN[known];
}

/** `null`, an empty string or a class this release does not know renders as `unknown`. */
export function normaliseFailureClass(
    failureClass: AppBuildFailureClass | string | null | undefined,
): AppBuildFailureClass {
    if (typeof failureClass !== 'string') return 'unknown';
    return (APP_BUILD_FAILURE_CLASSES as readonly string[]).includes(failureClass)
        ? (failureClass as AppBuildFailureClass)
        : 'unknown';
}

/**
 * The `{param}` values a class's templates read, taken from `failureDetail`.
 *
 * Numbers are stringified; arrays are joined with `, ` (the `{names}` case, whose
 * copy prints "A build value is missing: A, B"). Anything the detail does not
 * carry is omitted — see the file docstring.
 */
export function appBuildFailureParams(
    failureClass: AppBuildFailureClass | string | null,
    detail?: Record<string, unknown> | null,
): Record<string, string | number> {
    const known = normaliseFailureClass(failureClass);
    const source = detail ?? {};
    const params: Record<string, string | number> = {};

    const take = (key: string, as: 'string' | 'number' | 'list' = 'string'): void => {
        const raw = source[key];
        if (raw === undefined || raw === null) return;
        if (as === 'list') {
            const list = Array.isArray(raw) ? raw : [raw];
            params[key] = list.map((item) => String(item)).join(', ');
            return;
        }
        if (as === 'number') {
            const value = typeof raw === 'number' ? raw : Number(raw);
            if (Number.isFinite(value)) params[key] = value;
            return;
        }
        params[key] = String(raw);
    };

    switch (known) {
        case 'outOfMemory':
            take('memory');
            take('max', 'number');
            break;
        case 'dockerfileError':
            take('step', 'number');
            take('total', 'number');
            take('command');
            take('dockerfile');
            break;
        case 'missingBuildValue':
            take('names', 'list');
            break;
        case 'secretInImage':
            take('name');
            break;
        case 'timeout':
            take('minutes', 'number');
            break;
        case 'verificationFailed':
            take('failed', 'number');
            take('total', 'number');
            break;
        case 'egressBlocked':
            take('hosts', 'list');
            break;
        default:
            // Every remaining class's template has no placeholder (or, for a class
            // this release does not know, no template at all). Nothing to map — and
            // an unknown class never invents a param.
            break;
    }

    return params;
}

/**
 * The failure copy a Build's UI and an agent hand-off both read.
 *
 * A class rather than a bag of functions because the web's parity test and the
 * agent's hand-off must go through the SAME three members; a second call path
 * would be a second chance to render a different string.
 */
export class AppBuildFailureCopy {
    /** The next-intl leaf key of a class's title. */
    static titleKey(failureClass: AppBuildFailureClass | string | null): string {
        return `${APP_BUILD_FAILURE_I18N_PREFIX}.${normaliseFailureClass(failureClass)}.${APP_BUILD_FAILURE_TITLE_SUFFIX}`;
    }

    /** The next-intl leaf key of a class's suggestion. */
    static suggestionKey(failureClass: AppBuildFailureClass | string | null): string {
        return `${APP_BUILD_FAILURE_I18N_PREFIX}.${normaliseFailureClass(failureClass)}.${APP_BUILD_FAILURE_SUGGESTION_SUFFIX}`;
    }

    /**
     * Both leaves of a class with its params — what the API publishes beside a
     * failed Build so the web can render without importing the English templates.
     */
    static describe(
        failureClass: AppBuildFailureClass | string | null,
        detail?: Record<string, unknown> | null,
    ): {
        readonly class: AppBuildFailureClass;
        readonly titleKey: string;
        readonly suggestionKey: string;
        readonly params: Record<string, string | number>;
    } {
        const known = normaliseFailureClass(failureClass);
        return {
            class: known,
            titleKey: AppBuildFailureCopy.titleKey(known),
            suggestionKey: AppBuildFailureCopy.suggestionKey(known),
            params: appBuildFailureParams(known, detail),
        };
    }

    /**
     * The payload APW-08's delivery follow-up hands to a Task's agent
     * (plan §5:1225-1241, `APW05-G12`) — the type is contracts'
     * `AppBuildFailureHandoff`.
     *
     * `excerpt` is copied from the row, never fetched and never re-redacted;
     * `untrusted` is the literal `true`.
     */
    static forAgent(source: AppBuildFailureSource): AppBuildFailureHandoff {
        const known = normaliseFailureClass(source.failureClass);
        const params = appBuildFailureParams(known, source.failureDetail);
        const copy = APP_BUILD_FAILURE_COPY_EN[known];

        return {
            class: known,
            title: renderAppBuildFailureTemplate(copy.title, params),
            suggestion: renderAppBuildFailureTemplate(copy.suggestion, params),
            excerpt: [...(source.failureExcerpt ?? [])],
            logsUrl: source.logsUrl ?? null,
            untrusted: true,
        };
    }
}
