import { redactBody, redactHeaders, redactString } from '../redaction';

describe('redactHeaders', () => {
    it('replaces sensitive header values with [REDACTED]', () => {
        const out = redactHeaders({
            'X-GitHub-Token': 'ghp_aaaaaaaaaaa',
            authorization: 'Bearer xxx',
            'X-Hub-Signature-256': 'sha256=abc',
            'content-type': 'application/json',
        });
        expect(out['X-GitHub-Token']).toBe('[REDACTED]');
        expect(out['authorization']).toBe('[REDACTED]');
        expect(out['X-Hub-Signature-256']).toBe('[REDACTED]');
        expect(out['content-type']).toBe('application/json');
    });

    it('handles undefined input', () => {
        expect(redactHeaders(undefined)).toEqual({});
    });

    it('preserves undefined header values', () => {
        const out = redactHeaders({ 'x-foo': undefined });
        expect(out['x-foo']).toBeUndefined();
    });
});

describe('redactBody', () => {
    it('replaces sensitive top-level fields', () => {
        const out = redactBody({ token: 'xxx', repo: 'foo', agentPayment: { wallet: 'abc' } }) as Record<
            string,
            unknown
        >;
        expect(out.token).toBe('[REDACTED]');
        expect(out.agentPayment).toBe('[REDACTED]');
        expect(out.repo).toBe('foo');
    });

    it('recurses into nested objects', () => {
        const out = redactBody({
            outer: {
                inner: { secret: 'hush', nested: { password: 'p' } },
                visible: 'v',
            },
        }) as Record<string, any>;
        expect(out.outer.inner.secret).toBe('[REDACTED]');
        expect(out.outer.inner.nested.password).toBe('[REDACTED]');
        expect(out.outer.visible).toBe('v');
    });

    it('handles arrays', () => {
        const out = redactBody([{ token: 'a' }, { token: 'b' }]) as Array<Record<string, string>>;
        expect(out[0].token).toBe('[REDACTED]');
        expect(out[1].token).toBe('[REDACTED]');
    });

    it('returns primitives unchanged', () => {
        expect(redactBody(42)).toBe(42);
        expect(redactBody('hello')).toBe('hello');
        expect(redactBody(null)).toBeNull();
        expect(redactBody(undefined)).toBeUndefined();
    });
});

describe('redactString', () => {
    it('replaces every occurrence of each secret', () => {
        expect(redactString('token=abcd1234 retry token=abcd1234', ['abcd1234'])).toBe(
            'token=[REDACTED] retry token=[REDACTED]',
        );
    });

    it('skips secrets shorter than 4 chars to avoid false matches', () => {
        expect(redactString('foo bar baz', ['ab'])).toBe('foo bar baz');
    });

    it('returns the input unchanged when no secrets match', () => {
        expect(redactString('clean log line', ['xxxxxxx'])).toBe('clean log line');
    });
});
