'use client';

import { useState } from 'react';
import {
    AlertCircle,
    ChevronRight,
    Download,
    File as FileIcon,
    FileArchive,
    FileAudio,
    FileCode,
    FileSpreadsheet,
    FileText,
    FileVideo,
    Folder,
    Github,
    Image as ImageIcon,
    Loader2,
    RotateCcw,
    X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
    fileIconKind,
    fileTypeLabel,
    formatBytes,
    groupFolderFiles,
    folderRelativePath,
    isImageAttachment,
    isPreviewableAttachment,
    type ComposerAttachment,
    type ComposerFileAttachment,
    type ComposerFolderGroup,
    type ComposerImageAttachment,
    type FileIconKind,
} from './attachments';

/**
 * The strip of attached items rendered inside the composer card, above the
 * toolbar.
 *
 * Three shapes, matching what each thing actually is:
 *
 *   - **Images** → thumbnail tiles. Showing a picked screenshot as a filename
 *     chip is what made the old composer feel unfinished: you could not tell
 *     *which* image you had attached, or look at it again.
 *   - **Documents** → a card with a type glyph, the name, and `PDF · 240 KB`.
 *     Text and code documents are clickable and open in the preview overlay;
 *     binaries offer a download once the upload resolves.
 *   - **Folders** → one card per picked folder (`webkitdirectory` hands us a
 *     flat file list), with an aggregate size and progress, expanding to the
 *     files inside. Forty separate chips for one folder pick is unreadable.
 *
 * A failed upload stays on screen with its error and a retry rather than
 * disappearing; silently dropping it would let someone submit believing the
 * file went along.
 *
 * Colours come from the design-system tokens only (`text`, `text-muted`,
 * `border`, `danger`, `warning`, `success`, `info`) — no brand/primary accent,
 * so the strip stays quiet next to the prompt it belongs to.
 */

const KIND_ICONS: Record<FileIconKind, LucideIcon> = {
    image: ImageIcon,
    pdf: FileText,
    text: FileText,
    sheet: FileSpreadsheet,
    code: FileCode,
    archive: FileArchive,
    audio: FileAudio,
    video: FileVideo,
    file: FileIcon,
};

// One muted hue per family so a stack of documents is scannable. All four are
// design-system status tokens rather than the brand colour.
const KIND_TINTS: Record<FileIconKind, string> = {
    image: 'text-info',
    pdf: 'text-danger',
    text: 'text-text-secondary dark:text-text-secondary-dark',
    sheet: 'text-success',
    code: 'text-info',
    archive: 'text-warning',
    audio: 'text-info',
    video: 'text-info',
    file: 'text-text-secondary dark:text-text-secondary-dark',
};

// `pr-9` reserves the lane the remove / retry actions are absolutely
// positioned into, so a long filename truncates before it runs under them.
const CARD_BASE =
    'relative flex w-56 max-w-full items-center gap-2.5 overflow-hidden rounded-xl border py-2 pl-2.5 pr-9 text-left transition-colors';
const CARD_QUIET =
    'border-border/60 bg-foreground/[0.03] hover:bg-foreground/[0.06] dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.07]';
const CARD_ERROR = 'border-danger/40 bg-danger/[0.06]';
const ICON_TILE =
    'flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] dark:bg-white/[0.06]';
const ROW_ACTION =
    'shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-foreground/10 hover:text-text dark:text-text-muted-dark dark:hover:bg-white/10 dark:hover:text-text-dark';

function stateTagOf(a: ComposerFileAttachment): string {
    if (a.error) return 'error';
    return a.uploading ? 'uploading' : 'ready';
}

/** Thin progress rule on a card's bottom edge — no extra row. */
function ProgressRule({ percent }: { readonly percent: number }) {
    return (
        <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 bg-text-muted/70 transition-[width] duration-200 dark:bg-white/40"
            style={{ width: `${percent}%` }}
        />
    );
}

function RemoveButton({
    label,
    onClick,
    className,
}: {
    readonly label: string;
    readonly onClick: () => void;
    readonly className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={className}
        >
            <X className="size-3" aria-hidden="true" />
        </button>
    );
}

function RetryButton({
    label,
    onClick,
    className,
}: {
    readonly label: string;
    readonly onClick: () => void;
    readonly className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title="Retry upload"
            className={className}
        >
            <RotateCcw className="size-3" aria-hidden="true" />
        </button>
    );
}

