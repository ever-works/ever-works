import { ALLOWED_REDIRECT_URLS } from '../constants';

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

/**
 * Checks if a redirect URL is allowed based on configured host
 */
function isRedirectAllowedWithSession(redirectUrl: string) {
    if (!redirectUrl || redirectUrl.startsWith('/') || !redirectUrl.includes('://')) {
        return false;
    }

    try {
        const url = new URL(redirectUrl);
        const hostname = url.hostname;

        // Check if the hostname is in the allowed list
        return ALLOWED_REDIRECT_URLS.some((allowed) => {
            const cleanAllowed = allowed
                .replace(/^https?:\/\//, '')
                .toLowerCase()
                .trim();

            const cleanHostname = hostname.toLowerCase();

            // Check if it's a wildcard subdomain pattern (e.g., *.example.com)
            if (cleanAllowed.startsWith('*.')) {
                const domain = cleanAllowed.slice(2);
                // Match any subdomain but NOT the domain itself
                // sub.example.com matches *.example.com
                // example.com does NOT match *.example.com
                return cleanHostname !== domain && cleanHostname.endsWith('.' + domain);
            }

            // Strict exact match only (no implicit subdomain matching)
            // example.com matches ONLY example.com, NOT sub.example.com
            return cleanHostname === cleanAllowed;
        });
    } catch (e) {
        return true;
    }
}

/**
 * Alternative implementation using a more flexible approach
 */
export function addSessionTokenToUrl(redirectUrl: string, sessionToken?: string) {
    if (!redirectUrl || !sessionToken || !isRedirectAllowedWithSession(redirectUrl)) {
        return redirectUrl;
    }

    const isFullUrl = /^https?:\/\//i.test(redirectUrl);

    if (isFullUrl) {
        const url = new URL(redirectUrl);
        url.searchParams.set('sessionToken', sessionToken);
        return url.toString();
    } else {
        const separator = redirectUrl.includes('?') ? '&' : '?';
        return `${redirectUrl}${separator}sessionToken=${encodeURIComponent(sessionToken)}`;
    }
}
