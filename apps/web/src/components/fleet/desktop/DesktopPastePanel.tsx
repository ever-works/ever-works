'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ClipboardPaste } from 'lucide-react';
import {
    FLEET_CLIP_MAX_BYTES,
    fleetClipByteLength,
    redactSecrets,
    type FleetClipPasteResult,
    type FleetClipViewState,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { browserApiFetch } from '@/lib/api/browser-api';
import { readSessionError } from '../sessions/sessions.shared';
import { formatFileBytes } from '../files/files.shared';

/**
 * Paste into a desktop (FL-11 P2, spec S8, §5.8, FR-30…FR-34, T-21) — on a
 * live view of one of the person's computers:
 *
 *  - **Allow paste into this desktop** — off by default, for this view only,
 *    gone when the view ends;
 *  - **Paste text…** (or `Ctrl/⌘+Shift+V` while controlling) — opens the
 *    dialog with the person's OWN clipboard text (read on their gesture, with
 *    the browser's permission), editable, its size against the 256 KB cap, a
 *    warning — never a block — when it looks like it holds a secret, and the
 *    promise that nothing is read back from the computer. Disabled, it says
 *    why: "Take control first", "Switch on paste for this desktop first".
 *
 * Hidden entirely where the deployment does not offer paste (the switch read
 * answers 404).
 */
export function DesktopPastePanel({
    nodeId,
    nodeName,
    agentId,
    viewId,
    controlling,
}: {
    nodeId: string;
    nodeName: string;
    agentId: string;
    viewId: string;
    controlling: boolean;
}) {
    const t = useTranslations('fleet.desktop.paste');
    const [available, setAvailable] = useState(false);
    const [allowed, setAllowed] = useState(false);
    const [open, setOpen] = useState(false);
    const [notice, setNotice] = useState('');
    const base = `/api/fleet/nodes/${encodeURIComponent(nodeId)}/desktop`;

    useEffect(() => {
        let cancelled = false;
        const query = new URLSearchParams({ viewId, agentId }).toString();
        void browserApiFetch(`${base}/paste-switch?${query}`, { method: 'GET', cache: 'no-store' })
            .then(async (response) => {
                if (cancelled) return;
                if (!response.ok) {
                    setAvailable(false);
                    return;
                }
                const state = (await response.json()) as FleetClipViewState;
                setAvailable(true);
                setAllowed(state.pasteAllowed);
            })
            .catch(() => !cancelled && setAvailable(false));
        return () => {
            cancelled = true;
        };
    }, [base, viewId, agentId]);

    const toggle = async (next: boolean) => {
        const response = await browserApiFetch(`${base}/paste-switch`, {
            method: 'PUT',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewId, agentId, allowed: next }),
        }).catch(() => null);
        if (response?.ok) setAllowed(((await response.json()) as FleetClipViewState).pasteAllowed);
    };

    const disabledReason = !controlling
        ? t('takeControlFirst')
        : !allowed
          ? t('switchOnFirst')
          : null;

    const openDialog = useCallback(() => {
        if (!controlling || !allowed) return;
        setOpen(true);
    }, [controlling, allowed]);

    // FR-41: Ctrl/⌘+Shift+V opens the dialog only while controlling this desktop.
    useEffect(() => {
        if (!available || !controlling) return undefined;
        const onKey = (event: KeyboardEvent) => {
            if (
                (event.ctrlKey || event.metaKey) &&
                event.shiftKey &&
                (event.key === 'V' || event.key === 'v')
            ) {
                event.preventDefault();
                openDialog();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [available, controlling, openDialog]);

    if (!available) return null;

    return (
        <div
            className="flex flex-wrap items-center gap-2 text-xs"
            data-testid="fleet-desktop-paste"
        >
            <label className="inline-flex items-center gap-1 text-text-muted dark:text-text-muted-dark">
                <input
                    type="checkbox"
                    checked={allowed}
                    onChange={(event) => void toggle(event.target.checked)}
                    data-testid="fleet-desktop-paste-switch"
                />
                {t('allow')}
            </label>
            <Button
                size="sm"
                variant="secondary"
                disabled={disabledReason !== null}
                title={disabledReason ?? t('shortcut')}
                onClick={openDialog}
                data-testid="fleet-desktop-paste-open"
            >
                <ClipboardPaste className="w-4 h-4" aria-hidden="true" />
                {t('open')}
            </Button>
            {disabledReason && (
                <span className="text-text-muted dark:text-text-muted-dark">{disabledReason}</span>
            )}
            <span className="sr-only" aria-live="polite" role="status">
                {notice}
            </span>
            {open && (
                <DesktopPasteDialog
                    nodeName={nodeName}
                    onCancel={() => setOpen(false)}
                    onPaste={async (text) => {
                        const response = await browserApiFetch(`${base}/paste`, {
                            method: 'POST',
                            cache: 'no-store',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ viewId, agentId, text }),
                        });
                        const body = (await response.json().catch(() => null)) as unknown;
                        if (!response.ok) {
                            const read = readSessionError(response.status, body);
                            return read.hint ?? read.code;
                        }
                        const result = body as FleetClipPasteResult;
                        setNotice(
                            t('pasted', { size: formatFileBytes(result.bytes), node: nodeName }),
                        );
                        setOpen(false);
                        return null;
                    }}
                />
            )}
        </div>
    );
}

