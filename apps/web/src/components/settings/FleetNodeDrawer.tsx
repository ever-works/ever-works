'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, KeyRound, Pin, PinOff, Plus, X } from 'lucide-react';
import { QUEUED_REASON_WAITING_FOR_RUNNER } from '@ever-works/contracts';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type { FleetJobView, FleetNodeDetailView, FleetNodeView } from '@/lib/api/fleet';
import { centsToUsdInput, formatCeilingCents, usdInputToCents } from './fleet-cost-ceiling.shared';
import {
    FLEET_JOB_FILTERS,
    filterFleetJobs,
    fleetJobDurationMs,
    formatFleetJobDuration,
    type FleetJobFilter,
} from './fleet-node-drawer.shared';

interface FleetNodeDrawerProps {
    node: FleetNodeView | null;
    detail: FleetNodeDetailView | null;
    loading: boolean;
    error: string | null;
    isPending: boolean;
    onClose: () => void;
    onSaveCapabilities: (capabilities: string[], pinned: boolean) => void;
    /**
     * Fleet cost accounting (EW-777): this node's daily model-spend
     * ceiling, in cents; null clears it back to the deployment default.
     */
    onSaveCostCeiling: (dailyCostCeilingCents: number | null) => void;
    onRotate: () => void;
    onDrain: (drain: boolean) => void;
}

/** Max tags the API accepts; mirrored here so the UI refuses first. */
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 32;

