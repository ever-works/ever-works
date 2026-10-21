'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import {
    FLEET_PORT_LIST_REFRESH_MS,
    type FleetListeningPort,
    type FleetPortOpenTarget,
} from '@ever-works/contracts';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { FLEET_CONSENT_START_COMMANDS, type FleetComputerTabProps } from '../registry';
import { PortRow } from './PortRow';
import { PreviewPane } from './PreviewPane';
import { otherPortsLine, parsePortInput, portsClient, portsGroups, type PortsErrorRead } from './ports.shared';
import { usePortsLive } from './use-ports-live';

/**
 * Servers and ports (FL-10, spec §5) — the computer page's Ports tab.
 *
 * ```
 * SERVERS on build-01                                  [ Open a port… ]   ↻ live (5 s)
 * ● :3000  "Acme — Checkout"  200  node (pid 4812) · ~/code/api       [Open ▾] […]
 * ▸ 3 other ports   :22 ssh · :5432 postgres · :6379 redis
 * ▸ 6 system ports (hidden)                                                  [ show ]
 * ⏳ :4000  waiting for a server…                                                [✕]
 * ```
 *
 * Live (`use-ports-live.ts`: every 5 s while visible). Open follows R-3: the
 * desktop when it is available, else the preview browser, whose picture opens
 * in the pane beside the list. Every refusal reads its CONTRACTS §8 hint; the
 * list stays as last known under the kill switch. `?port=3000` selects a row
 * (the Overview's Servers block links here).
 */
export default function PortsTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.ports');
    const router = useRouter();
    const params = useSearchParams();
    const selectedPort = Number(params?.get('port') ?? NaN);
    const { list, error, loading, slow, watch, addWatch, removeWatch, reload } = usePortsLive(node.id);
    const [showOthers, setShowOthers] = useState(false);
    const [showSystem, setShowSystem] = useState(false);
    const [opening, setOpening] = useState<number | null>(null);
    const [field, setField] = useState('');
    const [fieldError, setFieldError] = useState(false);
    const [preview, setPreview] = useState<{
        port: number;
        attach: { token: string; wsUrl: string };
        endsAt: string | null;
    } | null>(null);
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const groups = useMemo(() => portsGroups(list), [list]);

    const open = async (port: FleetListeningPort, target: FleetPortOpenTarget) => {
        setOpening(port.port);
        try {
            const result = await portsClient.open(node.id, port.port, {
                target,
                ...(port.web?.scheme === 'https' ? { scheme: 'https' as const } : {}),
            });
            if (!result.ok) {
                toast.error(result.error.hint ?? t('openFailed', { port: port.port }));
                return;
            }
            if (result.data.target === 'desktop') {
                toast.success(t('openedDesktop', { url: result.data.url, name: node.name }), {
                    action: {
                        label: t('watchDesktop'),
                        onClick: () => router.push(ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'desktop')),
                    },
                });
                return;
            }
            if (result.data.attach) {
                setPreview({
                    port: port.port,
                    attach: { token: result.data.attach.token, wsUrl: result.data.attach.wsUrl },
                    endsAt: result.data.endsAt ?? null,
                });
            }
        } finally {
            setOpening(null);
        }
    };

    const submitField = () => {
        const port = parsePortInput(field);
        if (port === null) {
            setFieldError(true);
            return;
        }
        setFieldError(false);
        setField('');
        addWatch(port);
    };

    const header = (
        <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide">{t('title', { name: node.name })}</h2>
            <form
                className="ml-auto flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    submitField();
                }}
            >
                <input
                    ref={fieldRef}
                    value={field}
                    onChange={(event) => {
                        setField(event.target.value);
                        setFieldError(false);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') setField('');
                    }}
                    inputMode="numeric"
                    placeholder={t('openAPort')}
                    aria-label={t('openAPortLabel')}
                    aria-invalid={fieldError}
                    className="w-36 rounded-md border border-border bg-transparent px-2 py-1 text-sm dark:border-border-dark"
                    data-testid="fleet-ports-open-a-port"
                />
                <Button type="submit" size="sm" variant="secondary">
                    {t('openAPortAdd')}
                </Button>
            </form>
            <span className="flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark">
                <RefreshCw className="h-3 w-3" aria-hidden />
                {t('live', { seconds: FLEET_PORT_LIST_REFRESH_MS / 1000 })}
            </span>
            {fieldError && <p className="w-full text-xs text-danger">{t('openAPortInvalid')}</p>}
        </div>
    );

    if (!list) {
        return (
            <div className="space-y-4" data-testid="fleet-ports-tab">
                {header}
                {error ? (
                    <ErrorCard error={error} nodeName={node.name} onRetry={() => void reload()} />
                ) : (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {loading && slow ? t('states.slow', { name: node.name }) : t('states.loading', { name: node.name })}
                    </p>
                )}
            </div>
        );
    }

    const listedPorts = groups.web.length + groups.other.length + groups.noise.length;

    return (
        <div className="space-y-4" data-testid="fleet-ports-tab">
            {header}
            {error && (
                <ErrorCard error={error} nodeName={node.name} onRetry={() => void reload()} lastKnown />
            )}
            {!list.canOpen && <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('noOpen', { name: node.name })}</p>}

            {preview && (
                <PreviewPane
                    nodeName={node.name}
                    port={preview.port}
                    attach={preview.attach}
                    endsAt={preview.endsAt}
                    onClose={() => setPreview(null)}
                />
            )}

            {listedPorts === 0 && groups.waiting.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm dark:border-border-dark">
                    <p>{t('states.empty', { name: node.name })}</p>
                    <Button className="mt-3" size="sm" variant="secondary" onClick={() => fieldRef.current?.focus()}>
                        {t('openAPort')}
                    </Button>
                </div>
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border dark:divide-border-dark dark:border-border-dark">
                    {groups.web.map((port) => (
                        <PortRow
                            key={`web-${port.port}`}
                            port={port}
                            list={list}
                            nodeId={node.id}
                            nodeName={node.name}
                            opening={opening === port.port}
                            selected={port.port === selectedPort}
                            onOpen={(row, target) => void open(row, target)}
                        />
                    ))}
                    {groups.other.length > 0 && (
                        <li className="px-3 py-2 text-sm">
                            <button
                                type="button"
                                className="flex w-full items-center gap-2 text-left"
                                aria-expanded={showOthers}
                                onClick={() => setShowOthers((value) => !value)}
                            >
                                {showOthers ? (
                                    <ChevronDown className="h-4 w-4" aria-hidden />
                                ) : (
                                    <ChevronRight className="h-4 w-4" aria-hidden />
                                )}
                                <span>{t('otherPorts', { count: groups.other.length })}</span>
                                <span className="truncate text-text-muted dark:text-text-muted-dark">
                                    {otherPortsLine(groups.other)}
                                </span>
                            </button>
                            {showOthers && (
                                <ul className="mt-2 divide-y divide-border dark:divide-border-dark">
                                    {groups.other.map((port) => (
                                        <PortRow
                                            key={`other-${port.port}`}
                                            port={port}
                                            list={list}
                                            nodeId={node.id}
                                            nodeName={node.name}
                                            opening={false}
                                            onOpen={(row, target) => void open(row, target)}
                                        />
                                    ))}
                                </ul>
                            )}
                        </li>
                    )}
                    {groups.noise.length > 0 && (
                        <li className="px-3 py-2 text-sm">
                            <div className="flex items-center gap-2">
                                <ChevronRight className="h-4 w-4" aria-hidden />
                                <span>{t('systemPorts', { count: groups.noise.length })}</span>
                                <Button
                                    className="ml-auto"
                                    size="sm"
                                    variant="ghost"
                                    aria-expanded={showSystem}
                                    onClick={() => setShowSystem((value) => !value)}
                                >
                                    {showSystem ? t('hide') : t('show')}
                                </Button>
                            </div>
                            {showSystem && (
                                <ul className="mt-2 divide-y divide-border dark:divide-border-dark">
                                    {groups.noise.map((port) => (
                                        <PortRow
                                            key={`noise-${port.port}`}
                                            port={port}
                                            list={list}
                                            nodeId={node.id}
                                            nodeName={node.name}
                                            opening={false}
                                            onOpen={(row, target) => void open(row, target)}
                                        />
                                    ))}
                                </ul>
                            )}
                        </li>
                    )}
                    {groups.waiting.map((port) => (
                        <PortRow
                            key={`waiting-${port.port}`}
                            port={port}
                            list={list}
                            nodeId={node.id}
                            nodeName={node.name}
                            opening={false}
                            onOpen={() => undefined}
                            onRemoveWatch={removeWatch}
                        />
                    ))}
                </ul>
            )}
            {watch.length > 0 && groups.waiting.length === 0 && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('watchLive')}</p>
            )}
        </div>
    );
}

