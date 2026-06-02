/**
 * Shared helper for browser-side file downloads with proper loading + error
 * UX. Replaces the brittle `window.location.href = url` pattern: that variant
 * gives the user zero feedback while the server is doing work (cloning a
 * data repo or serialising items can take several seconds for large
 * directories) and surfaces server errors as a raw JSON error page.
 *
 * With `fetch` we can:
 *   - keep the trigger button in a spinner state until the response starts
 *   - parse upstream error payloads and surface them as toasts
 *   - reject if the response isn't OK so callers can show a friendly error
 *
 * The downloaded file is delivered through a transient `<a download>` so the
 * browser's native save dialog still kicks in. We honor the upstream
 * `Content-Disposition` filename when present, falling back to a fallback
 * derived from the URL otherwise.
 */
export async function downloadFromUrl(url: string): Promise<void> {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        let message = `Server responded ${response.status}`;
        try {
            const parsed = JSON.parse(detail) as { message?: unknown };
            if (typeof parsed.message === 'string') {
                message = parsed.message;
            }
        } catch {
            // Non-JSON body — keep the status-only message.
        }
        throw new Error(message);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filenameFromDispositionOrUrl(
            response.headers.get('Content-Disposition'),
            url,
        );
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

// Security: strip path separators, null bytes, and non-printable control characters from
// Content-Disposition filenames before they are used as the `download` attribute value.
// Limits the result to 255 characters to match common filesystem constraints.
function sanitizeFilename(name: string): string {
    return name.replace(/[/\\?\x00-\x1f]/g, '_').slice(0, 255) || 'download';
}

function filenameFromDispositionOrUrl(disposition: string | null, url: string): string {
    if (disposition) {
        const match = /filename\*?=(?:UTF-8'')?(?:"([^"]+)"|([^;\s]+))/i.exec(disposition);
        const captured = match?.[1] ?? match?.[2];
        if (captured) {
            // Security: sanitize after URI-decoding to prevent path traversal or
            // control-character injection via a crafted Content-Disposition header.
            return sanitizeFilename(decodeURIComponent(captured));
        }
    }
    // Strip the query string and take the last path segment.
    const path = url.split('?')[0];
    const last = path.substring(path.lastIndexOf('/') + 1) || 'download';
    // Security: sanitize the URL-derived fallback name as well.
    return sanitizeFilename(last);
}
