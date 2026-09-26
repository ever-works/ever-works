'use server';

import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import { APP_LAUNCHER_SETTINGS_PAGE_SIZE, appLauncherAPI } from '@/lib/api/app-launcher';
import { ApiResponseError } from '@/lib/api/server-api';
import type {
    AppLauncherListResponse,
    AppLauncherPreferenceChange,
    AppLauncherSavePreferencesResponse,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * APW-11 T16 — the **Manage apps** save, as a Server Action (plan §4.2, FR-28).
 *
 * The shape follows `app/actions/settings/fleet.ts`: a discriminated
 * `{ success, data, error }` result, so the client editor can render
 * `Saving…`/`Saved`/`Couldn't save. Try again.` without a thrown error crossing
 * the RSC boundary (production redacts a thrown Server Action message, so a
 * component that branched on one would show a redacted sentence).
 *
 * ## What this action deliberately does NOT do
 *
 * - **It does not revalidate the page.** Every other settings action calls
 *   `revalidatePath` because it saves a form and the page must re-read the
 *   server's copy; this one saves on a 500 ms debounce while the person keeps
 *   editing, and a revalidation would hand the editor a fresh RSC payload
 *   mid-interaction and re-mount its rows. The page is dynamic anyway
 *   (`serverFetch` is `no-store`, the shell reads cookies), so a reload already
 *   shows the stored state — and the save's own response carries the refreshed
 *   list, which is what the editor re-renders from (plan §4.2:437-438).
 * - **It never trusts the caller with whose preferences these are.** The API
 *   resolves the person from the session and the scope from the workspace
 *   header `serverFetch` stamps; the action's only input is the change list.
 * - **It does not invent the change list.** `changes` is the client's merge
 *   patch, sent verbatim: the action is transport, and the API's DTO is the
 *   validator (1..200 entries, key shape, `order` 0..9999).
 *
 * ## The pin limit is a refusal, not a message to parse
 *
 * `PUT /api/me/apps/preferences` answers **422 `{ code: 'pinLimit', limit: 6 }`**
 * when the save would hold more than six pins (FR-25): the whole save is
 * refused and nothing is written. `ApiResponseError` carries the status and the
 * code, so this action reports that as a plain failure — the person is told the
 * save did not happen, and the editor keeps the pending change queued for their
 * next attempt rather than pretending it was stored.
 *
 * ## Only async functions are exported
 *
 * A `'use server'` module may export async functions and types and nothing
 * else, so both constants below stay module-private: the editor branches on
 * `success`, never on the API's wording.
 */

/** Plan §4.5's refusal code. */
const PIN_LIMIT_CODE = 'pinLimit';

/** What a failure without a usable message reports as. */
const SAVE_ERROR_FALLBACK = 'saveFailed';

export type SaveAppLauncherPreferencesResult =
    | { success: true; data: AppLauncherSavePreferencesResponse; error: null }
    | { success: false; data: null; error: string };

/** What FR-63's filter read answers: the registry's list, or a failure to report. */
export type ReadAppLauncherListResult =
    | { success: true; data: AppLauncherListResponse; error: null }
    | { success: false; data: null; error: string };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

/**
 * The value the editor branches on when a save failed. The API's own message is
 * preferred when it has one (a 400's validation text is actionable); the
 * pin-limit refusal has no message — only a code — so it maps to the fallback.
 */
function errorMessage(error: unknown): string {
    if (error instanceof ApiResponseError) {
        if (error.statusCode === 422 || error.code === PIN_LIMIT_CODE) {
            return SAVE_ERROR_FALLBACK;
        }
        if (error.message) return error.message;
    }
    if (error instanceof Error && error.message) return error.message;
    return SAVE_ERROR_FALLBACK;
}

/**
 * Save one batch of App Launcher preferences.
 *
 * `changes` is one debounce window's merge patch: every key appears once per
 * field it changes (`visible`, `pinned`, and — for a reorder — `order` on every
 * item of the section that moved, FR-62).
 */
export async function saveAppLauncherPreferencesAction(
    changes: AppLauncherPreferenceChange[],
): Promise<SaveAppLauncherPreferencesResult> {
    await ensureAuth();
    try {
        const data = await appLauncherAPI.savePreferences(changes);
        return { success: true, data, error: null };
    } catch (error) {
        return { success: false, data: null, error: errorMessage(error) };
    }
}

/**
 * FR-63's filter, as a read (spec.md:303-305).
 *
 * The **Manage apps** filter cannot be a browser-side predicate alone: a
 * client-side filter narrows the 200 rows the page already holds, so the 240th
 * of 250 eligible items is unreachable — the one thing FR-63 forbids. This
 * action re-reads the registry with `q` set, and the API narrows the **eligible**
 * set before its cap, so the answer can contain a row the first page never had.
 *
 * It is a read, so it is deliberately **not** the save action: no
 * `revalidatePath`, no write, and the editor debounces it on its own, much
 * shorter window (`FILTER_DEBOUNCE_MS` in `AppLauncherSettings.tsx`) rather than
 * on FR-28's half-second save window.
 *
 * `filter` travels verbatim — the action is transport, and the API's
 * `ListAppLauncherQueryDto` is what trims it and refuses one past its cap. The
 * page size is the same {@link APP_LAUNCHER_SETTINGS_PAGE_SIZE} the page read
 * with, so the unfiltered case answers exactly the list the page already has.
 */
export async function readAppLauncherListAction(
    filter: string,
): Promise<ReadAppLauncherListResult> {
    await ensureAuth();
    try {
        const data = await appLauncherAPI.list({
            includeHidden: true,
            limit: APP_LAUNCHER_SETTINGS_PAGE_SIZE,
            filter,
        });
        return { success: true, data, error: null };
    } catch (error) {
        return { success: false, data: null, error: errorMessage(error) };
    }
}
