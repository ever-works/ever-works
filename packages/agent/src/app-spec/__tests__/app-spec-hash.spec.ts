import { createHash } from 'crypto';
import { appSpecHashesEqual, canonicalAppSpecJson, hashAppSpec } from '../app-spec-hash';

/**
 * APW-03 T12 — the canonical App spec hash (FR-23, plan §3.1:412).
 *
 * > The spec hash MUST be computed over the `spec` block only, in a canonical
 * > form independent of key order and whitespace.
 *
 * Every case below is one half of that sentence: the hash must be **stable**
 * across everything that does not change the spec (key order, whitespace, an
 * `undefined` property) and must **differ** for everything that does (a value,
 * an array's order, an added key). ACC-03-11 ("Re-evaluating identical content
 * emits no Activity") and ACC-03-12's neighbour FR-21 ("the event MUST fire only
 * when the effective spec hash changes") are both decided by this function, so a
 * false "same" here is a missed event and a false "different" is a duplicate
 * one.
 */
describe('app-spec-hash (APW-03 T12, FR-23)', () => {
    const SPEC = {
        source: { relation: 'fork', upstream: { repo: 'calcom/cal.diy', defaultBranch: 'main' } },
        build: { strategy: 'dockerfile', dockerfile: 'Dockerfile' },
        components: [{ name: 'web', role: 'web', port: 3000 }],
        env: [
            { name: 'NEXTAUTH_SECRET', secret: true, generate: { kind: 'base64', bytes: 32 } },
            { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
        ],
        agents: { requireHumanMergePaths: ['.github/workflows/**'] },
    };

    describe('canonicalAppSpecJson', () => {
        it('sorts object keys at every depth and emits no whitespace', () => {
            const canonical = canonicalAppSpecJson({
                b: 1,
                a: { d: [2, 1], c: 'x' },
            });

            expect(canonical).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
            expect(canonical).not.toContain(' ');
            expect(canonical).not.toContain('\n');
        });

        it('preserves array order — two different component orders are two specs', () => {
            expect(canonicalAppSpecJson({ a: [1, 2] })).not.toBe(
                canonicalAppSpecJson({ a: [2, 1] }),
            );
        });

        it('canonicalises objects INSIDE an array, so a reordered key is not a change', () => {
            expect(canonicalAppSpecJson([{ b: 1, a: 2 }])).toBe(
                canonicalAppSpecJson([{ a: 2, b: 1 }]),
            );
        });

        it('drops undefined properties and keeps null (a declared value is not an absence)', () => {
            expect(canonicalAppSpecJson({ a: 1, b: undefined })).toBe('{"a":1}');
            expect(canonicalAppSpecJson({ a: null })).toBe('{"a":null}');
        });

        it('never consults toJSON — a class instance hashes as its own enumerable keys', () => {
            class Sneaky {
                value = 1;
                toJSON(): unknown {
                    return { value: 999 };
                }
            }

            expect(canonicalAppSpecJson(new Sneaky())).toBe('{"value":1}');
        });
    });

    describe('hashAppSpec', () => {
        it('is the lowercase-hex sha256 of the canonical JSON, 64 characters wide', () => {
            const expected = createHash('sha256')
                .update(canonicalAppSpecJson(SPEC), 'utf8')
                .digest('hex');
            const hash = hashAppSpec(SPEC);

            expect(hash).toBe(expected);
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
            // The width of both hash columns (`work-app-spec-state.entity.ts:167-169`).
            expect(hash).toHaveLength(64);
        });

        it('is stable across key order and across an undefined property (FR-23)', () => {
            const reordered = {
                agents: { requireHumanMergePaths: ['.github/workflows/**'] },
                env: [
                    {
                        name: 'NEXTAUTH_SECRET',
                        secret: true,
                        generate: { kind: 'base64', bytes: 32 },
                    },
                    { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
                ],
                components: [{ port: 3000, role: 'web', name: 'web' }],
                build: { dockerfile: 'Dockerfile', strategy: 'dockerfile' },
                source: {
                    upstream: { defaultBranch: 'main', repo: 'calcom/cal.diy' },
                    relation: 'fork',
                },
                xNote: undefined,
            };

            expect(hashAppSpec(reordered)).toBe(hashAppSpec(SPEC));
        });

        it('changes when a leaf changes, when a key is added and when an array is reordered', () => {
            expect(hashAppSpec({ ...SPEC, build: { strategy: 'image' } })).not.toBe(
                hashAppSpec(SPEC),
            );
            expect(hashAppSpec({ ...SPEC, display: { name: 'Cal.diy' } })).not.toBe(
                hashAppSpec(SPEC),
            );
            expect(hashAppSpec({ ...SPEC, env: [...(SPEC.env as unknown[])].reverse() })).not.toBe(
                hashAppSpec(SPEC),
            );
        });

        it('hashes an empty object — {} is a spec with nothing in it', () => {
            expect(hashAppSpec({})).toBe(createHash('sha256').update('{}', 'utf8').digest('hex'));
        });

        it('answers null for anything that is not a spec block', () => {
            // `null` and `''` are different answers on purpose: the hash is defined
            // over the `spec` block, and a caller that forgot to check must not be
            // handed a digest of `"null"`.
            for (const value of [null, undefined, 'source: {}', 42, ['a'], true]) {
                expect(hashAppSpec(value)).toBeNull();
            }
        });
    });

    describe('appSpecHashesEqual', () => {
        it('treats two absences as the same answer and a hash against an absence as different', () => {
            expect(appSpecHashesEqual(null, undefined)).toBe(true);
            expect(appSpecHashesEqual(undefined, undefined)).toBe(true);
            expect(appSpecHashesEqual('a'.repeat(64), null)).toBe(false);
            expect(appSpecHashesEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
            expect(appSpecHashesEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
        });
    });
});
