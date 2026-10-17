import {
    normalizeRecordListView,
    RECORD_LIST_VIEWS,
    type RecordListView,
    type RecordVisibility,
} from '@ever-works/contracts';

/**
 * Record visibility (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §7) —
 * shared by the list tabs and the visibility control. Safe on the server and the
 * client (no fetch here).
 *
 * The list tab lives in `?tab=` on the web URL (`/tasks` already uses `?view=` for
 * board / list) and is sent to the API as `view`.
 */
export const RECORD_TAB_PARAM = 'tab';

export const RECORD_TABS: readonly RecordListView[] = RECORD_LIST_VIEWS;

export type { RecordListView, RecordVisibility };

/** The five aggregates the visibility control and the tabs cover. */
export type RecordAggregate = 'task' | 'goal' | 'mission' | 'idea' | 'agent';

/** `?tab=` value → list view. Unknown or missing = `mine` (today's list). */
export function parseRecordTab(value?: string | string[] | null): RecordListView {
    return normalizeRecordListView(Array.isArray(value) ? value[0] : value);
}

/**
 * The href of `tab` on the current page: every other filter is kept, the paging
 * offset is reset (page 3 of Mine is not page 3 of Organization), and the default
 * tab drops the parameter so `Mine` keeps today's URL.
 */
export function recordTabHref(
    pathname: string,
    current: URLSearchParams,
    tab: RecordListView,
): string {
    const params = new URLSearchParams(current.toString());
    params.delete('offset');
    if (tab === 'mine') params.delete(RECORD_TAB_PARAM);
    else params.set(RECORD_TAB_PARAM, tab);
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
}

/** A visibility choice in the control: a value by hand, or `automatic` (D11). */
export type VisibilityChoice = RecordVisibility | 'automatic';

export const VISIBILITY_CHOICES: readonly VisibilityChoice[] = [
    'automatic',
    'private',
    'team',
    'organization',
];

/** What `GET /api/record-visibility/:aggregate/:id` answers. */
export interface RecordVisibilityView {
    visibility: RecordVisibility;
    visibilityExplicit: boolean;
    teamIds: string[];
    canEdit: boolean;
    organizationTeams?: Array<{ id: string; name: string; slug: string }>;
}

/** The control's current choice: `automatic` until somebody picked a value by hand. */
export function currentChoice(
    view: Pick<RecordVisibilityView, 'visibility' | 'visibilityExplicit'>,
): VisibilityChoice {
    return view.visibilityExplicit ? view.visibility : 'automatic';
}

/** Keep the list tab on a server-built href (pagination, filters). `mine` adds nothing. */
export function withRecordTab(href: string, tab: RecordListView): string {
    if (tab === 'mine') return href;
    return `${href}${href.includes('?') ? '&' : '?'}${RECORD_TAB_PARAM}=${tab}`;
}
