/**
 * Attachment shapes shared by the PromptComposer and its sub-components.
 *
 * Lives in its own module so `AttachmentStrip` / `AttachmentPreview` can type
 * their props without importing back from `PromptComposer.tsx` (a cycle).
 */

export interface ComposerFileAttachment {
    readonly kind: 'file' | 'folder-file';
    readonly localId: string;
    readonly file: File;
    readonly displayName: string;
    /** 0–100 percent — XHR-driven during upload. */
    progress: number;
    uploading: boolean;
    /** Server-side upload id (sha256 of bytes); the canonical reference callers persist. */
    uploadId?: string;
    /** API-routed serve URL (`/api/uploads/<userId>/<filename>`) once uploaded. */
    url?: string;
    mimeType?: string;
    error?: string;
    /**
     * `URL.createObjectURL(file)` for images only, set at pick time so the
     * thumbnail renders without waiting on the upload. Revoked on removal and
     * on unmount — an un-revoked object URL pins the whole file in memory.
     */
    previewUrl?: string;
}

export interface ComposerGithubAttachment {
    readonly kind: 'github-repo';
    readonly localId: string;
    readonly url: string;
    readonly displayName: string;
}

export type ComposerAttachment = ComposerFileAttachment | ComposerGithubAttachment;

export type ComposerImageAttachment = ComposerFileAttachment & { previewUrl: string };

/** Matches the uploads API's own default cap, so we reject before the wire. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function isImageFile(file: File): boolean {
    return file.type.startsWith('image/');
}

/**
 * Guards on `previewUrl` rather than the MIME type so an image we could not
 * create an object URL for still degrades to a normal file chip.
 */
export function isImageAttachment(a: ComposerAttachment): a is ComposerImageAttachment {
    return a.kind !== 'github-repo' && typeof a.previewUrl === 'string';
}

/** Which glyph a document card shows. Mapped to a lucide icon by the strip. */
export type FileIconKind =
    | 'image'
    | 'pdf'
    | 'text'
    | 'sheet'
    | 'code'
    | 'archive'
    | 'audio'
    | 'video'
    | 'file';

// Extension first, MIME as the fallback: browsers routinely hand us
// `application/octet-stream` (or ``) for .md, .csv and most code files, so
// trusting `file.type` alone would flatten every document to a generic icon.
const EXTENSION_KINDS: ReadonlyArray<readonly [RegExp, FileIconKind]> = [
    [/\.pdf$/i, 'pdf'],
    [/\.(docx?|odt|rtf|txt|md|markdown|pages)$/i, 'text'],
    [/\.(csv|tsv|xlsx?|ods|numbers)$/i, 'sheet'],
    [/\.(zip|tar|gz|tgz|bz2|rar|7z)$/i, 'archive'],
    [
        /\.(json|ya?ml|toml|xml|html?|css|scss|less|tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|bash|zsh|sql|ini|conf|env|log)$/i,
        'code',
    ],
];

export function fileIconKind(name: string, mimeType: string): FileIconKind {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'pdf';
    for (const [pattern, kind] of EXTENSION_KINDS) {
        if (pattern.test(name)) return kind;
    }
    if (mimeType.startsWith('text/')) return 'text';
    return 'file';
}

/** Short type badge for a card's second line — `PDF`, `DOCX`, `PNG`. */
export function fileTypeLabel(name: string, mimeType: string): string {
    const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
    if (extension) return extension.toUpperCase();
    const subtype = mimeType.split('/')[1];
    return subtype ? subtype.split(/[+.;]/)[0].toUpperCase() : 'FILE';
}

const TEXT_EXTENSIONS =
    /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|html?|css|scss|less|tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|bash|zsh|sql|ini|conf|env|log)$/i;

/** How much of a text file we read for the preview pane. */
export const TEXT_PREVIEW_BYTES = 128 * 1024;

/**
 * Whether we can render this file's contents ourselves from the local `File`.
 * PDFs and binaries deliberately return false: the uploads API serves
 * attachments with a non-inline disposition and the app's CSP blocks `blob:`
 * frames, so there is nothing honest to embed.
 */
