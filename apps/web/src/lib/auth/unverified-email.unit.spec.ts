import { describe, expect, it } from 'vitest';
import {
    VERIFY_EMAIL_PARAM,
    VERIFY_EMAIL_REQUIRED,
    isEmailUnconfirmed,
    withUnverifiedEmailNotice,
} from './unverified-email';

describe('isEmailUnconfirmed', () => {
    it('is true only for an explicit false', () => {
        expect(isEmailUnconfirmed({ emailVerified: false })).toBe(true);
    });

    it('is false for a confirmed address', () => {
        expect(isEmailUnconfirmed({ emailVerified: true })).toBe(false);
    });

    it('is false when the API simply omits the field', () => {
        // A missing field is not evidence of anything. Treating `undefined` as
        // unverified would show the lock-out warning to every user the moment
        // the field is dropped from a payload.
        expect(isEmailUnconfirmed({})).toBe(false);
        expect(isEmailUnconfirmed(undefined)).toBe(false);
        expect(isEmailUnconfirmed(null)).toBe(false);
    });
});

describe('withUnverifiedEmailNotice', () => {
    it('tags a bare in-app path', () => {
        expect(withUnverifiedEmailNotice('/')).toBe(
            `/?${VERIFY_EMAIL_PARAM}=${VERIFY_EMAIL_REQUIRED}`,
        );
    });

    it('preserves query params that are already there', () => {
        // `register` appends `?newUser=true`, and the welcome toast depends on
        // it surviving.
        const out = withUnverifiedEmailNotice('/?newUser=true');
        const params = new URL(out, 'https://x.invalid').searchParams;
        expect(params.get('newUser')).toBe('true');
        expect(params.get(VERIFY_EMAIL_PARAM)).toBe(VERIFY_EMAIL_REQUIRED);
    });

    it('preserves a fragment', () => {
        expect(withUnverifiedEmailNotice('/works/42#tab')).toBe(
            `/works/42?${VERIFY_EMAIL_PARAM}=${VERIFY_EMAIL_REQUIRED}#tab`,
        );
    });

    it('leaves an absolute destination untouched', () => {
        // An allowlisted external host has no idea what this param means, so
        // decorating its URL would only leak an internal flag off-site.
        const external = 'https://docs.ever.works/guide?a=1';
        expect(withUnverifiedEmailNotice(external)).toBe(external);
    });

    it('is idempotent', () => {
        const once = withUnverifiedEmailNotice('/');
        expect(withUnverifiedEmailNotice(once)).toBe(once);
    });
});
