'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    getRosterBlueprints,
    getRosterState,
    provisionRoster,
} from '@/app/actions/onboarding/roster';
import type {
    RosterBlueprintsResponse,
    RosterLaneLabelKey,
    RosterLaneOption,
} from '@/lib/api/onboarding';
import type { RosterBlueprintSlug, RosterLaneKey } from '@ever-works/contracts/api';
import { RosterProvisionProgress } from '@/components/get-started/RosterProvisionProgress';

/** One row in the editable proposal. */
interface DraftLane {
    readonly laneKey: RosterLaneKey;
    readonly labelKey: RosterLaneLabelKey;
    readonly isCoordinator: boolean;
    name: string;
}

export interface RosterStepProps {
    /**
     * Injected by specs so the step can be rendered without the server
     * actions. Production leaves it undefined and the step loads its own
     * proposal — the same posture `ProfileStep`'s suggestion block takes.
     */
    readonly initialBlueprints?: RosterBlueprintsResponse;
    /** Fires when a provisioning run reaches a terminal state. */
    readonly onProvisioned?: () => void;
}

/**
 * AW-20 P1 — the setup wizard's **Your agents** step.
 *
 * Setup today ends at infrastructure: four provider questions, then a
 * dashboard with zero agents and no next action. This step is where a new
 * owner gets a team — a coordinator to hand ambiguous work to, plus a
 * specialist per lane — and it is the only step in the flow that is about
 * delegating work rather than provisioning plumbing.
 *
 * Always skippable through the wizard's own footer: skipping records the
 * skip and creates nothing. Nothing downstream is gated on it.
 */