function formatMoment(value: string | null): string {
    if (!value) return '-';
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

/** Tailwind classes for the job status badge; `failed` is the one that must stand out. */
function jobStatusBadgeClass(status: FleetJobView['status']): string {
    switch (status) {
        case 'failed':
            return 'bg-danger/10 text-danger';
        case 'done':
            return 'bg-success/10 text-success';
        case 'running':
        case 'leased':
            return 'bg-info/10 text-info';
        default:
            return 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark';
    }
}

/**
 * Node detail — everything about ONE machine that the table row cannot
 * carry: its recent job history with each job's outcome, an editor for
 * its capability tags, and the two credential-lifecycle controls
 * (rotate, drain).
 *
 * The job history is the reason this exists. "Node X is online" is not
 * an answer to "why did my checks stop passing on X", and neither is a
 * bare list of failed kinds: the operator needs to see WHEN a job ran,
 * how long it took, how many attempts it burned and — for a job that
 * never started — why it is still queued. Every one of those facts is on
 * `FleetJobView`; the rows below render them, and the All / Failed /
 * Running filter keeps a busy machine's history scannable.
 */
export function FleetNodeDrawer({
    node,
    detail,
    loading,
    error,
    isPending,
    onClose,
    onSaveCapabilities,
    onSaveCostCeiling,
    onRotate,
    onDrain,
}: FleetNodeDrawerProps) {
    const t = useTranslations('dashboard.settings.fleet');
    const [tags, setTags] = useState<string[]>([]);
    const [pinned, setPinned] = useState(false);
    const [draft, setDraft] = useState('');
    const [jobFilter, setJobFilter] = useState<FleetJobFilter>('all');
    // Fleet cost accounting (EW-777): the per-node daily ceiling, edited
    // in dollars and sent as whole cents.
    const [ceilingDraft, setCeilingDraft] = useState('');

    // Re-seed the editor whenever a different node (or fresher data for
    // the same node) arrives, so the form never shows another machine's
    // tags. Keyed on the node id + the server's own values.
    const serverTags = detail?.node.capabilities ?? node?.capabilities ?? [];
    const serverPinned = detail?.node.capabilitiesPinned ?? node?.capabilitiesPinned ?? false;
    const seedKey = `${node?.id ?? ''}|${serverTags.join(',')}|${serverPinned}`;
    useEffect(() => {
        setTags(serverTags);
        setPinned(serverPinned);
        setDraft('');
        // `seedKey` collapses the identity of the seed into one primitive
        // so this does not re-run on every parent render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seedKey]);

    // A filter chosen for one machine must not carry over to the next:
    // opening a healthy node straight after a broken one would otherwise
    // greet the operator with an empty "Failed" list.
    const nodeId = node?.id ?? '';
    useEffect(() => {
        setJobFilter('all');
    }, [nodeId]);

    // Re-seed the ceiling editor from the server's value, keyed the same
    // way as the tags so a save (or another node) never shows a stale draft.
    const serverCeiling = detail?.node.dailyCostCeilingCents ?? node?.dailyCostCeilingCents ?? null;
    const ceilingSeedKey = `${nodeId}|${serverCeiling ?? ''}`;
    useEffect(() => {
        setCeilingDraft(centsToUsdInput(serverCeiling));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ceilingSeedKey]);

    if (!node) return null;

    const saveCeiling = () => {
        const cents = usdInputToCents(ceilingDraft);
        if (cents === undefined) {
            toast.error(t('costCeiling.invalid'));
            return;
        }
        onSaveCostCeiling(cents);
    };

    const recentJobs = detail?.recentJobs ?? [];
    const visibleJobs = filterFleetJobs(recentJobs, jobFilter);
    // One clock reading per render, so every running job's elapsed time
    // is measured against the same instant.
    const now = Date.now();

    const queuedReasonLabel = (reason: string): string =>
        reason === QUEUED_REASON_WAITING_FOR_RUNNER
            ? t('jobs.queuedReasons.waitingForRunner')
            : reason;

    const addTag = () => {
        const tag = draft.trim().slice(0, MAX_TAG_LENGTH);
        if (!tag || tags.includes(tag) || tags.length >= MAX_TAGS) {
            setDraft('');
            return;
        }
        setTags([...tags, tag]);
        setDraft('');
    };

    const drained = node.status === 'disabled';

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-3xl">
                <DialogClose onClose={onClose} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                        {node.name}
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-6" data-testid="fleet-node-drawer">
                    {error ? (
                        <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-text dark:text-text-dark">{error}</p>
                        </div>
                    ) : null}

                    {/* Summary */}
                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div>
                            <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                                {t('table.status')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                {t(`statuses.${node.status}` as never)}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                                {t('table.kind')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                {t(`kinds.${node.kind}` as never)}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                                {t('table.platform')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                {node.platform ?? '-'}
                                {node.version ? ` · ${node.version}` : ''}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                                {t('table.lastSeen')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                {formatMoment(node.lastHeartbeatAt)}
                            </dd>
                        </div>
                        {/* Fleet cost accounting (EW-777): the seat this
                            machine's spend is billed to, and its ceiling. */}
                        <div className="col-span-2">
                            <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                                {t('table.billingIdentity')}
                            </dt>
                            <dd
                                className="text-text dark:text-text-dark break-all"
                                data-testid="fleet-node-drawer-identity"
                            >
                                {node.modelIdentity ?? t('table.identityUnknown')}
                            </dd>
                        </div>
                        <div className="col-span-2">
                            <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                                {t('costCeiling.nodeTitle')}
                            </dt>
                            <dd
                                className="text-text dark:text-text-dark"
                                data-testid="fleet-node-drawer-ceiling"
                            >
                                {formatCeilingCents(node.dailyCostCeilingCents) ??
                                    t('costCeiling.nodeInherit')}
                                {node.dailyCostTrippedOn ? (
                                    <span className="block text-xs text-warning">
                                        {t('costCeiling.nodeTripped', {
                                            day: node.dailyCostTrippedOn,
                                        })}
                                    </span>
                                ) : null}
                            </dd>
                        </div>
                    </dl>

                    {/* Per-node daily cost ceiling — editable */}
                    <section className="space-y-2" data-testid="fleet-node-cost-ceiling">
                        <h4 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('costCeiling.nodeTitle')}
                        </h4>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('costCeiling.nodeHint')}
                        </p>
                        <div className="flex items-center gap-2">
                            <Input
                                inputMode="decimal"
                                value={ceilingDraft}
                                onChange={(event) => setCeilingDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        saveCeiling();
                                    }
                                }}
                                placeholder={t('costCeiling.inputPlaceholder')}
                                aria-label={t('costCeiling.nodeTitle')}
                                data-testid="fleet-node-cost-ceiling-input"
                            />
                            <Button
                                onClick={saveCeiling}
                                loading={isPending}
                                data-testid="fleet-node-cost-ceiling-save"
                            >
                                {t('costCeiling.save')}
                            </Button>
                            <Button
                                variant="secondary"
                                onClick={() => onSaveCostCeiling(null)}
                                disabled={isPending || node.dailyCostCeilingCents == null}
                                data-testid="fleet-node-cost-ceiling-clear"
                            >
                                {t('costCeiling.clear')}
                            </Button>
                        </div>
                    </section>

                    {/* Capability tags — admin-editable */}
                    <section className="space-y-2" data-testid="fleet-capability-editor">
                        <div className="flex items-center justify-between gap-3">
                            <h4 className="text-sm font-semibold text-text dark:text-text-dark">
                                {t('capabilities.title')}
                            </h4>
                            <button
                                type="button"
                                onClick={() => setPinned(!pinned)}
                                className="inline-flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                data-testid="fleet-capability-pin-toggle"
                            >
                                {pinned ? (
                                    <Pin className="w-3.5 h-3.5" />
                                ) : (
                                    <PinOff className="w-3.5 h-3.5" />
                                )}
                                {pinned ? t('capabilities.pinned') : t('capabilities.unpinned')}
                            </button>
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {pinned ? t('capabilities.pinnedHint') : t('capabilities.unpinnedHint')}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {tags.length === 0 ? (
                                <span className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('capabilities.none')}
                                </span>
                            ) : (
                                tags.map((tag) => (
                                    <span
                                        key={tag}
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-info/10 text-info"
                                        data-testid={`fleet-capability-tag-${tag}`}
                                    >
                                        {tag}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setTags(tags.filter((entry) => entry !== tag))
                                            }
                                            aria-label={t('capabilities.remove', { tag })}
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </span>
                                ))
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <Input
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        addTag();
                                    }
                                }}
                                maxLength={MAX_TAG_LENGTH}
                                placeholder={t('capabilities.placeholder')}
                                data-testid="fleet-capability-input"
                            />
                            <Button
                                variant="secondary"
                                onClick={addTag}
                                disabled={isPending}
                                data-testid="fleet-capability-add"
                            >
                                <Plus className="w-4 h-4" />
                                {t('capabilities.add')}
                            </Button>
                            <Button
                                onClick={() => onSaveCapabilities(tags, pinned)}
                                loading={isPending}
                                data-testid="fleet-capability-save"
                            >
                                {t('capabilities.save')}
                            </Button>
                        </div>
                    </section>

                    {/* Credential + drain controls */}
                    <section className="space-y-2" data-testid="fleet-node-controls">
                        <h4 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('controls.title')}
                        </h4>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="secondary"
                                onClick={onRotate}
                                disabled={isPending}
                                data-testid="fleet-node-rotate"
                            >
                                <KeyRound className="w-4 h-4" />
                                {t('controls.rotate')}
                            </Button>
                            <Button
                                variant={drained ? 'secondary' : 'danger'}
                                onClick={() => onDrain(!drained)}
                                disabled={isPending}
                                data-testid="fleet-node-drain"
                            >
                                {drained ? t('controls.undrain') : t('controls.drain')}
                            </Button>
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {drained ? t('controls.undrainHint') : t('controls.drainHint')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('controls.rotateHint')}
                        </p>
                    </section>

                    {/* Job history — every recent job with its outcome */}
                    <section className="space-y-2" data-testid="fleet-node-jobs">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <h4 className="text-sm font-semibold text-text dark:text-text-dark">
                                {t('jobs.title')}
                            </h4>
                            <div
                                className="inline-flex rounded-lg border border-border dark:border-border-dark p-0.5"
                                role="group"
                                aria-label={t('jobs.title')}
                                data-testid="fleet-node-jobs-filter"
                            >
                                {FLEET_JOB_FILTERS.map((filter) => {
                                    const active = filter === jobFilter;
                                    return (
                                        <button
                                            key={filter}
                                            type="button"
                                            onClick={() => setJobFilter(filter)}
                                            aria-pressed={active}
                                            className={`px-2 py-0.5 rounded-md text-xs font-medium transition-colors ${
                                                active
                                                    ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                                                    : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark'
                                            }`}
                                            data-testid={`fleet-node-jobs-filter-${filter}`}
                                        >
                                            {filter === 'all'
                                                ? t('jobs.filterAll')
                                                : filter === 'failed'
                                                  ? t('jobs.filterFailed')
                                                  : t('jobs.filterRunning')}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('jobs.description')}
                        </p>
                        {loading ? (
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('history.loading')}
                            </p>
                        ) : detail?.historyUnavailable ? (
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('history.unavailable')}
                            </p>
                        ) : visibleJobs.length === 0 ? (
                            <p
                                className="text-sm text-text-muted dark:text-text-muted-dark"
                                data-testid="fleet-node-jobs-empty"
                            >
                                {jobFilter === 'failed'
                                    ? t('jobs.emptyFailed')
                                    : jobFilter === 'running'
                                      ? t('jobs.emptyRunning')
                                      : t('jobs.emptyAll')}
                            </p>
                        ) : (
                            <ul className="space-y-1.5">
                                {visibleJobs.map((job) => {
                                    const failed = job.status === 'failed';
                                    const durationMs = fleetJobDurationMs(job, now);
                                    const duration = formatFleetJobDuration(durationMs);
                                    return (
                                        <li
                                            key={job.id}
                                            className={`p-2 rounded-lg border text-sm ${
                                                failed
                                                    ? 'border-danger/20 bg-danger/5'
                                                    : 'border-border dark:border-border-dark'
                                            }`}
                                            data-testid={`fleet-node-job-${job.id}`}
                                            data-status={job.status}
                                        >
                                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                                <span className="flex items-center gap-2 min-w-0">
                                                    <span className="font-medium font-mono text-text dark:text-text-dark truncate">
                                                        {job.kind}
                                                    </span>
                                                    <span
                                                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${jobStatusBadgeClass(job.status)}`}
                                                        data-testid={`fleet-node-job-status-${job.id}`}
                                                    >
                                                        {t(`jobs.statuses.${job.status}` as never)}
                                                    </span>
                                                    {job.targetNodeId === node.id && (
                                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] bg-primary/10 text-primary">
                                                            {t('jobs.pinned')}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                                    {t('jobs.attempts', {
                                                        attempts: job.attempts,
                                                        maxAttempts: job.maxAttempts,
                                                    })}
                                                </span>
                                            </div>
                                            <dl className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                                <div>
                                                    <dt className="sr-only">
                                                        {t('jobs.queuedAt')}
                                                    </dt>
                                                    <dd>
                                                        {t('jobs.queuedAtValue', {
                                                            time: formatMoment(job.createdAt),
                                                        })}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt className="sr-only">{t('jobs.started')}</dt>
                                                    <dd
                                                        data-testid={`fleet-node-job-started-${job.id}`}
                                                    >
                                                        {job.startedAt
                                                            ? t('jobs.startedValue', {
                                                                  time: formatMoment(job.startedAt),
                                                              })
                                                            : t('jobs.notStarted')}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt className="sr-only">
                                                        {t('jobs.completed')}
                                                    </dt>
                                                    <dd
                                                        data-testid={`fleet-node-job-completed-${job.id}`}
                                                    >
                                                        {job.completedAt
                                                            ? t('jobs.completedValue', {
                                                                  time: formatMoment(
                                                                      job.completedAt,
                                                                  ),
                                                              })
                                                            : t('jobs.notCompleted')}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt className="sr-only">
                                                        {t('jobs.duration')}
                                                    </dt>
                                                    <dd
                                                        data-testid={`fleet-node-job-duration-${job.id}`}
                                                    >
                                                        {duration
                                                            ? job.completedAt
                                                                ? t('jobs.durationValue', {
                                                                      duration,
                                                                  })
                                                                : t('jobs.elapsedValue', {
                                                                      duration,
                                                                  })
                                                            : '-'}
                                                    </dd>
                                                </div>
                                            </dl>
                                            {job.status === 'queued' && job.queuedReason ? (
                                                <p
                                                    className="mt-1 text-xs text-warning"
                                                    data-testid={`fleet-node-job-queued-reason-${job.id}`}
                                                >
                                                    {t('jobs.queuedReason', {
                                                        reason: queuedReasonLabel(job.queuedReason),
                                                    })}
                                                </p>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {recentJobs.length > 0 && !loading && !detail?.historyUnavailable ? (
                            <p
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                                data-testid="fleet-node-history-count"
                            >
                                {t('history.recentCount', { count: recentJobs.length })}
                            </p>
                        ) : null}
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}
