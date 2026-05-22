'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { updateKbDocumentAction } from '@/app/actions/works/kb-document';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

interface KbEditorProps {
    workId: string;
    doc: KbDocumentBodyDto;
    /**
     * When the document is locked in `full` mode the API rejects body
     * mutations; this flag disables the editor + hides the save button
     * locally so the user sees a clear read-only signal instead of
     * watching the save bounce off the server with a 403.
     */
    readOnly?: boolean;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * EW-641 Phase 1B/d row 5 — basic Tiptap editor for KB documents.
 *
 * Wraps `@tiptap/react` + StarterKit + Link + `tiptap-markdown` so the
 * round-trip between the editor model and the API's Markdown body is
 * lossless for the basics (headings, lists, code blocks, links, etc.).
 * Autosave + dirty/saved indicator come in row 6 — this PR ships a
 * manual save button so the upload → edit → save loop is testable end
 * to end before the debounce + activity-log wiring lands.
 *
 * Selectors locked for the upcoming Playwright suite (A12-A17):
 *  - `data-testid="kb-editor"` (root, same as the row #4 read-only
 *    view so tests that pre-date this PR keep working)
 *  - `data-testid="kb-editor-body"` (the contenteditable surface)
 *  - `data-testid="kb-editor-save"` (the save button)
 *  - `data-testid="kb-editor-status"` (the saving/saved/error pill;
 *    autosave in row 6 keeps the same selector)
 *
 * Tiptap on React 19 strict mode needs `immediatelyRender: false` —
 * the editor's initial commit happens after mount instead of during
 * render, which avoids the "useSyncExternalStore inside render"
 * warning + double-mount content duplication.
 */
export function KbEditor({ workId, doc, readOnly = false }: KbEditorProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const editor = useEditor({
        immediatelyRender: false,
        editable: !readOnly,
        extensions: [
            StarterKit.configure({
                // tiptap-markdown owns codeBlock serialisation; keep
                // StarterKit's codeBlock node so the toolbar's parsing
                // stays consistent.
            }),
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
            }),
            Markdown.configure({
                html: false, // raw HTML in markdown body would break the round-trip
                breaks: true,
                transformPastedText: true,
            }),
        ],
        content: doc.body ?? '',
        editorProps: {
            attributes: {
                'data-testid': 'kb-editor-body',
                class: cn(
                    'prose prose-sm dark:prose-invert max-w-none focus:outline-none',
                    'min-h-[16rem] px-4 py-3',
                ),
            },
        },
    });

    const onSave = useCallback(() => {
        if (!editor) return;
        setError(null);
        setStatus('saving');
        // Tiptap's markdown extension exposes a `getMarkdown()` helper
        // through the editor storage. Round-trip through that so the
        // saved payload matches what `tiptap-markdown` would parse back
        // on the next mount.
        const body = (
            editor.storage as Record<string, { getMarkdown?: () => string }>
        ).markdown?.getMarkdown?.();
        if (typeof body !== 'string') {
            setStatus('error');
            setError('Could not serialize editor content as Markdown.');
            return;
        }

        startTransition(async () => {
            const result = await updateKbDocumentAction({
                workId,
                docId: doc.id,
                body: { body },
            });
            if (result.success) {
                setStatus('saved');
            } else {
                setStatus('error');
                setError(result.error ?? 'Failed to save');
            }
        });
    }, [editor, doc.id, workId]);

    return (
        <section
            data-testid="kb-editor"
            aria-label={t('panes.editor.title')}
            data-doc-id={doc.id}
            data-doc-path={doc.path}
            className={cn(
                'rounded-lg border border-border dark:border-border-dark',
                'bg-card/50 dark:bg-card-primary-dark/30',
                'p-4 flex flex-col gap-3 min-h-[24rem]',
            )}
        >
            <header
                data-testid="kb-document-meta"
                className="flex flex-wrap items-center gap-2 text-xs"
            >
                <h2
                    data-testid="kb-document-title"
                    className="mr-2 text-lg font-semibold text-text dark:text-text-dark"
                >
                    {doc.title || doc.path}
                </h2>
                <span
                    className={cn(
                        'rounded-full px-2 py-0.5 font-medium uppercase tracking-wide',
                        'bg-primary/10 text-primary dark:bg-primary/20',
                    )}
                    data-kb-class={doc.class}
                >
                    {t(`classes.${doc.class}`)}
                </span>
                <span
                    className={cn(
                        'rounded-full px-2 py-0.5',
                        doc.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : doc.status === 'archived'
                              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                              : 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70',
                    )}
                    data-kb-status={doc.status}
                >
                    {t(`status.${doc.status}`)}
                </span>
                {doc.locked ? (
                    <span
                        className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300"
                        data-locked="true"
                        data-kb-lock-mode={doc.lockMode ?? undefined}
                    >
                        🔒 {t(`lock.${doc.lockMode ?? 'full'}`)}
                    </span>
                ) : null}
                <span className="ml-auto font-mono text-[11px] text-text-muted dark:text-text-muted-dark/60">
                    {doc.path}
                </span>
            </header>

            <EditorSurface
                editor={editor}
                readOnly={readOnly}
                placeholder={t('editor.placeholder')}
            />

            <footer className="flex items-center gap-3">
                <SaveButton
                    disabled={readOnly || !editor || status === 'saving'}
                    onClick={onSave}
                    saving={status === 'saving'}
                    label={t('editor.save')}
                    savingLabel={t('editor.saving')}
                />
                <SaveStatusPill
                    status={status}
                    error={error}
                    labels={{
                        idle: t('editor.idle'),
                        saving: t('editor.saving'),
                        saved: t('editor.saved'),
                        error: t('editor.error'),
                    }}
                />
            </footer>
        </section>
    );
}

