'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pause, Play, Trash2 } from 'lucide-react';
import type { FleetDesktopRecordingView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { formatFileBytes } from '../files/files.shared';
import { DesktopPainter } from './desktop-painter';
import { DesktopRecordingPlayback, formatRecordingTime } from './desktop-recording-playback';
import { desktopClient } from './desktop.shared';

/**
 * Desktop view & control (FL-07 P2.C, T-41, FR-53 … FR-55) — the Desktop tab's
 * recordings: what was recorded on this computer (when, how long, how big,
 * where it is stored, until when), and a player that repaints a recording the
 * way its viewers saw it, with the stretches of control marked, steps of one
 * and ten seconds, and Delete now behind a confirmation (audited on the
 * platform). The watermark is drawn over every picture.
 */

const PLAY_TICK_MS = 100;

export function DesktopRecordings({ nodeId, nodeName }: { nodeId: string; nodeName: string }) {
    const t = useTranslations('fleet.desktop.recordings');
    const [items, setItems] = useState<FleetDesktopRecordingView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);

    const load = useCallback(async () => {
        const result = await desktopClient.recordings(nodeId);
        if (!result.ok) {
            setError(result.error.hint ?? t('error'));
            setItems([]);
            return;
        }
        setError(null);
        setItems(result.data);
    }, [nodeId, t]);

    useEffect(() => {
        void load();
    }, [load]);

    if (items === null) return null;

    return (
        <section
            className="flex flex-col gap-2 text-sm"
            aria-label={t('title', { name: nodeName })}
            data-testid="desktop-recordings"
        >
            <h3 className="font-medium">{t('title', { name: nodeName })}</h3>
            {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
            {items.length === 0 && !error ? (
                <p className="text-xs text-muted-foreground">{t('none')}</p>
            ) : null}
            <ul className="flex flex-col gap-1">
                {items.map((item) => (
                    <li
                        key={item.viewId}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1"
                    >
                        <span>{new Date(item.startedAt).toLocaleString()}</span>
                        <span className="text-muted-foreground">
                            {formatRecordingTime(item.durationMs)}
                        </span>
                        <span className="text-muted-foreground">{formatFileBytes(item.bytes)}</span>
                        {item.expiresAt ? (
                            <span className="text-xs text-muted-foreground">
                                {t('expires', {
                                    date: new Date(item.expiresAt).toLocaleDateString(),
                                })}
                            </span>
                        ) : null}
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="ml-auto"
                            onClick={() => setOpenId(openId === item.viewId ? null : item.viewId)}
                        >
                            {openId === item.viewId ? t('close') : t('watch')}
                        </Button>
                    </li>
                ))}
            </ul>
            {openId ? (
                <DesktopRecordingPlayer
                    key={openId}
                    nodeId={nodeId}
                    nodeName={nodeName}
                    viewId={openId}
                    onDeleted={() => {
                        setOpenId(null);
                        void load();
                    }}
                />
            ) : null}
        </section>
    );
}

export function DesktopRecordingPlayer({
    nodeId,
    nodeName,
    viewId,
    onDeleted,
}: {
    nodeId: string;
    nodeName: string;
    viewId: string;
    onDeleted: () => void;
}) {
    const t = useTranslations('fleet.desktop.recordings');
    const [recording, setRecording] = useState<FleetDesktopRecordingView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [position, setPosition] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const playbackRef = useRef<DesktopRecordingPlayback | null>(null);
    const positionRef = useRef(0);

    useEffect(() => {
        let cancelled = false;
        void desktopClient.recording(nodeId, viewId).then(async (result) => {
            if (cancelled) return;
            if (!result.ok) {
                setError(result.error.hint ?? t('error'));
                return;
            }
            setRecording(result.data);
            const painter = new DesktopPainter({
                canvas: () => canvasRef.current,
                requestKeyframe: () => undefined,
            });
            const playback = new DesktopRecordingPlayback(
                result.data.chunks ?? [],
                (seq) => desktopClient.recordingChunk(nodeId, viewId, seq),
                painter,
            );
            playbackRef.current = playback;
            await playback.seek(0);
        });
        return () => {
            cancelled = true;
        };
    }, [nodeId, viewId, t]);

    const duration = recording?.durationMs ?? 0;

    const seek = useCallback(
        async (to: number) => {
            const clamped = Math.max(0, Math.min(duration, to));
            positionRef.current = clamped;
            setPosition(clamped);
            await playbackRef.current?.seek(clamped);
        },
        [duration],
    );

    useEffect(() => {
        if (!playing) return;
        let painting = false;
        const timer = setInterval(() => {
            // One step at a time: a slow chunk fetch holds the clock instead of piling up paints.
            if (painting) return;
            const next = positionRef.current + PLAY_TICK_MS;
            if (next >= duration) {
                setPlaying(false);
                return;
            }
            positionRef.current = next;
            setPosition(next);
            painting = true;
            void (playbackRef.current?.advance(next) ?? Promise.resolve()).finally(() => {
                painting = false;
            });
        }, PLAY_TICK_MS);
        return () => clearInterval(timer);
    }, [duration, playing]);

    const remove = async () => {
        setBusy(true);
        const result = await desktopClient.deleteRecording(nodeId, viewId);
        setBusy(false);
        setConfirming(false);
        if (!result.ok) {
            setError(result.error.hint ?? t('error'));
            return;
        }
        onDeleted();
    };

    if (error) return <p className="text-sm text-destructive">{error}</p>;
    if (!recording) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;

    return (
        <div
            className="flex flex-col gap-2 rounded-lg border border-border p-2"
            data-testid="desktop-recording-player"
        >
            <div className="relative overflow-hidden rounded-md bg-black">
                <canvas
                    ref={canvasRef}
                    className="mx-auto block h-auto max-w-full"
                    aria-label={t('player', { name: nodeName })}
                />
                <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] font-semibold uppercase tracking-wide text-white/70">
                    {t('watermark', { name: nodeName })}
                </span>
            </div>
            <div className="relative h-2 rounded bg-muted" aria-hidden="true">
                {recording.spans.map((span, index) => {
                    const left = duration > 0 ? (span.startMs / duration) * 100 : 0;
                    const end = span.endMs ?? duration;
                    const width = duration > 0 ? ((end - span.startMs) / duration) * 100 : 0;
                    return (
                        <span
                            key={index}
                            className="absolute top-0 h-2 rounded bg-amber-500"
                            style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
                        />
                    );
                })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={playing ? t('pause') : t('play')}
                    onClick={() => setPlaying((value) => !value)}
                >
                    {playing ? (
                        <Pause className="h-4 w-4" aria-hidden="true" />
                    ) : (
                        <Play className="h-4 w-4" aria-hidden="true" />
                    )}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void seek(position - 10_000)}
                >
                    {t('back10')}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void seek(position - 1_000)}
                >
                    {t('back1')}
                </Button>
                <input
                    type="range"
                    min={0}
                    max={Math.max(1, duration)}
                    step={1000}
                    value={position}
                    aria-label={t('scrubber')}
                    onChange={(event) => void seek(Number(event.target.value))}
                    className="min-w-[8rem] flex-1"
                />
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void seek(position + 1_000)}
                >
                    {t('forward1')}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void seek(position + 10_000)}
                >
                    {t('forward10')}
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
                    {formatRecordingTime(position)} / {formatRecordingTime(duration)}
                </span>
            </div>
            <p className="text-xs text-muted-foreground">
                {t('facts', {
                    display: recording.displayId ?? t('primary'),
                    quality: recording.quality,
                    storage: recording.storage,
                    size: formatFileBytes(recording.bytes),
                    date: recording.expiresAt
                        ? new Date(recording.expiresAt).toLocaleDateString()
                        : t('never'),
                })}
            </p>
            {recording.spans.length > 0 ? (
                <p className="text-xs text-muted-foreground">{t('spans')}</p>
            ) : null}
            {confirming ? (
                <div
                    role="alertdialog"
                    aria-label={t('deleteTitle', { name: nodeName })}
                    className="rounded-md border border-border p-2"
                >
                    <p className="font-medium">{t('deleteTitle', { name: nodeName })}</p>
                    <p className="text-xs text-muted-foreground">{t('deleteBody')}</p>
                    <div className="mt-2 flex gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void remove()}
                        >
                            {t('deleteYes')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirming(false)}
                        >
                            {t('deleteNo')}
                        </Button>
                    </div>
                </div>
            ) : (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    onClick={() => setConfirming(true)}
                >
                    <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
                    {t('delete')}
                </Button>
            )}
        </div>
    );
}
