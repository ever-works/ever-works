'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Live microphone level meter for the composer's dictation bar.
 *
 * The Web Speech API exposes no audio level, so this hook opens a second,
 * silent `getUserMedia` stream purely to read amplitude off an `AnalyserNode`
 * and paint it as a scrolling bar meter.
 *
 * Everything runs on refs + `requestAnimationFrame` into a `<canvas>`, so
 * React never re-renders while recording.
 *
 * The analyser is deliberately NOT connected to `ctx.destination` — routing
 * the mic to the speakers would feed back.
 */

/** Widest history we keep; the visible count is derived from canvas width. */
const MAX_SAMPLES = 96;
/** ~18 samples/sec — fast enough to track syllables, cheap to paint. */
const SAMPLE_INTERVAL_MS = 55;
const BAR_WIDTH = 2.5;
const BAR_GAP = 2;
/** Speech RMS lands around 0.02–0.2; scale so normal talking fills the bar. */
const LEVEL_GAIN = 4;
const MIN_LEVEL = 0.05;

export interface MicWaveform {
    readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
    readonly active: boolean;
    start: () => Promise<boolean>;
    stop: () => void;
}

/** RMS amplitude of the current frame, normalized to a 0–1 bar height. */
function readLevel(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
        const deviation = (data[i] - 128) / 128;
        sumSquares += deviation * deviation;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    return Math.min(1, Math.max(MIN_LEVEL, rms * LEVEL_GAIN));
}

function paint(canvas: HTMLCanvasElement, levels: ReadonlyArray<number>): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.round(cssWidth * dpr);
    const targetHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = window.getComputedStyle(canvas).color || '#71717a';

    const step = BAR_WIDTH + BAR_GAP;
    const visible = Math.max(6, Math.floor((cssWidth + BAR_GAP) / step));
    const window_ = levels.slice(-visible);
    const offset = visible - window_.length;

    for (let i = 0; i < window_.length; i++) {
        const level = window_[i];
        const height = Math.max(2, level * (cssHeight - 2));
        const x = (offset + i) * step;
        const y = (cssHeight - height) / 2;
        ctx.globalAlpha = 0.3 + 0.7 * ((offset + i + 1) / visible);
        if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(x, y, BAR_WIDTH, height, BAR_WIDTH / 2);
            ctx.fill();
        } else {
            ctx.fillRect(x, y, BAR_WIDTH, height);
        }
    }
    ctx.globalAlpha = 1;
}

export function useMicWaveform(): MicWaveform {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const levelsRef = useRef<number[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastSampleRef = useRef(0);
    /** Bumped by every `start`/`stop`; lets a resolving `start` know it is stale. */
    const sessionRef = useRef(0);
    const [active, setActive] = useState(false);

    const stop = useCallback(() => {
        sessionRef.current++;
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        analyserRef.current = null;
        dataRef.current = null;
        if (audioCtxRef.current) {
            void audioCtxRef.current.close().catch(() => {
                /* already closed */
            });
            audioCtxRef.current = null;
        }
        levelsRef.current = [];
        setActive(false);
    }, []);

    const start = useCallback(async () => {
        if (typeof window === 'undefined') return false;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
        if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) return false;

        const session = ++sessionRef.current;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // The permission prompt can outlive the request: bail out if the caller
            // stopped dictation, or started it again, while we were waiting.
            if (sessionRef.current !== session) {
                stream.getTracks().forEach((track) => track.stop());
                return false;
            }
            streamRef.current = stream;

            const audioCtx = new window.AudioContext();
            audioCtxRef.current = audioCtx;
            void audioCtx.resume().catch(() => {});

            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.7;
            audioCtx.createMediaStreamSource(stream).connect(analyser);
            analyserRef.current = analyser;
            dataRef.current = new Uint8Array(analyser.fftSize);

            levelsRef.current = [];
            lastSampleRef.current = 0;
            function frame() {
                rafRef.current = requestAnimationFrame(frame);

                const canvas = canvasRef.current;
                const liveAnalyser = analyserRef.current;
                const data = dataRef.current;
                if (!canvas || !liveAnalyser || !data) return;

                const now = performance.now();
                if (now - lastSampleRef.current < SAMPLE_INTERVAL_MS) return;
                lastSampleRef.current = now;

                const levels = levelsRef.current;
                levels.push(readLevel(liveAnalyser, data));
                if (levels.length > MAX_SAMPLES) levels.shift();
                paint(canvas, levels);
            }

            setActive(true);
            rafRef.current = requestAnimationFrame(frame);
            return true;
        } catch {
            if (sessionRef.current === session) stop();
            return false;
        }
    }, [stop]);

    useEffect(() => stop, [stop]);
    return useMemo(() => ({ canvasRef, active, start, stop }), [active, start, stop]);
}