function ErrorCard({
    error,
    nodeName,
    onRetry,
    lastKnown = false,
}: {
    error: PortsErrorRead;
    nodeName: string;
    onRetry: () => void;
    lastKnown?: boolean;
}) {
    const t = useTranslations('fleet.ports.states');
    const consent = typeof error.details?.consent === 'string' ? (error.details.consent as string) : null;
    const command =
        error.code === 'consent_missing' && (consent === 'manage' || consent === 'attend' || consent === 'work')
            ? FLEET_CONSENT_START_COMMANDS[consent]
            : null;
    const heading =
        error.code === 'kill_switch'
            ? t('killSwitch')
            : error.code === 'consent_missing'
              ? t('consentMissing', { name: nodeName })
              : error.code === 'unreachable'
                ? t('offline', { name: nodeName })
                : error.code === 'permission_denied'
                  ? t('permissionDenied', { name: nodeName })
                  : error.code === 'unsupported_on_node'
                    ? t('unsupported', { name: nodeName })
                    : t('error', { name: nodeName });
    return (
        <div
            className="rounded-lg border border-border bg-warning/10 p-4 text-sm dark:border-border-dark"
            role="status"
            data-testid="fleet-ports-error"
        >
            <p className="font-medium">{heading}</p>
            {error.hint && <p className="mt-1 text-text-muted dark:text-text-muted-dark">{error.hint}</p>}
            {command && <code className="mt-2 block font-mono text-xs">{command}</code>}
            {lastKnown && <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">{t('lastKnown')}</p>}
            <Button className="mt-3" size="sm" variant="secondary" onClick={onRetry}>
                {t('tryAgain')}
            </Button>
        </div>
    );
}
