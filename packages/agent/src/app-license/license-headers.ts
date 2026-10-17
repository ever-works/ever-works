/**
 * APW-03 T41 (FR-54) — licence header scanning, pure.
 *
 * Reads only the first {@link LICENSE_HEADER_SCAN_BYTES} (2 KiB) of each file — the
 * header, where `SPDX-License-Identifier:` and `@license` tags live — and answers the
 * SPDX expressions it finds. No I/O: APW-04 and APW-05 call it on files already in
 * their checkouts, and the licence service calls it on files it already read.
 *
 * An expression is kept only when `parseSpdxExpression` accepts it (or it is a
 * `LicenseRef-*` id), so a stray `@license see LICENSE` comment never becomes a
 * classification input.
 */
import { LICENSE_HEADER_SCAN_BYTES } from '@ever-works/contracts';
import { parseSpdxExpression } from './spdx-expression';

/** One finding: the file it came from and the expression it declares. */
export interface LicenseHeaderFinding {
    readonly path: string;
    readonly spdx: string;
}

// Linear patterns: the rest of the line is captured whole and cut by `cutExpression`
// (a lazy group followed by `\s*` and an alternation backtracks polynomially).
const SPDX_TAG = /SPDX-License-Identifier:([^\r\n]*)/gi;
const LICENSE_TAG = /@license[ \t]([^\r\n]*)/gi;

/** The expression part of a tag's line: up to a comment close (`*`, `-->`, `#}`), trimmed. */
function cutExpression(rest: string): string {
    let end = rest.length;
    for (const stop of ['*', '-->', '#}']) {
        const at = rest.indexOf(stop);
        if (at !== -1 && at < end) {
            end = at;
        }
    }
    return rest.slice(0, end).trim();
}

/** The first 2 KiB of a text, by UTF-8 bytes, never splitting a character. */
export function licenseHeadOf(text: string): string {
    if (typeof text !== 'string' || text === '') {
        return '';
    }
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= LICENSE_HEADER_SCAN_BYTES) {
        return text;
    }
    // `toString` replaces a cut trailing sequence with U+FFFD; drop it.
    return trimTrailing(bytes.subarray(0, LICENSE_HEADER_SCAN_BYTES).toString('utf8'), '�');
}

/** Drop trailing characters from `chars` — a linear loop, not an end-anchored regex. */
function trimTrailing(value: string, chars: string): string {
    let end = value.length;
    while (end > 0 && chars.includes(value[end - 1])) {
        end -= 1;
    }
    return value.slice(0, end);
}

function acceptable(expression: string): boolean {
    const trimmed = expression.trim();
    if (trimmed === '' || trimmed.length > 200) {
        return false;
    }
    if (/^LicenseRef-[A-Za-z0-9.-]+$/.test(trimmed)) {
        return true;
    }
    return parseSpdxExpression(trimmed) !== null;
}

/**
 * The SPDX expressions one file's header declares, de-duplicated in order of
 * appearance. Only the first 2 KiB of `text` is read.
 */
export function scanLicenseHeaderText(text: string): string[] {
    const head = licenseHeadOf(text);
    if (head === '') {
        return [];
    }
    const found: string[] = [];
    const seen = new Set<string>();
    for (const pattern of [SPDX_TAG, LICENSE_TAG]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(head)) !== null) {
            const expression = trimTrailing(cutExpression(match[1]), ';,');
            const key = expression.toLowerCase();
            if (!seen.has(key) && acceptable(expression)) {
                seen.add(key);
                found.push(expression);
            }
        }
    }
    return found;
}

/**
 * Plan §2.6's `scanLicenseHeaders(files: { path, head }[])` — every finding across the
 * files, one per (path, expression). `head` may be the whole file; only its first
 * 2 KiB is read.
 */
export function scanLicenseHeaders(
    files: ReadonlyArray<{ path: string; head: string }>,
): LicenseHeaderFinding[] {
    const findings: LicenseHeaderFinding[] = [];
    for (const file of files ?? []) {
        if (!file || typeof file.path !== 'string') continue;
        for (const spdx of scanLicenseHeaderText(file.head)) {
            findings.push({ path: file.path, spdx });
        }
    }
    return findings;
}
