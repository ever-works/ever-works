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

    /** `{ a: { a: … { leaf } } }`, `levels` objects deep. */
    function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
        let node: Record<string, unknown> = leaf;
        for (let i = 0; i < levels; i++) node = { a: node };
        return node;
    }

    describe("the default 'text' mode keeps its behavior", () => {
        it('keeps object keys and a string that is exactly a short value', () => {
            const credentials = new Map([
                ['long', 'abcdefgh12345'],
                ['short', 'pin42'],
            ]);
            const result = redactCredentialValues(
                { abcdefgh12345: 'x', code: 'pin42' },
                credentials,
            ) as Record<string, unknown>;
            expect(Object.keys(result)).toEqual(['abcdefgh12345', 'code']);
            expect(result.code).toBe('pin42');
        });
    });

    describe("'credential' mode", () => {
        const SECRET = 'resolved-vault-value-9f8e7d6c';
        const credentials = new Map([['docs_token', SECRET]]);
        const token = credentialRedactionToken('docs_token');

        it('scrubs a value reflected in an object key', () => {
            const result = redactCredentialValues(
                { properties: { [SECRET]: { type: 'string' }, [`x-${SECRET}`]: 1 } },
                credentials,
                { mode: 'credential' },
            );
            expect(JSON.stringify(result)).not.toContain(SECRET);
            expect(Object.keys(result.properties as object)).toEqual([token, `x-${token}`]);
        });

        it('redacts a string or key that is exactly a short value, but not ordinary text around it', () => {
            const short = new Map([['pin', 'cat']]);
            const result = redactCredentialValues(
                { value: 'cat', cat: true, text: 'about the cat' },
                short,
                { mode: 'credential' },
            ) as Record<string, unknown>;
            expect(result.value).toBe(credentialRedactionToken('pin'));
            expect(result[credentialRedactionToken('pin')]).toBe(true);
            expect(result.cat).toBeUndefined();
            expect(result.text).toBe('about the cat');
        });

        it('scrubs content nested deeper than the text-mode walk limit', () => {
            const input = nest(20, { description: `Bearer ${SECRET}`, [SECRET]: 'k' });
            const result = redactCredentialValues(input, credentials, { mode: 'credential' });
            expect(JSON.stringify(result)).not.toContain(SECRET);
            expect(JSON.stringify(result)).toContain(`Bearer ${token}`);
        });

        it('fails closed past the rebuild depth: a subtree carrying a value is replaced whole', () => {
            const input = nest(500, { description: `Bearer ${SECRET}` });
            const result = redactCredentialValues(input, credentials, { mode: 'credential' });

            let node: unknown = result;
            let depth = 0;
            while (node && typeof node === 'object') {
                node = (node as Record<string, unknown>).a;
                depth++;
            }
            expect(node).toBe(token);
            expect(depth).toBeGreaterThan(8);
            expect(depth).toBeLessThan(500);
        });

        it('passes a deep subtree through untouched when it carries no value', () => {
            const deep = nest(500, { description: 'nothing to hide' });
            const result = redactCredentialValues(deep, credentials, { mode: 'credential' });

            // The top levels are rebuilt; below the rebuild depth the very
            // same objects are handed back.
            let original: unknown = deep;
            let copy: unknown = result;
            let depth = 0;
            while (copy !== original && copy && typeof copy === 'object') {
                copy = (copy as Record<string, unknown>).a;
                original = (original as Record<string, unknown>).a;
                depth++;
            }
            expect(copy).toBe(original);
            expect(copy && typeof copy === 'object').toBe(true);
            expect(depth).toBeGreaterThan(8);
            expect(JSON.stringify(result)).toBe(JSON.stringify(deep));
        });

        it('terminates on a cyclic structure', () => {
            const cyclic: Record<string, unknown> = { note: 'loop' };
            cyclic.self = cyclic;
            expect(() =>
                redactCredentialValues(cyclic, credentials, { mode: 'credential' }),
            ).not.toThrow();
        });
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
