import { createHash } from 'node:crypto';

/**
 * Knowledge library — the whitespace-insensitive fingerprint of a Knowledge
 * Base document body.
 *
 * A reformat (reflowed paragraphs, changed indentation, trailing newlines,
 * CRLF vs LF) must never tell a reader the document changed. So the
 * comparison input for a substantive body change is the hash of the body
 * with every run of whitespace collapsed to one space.
 *
 * Deliberately nothing more: no Markdown parsing, no case folding. A change
 * to any non-whitespace character is a change. Pure — no I/O, no module
 * state.
 */

const BYTE_ORDER_MARK = '﻿';

/**
 * Normalize a body for comparison: strip a leading byte-order mark, turn
 * CRLF / CR line endings into LF, collapse every whitespace run to a single
 * space, and trim.
 */
export function normalizeBody(body: string | null | undefined): string {
    if (!body) return '';
    let text = body;
    if (text.startsWith(BYTE_ORDER_MARK)) {
        text = text.slice(BYTE_ORDER_MARK.length);
    }
    return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** SHA-256 (hex, 64 chars) of {@link normalizeBody}. */
export function hashNormalizedBody(body: string | null | undefined): string {
    return createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex');
}