export function isTextLike(file: File, displayName: string): boolean {
    if (file.type.startsWith('text/')) return true;
    if (file.type === 'application/json') return true;
    return TEXT_EXTENSIONS.test(displayName);
}

/** Entries the preview overlay can open: images plus readable text files. */
export function isPreviewableAttachment(a: ComposerAttachment): a is ComposerFileAttachment {
    if (a.kind === 'github-repo') return false;
    return typeof a.previewUrl === 'string' || isTextLike(a.file, a.displayName);
}

/**
 * A picked folder, reassembled from the flat `FileList` the browser hands back
 * for `webkitdirectory` — one card per folder instead of 40 loose chips.
 */
export interface ComposerFolderGroup {
    readonly name: string;
    readonly files: ReadonlyArray<ComposerFileAttachment>;
    readonly totalBytes: number;
    readonly uploadingCount: number;
    readonly failedCount: number;
    /** Size-weighted aggregate upload progress, 0–100. */
    readonly progress: number;
}

/** Top-level folder segment of a `webkitRelativePath`-derived display name. */
export function folderNameOf(displayName: string): string {
    const slash = displayName.indexOf('/');
    return slash > 0 ? displayName.slice(0, slash) : 'Folder';
}

/** Path of a file relative to its folder card, for the expanded list. */
export function folderRelativePath(displayName: string): string {
    const slash = displayName.indexOf('/');
    return slash > 0 ? displayName.slice(slash + 1) : displayName;
}

export function groupFolderFiles(
    attachments: ReadonlyArray<ComposerAttachment>,
): ReadonlyArray<ComposerFolderGroup> {
    const buckets = new Map<string, ComposerFileAttachment[]>();
    for (const a of attachments) {
        if (a.kind !== 'folder-file') continue;
        const name = folderNameOf(a.displayName);
        const bucket = buckets.get(name);
        if (bucket) bucket.push(a);
        else buckets.set(name, [a]);
    }

    const groups: ComposerFolderGroup[] = [];
    for (const [name, files] of buckets) {
        let totalBytes = 0;
        let totalWeight = 0;
        let weightedProgress = 0;
        let uploadingCount = 0;
        let failedCount = 0;
        for (const f of files) {
            totalBytes += f.file.size;
            // Weight by size so a folder's bar tracks bytes transferred, not
            // file count; floor at 1 so zero-byte files still count as one.
            const weight = Math.max(1, f.file.size);
            totalWeight += weight;
            weightedProgress += weight * (f.error ? 0 : f.uploading ? f.progress : 100);
            if (f.uploading) uploadingCount += 1;
            if (f.error) failedCount += 1;
        }
        groups.push({
            name,
            files,
            totalBytes,
            uploadingCount,
            failedCount,
            progress: Math.round(weightedProgress / totalWeight),
        });
    }
    return groups;
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** exponent;
    return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** The lighter attachment shape that `useStartFromPrompt` accepts. */
export interface ComposerAttachmentRef {
    readonly name: string;
    readonly url: string;
    readonly mimeType?: string;
    readonly kind: 'upload' | 'github-repo';
    /** SHA-256 upload id — present only for completed `kind: 'upload'` refs. */
    readonly uploadId?: string;
}

/**
 * Uploads still in flight, uploads that failed, and entries without a
 * server-side URL are filtered out — only references the chat AI can actually
 * resolve are forwarded.
 */
export function buildAttachmentRefs(
    attachments: ReadonlyArray<ComposerAttachment>,
): ReadonlyArray<ComposerAttachmentRef> {
    const refs: ComposerAttachmentRef[] = [];
    for (const a of attachments) {
        if (a.kind === 'github-repo') {
            refs.push({ name: a.displayName, url: a.url, kind: 'github-repo' });
            continue;
        }
        if (a.url && a.uploadId && !a.uploading && !a.error) {
            refs.push({
                name: a.displayName,
                url: a.url,
                mimeType: a.mimeType,
                kind: 'upload',
                uploadId: a.uploadId,
            });
        }
    }
    return refs;
}
