'use client';

import { useState, useTransition } from 'react';
import {
    Archive,
    ArrowRight,
    Cog,
    FolderClosed,
    Link2,
    Megaphone,
    Search,
    Sparkles,
    Trash2,
    TrendingUp,
    TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { WORK_KIND_PRESENTATION, normalizeWorkKind } from '@/lib/work-kinds/catalog';
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

// Date-only formatter for the edge's `createdAt`. Fed to `ShowDateTime`
// rather than called during render: this is a client component, so a
// bare `toLocaleDateString()` would format with the server's locale and
// time zone on the SSR pass and the browser's on hydration, which is a
// mismatch. `ShowDateTime` renders nothing until mounted.
const formatAttachedAt = (date: string, locale: string) =>
    new Date(date).toLocaleDateString(locale);

export interface AttachableWorkOption {
    readonly id: string;
    readonly name: string;
    /** Raw `work.kind`; drives the option's leading icon. */
    readonly kind?: string;
}

/**
 * Leading icons for the two pickers. `Select` renders `iconMap[key]`
 * for any `<option data-icon={key}>`, in both the trigger and the
 * dropdown rows.
 *
 * Works reuse `WORK_KIND_PRESENTATION` so a Work carries the same glyph
 * here as on its card, header and badge. The glyphs are already
 * distinct per kind, so they render in the neutral text tone rather
 * than the badge's pill colours — colour would compete with the
 * relation chip sitting next to the picker.
 */
const WORK_ICON_MAP: Record<string, React.ReactNode> = Object.fromEntries(
    Object.entries(WORK_KIND_PRESENTATION).map(([kind, { icon: Icon }]) => [
        kind,
        <Icon key={kind} className="size-3.5 text-text-muted dark:text-text-muted-dark" />,
    ]),
);

const RELATION_ICONS: Record<MissionWorkRelation, React.ReactNode> = {
    created: <Sparkles className="size-3.5 text-primary" />,
    improves: <TrendingUp className="size-3.5 text-primary" />,
    operates: <Cog className="size-3.5 text-primary" />,
    markets: <Megaphone className="size-3.5 text-primary" />,
    researches: <Search className="size-3.5 text-primary" />,
    retires: <Archive className="size-3.5 text-primary" />,
};

export interface MissionAttachedWorksPanelProps {
    missionId: string;
    initialRelations: MissionWorkRelationDto[];
    /** The caller's Works, for the "Attach Work" select. */
    attachableWorks: ReadonlyArray<AttachableWorkOption>;
}

const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The relation chip on a row. Neutral rather than primary-filled: the
 * row already competes for attention with the Work name, the date and
 * the detach control, and a saturated pill on every row made the list
 * read as a wall of badges. The relation is a qualifier, not a state,
 * so it gets the same quiet treatment as the count pills in the
 * section headers.
 */
function RelationBadge({ label }: { label: string }) {
    return (
        <span className="shrink-0 rounded-full border border-border/70 dark:border-border-dark/70 bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-0.5 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">
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
    // The edge awaiting detach confirmation; null = dialog closed. The
    // whole row is held (not just its ids) so the dialog body can name
    // the Work after the list has been filtered.
    const [detachTarget, setDetachTarget] = useState<MissionWorkRelationDto | null>(null);
    const [detachError, setDetachError] = useState<string | null>(null);

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

    // Closing mid-flight would strand a half-finished detach, so
    // `pending` locks the dialog shut (same guard as the Mission
    // delete dialog).
    const closeDetach = () => {
        if (pending) return;
        setDetachTarget(null);
        setDetachError(null);
    };

    const handleDetach = () => {
        const row = detachTarget;
        if (!row) return;
        setDetachError(null);
        startTransition(async () => {
            try {
                await detachWorkFromMissionAction(missionId, row.workId, row.relation);
                setRelations((prev) => prev.filter((r) => r.id !== row.id));
                setDetachTarget(null);
                toast.success(t('toasts.detached'));
            } catch (err) {
                // Surfaced inside the dialog as well as the toast, so the
                // failure sits next to the button that caused it.
                setDetachError(err instanceof Error ? err.message : t('detachDialog.error'));
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
                    {/* Neutral tile — see the matching note in
                        MissionGoalsPanel: section icons on the Mission detail
                        page are design-system surface, not accented. */}
                    <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60">
                        <FolderClosed className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
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
                <ul className="space-y-1.5" data-testid="mission-attached-works-list">
                    {relations.map((r) => {
                        // The row's primary label falls back name → slug →
                        // id; the slug only repeats underneath when it is
                        // NOT already standing in as that primary label.
                        const primaryLabel = r.workName ?? r.workSlug ?? r.workId;
                        const secondaryLabel = r.workName && r.workSlug ? r.workSlug : null;
                        return (
                            <li
                                key={r.id}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/30 dark:bg-surface-dark/30 hover:border-border dark:hover:border-border-dark hover:bg-surface-secondary/50 dark:hover:bg-surface-secondary-dark/50 transition-colors group"
                                data-testid={`mission-attached-works-row-${r.workId}-${r.relation}`}
                            >
                                <Link
                                    href={ROUTES.DASHBOARD_WORK(r.workId)}
                                    className="flex items-center gap-2.5 min-w-0 flex-1"
                                >
                                    {/* Generic Work glyph — `FolderClosed` is
                                        what WORK_KIND_PRESENTATION gives the
                                        `default` kind, and the edge DTO
                                        carries no `kind` to specialise on. */}
                                    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60 dark:border-border-dark/60 bg-surface-secondary dark:bg-surface-secondary-dark">
                                        <FolderClosed className="size-4 text-text-muted dark:text-text-muted-dark" />
                                    </span>
                                    {/* Regular weight, not `font-medium`: with
                                        a leading tile and a two-line stack the
                                        row already has enough hierarchy, and
                                        bolding every name flattened it. */}
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5">
                                            <span className="truncate text-sm text-text dark:text-text-dark group-hover:text-primary transition-colors">
                                                {primaryLabel}
                                            </span>
                                            <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </span>
                                        {secondaryLabel && (
                                            <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                                {secondaryLabel}
                                            </span>
                                        )}
                                    </span>
                                </Link>
                                <RelationBadge label={t(`relations.${r.relation}`)} />
                                <span className="hidden sm:block shrink-0 text-[11px] text-text-muted dark:text-text-muted-dark tabular-nums">
                                    <ShowDateTime
                                        value={r.createdAt}
                                        customFormatter={formatAttachedAt}
                                    />
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setDetachError(null);
                                        setDetachTarget(r);
                                    }}
                                    disabled={pending}
                                    title={t('detach')}
                                    aria-label={t('detach')}
                                    data-testid={`mission-attached-works-detach-${r.workId}-${r.relation}`}
                                    className="shrink-0 grid h-7 w-7 place-items-center rounded-md text-text-muted hover:text-danger hover:bg-danger/5 dark:hover:bg-danger/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </li>
                        );
                    })}
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
                    <>
                        {/* One 32px-tall control row: each labelled select is a
                            stacked block and the submit sits in its own
                            fixed-height group, so `items-end` lines all three
                            bottoms up. The truncation hint lives OUTSIDE the
                            row — inside the label it grew that stack and
                            knocked the other controls out of alignment. */}
                        <div className="flex flex-wrap items-end gap-3">
                            <label className="min-w-48 flex-1 max-w-xs">
                                <span className="mb-1.5 block text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('workLabel')}
                                </span>
                                <Select
                                    size="xs"
                                    value={workDraft}
                                    onValueChange={setWorkDraft}
                                    placeholder={t('workPlaceholder')}
                                    iconMap={WORK_ICON_MAP}
                                    data-testid="mission-attach-work-select"
                                >
                                    {attachableWorks.map((w) => (
                                        <option
                                            key={w.id}
                                            value={w.id}
                                            data-icon={normalizeWorkKind(w.kind)}
                                        >
                                            {w.name}
                                        </option>
                                    ))}
                                </Select>
                            </label>
                            <label className="min-w-36">
                                <span className="mb-1.5 block text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('relationLabel')}
                                </span>
                                <Select
                                    size="xs"
                                    value={relationDraft}
                                    onValueChange={(v) =>
                                        setRelationDraft(v as MissionWorkRelation)
                                    }
                                    iconMap={RELATION_ICONS}
                                    data-testid="mission-attach-relation-select"
                                >
                                    {RELATIONS.map((rel) => (
                                        <option key={rel} value={rel} data-icon={rel}>
                                            {t(`relations.${rel}`)}
                                        </option>
                                    ))}
                                </Select>
                            </label>
                            <div className="flex h-8 items-center">
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
                        </div>
                        {attachableWorks.length >= 100 ? (
                            <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('pickerTruncated')}
                            </p>
                        ) : null}
                    </>
                )}
            </div>

            {/* Detach confirmation — mirrors the Mission delete dialog.
                Rendered inside the section only for code locality: the
                Dialog portals to the document body, so its position in
                this tree has no layout effect. */}
            <Dialog
                open={detachTarget !== null}
                onOpenChange={(next) => {
                    if (!next) closeDetach();
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogClose onClose={closeDetach} />
                    <DialogHeader className="mb-0">
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('detachDialog.title')}
                            </DialogTitle>
                        </div>
                        <DialogDescription>
                            {t('detachDialog.body', {
                                title:
                                    detachTarget?.workName ??
                                    detachTarget?.workSlug ??
                                    detachTarget?.workId ??
                                    '',
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    {detachError && (
                        <p
                            role="alert"
                            data-testid="mission-attached-works-detach-error"
                            className="mt-4 text-xs text-danger"
                        >
                            {detachError}
                        </p>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="mission-attached-works-detach-cancel"
                            disabled={pending}
                            onClick={closeDetach}
                        >
                            {t('detachDialog.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid="mission-attached-works-detach-confirm"
                            loading={pending}
                            onClick={handleDetach}
                        >
                            {pending ? t('detachDialog.detaching') : t('detachDialog.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
