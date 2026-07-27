'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, KeyRound, Pin, PinOff, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type { FleetNodeDetailView, FleetNodeView } from '@/lib/api/fleet';

interface FleetNodeDrawerProps {
    node: FleetNodeView | null;
    detail: FleetNodeDetailView | null;
    loading: boolean;
    error: string | null;
    isPending: boolean;
    onClose: () => void;
    onSaveCapabilities: (capabilities: string[], pinned: boolean) => void;
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

/**
 * Node detail — everything about ONE machine that the table row cannot
 * carry: its recent job history, the failures pulled out of that history,
 * an editor for its capability tags, and the two credential-lifecycle
 * controls (rotate, drain).
 *
 * The failure list is the reason this exists. "Node X is online" is not
 * an answer to "why did my checks stop passing on X": before this, the
 * only way to see that a machine had failed its last nine jobs was to
 * read the database.
 */
export function FleetNodeDrawer({
    node,
    detail,
    loading,
    error,
    isPending,
    onClose,
    onSaveCapabilities,
    onRotate,
    onDrain,
}: FleetNodeDrawerProps) {
    const t = useTranslations('dashboard.settings.fleet');
    const [tags, setTags] = useState<string[]>([]);
    const [pinned, setPinned] = useState(false);
    const [draft, setDraft] = useState('');

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

    if (!node) return null;

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
                    </dl>

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

                    {/* Failure history */}
                    <section className="space-y-2" data-testid="fleet-node-failures">
                        <h4 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('history.failuresTitle')}
                        </h4>
                        {loading ? (
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('history.loading')}
                            </p>
                        ) : detail?.historyUnavailable ? (
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('history.unavailable')}
                            </p>
                        ) : (detail?.failures.length ?? 0) === 0 ? (
                            <p
                                className="text-sm text-text-muted dark:text-text-muted-dark"
                                data-testid="fleet-node-failures-empty"
                            >
                                {t('history.noFailures')}
                            </p>
                        ) : (
                            <ul className="space-y-1.5">
                                {detail?.failures.map((job) => (
                                    <li
                                        key={job.id}
                                        className="p-2 rounded-lg border border-danger/20 bg-danger/5 text-sm"
                                        data-testid={`fleet-node-failure-${job.id}`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="font-medium text-text dark:text-text-dark">
                                                {job.kind}
                                            </span>
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                                {formatMoment(job.completedAt ?? job.createdAt)}
                                            </span>
                                        </div>
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('history.attempts', {
                                                attempts: job.attempts,
                                                maxAttempts: job.maxAttempts,
                                            })}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {(detail?.recentJobs.length ?? 0) > 0 ? (
                            <p
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                                data-testid="fleet-node-history-count"
                            >
                                {t('history.recentCount', {
                                    count: detail?.recentJobs.length ?? 0,
                                })}
                            </p>
                        ) : null}
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}
