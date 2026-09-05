'use client';

import { useState } from 'react';
import { useWorkspaceScope } from '@/lib/hooks/use-workspace-scope';
import { withUploadServeScope } from '@/lib/api/uploads';
import {
    AlertCircle,
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
    type FileIconKind,
} from './attachments';

/**
 * The strip of attached items rendered inside the composer card, above the
 * toolbar. Images, documents, folders and repos all take the same tile shape;
 * only the tile's face and caption differ.
 *
 * A failed upload stays on screen with its error and a retry rather than
 * disappearing — silently dropping it would let someone submit believing the
 * file went along.
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

// One muted hue per family so a stack of documents is scannable.
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

// Fixed on both axes — a tile that grew with its label would break the row
// into ragged bands.
const ITEM = 'group relative w-16 shrink-0';
const TILE_BASE =
    'relative flex size-16 items-center justify-center overflow-hidden rounded-xl border transition-[transform,box-shadow,border-color] duration-150';
const TILE_QUIET =
    'border-border/60 bg-foreground/[0.03] dark:border-white/10 dark:bg-white/[0.04]';
const TILE_ERROR = 'border-danger/50 bg-danger/[0.06]';
const TILE_INTERACTIVE =
    'hover:-translate-y-0.5 hover:shadow-md hover:border-border-secondary dark:hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/40';
const BADGE =
    'absolute rounded-full border border-border/60 bg-background p-1 text-text-muted shadow-sm transition-colors hover:text-text dark:border-white/15 dark:bg-zinc-900 dark:text-text-muted-dark dark:hover:text-text-dark';
const ROW_ACTION =
    'shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-foreground/10 hover:text-text dark:text-text-muted-dark dark:hover:bg-white/10 dark:hover:text-text-dark';
// Quiet until hover on pointer devices so the strip stays calm, but always
// reachable by keyboard and on touch.
const BADGE_REVEAL =
    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100';

function stateTagOf(a: ComposerFileAttachment): string {
    if (a.error) return 'error';
    return a.uploading ? 'uploading' : 'ready';
}

function Caption({ name, meta }: { readonly name: string; readonly meta: string }) {
    return (
        <span className="mt-1 block w-16">
            <span className="block truncate text-[11px] font-medium leading-tight text-text dark:text-text-dark">
                {name}
            </span>
            <span className="block truncate text-[10px] leading-tight text-text-muted dark:text-text-muted-dark">
                {meta}
            </span>
        </span>
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

function TileFace({ attachment }: { readonly attachment: ComposerFileAttachment }) {
    const { displayName, uploading, progress, error, file } = attachment;
    const kind = fileIconKind(displayName, file.type);
    const Icon = KIND_ICONS[kind];
    const thumbnail = isImageAttachment(attachment) ? attachment.previewUrl : undefined;

    return (
        <>
            {thumbnail ? (
                /* eslint-disable-next-line @next/next/no-img-element --
                   local `blob:` object URL for a just-picked file; nothing for
                   next/image to optimize or allowlist. */
                <img
                    src={thumbnail}
                    alt=""
                    decoding="async"
                    className={cn('size-full object-cover', (uploading || error) && 'blur-[1px]')}
                />
            ) : (
                <Icon className={cn('size-6', KIND_TINTS[kind])} aria-hidden="true" />
            )}

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
        </>
    );
}

function FileTile({
    attachment,
    onOpen,
    onRemove,
    onRetry,
    testId,
}: {
    readonly attachment: ComposerFileAttachment;
    /** Set when the file can be previewed in-app (image / text / code / CSV). */
    readonly onOpen?: () => void;
    readonly onRemove: () => void;
    readonly onRetry: () => void;
    readonly testId?: string;
}) {
    const { displayName, uploading, progress, error, file } = attachment;
    const label = fileTypeLabel(displayName, file.type);
    const meta = error
        ? error
        : uploading
          ? `${progress}% · ${label}`
          : `${label} · ${formatBytes(file.size)}`;
    const tileClass = cn(TILE_BASE, error ? TILE_ERROR : TILE_QUIET, onOpen && TILE_INTERACTIVE);
    // Only once the upload resolves — before that there is no URL to point at.
    // The download anchor is a navigation, so the tab's workspace rides on the href.
    const workspace = useWorkspaceScope();
    const downloadHref =
        !onOpen && !error && !uploading
            ? withUploadServeScope(attachment.url, workspace)
            : undefined;

    return (
        <li
            className={ITEM}
            data-testid={testId ? `${testId}-attachment-${stateTagOf(attachment)}` : undefined}
        >
            {/* Element type comes from the file, never from upload state, so the
                tile never remounts (or loses focus) when an upload lands. */}
            {onOpen ? (
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={`Preview ${displayName}`}
                    title={
                        error
                            ? `${displayName} — ${error}`
                            : `${displayName} · ${formatBytes(file.size)}`
                    }
                    className={tileClass}
                >
                    <TileFace attachment={attachment} />
                </button>
            ) : (
                <span
                    className={tileClass}
                    title={error ? `${displayName} — ${error}` : displayName}
                >
                    <TileFace attachment={attachment} />
                </span>
            )}

            <Caption name={displayName} meta={meta} />

            {/* Outside the tile button so a badge click never also opens the preview. */}
            {error ? (
                <RetryButton
                    label={`Retry upload of ${displayName}`}
                    onClick={onRetry}
                    className={cn(BADGE, '-bottom-1 -left-1')}
                />
            ) : null}

            {downloadHref ? (
                <a
                    href={downloadHref}
                    download={displayName}
                    aria-label={`Download ${displayName}`}
                    title="Download"
                    className={cn(BADGE, '-bottom-1 -right-1', BADGE_REVEAL)}
                >
                    <Download className="size-3" aria-hidden="true" />
                </a>
            ) : null}

            <RemoveButton
                label={`Remove ${displayName}`}
                onClick={onRemove}
                className={cn(BADGE, '-right-1.5 -top-1.5', BADGE_REVEAL)}
            />
        </li>
    );
}

