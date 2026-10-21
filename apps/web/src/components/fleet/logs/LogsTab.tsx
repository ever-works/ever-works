'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { FileText, Lock, MonitorSmartphone, OctagonX, RotateCw, ShieldOff, WifiOff } from 'lucide-react';
import type { FleetLogSourcesResponse } from '@ever-works/contracts';
import { FLEET_LOGS_SOURCES_REFRESH_MS } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { browserApiFetch } from '@/lib/api/browser-api';
import { relativeTime } from '../fleet-hub.shared';
import { CopyCommand } from '../link/CopyCommand';
import type { FleetComputerTabProps } from '../registry';
import { readSessionError } from '../sessions/sessions.shared';
import { LogSourceTree } from './LogSourceTree';
import { LogViewer } from './LogViewer';
import { logsDeepLinkSources, logsTabCard, toggleMergedSource, type LogsError, type LogsTabCard } from './logs.shared';

/**
 * Logs on computers (FL-08, spec §5, T-13) — the computer page's Logs tab:
 * the computer's log sources on the left (re-listed on open and every 30 s
 * while the tab is visible — FR-11), the open log on the right. When the
 * computer cannot be read, ONE card says why, in words: offline since when
 * (U1), the exact `--manage` command (U2), all computers stopped (U3), the
 * owner's family (U4), not on this kind of node (U13) — never a spinner.
 *
 * `?source=<id>` (or `?source=service&unit=<name>`, as FL-09's Services tab
 * links) opens a source directly — the deep link FL-09's rows and P3's "Open
 * the log" use.
 */
export default function LogsTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.logs');
    const locale = useLocale();
    const search = useSearchParams();
    const linked = search
        ? logsDeepLinkSources(
              (name) => search.getAll(name),
              (name) => search.get(name),
          )
        : [];
    const linkedTitle = search?.get('title')?.slice(0, 80) ?? null;
    // P3 (FR-39): `?at=<iso>` positions the first-opened view at that time (a failed service).
    const linkedAtRaw = search?.get('at') ?? null;
    const linkedAt = linkedAtRaw && !Number.isNaN(Date.parse(linkedAtRaw)) ? new Date(Date.parse(linkedAtRaw)).toISOString() : null;
    const [list, setList] = useState<FleetLogSourcesResponse | null>(null);
    const [error, setError] = useState<LogsError | null>(null);
    const [loading, setLoading] = useState(true);
    // One source, or (P2) a merged set: ctrl/cmd-click adds or removes a source.
    const [selected, setSelected] = useState<string[]>(linked);

    const reload = useCallback(async () => {
        if (node.kind === 'desktop-node' || node.status === 'offline') {
            setLoading(false);
            return;
        }
        try {
            const response = await browserApiFetch(`/api/fleet/nodes/${encodeURIComponent(node.id)}/logs/sources`, {
                method: 'GET',
                cache: 'no-store',
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                setError(readSessionError(response.status, body));
            } else {
                setError(null);
                setList(body as FleetLogSourcesResponse);
            }
        } catch {
            setError({ code: 'network', hint: null, details: {}, status: 0 });
        } finally {
            setLoading(false);
        }
    }, [node.id, node.kind, node.status]);

    useEffect(() => {
        void reload();
        const timer = setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') void reload();
        }, FLEET_LOGS_SOURCES_REFRESH_MS);
        return () => clearInterval(timer);
    }, [reload]);

    const card = logsTabCard(node, error);
    const sources = list?.sources ?? [];
    const selectedSource = useMemo(
        () => (selected.length === 1 ? (sources.find((source) => source.id === selected[0]) ?? null) : null),
        [sources, selected],
    );
    const permissionDenied = card?.kind === 'permission-denied';

    if (card && !permissionDenied) {
        return <LogsStateCard card={card} nodeName={node.name} locale={locale} onRetry={() => void reload()} />;
    }

    return (
        <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]" data-testid="fleet-logs-tab">
            <aside className="space-y-3 min-w-0">
                <div className="flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                        {t('sources.title')}
                    </h2>
                    <button
                        type="button"
                        onClick={() => void reload()}
                        className="inline-flex items-center gap-1 text-[11px] text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                        aria-label={t('sources.refresh')}
                        data-testid="fleet-logs-refresh"
                    >
                        <RotateCw className="w-3 h-3" aria-hidden="true" />
                        {t('sources.every', { seconds: FLEET_LOGS_SOURCES_REFRESH_MS / 1000 })}
                    </button>
                </div>
                {permissionDenied && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark flex items-start gap-1" role="status" data-testid="fleet-logs-permission">
                        <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                        {t('states.permissionDenied', { node: node.name })}
                    </p>
                )}
                {loading && !list ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark" role="status">
                        {t('sources.loading', { node: node.name })}
                    </p>
                ) : (
                    <LogSourceTree
                        sources={sources}
                        selected={selected}
                        disabled={permissionDenied}
                        onSelect={(id, additive) =>
                            setSelected((current) => (additive ? toggleMergedSource(current, id) : [id]))
                        }
                    />
                )}
                {!permissionDenied && sources.length > 1 && (
                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark">{t('viewer.mergedHint')}</p>
                )}
            </aside>
            <div className="min-w-0">
                {selected.length > 0 && !permissionDenied ? (
                    <LogViewer
                        key={selected.join('|')}
                        nodeId={node.id}
                        nodeName={node.name}
                        source={selectedSource}
                        sources={selected}
                        listed={sources}
                        title={selected.length > 1 ? linkedTitle : null}
                        at={linkedAt && selected.join('|') === linked.join('|') ? linkedAt : null}
                    />
                ) : list && sources.length === 0 ? (
                    <LogsEmpty nodeName={node.name} />
                ) : (
                    <div className="rounded-xl border border-dashed border-border dark:border-border-dark p-8 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        {t('viewer.pick')}
                    </div>
                )}
            </div>
        </div>
    );
}