export function DesktopPasteDialog({
    nodeName,
    onCancel,
    onPaste,
}: {
    nodeName: string;
    onCancel(): void;
    /** Resolves null on success, else the reason to show. */
    onPaste(text: string): Promise<string | null>;
}) {
    const t = useTranslations('fleet.desktop.paste');
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const bytes = fleetClipByteLength(text);
    const tooLarge = bytes > FLEET_CLIP_MAX_BYTES;
    const looksSecret = text.length > 0 && redactSecrets(text).redactions > 0;

    const readClipboard = async () => {
        try {
            setText(await navigator.clipboard.readText());
            setError(null);
        } catch {
            setError(t('clipboardDenied'));
        }
    };

    useEffect(() => {
        // Opened by a click or the shortcut (a user gesture): ask for the clipboard once.
        void readClipboard();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Dialog open onOpenChange={(next) => !next && !pending && onCancel()}>
            <DialogContent data-testid="fleet-desktop-paste-dialog">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title', { node: nodeName })}
                    </DialogTitle>
                    <DialogDescription>{t('body', { node: nodeName })}</DialogDescription>
                </DialogHeader>
                <textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={6}
                    spellCheck={false}
                    className="w-full rounded-md border border-border dark:border-border-dark bg-transparent p-2 font-mono text-xs"
                    aria-label={t('textLabel')}
                    data-testid="fleet-desktop-paste-text"
                />
                <div className="flex items-center justify-between text-xs">
                    <span
                        className={
                            tooLarge ? 'text-danger' : 'text-text-muted dark:text-text-muted-dark'
                        }
                    >
                        {t('size', {
                            size: formatFileBytes(bytes),
                            cap: formatFileBytes(FLEET_CLIP_MAX_BYTES),
                        })}
                    </span>
                    <button
                        type="button"
                        className="underline text-text-muted dark:text-text-muted-dark"
                        onClick={() => void readClipboard()}
                    >
                        {t('reread')}
                    </button>
                </div>
                {looksSecret && (
                    <p
                        className="text-xs text-warning"
                        role="status"
                        data-testid="fleet-desktop-paste-secret"
                    >
                        {t('secret', { node: nodeName })}
                    </p>
                )}
                {tooLarge && (
                    <p className="text-xs text-danger" role="alert">
                        {t('tooLarge')}
                    </p>
                )}
                {error && (
                    <p className="text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" disabled={pending} onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button
                        disabled={pending || tooLarge || text.length === 0}
                        onClick={async () => {
                            setPending(true);
                            const reason = await onPaste(text).catch(() => t('failed'));
                            setPending(false);
                            if (reason) setError(reason);
                        }}
                        data-testid="fleet-desktop-paste-confirm"
                    >
                        {t('paste')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
