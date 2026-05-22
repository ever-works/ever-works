'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useEditor, EditorContent, ReactRenderer, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { updateKbDocumentAction } from '@/app/actions/works/kb-document';
import {
    WikiLinkExtension,
    type WikiLinkRenderProps,
    type WikiLinkRenderer,
    type WikiLinkSuggestionItem,
} from './extensions/WikiLinkExtension';
import {
    WikiLinkSuggestionList,
    type WikiLinkSuggestionListHandle,
} from './WikiLinkSuggestionList';
import {
    MentionExtension,
    type MentionItem,
    type MentionRenderProps,
    type MentionRenderer,
} from './extensions/MentionExtension';
import { MentionSuggestionList, type MentionSuggestionListHandle } from './MentionSuggestionList';
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
    /**
     * Override the autosave debounce. Tests pass a smaller value so the
     * debounced path is exercisable inside `vi.useFakeTimers`; product
     * code leaves it at the default 800ms (spec §14 acceptance A13).
     */
    autosaveDebounceMs?: number;
}

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * EW-641 Phase 1B/d row 6 — Tiptap editor with 800ms debounced autosave
 * + dirty/saved indicator.
 *
 * Builds on row 5's manual-save editor:
 *  - `editor.on('update')` flips status `idle → dirty` and arms a
 *    `setTimeout` that fires the same save path the manual button uses.
 *    Successive edits within the window reset the timer (debounce).
 *  - The manual "Save" button stays around as a "save now" affordance:
 *    it clears the pending timer and runs the save immediately.
 *  - The status pill cycles `idle → dirty → saving → saved → idle`
 *    (with `error` short-circuiting). The `data-status` attribute is
 *    the canonical Playwright assertion target (A13).
 *  - When the in-flight save resolves we read the freshly returned
 *    body so the dirty comparison resets to the server-confirmed
 *    state — typing during the save still re-arms the timer afterwards.
 *
 * Tiptap on React 19 strict mode needs `immediatelyRender: false`.
 */
