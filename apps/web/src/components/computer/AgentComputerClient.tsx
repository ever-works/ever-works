'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Monitor } from 'lucide-react';
import type {
    ComputerChannel,
    ComputerNodeOption,
    ComputerQuality,
    FleetKillSwitchState,
    NodeAgentProfileView,
} from '@ever-works/contracts';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { ComputerBriefOverlay, type ComputerWorkingBrief } from './ComputerBriefOverlay';
import { ComputerControls } from './ComputerControls';
import { ComputerIdentityStrip } from './ComputerIdentityStrip';
import { ComputerNodePicker, type ComputerNodePickerHandle } from './ComputerNodePicker';
import { ComputerProfilePanel } from './ComputerProfilePanel';
import { ComputerShortcutSheet } from './ComputerShortcutSheet';
import { ComputerStage, type ComputerStageHandle } from './ComputerStage';
import {
    ComputerCannotShowState,
    ComputerConnectingState,
    ComputerEmptyState,
    ComputerMessageState,
    ComputerNotAttendedState,
    ComputerOfflineState,
    ComputerOverLimitState,
    ComputerStoppedBanner,
    ComputerUnwatchableState,
} from './ComputerStateCard';
import { ComputerStatusLine } from './ComputerStatusLine';
import { ComputerWatermark } from './ComputerWatermark';
import {
    buildComputerViewHref,
    closeReasonKey,
    computerStallAgeMs,
    computerStallStateForAge,
    connectingPhase,
    formatBandwidth,
    isNodeClockStale,
    isQualityLowered,
    nextQuality,
    nodeClockDisplay,
    readStoredQuality,
    resolveChannel,
    resolvePreOpenState,
    selectInitialNode,
    writeStoredQuality,
} from './computer-session.shared';
import { useComputerAttach, type ComputerAttachDeps } from './use-computer-attach';

export interface AgentComputerClientProps {
    agentId: string;
    agentName: string;
    /** Null when the computer list could not be read (the page says so rather than claiming there are none). */
    nodes: ComputerNodeOption[] | null;
    initialNodeId: string | null;
    initialChannel: string | null;
    stop: FleetKillSwitchState | null;
    brief: ComputerWorkingBrief | null;
    /** The Agent's profile on the initially selected computer (null when never used there). */
    profile: NodeAgentProfileView | null;
    /** Seams for tests. */
    attachDeps?: ComputerAttachDeps;
    stageSeams?: Pick<ComponentProps<typeof ComputerStage>, 'decodePicture' | 'createRenderer'>;
}

function safeStorage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

/**
 * The computer page shell: which computer and channel are open, the live
 * view's lifecycle, and every state that shows instead of a picture.
 *
 * Opening this page never pauses, steers or cancels a Run: a live view only
 * reads what the Agent's browser (or shell) shows on the chosen computer.
 * Watching only — take-over and teach are not offered here.
 */
