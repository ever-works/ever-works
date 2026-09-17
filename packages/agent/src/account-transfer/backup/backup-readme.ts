import { BACKUP_DOMAINS, type BackupManifest } from '@ever-works/contracts';

/**
 * Workspace backup (AW-22) — the `README.md` inside every archive.
 *
 * Someone who unzips this file two years from now has our manifest and no
 * context. This page is the context: what the archive is, when it was taken,
 * what each folder holds, what is deliberately absent, what can be put back,
 * and how long our own copy lasted.
 *
 * Deliberately English-only and deliberately short (under 400 words, spec
 * FR-26). It is a file inside the archive, not interface copy: the card and
 * the coverage drawer render their own translated strings. Keeping it plain
 * is the point — a reference nobody finishes reading answers nothing.
 */

export interface BuildBackupReadmeInput {
    readonly manifest: BackupManifest;
    /** Retention in force at the time the archive was produced (spec FR-28, FR-47). */
    readonly retentionDays: number;
    /** Where the published field reference lives. */
    readonly formatReferenceUrl: string;
}

export function buildReadme(input: BuildBackupReadmeInput): string {
    const { manifest } = input;
    const restorable = BACKUP_DOMAINS.filter((domain) => domain.restorability === 'restorable');
    const recordOnly = BACKUP_DOMAINS.filter((domain) => domain.restorability === 'record-only');
    const partly = BACKUP_DOMAINS.filter((domain) => domain.restorability === 'partly-restorable');
    const names = (keys: ReadonlyArray<{ key: string }>) =>
        keys.map((entry) => entry.key).join(', ');

    const omitted = manifest.files.omitted.length;
    const omittedLine =
        omitted > 0
            ? `${omitted} uploaded file(s) were too large to carry and are listed in \`manifest.json\` with the reason \`size_limit\`. Their metadata rows are still here, so you can fetch them individually.`
            : 'Every uploaded file that had bytes is included under `files/`.';

    return `# Your Ever Works workspace backup

This is a complete copy of the workspace **${manifest.workspace.displayName}**, taken on
${manifest.producedAt} by ${manifest.account.displayName} (${manifest.account.email}).
Archive format ${manifest.formatVersion}, written by build ${manifest.producedBy.build}.

## What is in here

- \`manifest.json\` — what this archive contains, section by section: record counts, what was
  trimmed and from when, which files were left out, and what a restore could recreate. Every
  count in it matches the number of lines in the file it describes.
- \`data/\` — one folder per section, holding newline-delimited JSON. One line is one record.
  Files are UTF-8 with LF line endings and are sorted oldest first, so two backups of unchanged
  data differ only in their timestamps.
- \`files/\` — the actual bytes of your uploaded documents and attachments, at
  \`files/<id>/<original filename>\`. ${omittedLine}
- \`checksums.txt\` — a SHA-256 for every other file in this archive. Verify it with
  \`sha256sum -c checksums.txt\`.

## What is deliberately not in here

${manifest.exclusions.map((exclusion) => `- ${exclusion.summary}`).join('\n')}

This file is **not encrypted**. It holds your workspace's content, though never your passwords,
API keys or connection credentials.

## What can be put back

- Recreated by a restore: ${names(restorable)}.
- Partly recreated: ${names(partly)} — settings and addresses come back, message history and
  machine inventory stay a record.
- Kept as a record only: ${names(recordOnly)}. Runs, decisions, money and history describe
  something that happened in this workspace; restoring them elsewhere would invent a past.

## How long our copy lasted

We kept our copy of this archive for ${input.retentionDays} days after it was produced, then
deleted it. The copy you are reading is yours and has no expiry.

Field reference: ${input.formatReferenceUrl}
`;
}

/** Word count as the spec FR-26 ceiling measures it. */
export function countReadmeWords(readme: string): number {
    return readme.split(/\s+/).filter(Boolean).length;
}
