'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { isAppSourceReasonCode, type AppTargetOwner } from '@ever-works/contracts';
import type { AppSourceReasonParams } from '@/lib/work-kinds/app-source-reasons';

/** Owners beyond this count get a type-to-search filter (spec §6.6). */
export const APP_OWNER_FILTER_THRESHOLD = 10;

export interface AppTargetOwnerPickerProps {
    owners: readonly AppTargetOwner[];
    value: string;
    onChange: (login: string) => void;
    /** `fork` reads "Fork into", `private-copy` reads "Copy into". */
    mode: 'fork' | 'private-copy';
    reasonParams: AppSourceReasonParams;
    disabled?: boolean;
}

/**
 * APW-01 T22 — the "Fork into [ owner ▾ ]" picker (spec §6.2, FR-9).
 *
 * Switching the owner re-derives everything from the preview already in hand —
 * no request. An owner the existing-fork scan did not reach
 * (`existingForkChecked: false`) stays selectable and shows no existing-fork
 * line (ACC-01-26): "not checked" is never rendered as "no fork".
 */
export function AppTargetOwnerPicker({
    owners,
    value,
    onChange,
    mode,
    reasonParams,
    disabled,
}: AppTargetOwnerPickerProps) {
    const t = useTranslations('dashboard.workCreation.app');
    const tReason = useTranslations('dashboard.workCreation.app.reasons');
    const selectId = useId();
    const [filter, setFilter] = useState('');

    const visible = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle) return owners;
        // The selected owner always stays in the list so the select never
        // silently shows a different value than the form holds.
        return owners.filter(
            (owner) => owner.login.toLowerCase().includes(needle) || owner.login === value,
        );
    }, [owners, filter, value]);

    const selected = owners.find((owner) => owner.login === value) ?? null;
    const selectedReason =
        selected && !selected.available && isAppSourceReasonCode(selected.reason)
            ? selected.reason
            : null;

    return (
        <div className="space-y-2" data-testid="app-work-owner-picker">
            <label
                htmlFor={selectId}
                className="block text-sm font-medium text-text dark:text-text-dark"
            >
                {mode === 'fork' ? t('forkInto') : t('copyInto')}
            </label>
            {owners.length > APP_OWNER_FILTER_THRESHOLD && (
                <input
                    type="search"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t('ownerFilter')}
                    aria-label={t('ownerFilter')}
                    data-testid="app-work-owner-filter"
                    className="w-full rounded-md border border-card-border dark:border-border-secondary-dark bg-transparent px-3 py-1.5 text-sm"
                />
            )}
            <select
                id={selectId}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
                data-testid="app-work-owner"
                className="w-full rounded-md border border-card-border dark:border-border-secondary-dark bg-card dark:bg-transparent px-3 py-2 text-sm"
            >
                {visible.map((owner) => {
                    const reason =
                        !owner.available && isAppSourceReasonCode(owner.reason)
                            ? tReason(owner.reason, { ...reasonParams, owner: owner.login })
                            : null;
                    const suffix = [
                        owner.type === 'organization' ? t('ownerOrganization') : null,
                        !owner.existingForkChecked ? t('ownerNotChecked') : null,
                        reason,
                    ]
                        .filter(Boolean)
                        .join(' · ');
                    return (
                        <option key={owner.login} value={owner.login} disabled={!owner.available}>
                            {suffix ? `${owner.login} — ${suffix}` : owner.login}
                        </option>
                    );
                })}
            </select>
            {selectedReason && selected && (
                <p
                    className="text-xs text-red-600 dark:text-red-400"
                    data-testid="app-work-owner-reason"
                >
                    {tReason(selectedReason, { ...reasonParams, owner: selected.login })}
                </p>
            )}
            {selected?.existingForkChecked && selected.existingFork && (
                <p
                    className="text-xs text-text-secondary dark:text-text-secondary-dark"
                    data-testid="app-work-existing-fork"
                >
                    {t('existingFork', { fullName: selected.existingFork.fullName })}
                </p>
            )}
        </div>
    );
}
