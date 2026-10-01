import { describe, expect, it } from 'vitest';
import {
    EVER_ID_ERROR_CODE_WIRE_VALUES,
    EVER_ID_LIMITS,
    EVER_ID_WIRE_ERROR_CODES,
} from '@ever-works/contracts';
import {
    EVER_ID_ADMIN_SETTINGS_LIMITS,
    EVER_ID_HTTPS_URL_PATTERN,
    EVER_ID_LOCAL_CLIENT_KINDS,
    EVER_ID_RATE_LIMITED,
    EVER_ID_RETURN_TO_MAX_LENGTH,
    everIdCodeFromErrorParam,
    everIdErrorPageHref,
    everIdMessageKey,
    everIdSecurityNoticeHref,
    isEverIdFailureCode,
    toEverIdReturnTo,
    toEverIdSecurityNotice,
    toRetryAfterSeconds,
} from './ever-id';

/**
 * APW-12 — the web's Ever ID vocabulary: the closed set of codes the flow may put
 * in an address, the one mapping from a wire code to its copy, and the return-path
 * rule (spec FR-10, FR-16, ACC-12-12).
 */
describe('everIdMessageKey — wire code → auth.error.everId leaf', () => {
    it.each(Object.entries(EVER_ID_ERROR_CODE_WIRE_VALUES))('maps %s ← %s', (member, wire) => {
        expect(everIdMessageKey(wire)).toBe(member);
    });

    it('names the rate limit, which has no wire code of its own', () => {
        expect(everIdMessageKey(EVER_ID_RATE_LIMITED)).toBe('rateLimited');
    });

    it('refuses anything outside the closed set, so no key is built from input', () => {
        for (const value of [
            '',
            'everIdDisabled',
            'EVER_ID_DISABLED',
            'constructor',
            '__proto__',
        ]) {
            expect(everIdMessageKey(value)).toBeNull();
        }
        expect(everIdMessageKey(null)).toBeNull();
        expect(everIdMessageKey(undefined)).toBeNull();
    });

    it('recognises every wire code as a failure code, and nothing else', () => {
        for (const code of EVER_ID_WIRE_ERROR_CODES) expect(isEverIdFailureCode(code)).toBe(true);
        expect(isEverIdFailureCode('rate_limited')).toBe(true);
        expect(isEverIdFailureCode('connected')).toBe(false);
        expect(isEverIdFailureCode(42)).toBe(false);
    });
});

describe('error destinations carry codes only', () => {
    it('sends a sign-in failure to the auth error page as ever_id_<code>', () => {
        const href = everIdErrorPageHref('subject_linked');
        const url = new URL(href, 'https://app.example');
        expect(url.pathname).toBe('/auth/error');
        expect(url.searchParams.get('error')).toBe('ever_id_subject_linked');
        expect([...url.searchParams.keys()]).toEqual(['error']);
    });

    it('adds the wait for a rate limit, clamped to a sane number', () => {
        const url = new URL(everIdErrorPageHref('rate_limited', 42), 'https://app.example');
        expect(url.searchParams.get('error')).toBe('ever_id_rate_limited');
        expect(url.searchParams.get('retryAfter')).toBe('42');
    });

    it('sends a connect failure (or success) to Settings → Security as ?everId=', () => {
        const failure = new URL(everIdSecurityNoticeHref('reauth_required'), 'https://app.example');
        expect(failure.pathname).toBe('/settings/security');
        expect(failure.searchParams.get('everId')).toBe('reauth_required');

        const success = new URL(everIdSecurityNoticeHref('connected'), 'https://app.example');
        expect(success.searchParams.get('everId')).toBe('connected');
    });

    it('reads the code back from ?error=, and only a known one', () => {
        expect(everIdCodeFromErrorParam('ever_id_transaction_invalid')).toBe('transaction_invalid');
        expect(everIdCodeFromErrorParam('ever_id_rate_limited')).toBe('rate_limited');
        expect(everIdCodeFromErrorParam('ever_id_made_up')).toBeNull();
        expect(everIdCodeFromErrorParam('oauth_callback')).toBeNull();
        expect(everIdCodeFromErrorParam(null)).toBeNull();
    });

    it('reads the Security notice back, and only a known one', () => {
        expect(toEverIdSecurityNotice('connected')).toBe('connected');
        expect(toEverIdSecurityNotice('user_has_issuer')).toBe('user_has_issuer');
        expect(toEverIdSecurityNotice('alice@example.com')).toBeNull();
        expect(toEverIdSecurityNotice(['connected'])).toBeNull();
    });
});

describe('toRetryAfterSeconds', () => {
    it.each([
        ['30', 30],
        [30, 30],
        ['2.4', 2],
        [2.4, 3],
        ['0', 60],
        ['-5', 60],
        ['soon', 60],
        [null, 60],
        [undefined, 60],
        ['999999', 3600],
    ])('%j → %i', (input, expected) => {
        expect(toRetryAfterSeconds(input as string | number | null | undefined)).toBe(expected);
    });
});

describe('toEverIdReturnTo — same-site relative paths only (FR-10, ACC-12-12)', () => {
    it.each(['/', '/works', '/settings/security?tab=a#b', '/org/acme/works/42'])(
        'keeps %s',
        (path) => {
            expect(toEverIdReturnTo(path)).toBe(path);
        },
    );

    it.each([
        'https://evil.example/phish',
        'http://localhost:3000/works',
        '//evil.example',
        '/\\evil.example',
        'javascript:alert(1)',
        'works',
        '',
        '   ',
        '/has space',
        '/<script>',
    ])('refuses %j', (value) => {
        expect(toEverIdReturnTo(value)).toBeUndefined();
    });

    it('refuses a path longer than the cookie budget allows', () => {
        expect(toEverIdReturnTo('/' + 'a'.repeat(EVER_ID_RETURN_TO_MAX_LENGTH - 1))).toBeDefined();
        expect(toEverIdReturnTo('/' + 'a'.repeat(EVER_ID_RETURN_TO_MAX_LENGTH))).toBeUndefined();
    });

    it('refuses anything that is not a string', () => {
        for (const value of [null, undefined, 42, {}, ['/works']]) {
            expect(toEverIdReturnTo(value)).toBeUndefined();
        }
    });
});

describe('administrator settings bounds', () => {
    it('takes the two list sizes from the contract, and mirrors the API for the rest', () => {
        expect(EVER_ID_ADMIN_SETTINGS_LIMITS).toEqual({
            displayNameMaxLength: 40,
            accountManagementUrlMaxLength: 2048,
            localClientsMax: EVER_ID_LIMITS.localClientsMax,
            clientIdMaxLength: 255,
            delegatedClientNamesMax: EVER_ID_LIMITS.delegatedClientNamesMax,
            delegatedDisplayNameMaxLength: 60,
        });
        expect(EVER_ID_ADMIN_SETTINGS_LIMITS.localClientsMax).toBe(5);
        expect(EVER_ID_ADMIN_SETTINGS_LIMITS.delegatedClientNamesMax).toBe(10);
        expect(EVER_ID_LOCAL_CLIENT_KINDS).toEqual(['cli', 'node']);
    });

    it.each([
        ['https://id.example/account', true],
        ['https://id.example', true],
        ['http://id.example/account', false],
        ['https://', false],
        ['https://id.example/my account', false],
        [' https://id.example', false],
        ['javascript:alert(1)', false],
    ])('the account address %j is accepted: %s', (value, accepted) => {
        expect(EVER_ID_HTTPS_URL_PATTERN.test(value)).toBe(accepted);
    });
});