export function RosterStep({ initialBlueprints, onProvisioned }: RosterStepProps) {
    const t = useTranslations('onboarding.rosterStep');

    const [blueprints, setBlueprints] = useState<RosterBlueprintsResponse | null>(
        initialBlueprints ?? null,
    );
    const [loading, setLoading] = useState(!initialBlueprints);
    const [loadFailed, setLoadFailed] = useState(false);
    const [lanes, setLanes] = useState<DraftLane[]>(() =>
        toDraft(initialBlueprints?.proposal ?? []),
    );
    const [addOpen, setAddOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [runId, setRunId] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (initialBlueprints) return;
        let cancelled = false;
        void (async () => {
            const [proposal, state] = await Promise.all([getRosterBlueprints(), getRosterState()]);
            if (cancelled) return;
            if (proposal.success && proposal.data) {
                setBlueprints(proposal.data);
                setLanes(toDraft(proposal.data.proposal));
            } else {
                setLoadFailed(true);
            }
            // A run that is still going — or that finished while the user
            // was on another step — takes the panel straight back to where
            // they left it, rather than re-offering a roster they already
            // asked for.
            if (state.success && state.data?.provisioning) {
                setRunId(state.data.provisioning.runId);
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [initialBlueprints]);

    const maxLanes = blueprints?.maxLanes ?? 8;
    const nameMax = blueprints?.nameMax ?? 60;
    const canCreateAgents = blueprints?.canCreateAgents ?? true;

    const available = useMemo(() => {
        const taken = new Set(lanes.map((lane) => lane.laneKey));
        return (blueprints?.catalog ?? []).filter((option) => !taken.has(option.laneKey));
    }, [blueprints, lanes]);

    const nameError = useCallback(
        (name: string): string | null => {
            if (!name.trim()) return t('nameRequired');
            if (name.length > nameMax) return t('nameTooLong');
            return null;
        },
        [nameMax, t],
    );

    const blocked = lanes.length === 0 || lanes.some((lane) => nameError(lane.name) !== null);

    const submit = useCallback(async () => {
        if (blocked || submitting || !canCreateAgents) return;
        setSubmitting(true);
        setSubmitError(null);
        const result = await provisionRoster({
            blueprintSlug: blueprints?.blueprintSlug as RosterBlueprintSlug | undefined,
            lanes: lanes.map((lane) => ({ laneKey: lane.laneKey, name: lane.name.trim() })),
        });
        setSubmitting(false);
        if (result.success && result.data) {
            setRunId(result.data.runId);
            return;
        }
        setSubmitError(result.error ?? t('provisionFailed'));
    }, [blocked, blueprints, canCreateAgents, lanes, submitting, t]);

    // Ctrl/Cmd+Enter is the primary action anywhere in the step. Esc is
    // deliberately NOT bound: it already closes the wizard dialog, and
    // stealing it here would change behaviour on every other step.
    useEffect(() => {
        const node = rootRef.current;
        if (!node) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit();
            }
            if (event.altKey && (event.key === 'a' || event.key === 'A')) {
                event.preventDefault();
                setAddOpen((open) => !open);
            }
        };
        node.addEventListener('keydown', onKeyDown);
        return () => node.removeEventListener('keydown', onKeyDown);
    }, [submit]);

    if (runId) {
        return (
            <RosterProvisionProgress
                runId={runId}
                onRetry={() => setRunId(null)}
                onFinished={onProvisioned}
            />
        );
    }

    return (
        <div ref={rootRef} className="space-y-6 max-w-3xl" data-testid="onboarding-roster-step">
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
                {blueprints && !blueprints.derivedFromRoles ? (
                    <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('noRolesNotice')}
                    </p>
                ) : null}
            </header>

            {loadFailed ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('loadFailed')}
                </p>
            ) : null}

            {loading ? (
                <div
                    className="flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="onboarding-roster-loading"
                >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('loading')}
                </div>
            ) : null}

            {!canCreateAgents ? (
                <p
                    className="rounded-lg border border-border dark:border-border-dark p-3 text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="onboarding-roster-readonly"
                >
                    {t('readOnlyNotice')}
                </p>
            ) : null}

            <ul className="space-y-2" data-testid="onboarding-roster-lanes">
                {lanes.map((lane, index) => {
                    const error = nameError(lane.name);
                    return (
                        <li
                            key={lane.laneKey}
                            data-testid={`onboarding-roster-lane-${lane.laneKey}`}
                            className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-3"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <p className="flex items-center gap-2 text-sm font-semibold text-text dark:text-text-dark">
                                        {t(`lanes.${lane.labelKey}`)}
                                        {lane.isCoordinator ? (
                                            <span className="inline-flex items-center rounded-full border border-border dark:border-border-dark px-2 py-0.5 text-[11px] font-normal text-text-muted dark:text-text-muted-dark">
                                                {t('coordinatorChip')}
                                            </span>
                                        ) : null}
                                    </p>
                                    <div className="mt-2">
                                        <Input
                                            value={lane.name}
                                            disabled={!canCreateAgents}
                                            aria-label={t(`lanes.${lane.labelKey}`)}
                                            data-testid={`onboarding-roster-name-${lane.laneKey}`}
                                            error={error ?? undefined}
                                            maxLength={nameMax + 1}
                                            onChange={(event) =>
                                                setLanes((prev) =>
                                                    prev.map((row, rowIndex) =>
                                                        rowIndex === index
                                                            ? { ...row, name: event.target.value }
                                                            : row,
                                                    ),
                                                )
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key !== 'Enter') return;
                                                event.preventDefault();
                                                const next = rootRef.current?.querySelectorAll(
                                                    'input[data-testid^="onboarding-roster-name-"]',
                                                );
                                                const target = next?.[index + 1];
                                                if (target instanceof HTMLInputElement) {
                                                    target.focus();
                                                }
                                            }}
                                        />
                                    </div>
                                    <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                        {t(`blurbs.${lane.labelKey}`)}
                                    </p>
                                </div>
                                {lane.isCoordinator ? null : (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={!canCreateAgents}
                                        aria-label={t('remove')}
                                        data-testid={`onboarding-roster-remove-${lane.laneKey}`}
                                        onClick={() =>
                                            setLanes((prev) =>
                                                prev.filter((row) => row.laneKey !== lane.laneKey),
                                            )
                                        }
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        {t('remove')}
                                    </Button>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>

            <div className="relative">
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                        !canCreateAgents || lanes.length >= maxLanes || available.length === 0
                    }
                    title={lanes.length >= maxLanes ? t('addLaneFull') : undefined}
                    data-testid="onboarding-roster-add"
                    onClick={() => setAddOpen((open) => !open)}
                >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('addLane')}
                </Button>
                {lanes.length >= maxLanes ? (
                    <p
                        className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="onboarding-roster-add-full"
                    >
                        {t('addLaneFull')}
                    </p>
                ) : null}
                {addOpen && available.length > 0 ? (
                    <ul
                        className="absolute z-10 mt-1 w-64 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-1 shadow-lg"
                        data-testid="onboarding-roster-add-menu"
                    >
                        {available.map((option) => (
                            <li key={option.laneKey}>
                                <button
                                    type="button"
                                    className={cn(
                                        'w-full rounded-md px-2 py-1.5 text-left text-sm',
                                        'hover:bg-surface-secondary/60 dark:hover:bg-white/5',
                                    )}
                                    data-testid={`onboarding-roster-add-${option.laneKey}`}
                                    onClick={() => {
                                        setLanes((prev) =>
                                            prev.length >= maxLanes
                                                ? prev
                                                : [...prev, ...toDraft([option])],
                                        );
                                        setAddOpen(false);
                                    }}
                                >
                                    {t(`lanes.${option.labelKey}`)}
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>

            <p className="flex items-start gap-2 rounded-lg border border-border dark:border-border-dark p-3 text-xs text-text-muted dark:text-text-muted-dark">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                {t('guardrailNotice')}
            </p>

            {submitError ? (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                    {submitError}
                </p>
            ) : null}

            <div>
                <Button
                    disabled={blocked || submitting || !canCreateAgents}
                    data-testid="onboarding-roster-submit"
                    onClick={() => void submit()}
                >
                    {submitting ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {t('primary')}
                </Button>
            </div>
        </div>
    );
}

function toDraft(options: readonly RosterLaneOption[]): DraftLane[] {
    return options.map((option) => ({
        laneKey: option.laneKey,
        labelKey: option.labelKey,
        isCoordinator: option.isCoordinator,
        name: option.defaultName,
    }));
}
