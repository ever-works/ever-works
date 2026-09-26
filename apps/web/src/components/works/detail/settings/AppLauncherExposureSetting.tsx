'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { isAppWorkKind } from '@ever-works/contracts';
import { setWorkAppLauncherExposureAction } from '@/app/actions/dashboard/works';
import { canEdit } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useRouter } from '@/i18n/navigation';
import type { WorkMemberRole } from '@/lib/api/enums';
import type { Work } from '@/lib/api/types-only';

/**
 * APW-11 T17 — the Work-level **Show in App Launcher** setting (plan §7, spec
 * FR-19, FR-23, FR-59, FR-60).
 *
 * This one component is the control on **both** surfaces — the settings card
 * (`GeneralSettings`, reached by MANAGER+) and the Overview card
 * (`AppLauncherExposureCard`, reached by everyone) — so the two cannot drift into
 * showing different states for the same Work (ACC-11-45).
 *
 * ## The four rules it exists to get right
 *
 * 1. **It saves through its own action, never through the General form**
 *    (APW11-G02). `useSettings().handleUpdate` submits the whole form to
 *    `updateWork`, whose zod object does not declare `appLauncherExposed` and
 *    therefore **strips** it — and the same action then rewrites the Work's
 *    README. This component imports neither: it calls
 *    {@link setWorkAppLauncherExposureAction}, which sends exactly
 *    `{ appLauncherExposed }` to `PUT /api/works/:id`, so the choice persists and
 *    nothing else about the Work is touched.
 * 2. **The launcher flag decides whether it exists at all** (APW11-G13): the
 *    caller mounts it only when `appLauncherEnabled` is true, and the prop
 *    defaults to `false` up the chain.
 * 3. **A Work with no address cannot be listed**, so the switch is disabled and
 *    says so (`disabledNotLive`) while still showing the stored choice — the
 *    setting is unavailable, not forgotten (ACC-11-17).
 * 4. **A viewer reads who can change it** (`viewerReadOnly`) rather than being
 *    offered a control the API would refuse: the change is granted to EDITOR or
 *    higher (`ensureCanEdit`, `work-ownership.service.ts:142-143`), which is
 *    exactly `canEdit` from `@/lib/permissions` (ACC-11-15).
 *
 * ## Why the kind default is computed here
 *
 * `null` means "no explicit choice, follow the kind" (FR-19): on for an `app`
 * Work, off for every other kind. The API's `effectiveExposed` answers that for
 * the *stored* value, but not for the value a person is about to choose — after
 * **Reset to default** the switch has to land on the kind default immediately,
 * before the refreshed payload arrives.
 */

/**
 * `work.appLauncher` — the projection the Work detail payload carries. Derived
 * from the API type rather than re-declared, so a rename cannot leave the two
 * out of step.
 */
export type WorkAppLauncherExposure = NonNullable<Work['appLauncher']>;

/** Where a save is, from the person's point of view (plan §8's save states). */
type SaveState = 'idle' | 'saved' | 'error';

export interface AppLauncherExposureSettingProps {
    /** The Work the choice belongs to. */
    workId: string;
    /**
     * `work.appLauncher`. Absent means the API did not answer the projection
     * (an older deployment): render nothing rather than guess a state.
     */
    exposure?: WorkAppLauncherExposure;
    /** `work.kind` — what an explicit `null` falls back to (FR-19). */
    kind?: string;
    /** `work.userRole` — the same role the API's `ensureCanEdit` reads. */
    userRole?: WorkMemberRole;
    /**
     * Render the setting's own title and description. `false` when a card
     * already shows them (the Overview card), so no sentence is printed twice.
     */
    showHeading?: boolean;
}

export function AppLauncherExposureSetting({
    workId,
    exposure,
    kind,
    userRole,
    showHeading = true,
}: AppLauncherExposureSettingProps) {
    const t = useTranslations('dashboard.workDetail.settings.appLauncher');
    const router = useRouter();

    const [exposed, setExposed] = useState<boolean | null>(exposure?.exposed ?? null);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [pending, setPending] = useState(false);

    const save = useCallback(
        async (next: boolean | null) => {
            const previous = exposed;
            // Optimistic: the switch follows the person's hand immediately and is
            // put back if the API refuses, so the control never lies for long.
            setExposed(next);
            setSaveState('idle');
            setPending(true);
            try {
                const result = await setWorkAppLauncherExposureAction(workId, next);
                if (!result.success) {
                    setExposed(previous);
                    setSaveState('error');
                    return;
                }
                setSaveState('saved');
                // The server payload is the source of truth for `exposed` /
                // `live`, so the page re-reads it after a save while the switch
                // stays where the person put it.
                router.refresh();
            } catch {
                setExposed(previous);
                setSaveState('error');
            } finally {
                setPending(false);
            }
        },
        [exposed, router, workId],
    );

    if (!exposure) return null;

    const editable = canEdit(userRole);
    const checked = exposed ?? isAppWorkKind(kind);
    const disabled = !editable || !exposure.live || pending;

    return (
        <div className="space-y-1.5" data-testid="app-launcher-exposure-setting">
            <div
                className={cn(
                    'flex items-start gap-3',
                    showHeading ? 'justify-between' : 'justify-end',
                )}
            >
                {showHeading ? (
                    <span className="text-sm text-text dark:text-text-dark">{t('title')}</span>
                ) : null}
                <input
                    type="checkbox"
                    role="switch"
                    data-testid="app-launcher-exposure-switch"
                    // The accessible name of the toggle, identical on both
                    // surfaces (plan §8's `switchLabel`) — it is what a screen
                    // reader announces when the title is not rendered beside it.
                    aria-label={t('switchLabel')}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:opacity-50"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => void save(event.target.checked)}
                />
            </div>

            {showHeading ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('description')}
                </p>
            ) : null}

            {!editable ? (
                <p
                    data-testid="app-launcher-exposure-read-only"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {t('viewerReadOnly')}
                </p>
            ) : !exposure.live ? (
                <p
                    data-testid="app-launcher-exposure-not-live"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {t('disabledNotLive')}
                </p>
            ) : null}

            {/* FR-60: offered only when there IS an explicit choice to clear. */}
            {editable && exposed !== null ? (
                <button
                    type="button"
                    data-testid="app-launcher-exposure-reset"
                    onClick={() => void save(null)}
                    className="text-xs text-primary hover:text-primary-hover disabled:opacity-50"
                >
                    {t('resetToDefault')}
                </button>
            ) : null}

            {saveState === 'idle' ? null : (
                <p
                    data-testid="app-launcher-exposure-save-state"
                    role={saveState === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className={cn(
                        'text-xs',
                        saveState === 'error'
                            ? 'text-error'
                            : 'text-text-muted dark:text-text-muted-dark',
                    )}
                >
                    {saveState === 'error' ? t('saveFailed') : t('saved')}
                </p>
            )}
        </div>
    );
}
