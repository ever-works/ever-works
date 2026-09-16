import * as yaml from 'yaml';

/** What a single-document Markdown export needs to know about the document. */
export interface KbMarkdownExportInput {
    title: string;
    slug: string;
    description?: string | null;
    class: string;
    tags?: string[] | null;
    status: string;
    source: string;
    workName?: string | null;
    folderPath?: string | null;
    revision: number;
    revisionAt?: Date | null;
    createdAt: Date;
    body: string;
}

/**
 * Knowledge library — render one Knowledge Base document as a standalone
 * Markdown file: YAML front matter carrying the document's metadata, then
 * the body exactly as stored.
 *
 * The file is meant to be handed to someone outside the workspace, so the
 * front matter carries human-meaningful values (the Work's name, the folder
 * path) rather than internal ids. Keys with no value are omitted rather
 * than written as `null`. Pure — no I/O.
 */
export function renderKbMarkdownExport(doc: KbMarkdownExportInput): {
    filename: string;
    content: string;
} {
    const frontMatter: Record<string, unknown> = {
        title: doc.title,
        slug: doc.slug,
        class: doc.class,
    };
    if (doc.description) frontMatter.description = doc.description;
    if (doc.tags && doc.tags.length > 0) frontMatter.tags = [...doc.tags];
    frontMatter.status = doc.status;
    frontMatter.source = doc.source;
    if (doc.workName) frontMatter.work = doc.workName;
    if (doc.folderPath) frontMatter.folder = doc.folderPath;
    frontMatter.revision = doc.revision;
    if (doc.revisionAt) frontMatter.changed = doc.revisionAt.toISOString();
    frontMatter.created = doc.createdAt.toISOString();

    const header = yaml.stringify(frontMatter).trimEnd();
    const body = doc.body.endsWith('\n') ? doc.body : `${doc.body}\n`;
    return {
        filename: `${safeSlug(doc.slug)}.md`,
        content: `---\n${header}\n---\n\n${body}`,
    };
}

/** A filename-safe slug: anything outside `[A-Za-z0-9._-]` becomes `-`. */
function safeSlug(slug: string): string {
    const cleaned = slug.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 200) : 'document';
}
