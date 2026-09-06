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
 *
 * WHICH provider transcribes is deliberately NOT chosen here. It used to
 * be a picker in this toolbar, which put a provider-brand chip inches
 * from the chat PROVIDER chip in the header — two controls that looked
 * identical and meant completely different things, so "Mistral" beside
 * the composer read as "Mistral is answering me" when it only meant
 * "Mistral transcribes my voice". Swapping speech vendors is a rare,
 * account-level decision, so it lives in Settings → Plugins → AI
 * Providers, and this request omits `providerId` entirely: the server
 * resolves the account's saved voice provider, then the scope-active
 * plugin, then the platform default.
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
    // Bumped whenever a session is abandoned. Anything still in flight from
    // an earlier generation drops its text instead of appending it to a
    // composer that has since moved on.
    const generationRef = useRef(0);

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
            const generation = generationRef.current;
            setState('transcribing');
            try {
                const form = new FormData();
                form.append('file', blob, 'dictation.webm');
                // No `providerId`: selection is the server's job now, and
                // sending one from here would PIN it, silently outranking the
                // account's own Settings choice.
                // eslint-disable-next-line no-restricted-syntax -- EW-790 ok
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
                if (text && generationRef.current === generation) onText(text);
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
            const generation = generationRef.current;
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
                // Checked HERE, not in `cancel`: `stop()` queues one last
                // `dataavailable` after the caller returns, so the final
                // chunk always arrives too late for the canceller to drop.
                if (generationRef.current !== generation) {
                    setState('idle');
                    return;
                }
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

    /** Abandon the session outright: release the mic, keep no audio, say nothing. */
    const cancel = useCallback(() => {
        generationRef.current += 1;
        recorderRef.current?.stop();
        recorderRef.current = null;
        stopTracks();
        setState('idle');
    }, [stopTracks]);

    // The composer can go disabled mid-recording — a reply starts streaming
    // while the user is still speaking. Disabling the button alone would
    // leave the recorder running with no way to reach it, the browser's
    // recording indicator lit the whole time. The clip is DISCARDED rather
    // than transcribed: the message it was meant for has already been sent,
    // so its words would otherwise land in the next one.
    useEffect(() => {
        if (disabled && state !== 'idle') cancel();
    }, [disabled, state, cancel]);

    if (unsupported) return null;

    const label =
        state === 'recording'
            ? t('stop')
            : state === 'transcribing'
              ? t('transcribing')
              : t('start');

    return (
        <>
            <button
                type="button"
                aria-label={label}
                title={label}
                data-testid="chat-dictation-button"
                data-state={state}
                disabled={disabled || state === 'transcribing'}
                onClick={() => (state === 'recording' ? stop() : void start())}
                className={cn(
                    'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors',
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
        </>
    );
}
