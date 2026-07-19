'use client';

import { useState, useTransition } from 'react';
import { ArrowRight, Link2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Select } from '@/components/ui/select';
import {
    attachWorkToMissionAction,
    detachWorkFromMissionAction,
} from '@/app/actions/dashboard/mission-works';
import type { MissionWorkRelation, MissionWorkRelationDto } from '@/lib/api/missions';

/**
 * PR-2 (domain-model evolution) — the explicit "Attached Works" panel
 * on the Mission detail page, driven by `GET /me/missions/:id/works`
 * (`mission_works` edges). ADDITIVE next to the existing derived
 * "Related Works" panel (accepted-Idea chain), which stays untouched.
 *
 * Copy reflects the invariants: Missions never own Works (I-7) and
 * detaching never touches the Work itself (I-6).
 */

// Local mirror of MISSION_WORK_RELATIONS from `@/lib/api/missions` —
// that module is `server-only`, so a client component may only import
// its types. The element type keeps the two lists in lockstep.
const RELATIONS: readonly MissionWorkRelation[] = [
    'created',
    'improves',
    'operates',
    'markets',
    'researches',
    'retires',
];

export interface AttachableWorkOption {
    readonly id: string;
    readonly name: string;
}

export interface MissionAttachedWorksPanelProps {
    missionId: string;
    initialRelations: MissionWorkRelationDto[];
    /** The caller's Works, for the "Attach Work" select. */
    attachableWorks: ReadonlyArray<AttachableWorkOption>;
}

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

function RelationBadge({ label }: { label: string }) {
    return (
        <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {label}
        </span>
    );
}

export function MissionAttachedWorksPanel({
    missionId,
    initialRelations,
    attachableWorks,
}: MissionAttachedWorksPanelProps) {
    const t = useTranslations('dashboard.missionDetail.attachedWorks');

    const [relations, setRelations] = useState<MissionWorkRelationDto[]>(initialRelations);
    const [pending, startTransition] = useTransition();
    const [workDraft, setWorkDraft] = useState<string>('');
    const [relationDraft, setRelationDraft] = useState<MissionWorkRelation>('improves');

    const handleAttach = () => {
        if (!workDraft) return;
        startTransition(async () => {
            try {
                const updated = await attachWorkToMissionAction(missionId, {
                    workId: workDraft,
                    relation: relationDraft,
                });
                setRelations(updated);
                setWorkDraft('');
                toast.success(t('toasts.attached'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.attachError'));
            }
        });
    };

    const handleDetach = (row: MissionWorkRelationDto) => {
        if (!window.confirm(t('confirmDetach'))) return;
        startTransition(async () => {
            try {
                await detachWorkFromMissionAction(missionId, row.workId, row.relation);
                setRelations((prev) => prev.filter((r) => r.id !== row.id));
                toast.success(t('toasts.detached'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.detachError'));
            }
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="mission-attached-works"
        >
            {/* Header — mirrors the SectionHeader style of the sibling panels */}
            <div className="flex items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border bg-primary/10 border-primary/20">
                        <Link2 className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                </div>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-surface-secondary-dark tabular-nums">
                    {relations.length}
                </span>
            </div>

            {relations.length === 0 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
            ) : (
                <ul className="space-y-2" data-testid="mission-attached-works-list">
                    {relations.map((r) => (
                        <li
                            key={r.id}
                            className="flex items-center gap-3 p-3 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/30 dark:bg-surface-dark/30 hover:border-border dark:hover:border-border-dark transition-colors group"
                            data-testid={`mission-attached-works-row-${r.workId}-${r.relation}`}
                        >
                            <Link
                                href={ROUTES.DASHBOARD_WORK(r.workId)}
                                className="flex items-center gap-2 min-w-0 flex-1 text-sm font-medium text-text dark:text-text-dark hover:text-primary transition-colors"
                            >
                                <span className="truncate">
                                    {r.workName ?? r.workSlug ?? r.workId}
                                </span>
                                <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </Link>
                            <RelationBadge label={t(`relations.${r.relation}`)} />
                            <span className="hidden sm:block shrink-0 text-[11px] text-text-muted dark:text-text-muted-dark tabular-nums">
                                {new Date(r.createdAt).toLocaleDateString()}
                            </span>
                            <button
                                type="button"
                                onClick={() => handleDetach(r)}
                                disabled={pending}
                                title={t('detach')}
                                aria-label={t('detach')}
                                data-testid={`mission-attached-works-detach-${r.workId}-${r.relation}`}
                                className="shrink-0 grid h-7 w-7 place-items-center rounded-md text-text-muted hover:text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {/* Attach affordance */}
            <div className="mt-5 pt-4 border-t border-border/60 dark:border-border-dark/60">
                <p className="text-xs font-medium text-text dark:text-text-dark mb-2">
                    {t('attachTitle')}
                </p>
                {attachableWorks.length === 0 ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('noWorksToAttach')}
                    </p>
                ) : (
                    <div className="flex flex-wrap items-end gap-3">
                        <label className="space-y-1.5 min-w-48 flex-1 max-w-xs">
                            <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                {t('workLabel')}
                            </span>
                            <Select
                                size="sm"
                                value={workDraft}
                                onValueChange={setWorkDraft}
                                placeholder={t('workPlaceholder')}
                                data-testid="mission-attach-work-select"
                            >
                                {attachableWorks.map((w) => (
                                    <option key={w.id} value={w.id}>
                                        {w.name}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <label className="space-y-1.5 min-w-36">
                            <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                {t('relationLabel')}
                            </span>
                            <Select
                                size="sm"
                                value={relationDraft}
                                onValueChange={(v) => setRelationDraft(v as MissionWorkRelation)}
                                data-testid="mission-attach-relation-select"
                            >
                                {RELATIONS.map((rel) => (
                                    <option key={rel} value={rel}>
                                        {t(`relations.${rel}`)}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <button
                            type="button"
                            onClick={handleAttach}
                            disabled={pending || !workDraft}
                            className={cn(btn, 'h-8')}
                            data-testid="mission-attach-work-submit"
                        >
                            <Link2 className="w-3.5 h-3.5" />
                            {t('attach')}
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}