function ImageTile({
    attachment,
    onOpen,
    onRemove,
    onRetry,
    testId,
}: {
    readonly attachment: ComposerImageAttachment;
    readonly onOpen: () => void;
    readonly onRemove: () => void;
    readonly onRetry: () => void;
    readonly testId?: string;
}) {
    const { displayName, uploading, progress, error, file } = attachment;
    return (
        <li className="group relative">
            <button
                type="button"
                onClick={onOpen}
                title={
                    error
                        ? `${displayName} — ${error}`
                        : `${displayName} · ${formatBytes(file.size)}`
                }
                aria-label={`Preview ${displayName}`}
                className={cn(
                    'relative block size-16 overflow-hidden rounded-xl border',
                    'transition-[transform,box-shadow,border-color] duration-150',
                    'hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none',
                    'focus-visible:ring-2 focus-visible:ring-text-muted/40',
                    error
                        ? 'border-danger/50'
                        : 'border-border/60 hover:border-border-secondary dark:border-white/10 dark:hover:border-white/20',
                )}
                data-testid={testId ? `${testId}-attachment-${stateTagOf(attachment)}` : undefined}
            >
                {/* eslint-disable-next-line @next/next/no-img-element --
                    local `blob:` object URL for a just-picked file; nothing
                    for next/image to optimize or allowlist. */}
                <img
                    src={attachment.previewUrl}
                    alt=""
                    decoding="async"
                    className={cn(
                        'size-full object-cover',
                        (uploading || error) && 'scale-100 blur-[1px]',
                    )}
                />

                {uploading ? (
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/45 text-white">
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        <span
                            className="text-[10px] font-medium tabular-nums"
                            aria-label={`Uploading ${progress} percent`}
                        >
                            {progress}%
                        </span>
                    </span>
                ) : null}

                {error ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-danger/25 text-danger">
                        <AlertCircle className="size-4" aria-hidden="true" />
                    </span>
                ) : null}
            </button>

            {error ? (
                <RetryButton
                    label={`Retry upload of ${displayName}`}
                    onClick={onRetry}
                    className="absolute -bottom-1 -left-1 rounded-full border border-border/60 bg-background p-1 text-text-muted shadow-sm transition-colors hover:text-text dark:border-white/15 dark:bg-zinc-900 dark:text-text-muted-dark dark:hover:text-text-dark"
                />
            ) : null}

            <RemoveButton
                label={`Remove ${displayName}`}
                onClick={onRemove}
                className={cn(
                    'absolute -right-1.5 -top-1.5 rounded-full border p-1 shadow-sm transition-all',
                    'border-border/60 bg-background text-text-muted dark:border-white/15 dark:bg-zinc-900 dark:text-text-muted-dark',
                    'hover:text-text dark:hover:text-text-dark',
                    // Always reachable by keyboard / touch, quiet until hover
                    // on pointer devices so the strip stays calm.
                    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    'group-focus-within:opacity-100 max-sm:opacity-100',
                )}
            />
        </li>
    );
}

/**
 * A document card: type glyph, name, and `PDF · 240 KB`. The card itself is
 * clickable when we can render the file ourselves (text / code / CSV);
 * otherwise it is inert and a download action appears once the upload lands.
 */
function FileCard({
    attachment,
    onOpen,
    onRemove,
    onRetry,
    testId,
}: {
    readonly attachment: ComposerFileAttachment;
    /** Set when the file can be previewed in-app (text / code / CSV). */
    readonly onOpen?: () => void;
    readonly onRemove: () => void;
    readonly onRetry: () => void;
    readonly testId?: string;
}) {
    const { displayName, uploading, progress, error, file } = attachment;
    const kind = fileIconKind(displayName, file.type);
    const Icon = KIND_ICONS[kind];
    const label = fileTypeLabel(displayName, file.type);

    const body = (
        <>
            <span className={ICON_TILE}>
                {uploading ? (
                    <Loader2
                        className="size-4 animate-spin text-text-muted dark:text-text-muted-dark"
                        aria-hidden="true"
                    />
                ) : error ? (
                    <AlertCircle className="size-4 text-danger" aria-hidden="true" />
                ) : (
                    <Icon className={cn('size-4', KIND_TINTS[kind])} aria-hidden="true" />
                )}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-text dark:text-text-dark">
                    {displayName}
                </span>
                <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                    {error ? error : uploading ? `${progress}% · ${label}` : label}
                    {error ? '' : ` · ${formatBytes(file.size)}`}
                </span>
            </span>
        </>
    );

    // Widen the reserved action lane when there are two buttons in it.
    const downloadable = !onOpen && !error && !uploading && Boolean(attachment.url);
    const cardClass = cn(
        CARD_BASE,
        error ? CARD_ERROR : CARD_QUIET,
        (error || downloadable) && 'pr-14',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/40',
    );
    const testIdAttr = testId ? `${testId}-attachment-${stateTagOf(attachment)}` : undefined;
    // Only offered once the upload resolves — before that there is no URL to
    // point at.
    const downloadHref = downloadable ? attachment.url : undefined;

    return (
        <li className="relative">
            {/* Element type is chosen from the file, never from upload state:
                previewability doesn't change mid-flight, so the card never
                remounts (and never loses focus) when an upload lands. */}
            {onOpen ? (
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={`Preview ${displayName}`}
                    title={`${displayName} — click to preview`}
                    className={cardClass}
                    data-testid={testIdAttr}
                >
                    {body}
                </button>
            ) : (
                <div className={cardClass} title={error || displayName} data-testid={testIdAttr}>
                    {body}
                </div>
            )}

            {/* Actions sit outside the card button so a click on them never
                also opens the preview. */}
            <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                {error ? (
                    <RetryButton
                        label={`Retry upload of ${displayName}`}
                        onClick={onRetry}
                        className={ROW_ACTION}
                    />
                ) : null}
                {downloadHref ? (
                    <a
                        href={downloadHref}
                        download={displayName}
                        aria-label={`Download ${displayName}`}
                        title="Download"
                        className={ROW_ACTION}
                    >
                        <Download className="size-3" aria-hidden="true" />
                    </a>
                ) : null}
                <RemoveButton
                    label={`Remove ${displayName}`}
                    onClick={onRemove}
                    className={ROW_ACTION}
                />
            </span>

            {uploading ? <ProgressRule percent={progress} /> : null}
        </li>
    );
}