function FolderTile({
    group,
    expanded,
    onToggle,
    onRemoveFolder,
    testId,
}: {
    readonly group: ComposerFolderGroup;
    readonly expanded: boolean;
    readonly onToggle: () => void;
    readonly onRemoveFolder: () => void;
    readonly testId?: string;
}) {
    const { name, files, totalBytes, uploadingCount, failedCount, progress } = group;
    const count = files.length;

    const meta =
        failedCount > 0
            ? `${failedCount} of ${count} failed`
            : uploadingCount > 0
              ? `${progress}% · ${count} files`
              : `${count} file${count === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`;

    return (
        <li className={ITEM} data-testid={testId ? `${testId}-attachment-folder` : undefined}>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${name}`}
                title={`${name} — click to ${expanded ? 'collapse' : 'expand'}`}
                className={cn(
                    TILE_BASE,
                    failedCount > 0 ? TILE_ERROR : TILE_QUIET,
                    TILE_INTERACTIVE,
                    expanded && 'border-border-secondary dark:border-white/25',
                )}
            >
                <Folder
                    className="size-6 text-text-secondary dark:text-text-secondary-dark"
                    aria-hidden="true"
                />
                <span className="absolute bottom-1 right-1 rounded px-1 text-[10px] font-medium tabular-nums text-text-muted dark:text-text-muted-dark">
                    {count}
                </span>

                {uploadingCount > 0 ? (
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/45 text-white">
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        <span className="text-[10px] font-medium tabular-nums">{progress}%</span>
                    </span>
                ) : failedCount > 0 ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-danger/25 text-danger">
                        <AlertCircle className="size-4" aria-hidden="true" />
                    </span>
                ) : null}
            </button>

            <Caption name={name} meta={meta} />

            <RemoveButton
                label={`Remove folder ${name}`}
                onClick={onRemoveFolder}
                className={cn(BADGE, '-right-1.5 -top-1.5', BADGE_REVEAL)}
            />
        </li>
    );
}

function RepoTile({
    attachment,
    onRemove,
}: {
    readonly attachment: Extract<ComposerAttachment, { kind: 'github-repo' }>;
    readonly onRemove: () => void;
}) {
    const { displayName, url } = attachment;
    return (
        <li className={ITEM}>
            <span className={cn(TILE_BASE, TILE_QUIET)} title={url}>
                <Github
                    className="size-6 text-text-secondary dark:text-text-secondary-dark"
                    aria-hidden="true"
                />
            </span>
            <Caption name={displayName} meta="GitHub repo" />
            <RemoveButton
                label={`Remove ${displayName}`}
                onClick={onRemove}
                className={cn(BADGE, '-right-1.5 -top-1.5', BADGE_REVEAL)}
            />
        </li>
    );
}

/**
 * Rendered under the tile row rather than inside the tile, so expanding a
 * folder never resizes a tile or reflows the row around it.
 */
function FolderFileList({
    group,
    onRemoveFile,
    onRetryFile,
    onOpenFile,
}: {
    readonly group: ComposerFolderGroup;
    readonly onRemoveFile: (localId: string) => void;
    readonly onRetryFile: (localId: string) => void;
    readonly onOpenFile: (localId: string) => void;
}) {
    return (
        <div className="rounded-lg border border-border/40 bg-foreground/[0.02] p-1 dark:border-white/[0.07] dark:bg-white/[0.02]">
            <p className="px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                {group.name}
            </p>
            <ul className="flex flex-col gap-px" aria-label={`Files in ${group.name}`}>
                {group.files.map((f) => {
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
        </div>
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
    // Held here rather than in the tile because the file list renders outside the row.
    const [expandedFolder, setExpandedFolder] = useState<string | null>(null);

    if (attachments.length === 0) return null;

    const loose = attachments.filter((a): a is ComposerFileAttachment => a.kind === 'file');
    const folders = groupFolderFiles(attachments);
    const repos = attachments.filter(
        (a): a is Extract<ComposerAttachment, { kind: 'github-repo' }> => a.kind === 'github-repo',
    );
    const openFolder = folders.find((g) => g.name === expandedFolder);

    return (
        <div
            className="flex flex-col gap-2 px-4 pb-2.5 pt-1"
            data-testid={testId ? `${testId}-attachments` : undefined}
        >
            <ul className="flex flex-wrap items-start gap-3" aria-label="Attachments">
                {loose.map((a) => (
                    <FileTile
                        key={a.localId}
                        attachment={a}
                        onOpen={isPreviewableAttachment(a) ? () => onPreview(a.localId) : undefined}
                        onRemove={() => onRemove(a.localId)}
                        onRetry={() => onRetry(a.localId)}
                        testId={testId}
                    />
                ))}

                {folders.map((group) => (
                    <FolderTile
                        key={group.name}
                        group={group}
                        expanded={group.name === expandedFolder}
                        onToggle={() =>
                            setExpandedFolder((cur) => (cur === group.name ? null : group.name))
                        }
                        onRemoveFolder={() => group.files.forEach((f) => onRemove(f.localId))}
                        testId={testId}
                    />
                ))}

                {repos.map((a) => (
                    <RepoTile key={a.localId} attachment={a} onRemove={() => onRemove(a.localId)} />
                ))}
            </ul>

            {openFolder ? (
                <FolderFileList
                    group={openFolder}
                    onRemoveFile={onRemove}
                    onRetryFile={onRetry}
                    onOpenFile={onPreview}
                />
            ) : null}
        </div>
    );
}
