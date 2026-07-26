'use client';

import { useEffect, useMemo, useState } from 'react';
import { GitMerge, Loader2, RotateCcw } from 'lucide-react';
import type { MergePolicyOverride, MergePolicyScope } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useMergePolicy } from '@/lib/hooks/use-merge-policy';
import {
    clearField,
    describeFieldOrigin,
    formatBranchList,
    isOverridden,
    MERGE_POLICY_UI_METHODS,
    parseBranchList,
    resolveFieldOrigins,
    setField,
    summarizePolicy,
    toggleMergeMethod,
    type MergePolicyField,
} from '@/lib/merge-policy';

export interface MergePolicyCardProps {
    /** Which scope's override this card edits. */
    scope: MergePolicyScope;
    /** Resolution inputs — pass whichever identifies the card's subject. */
    workId?: string | null;
    agentId?: string | null;
    organizationId?: string | null;
    /** The override CURRENTLY stored on this scope's row (`null` = inherit all). */
    storedOverride: MergePolicyOverride | null;
    /**
     * Persist the scope-local override. `null` clears it entirely. The
     * caller owns the transport (server action / PATCH), because each
     * scope already has its own write path and this feature adds a field
     * to those rather than a parallel one.
     */
    onSave: (next: MergePolicyOverride | null) => Promise<{ success: boolean; error?: string }>;
    title: string;
    subtitle: string;
    /** Test-id prefix so the three mounts stay individually addressable. */
    testIdPrefix: string;
}

