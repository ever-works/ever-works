'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Mic, Square } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Push-to-talk dictation for the chat composer.
 *
 * The transcription capability has existed since the KB media-ingest
 * work and is implemented by the AI-provider plugins; it simply had no
 * user-facing entry point. This is that entry point: record with
 * `MediaRecorder`, POST the clip to `/api/transcription`, hand the text
 * back to the composer.
 *
 * The control hides itself when the deployment has no transcription
 * provider (the endpoint answers 503). A mic button that always fails
 * is worse than no mic button, and whether a provider is configured is
 * a per-deployment fact the client cannot know up front — so it learns
 * from the first attempt rather than guessing.
 *
 * Transcribed text is handed to the caller to APPEND, never sent on its
 * own. Dictation that auto-sends turns a misheard word into a message
 * the user never chose to write.
 */

type State = 'idle' | 'recording' | 'transcribing';

export function ChatDictation({
    onText,
    disabled,
}: {
    readonly onText: (text: string) => void;
    readonly disabled?: boolean;
}) {
    const t = useTranslations('dashboard.aiChat.dictation');
    const [state, setState] = useState<State>('idle');
    const [unsupported, setUnsupported] = useState(false);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);

    const stopTracks = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    }, []);

    // Releasing the mic on unmount matters: without it the browser's
    // recording indicator stays lit after the panel closes, which reads
    // as the app still listening.
    useEffect(() => stopTracks, [stopTracks]);

    const transcribe = useCallback(
        async (blob: Blob) => {
            setState('transcribing');
            try {
                const form = new FormData();
                form.append('file', blob, 'dictation.webm');
                const res = await fetch('/api/transcription', { method: 'POST', body: form });
                if (res.status === 503) {
                    // No provider configured in this deployment — retire
                    // the control instead of offering a dead button.
                    setUnsupported(true);
                    return;
                }
                if (!res.ok) return;
                const body = (await res.json()) as { text?: string };
                const text = (body.text ?? '').trim();
                if (text) onText(text);
            } catch {
                // Swallow: a failed dictation leaves the composer exactly
                // as the user left it, which is the safe outcome.
            } finally {
                setState('idle');
            }
        },
        [onText],
    );

    const start = useCallback(async () => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            setUnsupported(true);
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const recorder = new MediaRecorder(stream);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                stopTracks();
                const blob = new Blob(chunksRef.current, {
                    type: recorder.mimeType || 'audio/webm',
                });
                chunksRef.current = [];
                if (blob.size > 0) void transcribe(blob);
                else setState('idle');
            };
            recorderRef.current = recorder;
            recorder.start();
            setState('recording');
        } catch {
            // Permission denied, no input device, or a policy block. All
            // three mean "dictation is not available here" to the user.
            stopTracks();
            setState('idle');
        }
    }, [stopTracks, transcribe]);

    const stop = useCallback(() => {
        recorderRef.current?.stop();
        recorderRef.current = null;
    }, []);

    if (unsupported) return null;

    const label =
        state === 'recording'
            ? t('stop')
            : state === 'transcribing'
              ? t('transcribing')
              : t('start');

    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            data-testid="chat-dictation-button"
            data-state={state}
            disabled={disabled || state === 'transcribing'}
            onClick={() => (state === 'recording' ? stop() : void start())}
            className={cn(
                'flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg transition-colors',
                state === 'recording'
                    ? 'bg-danger/10 text-danger hover:bg-danger/20'
                    : 'text-text-muted hover:bg-card-hover hover:text-text dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white',
                'disabled:cursor-not-allowed disabled:opacity-40',
            )}
        >
            {state === 'transcribing' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : state === 'recording' ? (
                <Square className="h-3 w-3" />
            ) : (
                <Mic className="h-3.5 w-3.5" />
            )}
        </button>
    );
}