export function AgentComputerClient({
    agentId,
    agentName,
    nodes,
    initialNodeId,
    initialChannel,
    stop,
    brief,
    profile,
    attachDeps,
    stageSeams,
}: AgentComputerClientProps) {
    const t = useTranslations('dashboard.computer');
    const router = useRouter();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
        () => selectInitialNode(nodes ?? [], initialNodeId)?.id ?? null,
    );
    const [requestedChannel, setRequestedChannel] = useState<string | null>(initialChannel);
    const [quality, setQualityState] = useState<ComputerQuality>('sharp');
    const [cancelled, setCancelled] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const stageRef = useRef<ComputerStageHandle | null>(null);
    const pickerRef = useRef<ComputerNodePickerHandle | null>(null);

    const node = useMemo(
        () => (nodes ?? []).find((option) => option.id === selectedNodeId) ?? null,
        [nodes, selectedNodeId],
    );
    const preOpen = resolvePreOpenState({ nodes, node, requestedChannel, stop });
    const channel: ComputerChannel | null = preOpen.kind === 'ready' ? preOpen.channel : null;

    // The owner's quality for this computer (localStorage; `sharp` when unreadable).
    useEffect(() => {
        if (selectedNodeId) setQualityState(readStoredQuality(safeStorage(), selectedNodeId));
    }, [selectedNodeId]);

    const attach = useComputerAttach(
        {
            agentId,
            nodeId: node?.id ?? null,
            channel,
            quality,
            enabled: preOpen.kind === 'ready' && !cancelled,
        },
        {
            onPicture: (frame) => stageRef.current?.drawPicture(frame),
            onTerminal: (frame) => stageRef.current?.writeTerminal(frame),
        },
        attachDeps,
    );

    // A one-second tick for the stall ladder, the machine's clock staleness and "has not answered yet".
    const ticking =
        attach.state === 'opening' || attach.state === 'connecting' || attach.state === 'live';
    useEffect(() => {
        if (!ticking) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [ticking]);

    const frameAge = computerStallAgeMs({
        channel,
        live: attach.state === 'live',
        lastFrameAt: attach.lastFrameAt,
        now,
    });
    const stall = computerStallStateForAge(frameAge);
    const autoRefreshedFor = useRef<number | null>(null);
    const {
        refresh: refreshView,
        reconnect,
        setQuality: sendQuality,
        endSession,
        lastFrameAt,
    } = attach;
    useEffect(() => {
        // One automatic refresh per stall (FR-20 ladder: stalled at 6 s, refresh at 20 s, dead at 45 s).
        if (
            stall === 'auto-refresh' &&
            lastFrameAt !== null &&
            autoRefreshedFor.current !== lastFrameAt
        ) {
            autoRefreshedFor.current = lastFrameAt;
            refreshView();
        }
    }, [stall, lastFrameAt, refreshView]);

    // Keep the address bar a shareable link to this computer and channel.
    useEffect(() => {
        if (typeof window === 'undefined' || !node) return;
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('node', node.id);
            if (channel) url.searchParams.set('channel', channel);
            window.history.replaceState(window.history.state, '', url);
        } catch {
            // a sandboxed history is not worth failing the page over
        }
    }, [node, channel]);

    const selectNode = useCallback((nodeId: string) => {
        setCancelled(false);
        setRequestedChannel(null);
        setSelectedNodeId(nodeId);
    }, []);
    const pickAnother = useCallback(() => pickerRef.current?.open(), []);
    const tryAgain = useCallback(() => {
        setCancelled(false);
        router.refresh();
        reconnect();
    }, [router, reconnect]);
    const switchChannel = useCallback((next: ComputerChannel) => {
        setCancelled(false);
        setRequestedChannel(next);
    }, []);
    const changeQuality = useCallback(
        (next: ComputerQuality) => {
            setQualityState(next);
            if (selectedNodeId) writeStoredQuality(safeStorage(), selectedNodeId, next);
            sendQuality(next);
        },
        [sendQuality, selectedNodeId],
    );
    const copyLink = useCallback(() => {
        // The current page (locale prefix included) with this computer and channel in the query.
        const url = new URL(window.location.href);
        const shared = new URL(buildComputerViewHref(agentId, node?.id, channel), url.origin);
        url.search = shared.search;
        void navigator.clipboard?.writeText(url.toString()).then(
            () => setLinkCopied(true),
            () => undefined,
        );
    }, [agentId, node, channel]);

    // Keyboard: R refresh, Q quality, C channel, N computers, ? this sheet. Never while typing.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (
                target &&
                (target.isContentEditable ||
                    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
            )
                return;
            if (event.key === '?') {
                setShortcutsOpen(true);
            } else if (event.key === 'n' || event.key === 'N') {
                pickerRef.current?.open();
            } else if (!node || preOpen.kind !== 'ready') {
                return;
            } else if (event.key === 'r' || event.key === 'R') {
                refreshView();
            } else if ((event.key === 'q' || event.key === 'Q') && channel === 'screen') {
                changeQuality(nextQuality(quality));
            } else if (event.key === 'c' || event.key === 'C') {
                const other: ComputerChannel = channel === 'screen' ? 'terminal' : 'screen';
                if (node.servableChannels.includes(other)) switchChannel(other);
            } else {
                return;
            }
            event.preventDefault();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [refreshView, channel, changeQuality, node, preOpen.kind, quality, switchChannel]);

    // The live surface carries the picker in its identity strip; every other state carries it in the header.
    const surfaceShown =
        preOpen.kind === 'ready' &&
        !cancelled &&
        (attach.state === 'idle' ||
            attach.state === 'opening' ||
            attach.state === 'connecting' ||
            attach.state === 'live');
    const picker =
        nodes && nodes.length > 0 ? (
            <ComputerNodePicker
                ref={pickerRef}
                agentId={agentId}
                agentName={agentName}
                nodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelect={selectNode}
            />
        ) : null;

    return (
        <div className="mx-auto flex max-w-screen-2xl flex-col gap-3 p-6">
            <header className="flex flex-wrap items-center gap-3">
                <Link
                    href={ROUTES.DASHBOARD_AGENT(agentId)}
                    className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text dark:text-text-secondary-dark"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    {t('backToAgent', { agent: agentName })}
                </Link>
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-text dark:text-text-dark">
                    <Monitor className="h-5 w-5" aria-hidden />
                    {t('title', { agent: agentName })}
                </h2>
                {picker && !surfaceShown ? <div className="ml-auto text-sm">{picker}</div> : null}
            </header>

            {renderBody()}

            {node ? (
                <ComputerProfilePanel
                    key={node.id}
                    open={profileOpen}
                    onOpenChange={setProfileOpen}
                    agentId={agentId}
                    agentName={agentName}
                    nodeId={node.id}
                    nodeName={node.name}
                    profile={node.id === initialNodeIdFor(nodes, initialNodeId) ? profile : null}
                />
            ) : null}
            <ComputerShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        </div>
    );

    function renderBody() {
        switch (preOpen.kind) {
            case 'nodes-unavailable':
                return (
                    <ComputerMessageState
                        testId="computer-nodes-unavailable"
                        title={t('errors.nodesUnavailable')}
                        actionLabel={t('offline.tryAgain')}
                        onAction={tryAgain}
                    />
                );
            case 'empty':
                return <ComputerEmptyState agentName={agentName} />;
            case 'stopped':
                return <ComputerStoppedBanner reason={preOpen.reason} since={preOpen.since} />;
            case 'offline':
                return (
                    <ComputerOfflineState
                        node={preOpen.node}
                        onTryAgain={tryAgain}
                        onPickAnother={pickAnother}
                    />
                );
            case 'not-attended':
                return (
                    <ComputerNotAttendedState
                        nodeName={preOpen.node.name}
                        onTryAgain={tryAgain}
                        onPickAnother={pickAnother}
                    />
                );
            case 'unwatchable':
                return (
                    <ComputerUnwatchableState
                        nodeName={preOpen.node.name}
                        reason={preOpen.reason}
                        onPickAnother={pickAnother}
                    />
                );
            case 'channel-unavailable':
                return (
                    <ComputerCannotShowState
                        agentName={agentName}
                        nodeName={preOpen.node.name}
                        channel={preOpen.channel}
                        reason={preOpen.reason}
                        alternative={preOpen.alternative}
                        onWatchChannel={switchChannel}
                        onPickAnother={pickAnother}
                    />
                );
            case 'ready':
                return renderLive(preOpen.node, preOpen.channel);
        }
    }

    function renderLive(current: ComputerNodeOption, currentChannel: ComputerChannel) {
        if (cancelled) {
            return (
                <ComputerMessageState
                    testId="computer-ended"
                    title={t('ended.title')}
                    body={t('ended.reasons.closedByUser')}
                    actionLabel={t('ended.openAgain')}
                    onAction={tryAgain}
                />
            );
        }
        if (attach.state === 'refused' && attach.refusal) {
            const refusal = attach.refusal;
            switch (refusal.kind) {
                case 'stopped':
                    return <ComputerStoppedBanner reason={refusal.reason} since={refusal.since} />;
                case 'empty':
                    return <ComputerEmptyState agentName={agentName} />;
                case 'over-limit':
                    return (
                        <ComputerOverLimitState
                            nodeName={current.name}
                            scope={refusal.scope}
                            limit={refusal.limit}
                            sessions={refusal.sessions}
                            onPickAnother={pickAnother}
                        />
                    );
                case 'channel-unavailable':
                    return (
                        <ComputerCannotShowState
                            agentName={agentName}
                            nodeName={current.name}
                            channel={refusal.channel}
                            reason={refusal.reason}
                            alternative={resolveChannel(
                                {
                                    servableChannels: current.servableChannels.filter(
                                        (c) => c !== refusal.channel,
                                    ),
                                },
                                null,
                            )}
                            onWatchChannel={switchChannel}
                            onPickAnother={pickAnother}
                        />
                    );
                case 'unwatchable':
                    if (refusal.reason === 'offline') {
                        return (
                            <ComputerOfflineState
                                node={current}
                                onTryAgain={tryAgain}
                                onPickAnother={pickAnother}
                            />
                        );
                    }
                    if (refusal.reason === 'not-attended') {
                        return (
                            <ComputerNotAttendedState
                                nodeName={current.name}
                                onTryAgain={tryAgain}
                                onPickAnother={pickAnother}
                            />
                        );
                    }
                    return (
                        <ComputerMessageState
                            testId="computer-unwatchable"
                            title={t('unwatchable.title', { node: current.name })}
                            actionLabel={t('offline.tryAgain')}
                            onAction={tryAgain}
                        />
                    );
                case 'unavailable':
                    return (
                        <ComputerMessageState
                            testId="computer-unavailable"
                            title={t('errors.unavailable')}
                        />
                    );
                default:
                    return (
                        <ComputerMessageState
                            testId="computer-refused"
                            title={t('errors.refused')}
                        />
                    );
            }
        }
        if (attach.state === 'cannot-connect') {
            return (
                <ComputerMessageState
                    testId="computer-cannot-connect"
                    title={t('errors.cannotConnect')}
                    actionLabel={t('stall.reconnect')}
                    onAction={tryAgain}
                />
            );
        }
        if (attach.state === 'ended' && attach.endReason === 'abandoned') {
            return (
                <ComputerNotAttendedState
                    nodeName={current.name}
                    abandoned
                    onTryAgain={tryAgain}
                    onPickAnother={pickAnother}
                />
            );
        }
        if (attach.state === 'ended') {
            return (
                <ComputerMessageState
                    testId="computer-ended"
                    title={t('ended.title')}
                    body={t(`ended.reasons.${closeReasonKey(attach.endReason)}`, {
                        node: current.name,
                    })}
                    actionLabel={t('ended.openAgain')}
                    onAction={tryAgain}
                />
            );
        }

        const waiting =
            attach.state === 'opening' || attach.state === 'connecting' || attach.state === 'idle';
        const lowered = isQualityLowered(attach.stats);
        return (
            <div
                data-testid="computer-surface"
                className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card dark:border-border-dark/60 dark:bg-card-primary-dark"
            >
                <ComputerIdentityStrip
                    agentName={agentName}
                    nodeName={current.name}
                    nodeSlot={picker}
                    clock={nodeClockDisplay(attach.stats?.nodeLocalTime)}
                    clockStale={attach.stats !== null && isNodeClockStale(attach.lastStatsAt, now)}
                    channel={currentChannel}
                    quality={attach.stats?.effectiveQuality ?? quality}
                    lowered={lowered}
                    live={waiting ? 'connecting' : 'live'}
                />
                <div className="flex p-3">
                    <ComputerStage
                        ref={stageRef}
                        channel={currentChannel}
                        label={t('a11y.stageLabelWatching', {
                            agent: agentName,
                            node: current.name,
                        })}
                        stall={stall}
                        staleSeconds={frameAge === null ? 0 : Math.floor(frameAge / 1000)}
                        onRefresh={attach.refresh}
                        onReconnect={tryAgain}
                        {...(stageSeams ?? {})}
                    >
                        {waiting ? (
                            <ComputerConnectingState
                                nodeName={current.name}
                                slow={
                                    attach.openedAt !== null &&
                                    connectingPhase(now - attach.openedAt) === 'slow'
                                }
                                onCancel={() => {
                                    endSession();
                                    setCancelled(true);
                                }}
                            />
                        ) : null}
                        {currentChannel === 'screen' ? (
                            <ComputerBriefOverlay brief={brief} />
                        ) : null}
                        <ComputerWatermark agentName={agentName} nodeName={current.name} />
                    </ComputerStage>
                </div>
                {attach.banners.length > 0 ? (
                    <ul data-testid="computer-banners" className="px-4 text-xs text-warning">
                        {attach.banners.map((message, index) => (
                            <li key={`${index}-${message}`}>
                                {t('banner', { node: current.name, message })}
                            </li>
                        ))}
                    </ul>
                ) : null}
                <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 dark:border-border-dark/60">
                    <ComputerStatusLine
                        agentName={agentName}
                        nodeName={current.name}
                        channel={currentChannel}
                        stall={stall}
                        lowered={
                            lowered && attach.stats
                                ? {
                                      tier: attach.stats.effectiveQuality,
                                      chosen: attach.stats.quality,
                                  }
                                : null
                        }
                    />
                    <ComputerControls
                        channel={currentChannel}
                        servableChannels={current.servableChannels}
                        quality={quality}
                        bandwidth={formatBandwidth(attach.stats?.bytesOut)}
                        canRefresh={attach.state === 'live' && currentChannel === 'screen'}
                        onChannel={switchChannel}
                        onQuality={changeQuality}
                        onRefresh={attach.refresh}
                        onOpenProfile={() => setProfileOpen(true)}
                        onCopyLink={copyLink}
                        onEndSession={attach.endSession}
                        onOpenShortcuts={() => setShortcutsOpen(true)}
                        linkCopied={linkCopied}
                    />
                </div>
            </div>
        );
    }
}

/** The computer the page server-rendered the profile for. */
function initialNodeIdFor(
    nodes: ComputerNodeOption[] | null,
    requested: string | null,
): string | null {
    return selectInitialNode(nodes ?? [], requested)?.id ?? null;
}