const FIELD_LABELS: Record<MergePolicyField, { label: string; hint: string }> = {
    allowAgentMerge: {
        label: 'Agents may merge pull requests',
        hint: 'Opening a pull request is a separate Agent permission. This controls landing one.',
    },
    requireGreenGate: {
        label: 'Require a green quality gate',
        hint: 'The run’s acceptance checks must all pass before an agent may merge.',
    },
    requireHumanApproval: {
        label: 'Require a human approval',
        hint: 'An agent finishing its own work is not an approval — leave this on to keep a person in the loop.',
    },
    allowedMergeMethods: {
        label: 'Allowed merge methods',
        hint: 'An empty selection refuses every agent merge.',
    },
    protectedBranches: {
        label: 'Protected branches',
        hint: 'One per line. Agents may never merge INTO these (case-insensitive).',
    },
};

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the settings card,
 * shared by the Work, Agent and organization mounts.
 *
 * The whole design problem here is INHERITANCE LEGIBILITY. A resolved
 * policy is a field-by-field fold of up to five layers, so a card that
 * showed only the effective values would be actively misleading: a user
 * would turn a switch off, see no change on a sibling Work, and conclude
 * the feature is broken. So every control renders three things — the
 * effective value, where that value came from ("Inherited from
 * organization"), and, when THIS scope owns it, a reset-to-inherit
 * control that DELETES the key rather than writing a falsy value.
 *
 * The card never resolves policy itself: it reads
 * `GET /api/merge-policy/resolve`, which returns the same chain the
 * runtime decision point uses. One resolver, one truth.
 */
export function MergePolicyCard({
    scope,
    workId,
    agentId,
    organizationId,
    storedOverride,
    onSave,
    title,
    subtitle,
    testIdPrefix,
}: MergePolicyCardProps) {
    const { resolution, isLoading, error, refresh } = useMergePolicy({
        workId,
        agentId,
        organizationId,
    });
    const [draft, setDraft] = useState<MergePolicyOverride | null>(storedOverride);
    const [branchText, setBranchText] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    // Re-seed whenever the server-confirmed override changes (a save, or a
    // parent refresh). Keyed on the serialized value so an unchanged
    // object identity from a re-render never clobbers an in-progress edit.
    const storedKey = JSON.stringify(storedOverride ?? null);
    useEffect(() => {
        setDraft(storedOverride ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storedKey]);

    const policy = resolution?.policy;
    const origins = useMemo(
        () => resolveFieldOrigins(resolution?.chain, scope),
        [resolution?.chain, scope],
    );

    // The textarea is the one control with local text state (a branch list
    // is edited as prose). Seed it from the effective policy once loaded.
    useEffect(() => {
        if (policy) setBranchText(formatBranchList(policy.protectedBranches));
    }, [policy]);

    const persist = async (next: MergePolicyOverride | null) => {
        setSaving(true);
        setSaveError(null);
        try {
            const result = await onSave(next);
            if (!result.success) {
                setSaveError(result.error ?? 'Could not save the merge policy.');
                return;
            }
            setDraft(next);
            // The chain changed — the field this scope just claimed now
            // reports "Set here" instead of its previous owner.
            refresh();
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : 'Could not save the merge policy.');
        } finally {
            setSaving(false);
        }
    };

    const busy = saving || isLoading;

    const originRow = (field: MergePolicyField) => {
        const origin = origins[field];
        const overridden = isOverridden(draft, field);
        return (
            <div className="mt-1 flex items-center gap-2">
                <span
                    className="text-[11px] text-text-muted dark:text-text-muted-dark"
                    data-testid={`${testIdPrefix}-${field}-origin`}
                >
                    {describeFieldOrigin(origin)}
                </span>
                {overridden ? (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void persist(clearField(draft, field))}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50"
                        data-testid={`${testIdPrefix}-${field}-reset`}
                    >
                        <RotateCcw className="h-3 w-3" />
                        Reset to inherit
                    </button>
                ) : null}
            </div>
        );
    };

    const booleanRow = (field: 'allowAgentMerge' | 'requireGreenGate' | 'requireHumanApproval') => (
        <div className="flex items-start justify-between gap-4">
            <div>
                <h4 className="text-xs font-medium text-text dark:text-text-dark">
                    {FIELD_LABELS[field].label}
                </h4>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {FIELD_LABELS[field].hint}
                </p>
                {originRow(field)}
            </div>
            <Switch
                className="mt-0"
                checked={Boolean(policy?.[field])}
                disabled={busy || !policy}
                onChange={(next: boolean) => void persist(setField(draft, field, next))}
                data-testid={`${testIdPrefix}-${field}`}
            />
        </div>
    );

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
            data-testid={testIdPrefix}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <div className="flex items-center gap-2">
                    <GitMerge className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h3>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" /> : null}
                </div>
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {subtitle}
                </p>
                <p
                    className="mt-1.5 text-xs font-medium text-text-secondary dark:text-text-secondary-dark"
                    data-testid={`${testIdPrefix}-summary`}
                >
                    {summarizePolicy(policy)}
                </p>
            </div>

            <div className="px-5 py-4 space-y-4">
                {error ? (
                    <p
                        className="text-xs text-red-600 dark:text-red-400"
                        data-testid={`${testIdPrefix}-error`}
                    >
                        {error}
                    </p>
                ) : null}
                {saveError ? (
                    <p
                        className="text-xs text-red-600 dark:text-red-400"
                        data-testid={`${testIdPrefix}-save-error`}
                    >
                        {saveError}
                    </p>
                ) : null}

                {booleanRow('allowAgentMerge')}
                {booleanRow('requireGreenGate')}
                {booleanRow('requireHumanApproval')}

                {/* Allowed merge methods */}
                <div>
                    <h4 className="text-xs font-medium text-text dark:text-text-dark">
                        {FIELD_LABELS.allowedMergeMethods.label}
                    </h4>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {FIELD_LABELS.allowedMergeMethods.hint}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-3">
                        {MERGE_POLICY_UI_METHODS.map((method) => {
                            const checked = Boolean(policy?.allowedMergeMethods.includes(method));
                            return (
                                <label
                                    key={method}
                                    className="inline-flex items-center gap-1.5 text-xs text-text-secondary dark:text-text-secondary-dark"
                                >
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={busy || !policy}
                                        onChange={(event) =>
                                            void persist(
                                                setField(
                                                    draft,
                                                    'allowedMergeMethods',
                                                    toggleMergeMethod(
                                                        policy?.allowedMergeMethods ?? [],
                                                        method,
                                                        event.target.checked,
                                                    ),
                                                ),
                                            )
                                        }
                                        data-testid={`${testIdPrefix}-method-${method}`}
                                    />
                                    {method}
                                </label>
                            );
                        })}
                    </div>
                    {originRow('allowedMergeMethods')}
                </div>

                {/* Protected branches */}
                <div>
                    <h4 className="text-xs font-medium text-text dark:text-text-dark">
                        {FIELD_LABELS.protectedBranches.label}
                    </h4>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                        {FIELD_LABELS.protectedBranches.hint}
                    </p>
                    <Textarea
                        variant="form"
                        rows={4}
                        value={branchText}
                        disabled={busy || !policy}
                        onChange={(event) => setBranchText(event.target.value)}
                        data-testid={`${testIdPrefix}-protected-branches`}
                    />
                    <div className="mt-2 flex items-center gap-2">
                        <Button
                            type="button"
                            size="sm"
                            disabled={busy || !policy}
                            onClick={() =>
                                void persist(
                                    setField(
                                        draft,
                                        'protectedBranches',
                                        parseBranchList(branchText),
                                    ),
                                )
                            }
                            data-testid={`${testIdPrefix}-protected-branches-save`}
                        >
                            Save branches
                        </Button>
                    </div>
                    {originRow('protectedBranches')}
                </div>
            </div>
        </div>
    );
}