interface EditorSurfaceProps {
    editor: Editor | null;
    readOnly: boolean;
    placeholder: string;
}

function EditorSurface({ editor, readOnly, placeholder }: EditorSurfaceProps) {
    if (!editor) {
        // Render a stable wrapper while the editor mounts so the test
        // selector + layout don't shift.
        return (
            <div
                data-testid="kb-editor-body"
                className={cn(
                    'min-h-[16rem] rounded-md border border-border/60 dark:border-border-dark/60',
                    'bg-card/70 dark:bg-card-primary-dark/10 px-4 py-3',
                    'text-sm italic text-text-muted dark:text-text-muted-dark/60',
                )}
            >
                {placeholder}
            </div>
        );
    }

    return (
        <div
            className={cn(
                'rounded-md border border-border/60 dark:border-border-dark/60',
                'bg-card/70 dark:bg-card-primary-dark/10',
                readOnly ? 'opacity-90' : null,
            )}
        >
            <EditorContent editor={editor} />
        </div>
    );
}

interface SaveButtonProps {
    disabled: boolean;
    onClick: () => void;
    saving: boolean;
    label: string;
    savingLabel: string;
}

function SaveButton({ disabled, onClick, saving, label, savingLabel }: SaveButtonProps) {
    return (
        <Button
            type="button"
            data-testid="kb-editor-save"
            disabled={disabled}
            onClick={onClick}
            size="sm"
        >
            {saving ? savingLabel : label}
        </Button>
    );
}

interface SaveStatusPillLabels {
    idle: string;
    saving: string;
    saved: string;
    error: string;
}

interface SaveStatusPillProps {
    status: SaveStatus;
    error: string | null;
    labels: SaveStatusPillLabels;
}

function SaveStatusPill({ status, error, labels }: SaveStatusPillProps) {
    return (
        <span
            data-testid="kb-editor-status"
            data-status={status}
            className={cn(
                'text-xs',
                status === 'saved'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : status === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : status === 'saving'
                        ? 'text-text-muted dark:text-text-muted-dark/70'
                        : 'sr-only',
            )}
        >
            {status === 'saved'
                ? labels.saved
                : status === 'saving'
                  ? labels.saving
                  : status === 'error'
                    ? (error ?? labels.error)
                    : labels.idle}
        </span>
    );
}