function FolderCard({
    group,
    onRemoveFile,
    onRetryFile,
    onOpenFile,
    testId,
}: {
    readonly group: ComposerFolderGroup;
    readonly onRemoveFile: (localId: string) => void;
    readonly onRetryFile: (localId: string) => void;
    readonly onOpenFile: (localId: string) => void;
    readonly testId?: string;
}) {
    const [expanded, setExpanded] = useState(false);
    const { name, files, totalBytes, uploadingCount, failedCount, progress } = group;
    const count = files.length;

    const summary =
        failedCount > 0
            ? `${failedCount} of ${count} failed`
            : uploadingCount > 0
              ? `Uploading ${count - uploadingCount + 1} of ${count}`
              : `${count} file${count === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`;

    return (
        <li className="relative w-full">
            <div
                className={cn(CARD_BASE, 'w-full', failedCount > 0 ? CARD_ERROR : CARD_QUIET)}
                data-testid={testId ? `${testId}-attachment-folder` : undefined}
            >
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${name}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
                >
                    <span className={ICON_TILE}>
                        {uploadingCount > 0 ? (
                            <Loader2
                                className="size-4 animate-spin text-text-muted dark:text-text-muted-dark"
                                aria-hidden="true"
                            />
                        ) : failedCount > 0 ? (
                            <AlertCircle className="size-4 text-danger" aria-hidden="true" />
                        ) : (
                            <Folder
                                className="size-4 text-text-secondary dark:text-text-secondary-dark"
                                aria-hidden="true"
                            />
                        )}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-text dark:text-text-dark">
                            {name}
                        </span>
                        <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                            {summary}
                        </span>
                    </span>
                    <ChevronRight
                        className={cn(
                            'size-3.5 shrink-0 text-text-muted transition-transform duration-150 dark:text-text-muted-dark',
                            expanded && 'rotate-90',
                        )}
                        aria-hidden="true"
                    />
                </button>

                {/* Inside the card, not the <li> — the list item grows when
                    the folder is expanded, so anchoring to it would drag the
                    button down to the middle of the file list. */}
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2">
                    <RemoveButton
                        label={`Remove folder ${name}`}
                        // Each file is its own attachment, so removing the
                        // folder removes them one by one; the functional state
                        // updates compose, so this settles as a single render.
                        onClick={() => files.forEach((f) => onRemoveFile(f.localId))}
                        className={ROW_ACTION}
                    />
                </span>

                {uploadingCount > 0 ? <ProgressRule percent={progress} /> : null}
            </div>

            {expanded ? (
                <ul className="mt-1 flex flex-col gap-px rounded-lg border border-border/40 bg-foreground/[0.02] p-1 dark:border-white/[0.07] dark:bg-white/[0.02]">
                    {files.map((f) => {
                        const relative = folderRelativePath(f.displayName);
                        const previewable = isPreviewableAttachment(f);
                        return (
                            <li
                                key={f.localId}
                                className="flex items-center gap-2 rounded-md px-1.5 py-1"
                            >
                                {f.uploading ? (
                                    <Loader2
                                        className="size-3 shrink-0 animate-spin text-text-muted dark:text-text-muted-dark"
                                        aria-hidden="true"
                                    />
                                ) : f.error ? (
                                    <AlertCircle
                                        className="size-3 shrink-0 text-danger"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <FileIcon
                                        className="size-3 shrink-0 text-text-muted dark:text-text-muted-dark"
                                        aria-hidden="true"
                                    />
                                )}
                                {previewable ? (
                                    <button
                                        type="button"
                                        onClick={() => onOpenFile(f.localId)}
                                        className="min-w-0 flex-1 truncate text-left text-[11px] text-text underline-offset-2 hover:underline dark:text-text-dark"
                                        title={`Preview ${relative}`}
                                    >
                                        {relative}
                                    </button>
                                ) : (
                                    <span
                                        className="min-w-0 flex-1 truncate text-[11px] text-text dark:text-text-dark"
                                        title={relative}
                                    >
                                        {relative}
                                    </span>
                                )}
                                <span className="shrink-0 text-[10px] tabular-nums text-text-muted/80 dark:text-text-muted-dark/80">
                                    {formatBytes(f.file.size)}
                                </span>
                                {f.error ? (
                                    <RetryButton
                                        label={`Retry upload of ${relative}`}
                                        onClick={() => onRetryFile(f.localId)}
                                        className={ROW_ACTION}
                                    />
                                ) : null}
                                <RemoveButton
                                    label={`Remove ${relative}`}
                                    onClick={() => onRemoveFile(f.localId)}
                                    className={ROW_ACTION}
                                />
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </li>
    );
}

export interface AttachmentStripProps {
    readonly attachments: ReadonlyArray<ComposerAttachment>;
    readonly onRemove: (localId: string) => void;
    readonly onRetry: (localId: string) => void;
    /** Open the preview overlay on an image or readable text document. */
    readonly onPreview: (localId: string) => void;
    readonly testId?: string;
}

export function AttachmentStrip({
    attachments,
    onRemove,
    onRetry,
    onPreview,
    testId,
}: AttachmentStripProps) {
    if (attachments.length === 0) return null;

    // Folder files always live inside their folder card, so the image and
    // document rows only consider standalone picks.
    const loose = attachments.filter((a) => a.kind === 'file');
    const images = loose.filter(isImageAttachment);
    const documents = loose.filter(
        (a): a is ComposerFileAttachment => a.kind === 'file' && !isImageAttachment(a),
    );
    const folders = groupFolderFiles(attachments);
    const repos = attachments.filter((a) => a.kind === 'github-repo');

    return (
        <div
            className="flex flex-col gap-2 px-4 pb-2.5"
            data-testid={testId ? `${testId}-attachments` : undefined}
        >
            {images.length > 0 ? (
                <ul className="flex flex-wrap gap-2.5 pt-1" aria-label="Attached images">
                    {images.map((a) => (
                        <ImageTile
                            key={a.localId}
                            attachment={a}
                            onOpen={() => onPreview(a.localId)}
                            onRemove={() => onRemove(a.localId)}
                            onRetry={() => onRetry(a.localId)}
                            testId={testId}
                        />
                    ))}
                </ul>
            ) : null}

            {documents.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="Attached files">
                    {documents.map((a) => (
                        <FileCard
                            key={a.localId}
                            attachment={a}
                            onOpen={
                                isPreviewableAttachment(a) ? () => onPreview(a.localId) : undefined
                            }
                            onRemove={() => onRemove(a.localId)}
                            onRetry={() => onRetry(a.localId)}
                            testId={testId}
                        />
                    ))}
                </ul>
            ) : null}

            {folders.length > 0 ? (
                <ul className="flex flex-col gap-1.5" aria-label="Attached folders">
                    {folders.map((group) => (
                        <FolderCard
                            key={group.name}
                            group={group}
                            onRemoveFile={onRemove}
                            onRetryFile={onRetry}
                            onOpenFile={onPreview}
                            testId={testId}
                        />
                    ))}
                </ul>
            ) : null}

            {repos.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="Attached repositories">
                    {repos.map((a) => (
                        <li key={a.localId} className="relative">
                            <div className={cn(CARD_BASE, CARD_QUIET)} title={a.url}>
                                <span className={ICON_TILE}>
                                    <Github
                                        className="size-4 text-text-secondary dark:text-text-secondary-dark"
                                        aria-hidden="true"
                                    />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px] font-medium text-text dark:text-text-dark">
                                        {a.displayName}
                                    </span>
                                    <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                        GitHub repository
                                    </span>
                                </span>
                            </div>
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2">
                                <RemoveButton
                                    label={`Remove ${a.displayName}`}
                                    onClick={() => onRemove(a.localId)}
                                    className={ROW_ACTION}
                                />
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
