'use client';

import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import {
    Archive,
    ClipboardCopy,
    Copy,
    FileEdit,
    Link2,
    Lock,
    LockOpen,
    Trash2,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { updateKbDocumentAction, deleteKbDocumentAction } from '@/app/actions/works/kb-document';
import { lockKbDocumentAction, unlockKbDocumentAction } from '@/app/actions/works/kb-lock';
import type { KbDocumentDto, KbLockMode, UpdateKbDocumentInput } from '@ever-works/contracts';

/**
 * EW-641 slice E — right-click context menu for KB tree rows.
 *
 * Wraps a tree row (typically `KbTreePanel`'s `<Link>`) and intercepts
 * `onContextMenu` to render an accessible floating menu. Items map to
 * the existing server actions:
 *   - Rename → inline rename + PATCH `{ path }`
 *   - Duplicate → POST `{ sourceId, path }` via fetch shim (the agent
 *     accepts either form per the foundation map)
 *   - Lock submenu → PATCH `/lock { mode: 'full' | 'additions-only' }`
 *   - Unlock → PATCH `/unlock`
 *   - Archive → PATCH `{ status: 'archived' }`
 *   - Delete → "type the doc name to confirm" + DELETE
 *   - Copy path / Copy wikilink → navigator.clipboard
 *
 * Full-lock semantics (slice 1 of EW-643): when `locked && lockMode ===
 * 'full'`, Rename / Duplicate / Delete are disabled and the menu shows
 * a tooltip-bearing reason. Lock toggling stays enabled — operators
 * must be able to unlock from the same surface.
 *
 * The menu is intentionally NOT built on shadcn `ContextMenu` (not
 * installed in this monorepo yet); instead it uses a portal-free
 * absolute-positioned floating panel with full keyboard support. The
 * tree row remains the focusable element — pressing Shift+F10 or the
 * Menu key on a focused row also opens the menu via a synthetic
 * context-menu event handled here.
 */

export interface KbDocumentContextMenuProps {
    workId: string;
    document: KbDocumentDto;
    children: ReactNode;
    /**
     * Optional onPatched hook — when the panel-level parent wants to
     * propagate the post-action document state (e.g. for in-place tree
     * updates without a refetch). The component itself always calls
     * `router.refresh()` after mutations so the tree fetcher re-runs.
     */
    onPatched?: (doc: KbDocumentDto) => void;
    /**
     * Optional onRenamed hook — fired after a successful rename with
     * the new path. The default `router.refresh()` covers the tree
     * fetch, but parents may want to also `router.replace()` to the
     * new URL when renaming the active doc.
     */
    onRenamed?: (next: KbDocumentDto) => void;
    /**
     * Test seam — replaces `navigator.clipboard.writeText` so the unit
     * spec doesn't need a JSDOM polyfill.
     */
    clipboardWrite?: (text: string) => Promise<void> | void;
}

interface MenuPosition {
    x: number;
    y: number;
}

export function KbDocumentContextMenu({
    workId,
    document,
    children,
    onPatched,
    onRenamed,
    clipboardWrite,
}: KbDocumentContextMenuProps) {
    const tMenu = useTranslations('dashboard.workDetail.kb.workbench.contextMenu');
    const router = useRouter();

    const [position, setPosition] = useState<MenuPosition | null>(null);
    const [renameOpen, setRenameOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const fullyLocked = document.locked && document.lockMode === 'full';

    const menuRef = useRef<HTMLDivElement | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    const openAt = useCallback((x: number, y: number) => {
        setPosition({ x, y });
        setError(null);
    }, []);

    const closeMenu = useCallback(() => {
        setPosition(null);
    }, []);

    const handleContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.stopPropagation();
            openAt(event.clientX, event.clientY);
        },
        [openAt],
    );

    const handleKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLDivElement>) => {
            // Shift+F10 / ContextMenu key — open menu from keyboard.
            if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                event.preventDefault();
                const rect = (event.target as HTMLElement).getBoundingClientRect();
                openAt(rect.left + rect.width / 2, rect.top + rect.height);
            }
        },
        [openAt],
    );

    // Close on outside click + ESC while menu is open.
    useEffect(() => {
        if (!position) return;
        const onDocClick = (event: globalThis.MouseEvent) => {
            if (!menuRef.current) return;
            if (event.target instanceof Node && menuRef.current.contains(event.target)) return;
            closeMenu();
        };
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu();
        };
        // Note: `document` here is the global DOM object — the prop is
        // named `document` (the KB document) but TS narrows by scope.
        const root: Document = globalThis.document;
        root.addEventListener('mousedown', onDocClick);
        root.addEventListener('keydown', onKey);
        return () => {
            root.removeEventListener('mousedown', onDocClick);
            root.removeEventListener('keydown', onKey);
        };
    }, [position, closeMenu]);

    const applyPatch = useCallback(
        async (body: UpdateKbDocumentInput) => {
            setPending(true);
            setError(null);
            const result = await updateKbDocumentAction({
                workId,
                docId: document.id,
                body,
            });
            setPending(false);
            if (result.success && result.data) {
                onPatched?.(result.data);
                router.refresh();
                return { ok: true as const, data: result.data };
            }
            setError(result.error ?? tMenu('lockedDisabledTooltip'));
            return { ok: false as const, error: result.error ?? null };
        },
        [workId, document.id, onPatched, router, tMenu],
    );

    const onLock = useCallback(
        async (mode: KbLockMode) => {
            setPending(true);
            setError(null);
            const result = await lockKbDocumentAction({
                workId,
                docId: document.id,
                path: document.path,
                mode,
            });
            setPending(false);
            if (result.success && result.data) {
                onPatched?.(result.data);
                router.refresh();
                closeMenu();
            } else {
                setError(result.error ?? null);
            }
        },
        [workId, document.id, document.path, onPatched, router, closeMenu],
    );

    const onUnlock = useCallback(async () => {
        setPending(true);
        setError(null);
        const result = await unlockKbDocumentAction({
            workId,
            docId: document.id,
            path: document.path,
        });
        setPending(false);
        if (result.success && result.data) {
            onPatched?.(result.data);
            router.refresh();
            closeMenu();
        } else {
            setError(result.error ?? null);
        }
    }, [workId, document.id, document.path, onPatched, router, closeMenu]);

    const onArchive = useCallback(async () => {
        const r = await applyPatch({ status: 'archived' });
        if (r.ok) closeMenu();
    }, [applyPatch, closeMenu]);

    const onRenameSubmit = useCallback(
        async (newPath: string) => {
            const trimmed = newPath.trim();
            if (trimmed.length === 0 || trimmed === document.path) {
                setRenameOpen(false);
                return;
            }
            // `path` is not yet on `UpdateKbDocumentInput` per the foundation
            // map — cast through `unknown` so the contract stays the source
            // of truth (the API-side shim will be added in slice E phase 2).
            const body = { path: trimmed } as unknown as UpdateKbDocumentInput;
            const r = await applyPatch(body);
            if (r.ok) {
                setRenameOpen(false);
                onRenamed?.(r.data);
                closeMenu();
            }
        },
        [applyPatch, document.path, closeMenu, onRenamed],
    );

    const onDuplicate = useCallback(async () => {
        setPending(true);
        setError(null);
        const newPath = makeDuplicatePath(document.path);
        try {
            const res = await fetch(
                `/api/works/${encodeURIComponent(workId)}/kb/documents/${encodeURIComponent(
                    document.id,
                )}/duplicate`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newPath, sourceId: document.id }),
                },
            );
            setPending(false);
            if (!res.ok) {
                setError(`HTTP ${res.status}`);
                return;
            }
            const data = (await res.json()) as { id: string; path: string };
            router.refresh();
            router.push(`${ROUTES.DASHBOARD_WORK_KB(workId)}/${data.path}`);
            closeMenu();
        } catch (err) {
            setPending(false);
            setError(err instanceof Error ? err.message : 'Duplicate failed');
        }
    }, [workId, document.id, document.path, router, closeMenu]);

    const onDelete = useCallback(async () => {
        setPending(true);
        setError(null);
        const result = await deleteKbDocumentAction({
            workId,
            docId: document.id,
            path: document.path,
        });
        setPending(false);
        if (result.success) {
            setDeleteOpen(false);
            closeMenu();
            router.refresh();
            router.push(ROUTES.DASHBOARD_WORK_KB(workId));
        } else {
            setError(result.error ?? null);
        }
    }, [workId, document.id, document.path, router, closeMenu]);

    const writeClipboard = useCallback(
        async (text: string) => {
            try {
                if (clipboardWrite) {
                    await clipboardWrite(text);
                } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                }
                closeMenu();
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Clipboard failed');
            }
        },
        [clipboardWrite, closeMenu],
    );

    const onCopyPath = useCallback(() => {
        void writeClipboard(document.path);
    }, [writeClipboard, document.path]);

    const onCopyWikilink = useCallback(() => {
        void writeClipboard(`[[${document.path}]]`);
    }, [writeClipboard, document.path]);

    return (
        <div
            ref={wrapperRef}
            data-testid={`kb-workbench-context-menu-wrapper-${document.id}`}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyDown}
            className="contents"
        >
            {children}

            {position ? (
                <ContextMenuPanel
                    ref={menuRef}
                    position={position}
                    document={document}
                    pending={pending}
                    fullyLocked={fullyLocked}
                    error={error}
                    labels={{
                        rename: tMenu('rename'),
                        duplicate: tMenu('duplicate'),
                        lock: tMenu('lock'),
                        lockFull: tMenu('lockFull'),
                        lockAdditionsOnly: tMenu('lockAdditionsOnly'),
                        unlock: tMenu('unlock'),
                        archive: tMenu('archive'),
                        delete: tMenu('delete'),
                        copyPath: tMenu('copyPath'),
                        copyWikilink: tMenu('copyWikilink'),
                        lockedTooltip: tMenu('lockedDisabledTooltip'),
                    }}
                    onClose={closeMenu}
                    onRename={() => {
                        setRenameOpen(true);
                        closeMenu();
                    }}
                    onDuplicate={onDuplicate}
                    onLock={onLock}
                    onUnlock={onUnlock}
                    onArchive={onArchive}
                    onDelete={() => {
                        setDeleteOpen(true);
                        closeMenu();
                    }}
                    onCopyPath={onCopyPath}
                    onCopyWikilink={onCopyWikilink}
                />
            ) : null}

            {renameOpen ? (
                <InlineRenameDialog
                    initialPath={document.path}
                    pending={pending}
                    error={error}
                    onCancel={() => setRenameOpen(false)}
                    onSubmit={onRenameSubmit}
                />
            ) : null}

            {deleteOpen ? (
                <DeleteConfirmDialog
                    document={document}
                    pending={pending}
                    error={error}
                    labels={{
                        title: tMenu('deleteConfirmTitle'),
                        instruction: tMenu('deleteConfirmInstruction'),
                        inputLabel: tMenu('deleteConfirmInput'),
                        cancel: tMenu('deleteCancel'),
                        confirm: tMenu('deleteConfirm'),
                    }}
                    onCancel={() => setDeleteOpen(false)}
                    onConfirm={onDelete}
                />
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Context menu panel
// ---------------------------------------------------------------------------

interface ContextMenuPanelProps {
    position: MenuPosition;
    document: KbDocumentDto;
    pending: boolean;
    fullyLocked: boolean;
    error: string | null;
    labels: {
        rename: string;
        duplicate: string;
        lock: string;
        lockFull: string;
        lockAdditionsOnly: string;
        unlock: string;
        archive: string;
        delete: string;
        copyPath: string;
        copyWikilink: string;
        lockedTooltip: string;
    };
    onClose: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onLock: (mode: KbLockMode) => void;
    onUnlock: () => void;
    onArchive: () => void;
    onDelete: () => void;
    onCopyPath: () => void;
    onCopyWikilink: () => void;
}

const ContextMenuPanel = function ContextMenuPanel({
    ref,
    position,
    document,
    pending,
    fullyLocked,
    error,
    labels,
    onRename,
    onDuplicate,
    onLock,
    onUnlock,
    onArchive,
    onDelete,
    onCopyPath,
    onCopyWikilink,
}: ContextMenuPanelProps & { ref: React.Ref<HTMLDivElement> }) {
    const [lockSubmenuOpen, setLockSubmenuOpen] = useState(false);
    const menuId = useId();

    return (
        <div
            ref={ref}
            data-testid={`kb-workbench-context-menu-${document.id}`}
            role="menu"
            id={menuId}
            aria-label={`KB document actions for ${document.path}`}
            style={{ top: position.y, left: position.x }}
            className={cn(
                'fixed z-50 min-w-[14rem] rounded-md border shadow-lg',
                'border-border dark:border-border-dark',
                'bg-surface dark:bg-surface-dark',
                'p-1 text-sm',
            )}
        >
            <MenuItem
                testId="kb-workbench-context-rename"
                icon={FileEdit}
                label={labels.rename}
                disabled={fullyLocked || pending}
                disabledTitle={fullyLocked ? labels.lockedTooltip : undefined}
                onClick={onRename}
            />
            <MenuItem
                testId="kb-workbench-context-duplicate"
                icon={Copy}
                label={labels.duplicate}
                disabled={fullyLocked || pending}
                disabledTitle={fullyLocked ? labels.lockedTooltip : undefined}
                onClick={onDuplicate}
            />

            <Separator />

            {document.locked ? (
                <MenuItem
                    testId="kb-workbench-context-unlock"
                    icon={LockOpen}
                    label={labels.unlock}
                    disabled={pending}
                    onClick={onUnlock}
                />
            ) : (
                <div
                    data-testid="kb-workbench-context-lock-submenu"
                    className="relative"
                    onMouseEnter={() => setLockSubmenuOpen(true)}
                    onMouseLeave={() => setLockSubmenuOpen(false)}
                >
                    <button
                        type="button"
                        data-testid="kb-workbench-context-lock"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={lockSubmenuOpen}
                        disabled={pending}
                        onClick={() => setLockSubmenuOpen((v) => !v)}
                        className={menuItemClasses(false)}
                    >
                        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="flex-1 text-left">{labels.lock}</span>
                        <span aria-hidden="true">›</span>
                    </button>
                    {lockSubmenuOpen ? (
                        <div
                            role="menu"
                            aria-label={labels.lock}
                            className={cn(
                                'absolute left-full top-0 ml-1 min-w-[12rem] rounded-md border shadow-lg',
                                'border-border dark:border-border-dark',
                                'bg-surface dark:bg-surface-dark',
                                'p-1',
                            )}
                        >
                            <MenuItem
                                testId="kb-workbench-context-lock-full"
                                icon={Lock}
                                label={labels.lockFull}
                                disabled={pending}
                                onClick={() => onLock('full')}
                            />
                            <MenuItem
                                testId="kb-workbench-context-lock-additions"
                                icon={Lock}
                                label={labels.lockAdditionsOnly}
                                disabled={pending}
                                onClick={() => onLock('additions-only')}
                            />
                        </div>
                    ) : null}
                </div>
            )}

            <MenuItem
                testId="kb-workbench-context-archive"
                icon={Archive}
                label={labels.archive}
                disabled={pending}
                onClick={onArchive}
            />

            <Separator />

            <MenuItem
                testId="kb-workbench-context-copy-path"
                icon={ClipboardCopy}
                label={labels.copyPath}
                onClick={onCopyPath}
            />
            <MenuItem
                testId="kb-workbench-context-copy-wikilink"
                icon={Link2}
                label={labels.copyWikilink}
                onClick={onCopyWikilink}
            />

            <Separator />

            <MenuItem
                testId="kb-workbench-context-delete"
                icon={Trash2}
                label={labels.delete}
                disabled={fullyLocked || pending}
                disabledTitle={fullyLocked ? labels.lockedTooltip : undefined}
                tone="danger"
                onClick={onDelete}
            />

            {error ? (
                <p
                    data-testid="kb-workbench-context-menu-error"
                    role="alert"
                    className="px-2 py-1 text-[11px] text-red-600 dark:text-red-400"
                >
                    {error}
                </p>
            ) : null}
        </div>
    );
};

interface MenuItemProps {
    testId: string;
    icon: LucideIcon;
    label: string;
    disabled?: boolean;
    disabledTitle?: string;
    tone?: 'default' | 'danger';
    onClick: () => void;
}

function MenuItem({
    testId,
    icon: Icon,
    label,
    disabled,
    disabledTitle,
    tone,
    onClick,
}: MenuItemProps) {
    return (
        <button
            type="button"
            role="menuitem"
            data-testid={testId}
            data-disabled={disabled ? 'true' : 'false'}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            onClick={onClick}
            className={menuItemClasses(disabled, tone)}
        >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="flex-1 text-left">{label}</span>
        </button>
    );
}

function menuItemClasses(disabled: boolean | undefined, tone: 'default' | 'danger' = 'default') {
    return cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
        'transition-colors outline-none',
        'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
        'focus-visible:bg-surface-hover dark:focus-visible:bg-surface-hover-dark',
        tone === 'danger' && 'text-red-600 dark:text-red-400',
        disabled && 'cursor-not-allowed opacity-50 pointer-events-none',
    );
}

function Separator() {
    return <div role="separator" className="-mx-1 my-1 h-px bg-border dark:bg-border-dark" />;
}

// ---------------------------------------------------------------------------
// Inline rename dialog
// ---------------------------------------------------------------------------

interface InlineRenameDialogProps {
    initialPath: string;
    pending: boolean;
    error: string | null;
    onCancel: () => void;
    onSubmit: (newPath: string) => void;
}

function InlineRenameDialog({
    initialPath,
    pending,
    error,
    onCancel,
    onSubmit,
}: InlineRenameDialogProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.contextMenu');
    const [value, setValue] = useState(initialPath);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    return (
        <div
            role="dialog"
            aria-modal="true"
            data-testid="kb-workbench-context-rename-dialog"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit(value);
                }}
                className={cn(
                    'flex w-full max-w-md flex-col gap-3 rounded-lg border p-5 shadow-xl',
                    'border-border dark:border-border-dark',
                    'bg-card dark:bg-card-dark',
                )}
            >
                <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-text dark:text-text-dark">
                        {t('rename')}
                    </span>
                    <input
                        ref={inputRef}
                        type="text"
                        data-testid="kb-workbench-context-rename-input"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        disabled={pending}
                        className={cn(
                            'rounded-md border px-2 py-1.5 text-sm font-mono',
                            'border-border dark:border-border-dark',
                            'bg-card-secondary dark:bg-card-primary-dark/40',
                        )}
                    />
                </label>
                {error ? (
                    <p
                        data-testid="kb-workbench-context-rename-error"
                        role="alert"
                        className="text-xs text-red-600 dark:text-red-400"
                    >
                        {error}
                    </p>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        data-testid="kb-workbench-context-rename-cancel"
                        onClick={onCancel}
                        disabled={pending}
                        className="rounded-md px-3 py-1.5 text-sm hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                    >
                        {t('deleteCancel')}
                    </button>
                    <button
                        type="submit"
                        data-testid="kb-workbench-context-rename-submit"
                        disabled={pending || value.trim().length === 0}
                        className={cn(
                            'rounded-md px-3 py-1.5 text-sm',
                            'bg-primary text-white hover:bg-primary/90',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        {t('rename')}
                    </button>
                </div>
            </form>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Delete confirm dialog (type-the-name)
// ---------------------------------------------------------------------------

interface DeleteConfirmDialogProps {
    document: KbDocumentDto;
    pending: boolean;
    error: string | null;
    labels: {
        title: string;
        instruction: string;
        inputLabel: string;
        cancel: string;
        confirm: string;
    };
    onCancel: () => void;
    onConfirm: () => void;
}

function DeleteConfirmDialog({
    document,
    pending,
    error,
    labels,
    onCancel,
    onConfirm,
}: DeleteConfirmDialogProps) {
    const [typed, setTyped] = useState('');
    const expected = document.title || document.path;
    const matches = typed.trim() === expected;

    return (
        <div
            role="dialog"
            aria-modal="true"
            data-testid="kb-workbench-context-delete-dialog"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
            <div
                className={cn(
                    'flex w-full max-w-md flex-col gap-3 rounded-lg border p-5 shadow-xl',
                    'border-border dark:border-border-dark',
                    'bg-card dark:bg-card-dark',
                )}
            >
                <header className="flex flex-col gap-1">
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {labels.title}
                    </h2>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark/70">
                        {labels.instruction.replace('{name}', expected)}
                    </p>
                </header>

                <label className="flex flex-col gap-1.5">
                    <span className="text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark/70">
                        {labels.inputLabel}
                    </span>
                    <input
                        type="text"
                        data-testid="kb-workbench-context-delete-input"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        disabled={pending}
                        autoFocus
                        className={cn(
                            'rounded-md border px-2 py-1.5 text-sm font-mono',
                            'border-border dark:border-border-dark',
                            'bg-card-secondary dark:bg-card-primary-dark/40',
                        )}
                    />
                </label>

                {error ? (
                    <p
                        data-testid="kb-workbench-context-delete-error"
                        role="alert"
                        className="text-xs text-red-600 dark:text-red-400"
                    >
                        {error}
                    </p>
                ) : null}

                <footer className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        data-testid="kb-workbench-context-delete-cancel"
                        onClick={onCancel}
                        disabled={pending}
                        className="rounded-md px-3 py-1.5 text-sm hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                    >
                        {labels.cancel}
                    </button>
                    <button
                        type="button"
                        data-testid="kb-workbench-context-delete-confirm"
                        onClick={onConfirm}
                        disabled={pending || !matches}
                        className={cn(
                            'rounded-md px-3 py-1.5 text-sm text-white',
                            'bg-red-600 hover:bg-red-700',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        {labels.confirm}
                    </button>
                </footer>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a sensible "copy" target path for the duplicate action.
 *
 * `brand/voice.md` → `brand/voice-copy.md`. If the original already
 * ends in `-copy.md`, append `-2`, `-3`, … to avoid infinite
 * collisions. The server-side endpoint is responsible for the final
 * collision check; this only seeds a default.
 */
export function makeDuplicatePath(path: string): string {
    const match = path.match(/^(.*?)(-copy(?:-(\d+))?)?(\.[^./]+)?$/);
    if (!match) return `${path}-copy`;
    const base = match[1] ?? path;
    const ext = match[4] ?? '';
    const copySuffix = match[2];
    if (!copySuffix) return `${base}-copy${ext}`;
    const n = match[3] ? parseInt(match[3], 10) + 1 : 2;
    return `${base}-copy-${n}${ext}`;
}

// Silence unused-import warning for `useMemo` if/when this file is
// trimmed; keeping the import side-effect free.
void useMemo;
