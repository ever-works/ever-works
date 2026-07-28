import {
    collectCredentialRefs,
    credentialRedactionToken,
    interpolateCredentials,
    invalidCredentialKeys,
    redactCredentialValues,
} from '../credential-interpolation';
import {
    EnvCredentialResolver,
    ENV_CREDENTIAL_PREFIX,
    envVarNameForCredential,
} from '../credential-resolver';

/**
 * `{{cred.key}}` interpolation (audit item G14).
 *
 * The invariants under test are the security ones: a reference resolves
 * SERVER-SIDE, an unresolvable reference fails the call rather than
 * silently becoming an empty string, and a resolved value that comes back
 * in a tool result is scrubbed before it can re-enter the conversation.
 */

describe('collectCredentialRefs', () => {
    it('finds references in strings, arrays and nested objects', () => {
        const refs = collectCredentialRefs({
            headers: { Authorization: 'Bearer {{cred.api_token}}' },
            body: ['{{cred.tenant_id}}', 'plain'],
        });
        expect(refs).toEqual(['api_token', 'tenant_id']);
    });

    it('tolerates whitespace inside the braces and dedupes', () => {
        expect(collectCredentialRefs('{{ cred.a }} and {{cred.a}}')).toEqual(['a']);
    });

    it('returns nothing for values with no references', () => {
        expect(collectCredentialRefs({ a: 1, b: 'plain', c: null })).toEqual([]);
    });

    it('does not treat other mustache-ish templates as credentials', () => {
        expect(collectCredentialRefs('{{user.email}} {{secret.key}}')).toEqual([]);
    });
});

describe('interpolateCredentials', () => {
    it('substitutes a resolved reference and reports the key as used', () => {
        const result = interpolateCredentials(
            { headers: { Authorization: 'Bearer {{cred.api_token}}' } },
            new Map([['api_token', 's3cr3t-value']]),
        );
        expect(result.value).toEqual({ headers: { Authorization: 'Bearer s3cr3t-value' } });
        expect(result.used).toEqual(['api_token']);
        expect(result.missing).toEqual([]);
    });

    it('leaves an UNRESOLVED reference verbatim and reports it missing', () => {
        // Substituting an empty string would send an unauthenticated
        // request that looks like it worked — the caller must be able to
        // fail instead.
        const result = interpolateCredentials('Bearer {{cred.nope}}', new Map());
        expect(result.value).toBe('Bearer {{cred.nope}}');
        expect(result.missing).toEqual(['nope']);
    });

    it('walks arrays and nested plain objects', () => {
        const result = interpolateCredentials(
            { list: [{ token: '{{cred.k}}' }] },
            new Map([['k', 'v-abcdefgh']]),
        );
        expect(result.value).toEqual({ list: [{ token: 'v-abcdefgh' }] });
    });

    it('leaves class instances untouched rather than mangling them', () => {
        const date = new Date(0);
        const result = interpolateCredentials({ when: date }, new Map());
        expect(result.value.when).toBe(date);
    });

    it('does not mutate the input', () => {
        const input = { token: '{{cred.k}}' };
        interpolateCredentials(input, new Map([['k', 'value-1234']]));
        expect(input.token).toBe('{{cred.k}}');
    });
});

describe('redactCredentialValues', () => {
    it('scrubs a resolved value that an upstream API echoed back', () => {
        const credentials = new Map([['api_token', 'super-secret-token']]);
        const result = redactCredentialValues(
            { error: 'invalid key: super-secret-token' },
            credentials,
        );
        expect(result.error).toBe(`invalid key: ${credentialRedactionToken('api_token')}`);
        expect(JSON.stringify(result)).not.toContain('super-secret-token');
    });

    it('scrubs every occurrence, including inside nested structures', () => {
        const credentials = new Map([['k', 'abcdefgh12345']]);
        const result = redactCredentialValues(
            { a: ['abcdefgh12345', { b: 'x abcdefgh12345 y' }] },
            credentials,
        );
        expect(JSON.stringify(result)).not.toContain('abcdefgh12345');
    });

    it('ignores implausibly short values so ordinary text is not corrupted', () => {
        const result = redactCredentialValues({ text: 'about the cat' }, new Map([['k', 'cat']]));
        expect(result.text).toBe('about the cat');
    });

    it('is a no-op when nothing was resolved', () => {
        const value = { a: 'b' };
        expect(redactCredentialValues(value, new Map())).toBe(value);
    });
});

describe('invalidCredentialKeys', () => {
    it('reports nothing for well-formed keys', () => {
        expect(invalidCredentialKeys('{{cred.api_token}} {{cred.a-b.c}}')).toEqual([]);
    });
});

describe('EnvCredentialResolver', () => {
    const resolver = new EnvCredentialResolver();
    const ctx = { userId: 'u1' };

    afterEach(() => {
        delete process.env[`${ENV_CREDENTIAL_PREFIX}API_TOKEN`];
    });

    it('maps a credential key to a NAMESPACED env var', () => {
        expect(envVarNameForCredential('api_token')).toBe(`${ENV_CREDENTIAL_PREFIX}API_TOKEN`);
        expect(envVarNameForCredential('a-b.c')).toBe(`${ENV_CREDENTIAL_PREFIX}A_B_C`);
    });

    it('resolves a configured key', async () => {
        process.env[`${ENV_CREDENTIAL_PREFIX}API_TOKEN`] = 'from-env';
        const resolved = await resolver.resolve(ctx, ['api_token']);
        expect(resolved.get('api_token')).toBe('from-env');
    });

    it('OMITS an unconfigured key rather than returning an empty string', async () => {
        const resolved = await resolver.resolve(ctx, ['api_token']);
        expect(resolved.has('api_token')).toBe(false);
    });

    it('SECURITY: cannot reach a platform env var outside the namespace', async () => {
        // The whole point of the mandatory prefix: a model-authored
        // `{{cred.database_url}}` must not hand out DATABASE_URL.
        process.env.DATABASE_URL = 'postgres://secret';
        try {
            const resolved = await resolver.resolve(ctx, ['database_url']);
            expect(resolved.has('database_url')).toBe(false);
        } finally {
            delete process.env.DATABASE_URL;
        }
    });

    it('ignores a malformed key', async () => {
        const resolved = await resolver.resolve(ctx, ['not a key!']);
        expect(resolved.size).toBe(0);
    });
});
