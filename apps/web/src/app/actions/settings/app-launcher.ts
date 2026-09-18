'use server';

import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import { appLauncherAPI } from '@/lib/api/app-launcher';
import { ApiResponseError } from '@/lib/api/server-api';
import type {
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
