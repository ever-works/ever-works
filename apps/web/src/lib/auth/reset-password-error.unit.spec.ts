import { describe, expect, it } from 'vitest';
import {
    classifyResetPasswordError,
    resetLinkIsDead,
    type ResetPasswordFailureReason,
} from './reset-password-error';

/**
 * EW-082 — every reset-password submit failure used to render one bare
 * "Failed to reset password", whether the link had expired, had already been
 * used, or the API had simply fallen over. Those three need opposite
 * responses from the user, so the classification is pinned here.
 *
 * The inputs below are the errors `serverFetch` actually constructs from what
 * the API actually sends (`ApiResponseError` carries `message` + `statusCode`,
 * and apps/api throws `BadRequestException('Reset token expired')` /
 * `BadRequestException('Invalid reset token')`).
 */

/** Mirrors `ApiResponseError` from lib/api/server-api without importing 'server-only'. */
function apiError(message: string, statusCode: number): Error {
    const err = new Error(message) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
}

describe('classifyResetPasswordError', () => {
    it('an EXPIRED token is reported as expired, not as a generic failure', () => {
        expect(classifyResetPasswordError(apiError('Reset token expired', 400))).toBe(
            'expiredToken',
        );
    });

    it('an INVALID / already-consumed token is reported as invalid', () => {
        // The API clears the token column on a successful reset, so a second
        // submit of the same link produces exactly this error. "Already used"
        // and "never valid" are indistinguishable upstream — hence one branch.
        expect(classifyResetPasswordError(apiError('Invalid reset token', 400))).toBe(
            'invalidToken',
        );
    });

    it('a THROTTLED submit (429) is reported as rate-limited, not as a dead link', () => {
        // Critical distinction: a 429 never reached the service, so the token
        // is untouched and waiting a minute really does fix it. Telling this
        // user their link is dead would send them to request a new one for no
        // reason — and straight back into the same throttle.
        expect(classifyResetPasswordError(apiError('ThrottlerException', 429))).toBe('rateLimited');
    });

    it('a SERVER error is reported as upstream, not as a dead link', () => {
        expect(classifyResetPasswordError(apiError('Internal server error', 500))).toBe('upstream');
        expect(classifyResetPasswordError(apiError('Bad gateway', 502))).toBe('upstream');
    });

    it('an unrecognised 400 falls back to the generic message rather than guessing', () => {
        // Reported vaguely, never wrongly: a future 400 on this route must not
        // start claiming the link expired.
        expect(classifyResetPasswordError(apiError('Password must be at least 8 chars', 400))).toBe(
            'failed',
        );
    });

    it('does not mistake an unrelated message for a token error', () => {
        expect(classifyResetPasswordError(apiError('Account suspended', 403))).toBe('failed');
    });

    it('handles a bare Error with no statusCode (network / fetch failure)', () => {
        // No status at all: still classify on wording, since `serverFetch` can
        // surface the API's message without a status in some failure paths.
        expect(classifyResetPasswordError(new Error('Reset token expired'))).toBe('expiredToken');
        expect(classifyResetPasswordError(new Error('fetch failed'))).toBe('failed');
    });

    it('handles null / undefined / non-Error throws without crashing', () => {
        expect(classifyResetPasswordError(null)).toBe('failed');
        expect(classifyResetPasswordError(undefined)).toBe('failed');
        expect(classifyResetPasswordError('some string')).toBe('failed');
    });

    it('the four distinguishable failures really are four DIFFERENT answers', () => {
        // The defect was that all of these collapsed into one string. This
        // asserts the collapse cannot come back: if someone reverts the
        // classifier to a constant, the Set shrinks and this fails.
        const reasons = [
            classifyResetPasswordError(apiError('Reset token expired', 400)),
            classifyResetPasswordError(apiError('Invalid reset token', 400)),
            classifyResetPasswordError(apiError('ThrottlerException', 429)),
            classifyResetPasswordError(apiError('Internal server error', 500)),
        ];
        expect(new Set(reasons).size).toBe(4);
    });
});

describe('resetLinkIsDead', () => {
    it('is true for exactly the reasons a NEW link fixes', () => {
        expect(resetLinkIsDead('expiredToken')).toBe(true);
        expect(resetLinkIsDead('invalidToken')).toBe(true);
    });

    it('is false where retrying the SAME link is the right advice', () => {
        // Offering "request a new link" here would be actively misleading —
        // the link is fine.
        expect(resetLinkIsDead('rateLimited')).toBe(false);
        expect(resetLinkIsDead('upstream')).toBe(false);
        expect(resetLinkIsDead('failed')).toBe(false);
    });

    it('covers every declared reason', () => {
        const all: ResetPasswordFailureReason[] = [
            'expiredToken',
            'invalidToken',
            'rateLimited',
            'upstream',
            'failed',
        ];
        expect(all.filter(resetLinkIsDead)).toEqual(['expiredToken', 'invalidToken']);
    });
});
