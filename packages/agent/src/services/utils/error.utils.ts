import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { redactSecrets } from '../../utils/secret-scan';

// Security: upstream API / git error strings flow back to authenticated users
// via `normalizeGeneratorError`. They can carry credentials embedded in URLs
// (`https://user:token@host/…`) or raw secret tokens lifted from a cause chain.
// Redact both BEFORE the string is returned so no caller can leak them.
//
// 1. Userinfo in any `scheme://user:pass@host` URL → `scheme://***:***@host`.
//    A URL scheme (`[a-z][a-z0-9+.-]*`), then a userinfo segment of the form
//    `user:pass@`; ONLY the user:pass is replaced with `***:***`.
//
//    The match starts at `://`, not at the scheme: a pattern that opens with
//    the scheme is retried from every offset of a long run of scheme
//    characters (seconds for 50,000 of them — CodeQL js/polynomial-redos),
//    and the message is upstream text. Whether a scheme precedes the `://` is
//    then read backwards from it: `[a-z][a-z0-9+.-]*` right before `://`
//    exists exactly when the run of scheme characters ending there holds a
//    letter. Runs before distinct `://` never overlap, so the whole pass stays
//    linear, and it redacts exactly the URLs the scheme-first pattern did.
const URL_USERINFO_RE = /:\/\/[^/\s:@]+:[^/\s@]+@/g;
const URL_SCHEME_CHAR_RE = /^[a-z0-9+.-]$/i;
const URL_SCHEME_LETTER_RE = /^[a-z]$/i;

function redactUrlCredentials(message: string): string {
    return message.replace(URL_USERINFO_RE, (userinfo: string, offset: number) => {
        for (let at = offset - 1; at >= 0 && URL_SCHEME_CHAR_RE.test(message[at]); at -= 1) {
            if (URL_SCHEME_LETTER_RE.test(message[at])) return '://***:***@';
        }
        return userinfo;
    });
}

function redactCredentials(message: string): string {
    // Strip credentials embedded in URLs first, then run the shared secret
    // scrubber to catch standalone tokens (ghp_…, sk-…, Bearer …, JWTs, etc.).
    return redactSecrets(redactUrlCredentials(message)).cleaned;
}

function getErrorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        return (error as any).message || (error as any).error || String(error);
    }

    return String(error);
}

function collectErrorMessages(error: unknown): string[] {
    const messages: string[] = [];
    const seen = new Set<object>();
    let current: unknown = error;

    while (current) {
        const message = getErrorMessage(current);
        if (message) {
            messages.push(message);
        }

        if (typeof current !== 'object' || current === null) {
            break;
        }

        if (seen.has(current)) {
            break;
        }

        seen.add(current);
        current = (current as any).cause;
    }

    return [...new Set(messages)];
}

export function rethrowAsNormalized(
    error: unknown,
    logger: Logger,
    context: string,
    extraFields?: Record<string, unknown>,
): never {
    if (error instanceof HttpException) {
        throw error;
    }

    logger.error(`Error ${context}:`, error);

    throw new BadRequestException({
        status: 'error',
        message: normalizeGeneratorError(error),
        ...extraFields,
    });
}

export function normalizeGeneratorError(error: any): string {
    if (!error) {
        return 'Unknown error';
    }

    const messages = collectErrorMessages(error);
    const message = messages[0] || String(error);
    const detailedMessage = messages.join(': ');

    const lowerMessage = detailedMessage.toLowerCase();

    if (lowerMessage.includes('not found')) {
        return 'Repository not found. Please verify the repository exists and try again.';
    }

    if (lowerMessage.includes('enotfound') || lowerMessage.includes('getaddrinfo')) {
        return 'Connection failed. Please check your network and try again.';
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timedout')) {
        return 'Request timed out. Please try again.';
    }

    if (
        lowerMessage.includes('could not read username') ||
        lowerMessage.includes('could not read password') ||
        lowerMessage.includes('no connected account found')
    ) {
        return 'Please reconnect your Git account to continue.';
    }

    // Security: only the raw upstream string falls through here (the canned
    // classification messages above carry no untrusted content). Redact
    // credentials-in-URLs and secret tokens before returning. Which message
    // wins is unchanged — only the chosen string is sanitised.
    return redactCredentials(detailedMessage || message);
}