export function KbEditor({
    workId,
    doc,
    readOnly = false,
    autosaveDebounceMs = DEFAULT_AUTOSAVE_DEBOUNCE_MS,
}: KbEditorProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    // Track the last body confirmed by the server so the autosave
    // debounce can short-circuit when nothing has actually changed.
    const lastSavedBodyRef = useRef<string>(doc.body ?? '');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);

    const wikilinkRenderFactory = useMemo(
        () => createWikiLinkRenderFactory(),
        // The factory itself is workId-agnostic — `WikiLinkExtension`
        // closes over `workId` via its own options. Only one factory
        // per editor lifecycle.
        [],
    );
    const mentionRenderFactory = useMemo(() => createMentionRenderFactory(), []);

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
            WikiLinkExtension.configure({
                workId,
                render: wikilinkRenderFactory,
            }),
            MentionExtension.configure({
                workId,
                render: mentionRenderFactory,
                // Row 17b — wires the agent side of the picker to the
                // Next.js proxy that fans out to /api/plugins?category=
                // pipeline. The list is small, so we filter
                // client-side by `q` and slice to 8.
                fetchAgents: async (id, query) => {
                    try {
                        const params = new URLSearchParams({ q: query, limit: '8' });
                        const response = await fetch(
                            `/api/works/${encodeURIComponent(id)}/agents?${params.toString()}`,
                            { cache: 'no-store' },
                        );
                        if (!response.ok) return [];
                        const json = (await response.json()) as {
                            items?: Array<{ id: string; name: string }>;
                        };
                        return (json.items ?? []).map((row) => ({
                            id: row.id,
                            name: row.name,
                            kind: 'agent' as const,
                        }));
                    } catch {
                        return [];
                    }
                },
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

    const flush = useCallback(() => {
        if (!editor) return;
        if (savingRef.current) return; // already saving; the next edit re-arms

        const body = readMarkdown(editor);
        if (typeof body !== 'string') {
            setStatus('error');
            setError('Could not serialize editor content as Markdown.');
            return;
        }
        if (body === lastSavedBodyRef.current) {
            // Nothing meaningful changed (e.g. focus toggled); skip the
            // network round-trip and settle back to `idle`.
            setStatus('idle');
            return;
        }

        savingRef.current = true;
        setError(null);
        setStatus('saving');

        startTransition(async () => {
            const result = await updateKbDocumentAction({
                workId,
                docId: doc.id,
                body: { body },
            });
            savingRef.current = false;
            if (result.success) {
                lastSavedBodyRef.current = result.data?.body ?? body;
                setStatus('saved');
            } else {
                setStatus('error');
                setError(result.error ?? 'Failed to save');
            }
        });
    }, [editor, doc.id, workId]);

    // Subscribe to editor updates → arm the autosave debounce.
    useEffect(() => {
        if (!editor) return;
        if (readOnly) return;
        const onUpdate = () => {
            // Don't downgrade an in-flight save to dirty — the next
            // settled state (`saved` / `error`) will reflect the latest
            // server response. We still re-arm the timer so the typing
            // that happened mid-save flushes once the request returns.
            if (!savingRef.current) {
                setStatus('dirty');
            }
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
            }
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                flush();
            }, autosaveDebounceMs);
        };
        editor.on('update', onUpdate);
        return () => {
            editor.off('update', onUpdate);
        };
    }, [editor, readOnly, autosaveDebounceMs, flush]);

    // Clean up any pending debounce on unmount.
    useEffect(() => {
        return () => {
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, []);

    const onSaveNow = useCallback(() => {
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        flush();
    }, [flush]);

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

            {doc.locked && doc.lockMode === 'additions-only' ? (
                <div
                    data-testid="kb-editor-lock-banner"
                    data-mode="additions-only"
                    role="status"
                    className={cn(
                        'rounded-md border px-3 py-2 text-xs',
                        'border-amber-500/30 bg-amber-500/10',
                        'text-amber-800 dark:text-amber-200',
                    )}
                >
                    🔒 {t('editor.additionsOnlyBanner')}
                </div>
            ) : null}

            <EditorSurface
                editor={editor}
                readOnly={readOnly}
                placeholder={t('editor.placeholder')}
            />

            <footer className="flex items-center gap-3">
                <SaveButton
                    disabled={readOnly || !editor || status === 'saving'}
                    onClick={onSaveNow}
                    saving={status === 'saving'}
                    label={t('editor.save')}
                    savingLabel={t('editor.saving')}
                />
                <SaveStatusPill
                    status={status}
                    error={error}
                    labels={{
                        idle: t('editor.idle'),
                        dirty: t('editor.dirty'),
                        saving: t('editor.saving'),
                        saved: t('editor.saved'),
                        error: t('editor.error'),
                    }}
                />
            </footer>
        </section>
    );
}

/**
 * Pull the Markdown body out of Tiptap's storage. The `tiptap-markdown`
 * extension installs a `markdown.getMarkdown()` helper on the editor
 * storage — that's the lossless round-trip path. We narrow the storage
 * type defensively because Tiptap's storage map is typed as
 * `Record<string, any>` upstream.
 */
function readMarkdown(editor: Editor): string | undefined {
    const storage = editor.storage as Record<string, { getMarkdown?: () => string }>;
    return storage.markdown?.getMarkdown?.();
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
    dirty: string;
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
                        : status === 'dirty'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'sr-only',
            )}
        >
            {status === 'saved'
                ? labels.saved
                : status === 'saving'
                  ? labels.saving
                  : status === 'dirty'
                    ? labels.dirty
                    : status === 'error'
                      ? (error ?? labels.error)
                      : labels.idle}
        </span>
    );
}

/**
 * Build a renderer factory for `WikiLinkExtension`. The factory owns a
 * single `ReactRenderer` instance + floating popover `<div>` over the
 * lifetime of the editor — `onStart` creates them, `onUpdate` reuses,
 * `onExit` tears down. Positioning is `position: fixed` keyed off the
 * `clientRect()` callback the suggestion plugin gives us (no `tippy`
 * dep — the popover is intentionally small).
 *
 * `findSuggestionMatch` in the extension only fires when the cursor is
 * inside a `[[…` chunk, so we don't need our own outside-click logic
 * (the plugin emits `onExit` once the match falls out of scope).
 */
