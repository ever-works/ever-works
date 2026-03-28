export function isValidRedirectUrl(url: string | undefined): boolean {
    if (!url || typeof url !== 'string') {
        return false;
    }

    url = url.trim();

    if (url.startsWith('/')) {
        // Basic validation for relative URLs
        const relativeUrlRegex = /^\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;
        return relativeUrlRegex.test(url);
    }

    // Comprehensive URL regex pattern for absolute URLs
    const urlRegex =
        /^https?:\/\/(([a-zA-Z0-9\-._~]+(?:\.[a-zA-Z0-9\-._~]+)*)|(\[[0-9a-fA-F:]+\]))(?::([0-9]+))?(\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?$/;

    if (!urlRegex.test(url)) {
        return false;
    }

    // Additional security checks for dangerous protocols
    const suspiciousPatterns = [/javascript:/i, /data:/i, /vbscript:/i, /file:/i, /ftp:/i];

    if (suspiciousPatterns.some((pattern) => pattern.test(url))) {
        return false;
    }

    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}