function LogsEmpty({ nodeName }: { nodeName: string }) {
    const t = useTranslations('fleet.logs');
    return (
        <div className="rounded-xl border border-border dark:border-border-dark p-8 text-center space-y-2" data-testid="fleet-logs-empty">
            <FileText className="w-6 h-6 mx-auto text-text-muted dark:text-text-muted-dark" aria-hidden="true" />
            <p className="text-sm font-medium text-text dark:text-text-dark">{t('states.empty', { node: nodeName })}</p>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('states.emptyBody')}</p>
        </div>
    );
}

function LogsStateCard({
    card,
    nodeName,
    locale,
    onRetry,
}: {
    card: LogsTabCard;
    nodeName: string;
    locale: string;
    onRetry(): void;
}) {
    const t = useTranslations('fleet.logs');
    const frame = 'rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark p-4 flex gap-3';
    const body = (() => {
        switch (card.kind) {
            case 'desktop-node':
                return {
                    icon: <MonitorSmartphone className="w-5 h-5 shrink-0 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />,
                    content: <p className="text-sm text-text dark:text-text-dark">{t('states.desktopNode')}</p>,
                };
            case 'offline': {
                const relative = relativeTime(card.lastSeenAt, new Date(), locale);
                return {
                    icon: <WifiOff className="w-5 h-5 shrink-0 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />,
                    content: (
                        <div className="space-y-2">
                            <p className="text-sm text-text dark:text-text-dark">
                                {relative ? t('states.offline', { node: nodeName, relative }) : t('states.offlineNever', { node: nodeName })}
                            </p>
                            <Button size="sm" variant="secondary" onClick={onRetry} data-testid="fleet-logs-retry">
                                {t('states.tryAgain')}
                            </Button>
                        </div>
                    ),
                };
            }
            case 'consent-missing':
                return {
                    icon: <ShieldOff className="w-5 h-5 shrink-0 text-warning" aria-hidden="true" />,
                    content: (
                        <div className="space-y-2 min-w-0">
                            <p className="text-sm font-medium text-text dark:text-text-dark">{t('states.consentMissing')}</p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('states.consentCommand', { node: nodeName })}</p>
                            <CopyCommand command={card.command} testId="fleet-logs-consent-command" />
                        </div>
                    ),
                };
            case 'kill-switch':
                return {
                    icon: <OctagonX className="w-5 h-5 shrink-0 text-danger" aria-hidden="true" />,
                    content: <p className="text-sm text-text dark:text-text-dark">{t('states.killSwitchTab')}</p>,
                };
            case 'unreachable':
                return {
                    icon: <WifiOff className="w-5 h-5 shrink-0 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />,
                    content: (
                        <div className="space-y-2">
                            <p className="text-sm text-text dark:text-text-dark">{card.hint ?? t('states.unreachable', { node: nodeName })}</p>
                            <Button size="sm" variant="secondary" onClick={onRetry} data-testid="fleet-logs-retry">
                                {t('states.tryAgain')}
                            </Button>
                        </div>
                    ),
                };
            case 'permission-denied':
                return {
                    icon: <Lock className="w-5 h-5 shrink-0 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />,
                    content: <p className="text-sm text-text dark:text-text-dark">{t('states.permissionDenied', { node: nodeName })}</p>,
                };
            default:
                return {
                    icon: <OctagonX className="w-5 h-5 shrink-0 text-danger" aria-hidden="true" />,
                    content: (
                        <div className="space-y-2">
                            <p className="text-sm text-text dark:text-text-dark">{t('states.listError', { node: nodeName })}</p>
                            {card.hint && <p className="text-xs text-text-muted dark:text-text-muted-dark font-mono">{card.hint}</p>}
                            <Button size="sm" variant="secondary" onClick={onRetry} data-testid="fleet-logs-retry">
                                {t('states.tryAgain')}
                            </Button>
                        </div>
                    ),
                };
        }
    })();
    return (
        <div role="status" className={frame} data-testid="fleet-logs-card" data-card={card.kind}>
            {body.icon}
            {body.content}
        </div>
    );
}
