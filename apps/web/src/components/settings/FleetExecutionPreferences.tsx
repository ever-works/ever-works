'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Cloud, Laptop, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { DEFAULT_FLEET_EXECUTION_MODE, FLEET_EXECUTION_MODES } from '@ever-works/contracts';
import type {
    FleetExecutionMode,
    FleetExecutionPreferenceView,
    FleetExecutionScopeType,
} from '@/lib/api/fleet';
import {
    clearFleetExecutionPreferenceAction,
    setFleetExecutionPreferenceAction,
} from '@/app/actions/settings/fleet';

interface FleetExecutionPreferencesProps {
    initialPreferences: FleetExecutionPreferenceView[];
    error: string | null;
}

/**
 * Execution routing — where runs go when this account has local runners.
 *
 * Two surfaces, because the underlying model has two levels and hiding
 * either one would make the other lie:
 *
 *   1. The ACCOUNT default, edited here directly. This is the row most
 *      owners will ever touch.
 *   2. The narrower per-Work / per-Goal overrides, LISTED here with a
 *      clear action. They are set from the Work/Goal they belong to
 *      (that is where the user knows which one they mean), but they must
 *      be visible and revocable from one place — an override the owner
 *      cannot find is how "I set the account to cloud and it still runs
 *      locally" becomes an unexplainable bug.
 *
 * The three modes are described in full rather than by name alone: the
 * difference between `local-wait` and `local-fallback` is precisely what
 * happens on a bad day, and a label like "Local runner" would not convey
 * which bad day the user is choosing.
 */
export function FleetExecutionPreferences({
    initialPreferences,
    error,
}: FleetExecutionPreferencesProps) {
    const t = useTranslations('dashboard.settings.fleet.routing');
    const [preferences, setPreferences] =
        useState<FleetExecutionPreferenceView[]>(initialPreferences);
    const [isPending, startTransition] = useTransition();

    const accountRow = preferences.find((entry) => entry.scopeType === 'user') ?? null;
    const accountMode: FleetExecutionMode = accountRow?.mode ?? DEFAULT_FLEET_EXECUTION_MODE;
    const overrides = preferences.filter((entry) => entry.scopeType !== 'user');

    const handleAccountChange = (mode: FleetExecutionMode) => {
        startTransition(async () => {
            const result = await setFleetExecutionPreferenceAction({ scopeType: 'user', mode });
            if (result.success) {
                setPreferences((prev) => [
                    ...prev.filter((entry) => entry.scopeType !== 'user'),
                    result.data,
                ]);
                toast.success(t('saved'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleClear = (scopeType: FleetExecutionScopeType, scopeId: string | null) => {
        startTransition(async () => {
            const result = await clearFleetExecutionPreferenceAction(scopeType, scopeId);
            if (result.success) {
                setPreferences((prev) =>
                    prev.filter(
                        (entry) =>
                            !(entry.scopeType === scopeType && (entry.scopeId ?? null) === scopeId),
                    ),
                );
                toast.success(t('cleared'));
            } else {
                toast.error(result.error);
            }
        });
    };

    return (
        <div className="space-y-3" data-testid="fleet-routing-section">
            <div className="flex items-center gap-2">
                <Laptop className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark max-w-2xl">
                {t('description')}
            </p>

            {error && (
                <p className="text-sm text-warning" data-testid="fleet-routing-error">
                    {error}
                </p>
            )}

            <div className="max-w-md space-y-1.5">
                <label
                    className="block text-sm font-medium text-text dark:text-text-dark"
                    htmlFor="fleet-routing-account-mode"
                >
                    {t('accountLabel')}
                </label>
                <Select
                    // `id` (not just the testid) so the label above
                    // actually associates — a `htmlFor` pointing at a
                    // testid names nothing, and a screen reader would
                    // announce this control unlabelled.
                    id="fleet-routing-account-mode"
                    value={accountMode}
                    onValueChange={(value) => handleAccountChange(value as FleetExecutionMode)}
                    disabled={isPending}
                    data-testid="fleet-routing-account-mode"
                >
                    {FLEET_EXECUTION_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                            {t(`modes.${mode}.label` as never)}
                        </option>
                    ))}
                </Select>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t(`modes.${accountMode}.helper` as never)}
                </p>
            </div>

            <div className="space-y-2">
                <h4 className="text-xs font-semibold text-text dark:text-text-dark">
                    {t('overridesTitle')}
                </h4>
                {overrides.length === 0 ? (
                    <p
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-routing-overrides-empty"
                    >
                        {t('overridesEmpty')}
                    </p>
                ) : (
                    <ul className="space-y-1" data-testid="fleet-routing-overrides">
                        {overrides.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex items-center gap-2 text-xs text-text dark:text-text-dark"
                            >
                                {entry.mode === 'cloud' ? (
                                    <Cloud className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark shrink-0" />
                                ) : (
                                    <Laptop className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark shrink-0" />
                                )}
                                <span className="text-text-muted dark:text-text-muted-dark">
                                    {t(`scopes.${entry.scopeType}` as never)}
                                </span>
                                <code className="font-mono truncate max-w-[16rem]">
                                    {entry.scopeId}
                                </code>
                                <span className="ml-auto">
                                    {t(`modes.${entry.mode}.label` as never)}
                                </span>
                                <Button
                                    variant="ghost"
                                    onClick={() =>
                                        handleClear(entry.scopeType, entry.scopeId ?? null)
                                    }
                                    disabled={isPending}
                                    title={t('clear')}
                                    data-testid={`fleet-routing-clear-${entry.id}`}
                                >
                                    <Trash2 className="w-3.5 h-3.5 text-danger" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
