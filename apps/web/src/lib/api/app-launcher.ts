import 'server-only';
import {
    APP_LAUNCHER_MAX_ITEMS_RESPONSE,
    type AppLauncherListResponse,
    type AppLauncherPreferenceChange,
    type AppLauncherSavePreferencesResponse,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * APW-11 T16 — the **Manage apps** transport (plan §4.1, §4.2).
 *
 * The two session routes live on the API as `/api/me/apps` and
 * `/api/me/apps/preferences` (`apps/api/src/app-launcher/app-launcher.controller.ts`);
 * `serverFetch` prepends `API_URL`, stamps the workspace scope header the API
 * resolves the request against (so a personal read and an Organization read are
 * never the same list) and forwards the session token — none of which a client
 * component may do for itself.
 *
 * ## Why this is a separate module from the page
 *
 * T14's panel reads the same endpoint through the BFF route, from the browser.
 * **Manage apps** is a server surface: the preference editor saves through a
 * Server Action (T16's `saveAppLauncherPreferencesAction`), and a Server Action
 * must not be handed a fetch the browser can also reach. Keeping the two calls
 * in one `server-only` module is what makes "the web calls match the DTO
 * exactly" a one-file review.
 *
 * ## The numbers are the contract's
 *
 * `limit` is bounded by {@link APP_LAUNCHER_MAX_ITEMS_RESPONSE} (1..200) and a
 * save carries at most {@link APP_LAUNCHER_MAX_CHANGES_PER_SAVE} changes; both
 * are enforced by the API's DTO, so this module sends what the contract allows
 * rather than a number of its own.
 */

/** `/api/me/apps` — the registry read of plan §4.1. */
const APPS_ENDPOINT = '/me/apps';

/** `/api/me/apps/preferences` — the save of plan §4.2. */
const PREFERENCES_ENDPOINT = '/me/apps/preferences';

/**
 * The **Manage apps** page size (FR-63): every eligible item, 200 at a time,
 * and 200 is also the DTO's maximum (`ListAppLauncherQueryDto > limit`), so the
 * page asks for as much of the eligible set as one response can carry.
 */
export const APP_LAUNCHER_SETTINGS_PAGE_SIZE = APP_LAUNCHER_MAX_ITEMS_RESPONSE;

export interface AppLauncherReadOptions {
    /** **Manage apps** reads the hidden and not-live rows too (FR-27). */
    includeHidden?: boolean;
    /** `1..200`; the DTO's own bound. */
    limit?: number;
    /**
     * FR-63's filter — sent as `q`, the one parameter `ListAppLauncherQueryDto`
     * declares for it (the API's pipe runs with `forbidNonWhitelisted`, so the
     * spelling is part of the route's contract and not this module's choice).
     *
     * A blank needle is not sent at all: the API trims it to "no filter" anyway,
     * so `?q=` would be a request that says nothing twice. The length cap stays
     * the DTO's (`APP_LAUNCHER_FILTER_MAX_LENGTH`); it is not re-checked here,
     * because a second copy of a boundary is how the two drift apart.
     */
    filter?: string;
}

export const appLauncherAPI = {
    /**
     * `GET /api/me/apps` (plan §4.1).
     *
     * `includeHidden` is sent as the string the DTO validates (`'true'` /
     * `'false'`) and `limit` only when the caller narrows it; an absent `limit`
     * is the API's default 200, which is the same number
     * {@link APP_LAUNCHER_SETTINGS_PAGE_SIZE} names — sending it explicitly
     * makes the page's assumption visible in the request rather than implied.
     *
     * `q` is sent only when there is something to filter by (FR-63): an empty
     * filter and no filter are the same request, and the API answers them the
     * same way.
     */
    list(options: AppLauncherReadOptions = {}): Promise<AppLauncherListResponse> {
        const params = new URLSearchParams();
        if (options.includeHidden !== undefined) {
            params.set('includeHidden', options.includeHidden ? 'true' : 'false');
        }
        params.set('limit', String(options.limit ?? APP_LAUNCHER_SETTINGS_PAGE_SIZE));
        const filter = options.filter?.trim() ?? '';
        if (filter.length > 0) {
            params.set('q', filter);
        }
        return serverFetch<AppLauncherListResponse>(`${APPS_ENDPOINT}?${params.toString()}`);
    },

    /**
     * `PUT /api/me/apps/preferences` (plan §4.2).
     *
     * The body is exactly `{ changes: [{ key, visible?, pinned?, order? }] }` —
     * a merge patch per item, no `pinOrder` (the API recomputes the pin ranking
     * from the resulting sequence inside its own transaction, FR-62) and no
     * scope, user or limit field: the session and the scope header are the
     * request's authority, never the body.
     *
     * The answer is the refreshed `includeHidden=true` list, which is why the
     * editor re-renders from this response instead of keeping its optimistic
     * copy (plan §4.2:437-438).
     */
    savePreferences(
        changes: ReadonlyArray<AppLauncherPreferenceChange>,
    ): Promise<AppLauncherSavePreferencesResponse> {
        return serverMutation<AppLauncherSavePreferencesResponse>({
            endpoint: PREFERENCES_ENDPOINT,
            data: { changes: [...changes] },
            method: 'PUT',
            wrapInData: false,
        });
    },
};