function createWikiLinkRenderFactory(): () => WikiLinkRenderer {
    return () => {
        let renderer: ReactRenderer<WikiLinkSuggestionListHandle> | null = null;
        let popoverEl: HTMLDivElement | null = null;

        function positionFrom(clientRect: (() => DOMRect | null) | null) {
            if (!popoverEl) return;
            const rect = clientRect?.();
            if (!rect) {
                popoverEl.style.visibility = 'hidden';
                return;
            }
            popoverEl.style.visibility = 'visible';
            popoverEl.style.top = `${rect.bottom + 4}px`;
            popoverEl.style.left = `${rect.left}px`;
        }

        function mount(props: WikiLinkRenderProps) {
            popoverEl = document.createElement('div');
            popoverEl.setAttribute('data-testid', 'kb-wikilink-popover');
            popoverEl.style.position = 'fixed';
            popoverEl.style.zIndex = '60';
            document.body.appendChild(popoverEl);
            renderer = new ReactRenderer(WikiLinkSuggestionList, {
                editor: undefined as unknown as Editor, // satisfies the type; the list doesn't read it
                props: {
                    items: props.items,
                    query: props.query,
                    onSelect: (item: WikiLinkSuggestionItem) => props.command(item),
                } as Record<string, unknown>,
            });
            // `ReactRenderer.element` is an HTMLElement the renderer
            // mounted into. We move it under our positioned popoverEl.
            const element = renderer.element as unknown as HTMLElement | null;
            if (element) {
                popoverEl.appendChild(element);
            }
            positionFrom(props.clientRect);
        }

        return {
            onStart: (props) => {
                mount(props);
            },
            onUpdate: (props) => {
                if (!renderer) return;
                renderer.updateProps({
                    items: props.items,
                    query: props.query,
                    onSelect: (item: WikiLinkSuggestionItem) => props.command(item),
                });
                positionFrom(props.clientRect);
            },
            onKeyDown: ({ event }) => {
                if (event.key === 'Escape') {
                    // Let the upstream `onExit` fire by returning true;
                    // the suggestion plugin sees Escape and tears down.
                    return false;
                }
                return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
                renderer?.destroy();
                renderer = null;
                popoverEl?.remove();
                popoverEl = null;
            },
        };
    };
}

/**
 * Row-17 sibling of {@link createWikiLinkRenderFactory}. Identical
 * lifecycle — mounts a `ReactRenderer<MentionSuggestionListHandle>`
 * inside a `position: fixed` popover `<div>` and tears it down on
 * exit. Test-id on the wrapper diverges so the two pickers can be
 * distinguished by Playwright (`kb-mention-popover`).
 */
function createMentionRenderFactory(): () => MentionRenderer {
    return () => {
        let renderer: ReactRenderer<MentionSuggestionListHandle> | null = null;
        let popoverEl: HTMLDivElement | null = null;

        function positionFrom(clientRect: (() => DOMRect | null) | null) {
            if (!popoverEl) return;
            const rect = clientRect?.();
            if (!rect) {
                popoverEl.style.visibility = 'hidden';
                return;
            }
            popoverEl.style.visibility = 'visible';
            popoverEl.style.top = `${rect.bottom + 4}px`;
            popoverEl.style.left = `${rect.left}px`;
        }

        function mount(props: MentionRenderProps) {
            popoverEl = document.createElement('div');
            popoverEl.setAttribute('data-testid', 'kb-mention-popover');
            popoverEl.style.position = 'fixed';
            popoverEl.style.zIndex = '60';
            document.body.appendChild(popoverEl);
            renderer = new ReactRenderer(MentionSuggestionList, {
                editor: undefined as unknown as Editor,
                props: {
                    items: props.items,
                    query: props.query,
                    onSelect: (item: MentionItem) => props.command(item),
                } as Record<string, unknown>,
            });
            const element = renderer.element as unknown as HTMLElement | null;
            if (element) {
                popoverEl.appendChild(element);
            }
            positionFrom(props.clientRect);
        }

        return {
            onStart: (props) => {
                mount(props);
            },
            onUpdate: (props) => {
                if (!renderer) return;
                renderer.updateProps({
                    items: props.items,
                    query: props.query,
                    onSelect: (item: MentionItem) => props.command(item),
                });
                positionFrom(props.clientRect);
            },
            onKeyDown: ({ event }) => {
                if (event.key === 'Escape') return false;
                return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
                renderer?.destroy();
                renderer = null;
                popoverEl?.remove();
                popoverEl = null;
            },
        };
    };
}
