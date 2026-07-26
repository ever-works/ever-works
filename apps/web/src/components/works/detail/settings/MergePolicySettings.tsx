'use client';

import type { MergePolicyOverride } from '@ever-works/contracts';
import { MergePolicyCard } from '@/components/policy/MergePolicyCard';
import { updateWorkMergePolicy } from '@/app/actions/dashboard/works';
import { useSettings } from './SettingsContext';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the Work mount.
 *
 * Sits next to the quality-gates card for a reason: the gate decides
 * whether a pull request is allowed to EXIST, and this decides whether an
 * agent may LAND it. Together they are the whole "agents ship their own
 * work" story, and the platform default keeps both conservative until
 * someone here opts in.
 */
export function MergePolicySettings() {
    const { context } = useSettings();
    const { work } = context;

    const save = (next: MergePolicyOverride | null) => updateWorkMergePolicy(work.id, next);

    return (
        <MergePolicyCard
            scope="work"
            workId={work.id}
            storedOverride={work.mergePolicy ?? null}
            onSave={save}
            title="Merge policy"
            subtitle="Whether agents may land the pull requests they open for this Work, and under what conditions. Every field inherits from the organization unless this Work sets it."
            testIdPrefix="work-merge-policy"
        />
    );
}
