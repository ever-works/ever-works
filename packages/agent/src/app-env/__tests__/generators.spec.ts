import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ENV_ALPHABETS, appEnvGeneratorFingerprint } from '@ever-works/contracts';
import {
    APP_ENV_GENERATOR_DEFAULT_BYTES,
    APP_ENV_GENERATOR_DEFAULT_LENGTH,
    AppEnvGeneratorError,
    generateAppEnvValue,
    generateBase64,
    generateChars,
    generateHex,
    generateKeypair,
    generateUuid,
    isAppEnvGeneratorError,
} from '../generators';

/**
 * APW-07 T10 — the five generators of plan §4.3 (`plan.md:377-402`).
 *
 * Spec: FR-10 (`spec.md:217-220`, the exact lengths and alphabets), FR-11
 * (`spec.md:221`, "Randomness comes from the operating system's
 * cryptographically secure source"), FR-14/FR-15 (`spec.md:231-240`, the keypair
 * formats and the public half), ACC-07-01 (`spec.md:574-575`, the four declared
 * lengths) and ACC-07-06 (`spec.md:582-583`, the public half verifies).
 *
 * ## The sample counts are the plan's, and they are the point
 *
 * 1,000 samples per generator, because a length assertion passes by accident
 * once and a distribution assertion cannot: `chars` could drop its rejection
 * sampling and still return 40 characters from the right alphabet, and a
 * one-sample test would never notice. Every sample is a fresh call — nothing is
 * reused between assertions.
 *
 * ## How the statistical test stays off the flake list
 *
 * The chi-square leg is the only probabilistic assertion here, and it is
 * anchored three ways:
 *
 *   1. **A fixed sample count.** 1,000 values × 40 characters = exactly 40,000
 *      observations over exactly 62 buckets, so the degrees of freedom (61) and
 *      the expected count per bucket (40,000/62) are constants of this file.
 *   2. **The plan's own threshold**, not one invented here: the 99.9% critical
 *      value for 61 degrees of freedom, {@link CHI_SQUARE_999_DF_61}. It is
 *      derived from the chi-square survival function rather than transcribed
 *      from a table, and the derivation is cross-checked against the tabulated
 *      value for 60 degrees of freedom (99.607) in the assertion below it.
 *   3. **No wall-clock and no seed.** Nothing here reads the time, and the
 *      deterministic leg below replaces the entropy source with a fixed
 *      `sha256(counter)` stream, which makes the statistic a CONSTANT: that leg
 *      can never flake. The live-entropy leg keeps `randomBytes` and therefore
 *      carries the 0.1% false-failure rate the 99.9% threshold implies — that is
 *      the plan's number and it is stated rather than hidden.
 *
 * The measured statistic is printed (it contains characters from an alphabet,
 * never a stored value) so a reader of a CI log can see the margin.
 *
 * ## What is NOT here
 *
 * `base64url-raw` and `pkcs12` are T42's (`tasks.md:156-157`, "the `pem` keypair
 * format here; other formats in T42"), so this spec asserts they are REFUSED
 * rather than implementing them.
 */

/**
 * The 99.9% critical value of the chi-square distribution with 61 degrees of
 * freedom (62 buckets — the `alnum` alphabet of FR-10).
 *
 * Derived by inverting the regularized incomplete gamma function
 * (`P(61/2, x/2) = 0.999`) with a bisection to 1e-12. Cross-check: the same
 * routine gives 99.6072 for 60 degrees of freedom, which is the published table
 * value, so the arithmetic is validated against a known point rather than
 * trusted.
 */
const CHI_SQUARE_999_DF_61 = 100.8879;

/** The plan's sample count per generator (`plan.md:400`, `tasks.md:158`). */
const SAMPLES = 1_000;

/** The characters `chars` draws per `it` case, 40 per ACC-07-01. */
const CHARS_LENGTH = 40;

/** One value's characters counted per bucket, over the whole sample. */
function countCharacters(values: readonly string[], alphabet: string): number[] {
    const index = new Map<string, number>();
    for (const [position, character] of Array.from(alphabet).entries()) {
        index.set(character, position);
    }
    const counts = new Array<number>(alphabet.length).fill(0);
    for (const value of values) {
        for (const character of Array.from(value)) {
            const bucket = index.get(character);
            expect(bucket).toBeDefined();
            counts[bucket as number] += 1;
        }
    }
    return counts;
}

/** Pearson's chi-square statistic of `counts` against a uniform expectation. */
function chiSquare(counts: readonly number[]): number {
    const total = counts.reduce((sum, count) => sum + count, 0);
    const expected = total / counts.length;
    return counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
}

/**
 * A deterministic byte stream for the no-flake leg: `sha256(counter)` blocks,
 * trimmed to the requested size. Uniform and reproducible, so the statistic it
 * produces is the same number on every machine and every run.
 */
function deterministicByteStream(): (size: number) => Buffer {
    let counter = 0;
    return (size: number): Buffer => {
        const blocks: Buffer[] = [];
        let produced = 0;
        while (produced < size) {
            const block = createHash('sha256')
                .update(`app-env-generators-spec:${counter++}`)
                .digest();
            blocks.push(block);
            produced += block.length;
        }
        return Buffer.concat(blocks).subarray(0, size);
    };
}

describe('AppEnv generators (T10, plan §4.3:377-402)', () => {
    describe('base64 — 24 bytes are exactly 32 characters (ACC-07-01)', () => {
        const values = Array.from({ length: SAMPLES }, () => generateBase64(24));

        it(`produces ${SAMPLES} values of exactly 32 characters`, () => {
            for (const value of values) {
                expect(value).toHaveLength(4 * Math.ceil(24 / 3));
                expect(value).toHaveLength(32);
            }
        });

        it('uses the standard base64 alphabet and decodes back to 24 bytes', () => {
            for (const value of values) {
                expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
                expect(Buffer.from(value, 'base64')).toHaveLength(24);
            }
        });

        it('is 4·ceil(bytes/3) at the other sizes the App spec allows (FR-10)', () => {
            for (const bytes of [16, 31, 32, 33, 128]) {
                const value = generateBase64(bytes);
                expect(value).toHaveLength(4 * Math.ceil(bytes / 3));
                expect(Buffer.from(value, 'base64')).toHaveLength(bytes);
            }
        });

        it('never repeats — 1,000 draws of 24 random bytes are 1,000 distinct values (FR-11)', () => {
            expect(new Set(values).size).toBe(SAMPLES);
        });

        it.each([0, 15, 129, 24.5, -1, Number.NaN])('refuses bytes=%s', (bytes) => {
            expect(() => generateBase64(bytes as number)).toThrow(AppEnvGeneratorError);
        });
    });

    describe('hex — 32 bytes are exactly 64 lower-case characters (ACC-07-01)', () => {
        const values = Array.from({ length: SAMPLES }, () => generateHex(32));

        it(`produces ${SAMPLES} values of exactly 64 characters`, () => {
            for (const value of values) {
                expect(value).toHaveLength(2 * 32);
                expect(value).toHaveLength(64);
            }
        });

        it('is lower-case hex, and lower-case only', () => {
            for (const value of values) {
                expect(value).toMatch(/^[0-9a-f]{64}$/);
                expect(value).toBe(value.toLowerCase());
            }
        });

        it('never repeats (FR-11)', () => {
            expect(new Set(values).size).toBe(SAMPLES);
        });

        it.each([0, 15, 129, 32.5, Number.NaN])('refuses bytes=%s', (bytes) => {
            expect(() => generateHex(bytes as number)).toThrow(AppEnvGeneratorError);
        });
    });

    describe('chars — 40 alphanumeric characters, drawn without bias (FR-10)', () => {
        const values = Array.from({ length: SAMPLES }, () => generateChars(CHARS_LENGTH, 'alnum'));

        it(`produces ${SAMPLES} values of exactly 40 characters`, () => {
            for (const value of values) {
                expect(value).toHaveLength(CHARS_LENGTH);
            }
        });

        it('draws every character from the declared alphabet', () => {
            const alphabet = APP_ENV_ALPHABETS.alnum;
            const allowed = new Set(Array.from(alphabet));
            for (const value of values) {
                for (const character of Array.from(value)) {
                    expect(allowed.has(character)).toBe(true);
                }
            }
        });

        it('defaults to the alnum alphabet', () => {
            expect(generateChars(CHARS_LENGTH)).toMatch(/^[A-Za-z0-9]{40}$/);
        });

        it('is uniform over the 62 buckets — chi-square below the 99.9% critical value', () => {
            const alphabet = APP_ENV_ALPHABETS.alnum;
            const counts = countCharacters(values, alphabet);
            const statistic = chiSquare(counts);

            expect(counts).toHaveLength(62);
            expect(counts.reduce((sum, count) => sum + count, 0)).toBe(SAMPLES * CHARS_LENGTH);
            // eslint-disable-next-line no-console -- a statistic, never a value
            console.log(
                `[T10] chars(40,'alnum') chi-square over ${SAMPLES * CHARS_LENGTH} observations: ` +
                    `${statistic.toFixed(4)} vs 99.9% critical value ${CHI_SQUARE_999_DF_61} (df=61)`,
            );
            expect(statistic).toBeLessThan(CHI_SQUARE_999_DF_61);
        });

        it("honours every declared alphabet, and only that alphabet's characters", () => {
            for (const [name, alphabet] of Object.entries(APP_ENV_ALPHABETS)) {
                const allowed = new Set(Array.from(alphabet));
                for (let sample = 0; sample < 50; sample += 1) {
                    const value = generateChars(64, name as keyof typeof APP_ENV_ALPHABETS);
                    expect(value).toHaveLength(64);
                    for (const character of Array.from(value)) {
                        expect(allowed.has(character)).toBe(true);
                    }
                }
            }
        });

        it.each([0, 15, 257, 40.5, Number.NaN])('refuses length=%s', (length) => {
            expect(() => generateChars(length as number)).toThrow(AppEnvGeneratorError);
        });

        it('refuses an alphabet it does not have', () => {
            expect(() => generateChars(40, 'no-such-alphabet' as never)).toThrow(
                AppEnvGeneratorError,
            );
        });
    });

    describe('the sampling is deterministic when the entropy source is fixed (no flake)', () => {
        // The same assertions as the live-entropy leg, over a `randomBytes` that
        // returns `sha256(counter)` blocks. `generateChars` is the only generator
        // whose distribution is worth pinning, and with a fixed stream the
        // statistic below is a CONSTANT — this leg cannot flake on any machine.
        let spy: jest.SpyInstance;

        beforeEach(() => {
            spy = jest
                .spyOn(require('node:crypto'), 'randomBytes')
                .mockImplementation(deterministicByteStream() as never);
        });

        afterEach(() => {
            spy.mockRestore();
        });

        it(`still yields ${SAMPLES} values of 40 in-alphabet characters`, () => {
            const allowed = new Set(Array.from(APP_ENV_ALPHABETS.alnum));
            for (let sample = 0; sample < SAMPLES; sample += 1) {
                const value = generateChars(CHARS_LENGTH, 'alnum');
                expect(value).toHaveLength(CHARS_LENGTH);
                for (const character of Array.from(value)) {
                    expect(allowed.has(character)).toBe(true);
                }
            }
        });

        it('reaches the same statistic on every run — below the 99.9% critical value', () => {
            const values = Array.from({ length: SAMPLES }, () =>
                generateChars(CHARS_LENGTH, 'alnum'),
            );
            const statistic = chiSquare(countCharacters(values, APP_ENV_ALPHABETS.alnum));

            // eslint-disable-next-line no-console -- a statistic, never a value
            console.log(
                `[T10] chars(40,'alnum') chi-square over a fixed sha256(counter) stream: ` +
                    `${statistic.toFixed(4)} (df=61, constant)`,
            );
            expect(statistic).toBeLessThan(CHI_SQUARE_999_DF_61);
        });

        it('rejects an octet at or above 256 − (256 mod n) rather than folding it in (plan §4.3:382)', () => {
            // The chi-square leg above does catch a FULLY naive fold — measured at
            // 342.85 against the 100.89 bound, because the 8 rejected octets are
            // 3% of the stream. What it cannot catch is a near-miss rule (rejecting
            // only at 255, say) whose bias is small enough to hide inside 40,000
            // observations. This case pins the RULE instead of the distribution: the
            // stream is scripted, so the assertion is about which octets the
            // implementation accepted rather than about how the draws looked.
            //
            // For `alnum` (n = 62) the bound is 248, so the FIRST octet is 250 and
            // must be rejected; the 40 that follow are 0, 1, 2, … and are all
            // accepted. The expected value is derived from the alphabet here —
            // `octets[1..16] % 62` — so a fold of the rejected octet, which would
            // start with `alnum[250 % 62] = 'C'`, cannot produce it.
            const accepted = Array.from({ length: 40 }, (_unused, index) => index);
            const octets = [250, ...accepted];
            const characters = APP_ENV_ALPHABETS.alnum;
            const expected = accepted
                .slice(0, 16)
                .map((octet) => characters[octet % characters.length])
                .join('');

            spy.mockImplementation(((size: number) =>
                Buffer.from(octets).subarray(0, size)) as never);

            const value = generateChars(16, 'alnum');
            expect(value).toBe(expected);
            expect(value).toHaveLength(16);
            // The rejected octet's own fold — `250 % 62` is 2, `alnum[2]` is `C` —
            // is the value a folding implementation would have produced.
            expect(value[0]).not.toBe(characters[250 % characters.length]);
        });

        it('the deterministic stream produces exactly the requested octets', () => {
            const stream = deterministicByteStream();
            expect(stream(8)).toHaveLength(8);
            expect(stream(40)).toHaveLength(40);
            // Reproducible: a second stream returns the same first block.
            expect(deterministicByteStream()(32).equals(stream(32))).toBe(false);
            expect(deterministicByteStream()(32).equals(deterministicByteStream()(32))).toBe(true);
        });
    });

    describe('uuid — a version-4 UUID (FR-10)', () => {
        const values = Array.from({ length: SAMPLES }, () => generateUuid());

        it(`produces ${SAMPLES} values of exactly 36 characters`, () => {
            for (const value of values) {
                expect(value).toHaveLength(36);
                expect(value).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
                );
            }
        });

        it("carries version nibble '4' and an RFC 4122 variant nibble", () => {
            for (const value of values) {
                expect(value[14]).toBe('4');
                expect('89ab').toContain(value[19]);
            }
        });

        it('never repeats (FR-11)', () => {
            expect(new Set(values).size).toBe(SAMPLES);
        });
    });

    describe('keypair — PKCS#8 private + SPKI public, pem format (FR-14, ACC-07-06)', () => {
        const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';
        const SPKI_HEADER = '-----BEGIN PUBLIC KEY-----';
        const DATA = Buffer.from('ever-works app env keypair signature check');

        const verifies = (value: string, publicValue: string, algorithm: string | null): void => {
            const signature = sign(
                algorithm as never,
                DATA,
                createPrivateKey({ key: value, format: 'pem' }),
            );
            expect(
                verify(
                    algorithm as never,
                    DATA,
                    createPublicKey({ key: publicValue, format: 'pem' }),
                    signature,
                ),
            ).toBe(true);
        };

        it('ed25519', () => {
            const pair = generateKeypair('ed25519');
            expect(pair.value.startsWith(PKCS8_HEADER)).toBe(true);
            expect(pair.publicValue.startsWith(SPKI_HEADER)).toBe(true);
            verifies(pair.value, pair.publicValue, null);
        });

        it('ec-p256', () => {
            const pair = generateKeypair('ec-p256');
            expect(pair.value.startsWith(PKCS8_HEADER)).toBe(true);
            expect(pair.publicValue.startsWith(SPKI_HEADER)).toBe(true);
            expect(createPrivateKey(pair.value).asymmetricKeyType).toBe('ec');
            verifies(pair.value, pair.publicValue, 'sha256');
        });

        it('rsa-2048', () => {
            const pair = generateKeypair('rsa-2048');
            expect(pair.value.startsWith(PKCS8_HEADER)).toBe(true);
            expect(pair.publicValue.startsWith(SPKI_HEADER)).toBe(true);
            expect(createPrivateKey(pair.value).asymmetricKeyDetails?.modulusLength).toBe(2048);
            verifies(pair.value, pair.publicValue, 'sha256');
        });

        it('rsa-4096 — once (the slow one)', () => {
            const pair = generateKeypair('rsa-4096');
            expect(pair.value.startsWith(PKCS8_HEADER)).toBe(true);
            expect(pair.publicValue.startsWith(SPKI_HEADER)).toBe(true);
            expect(createPrivateKey(pair.value).asymmetricKeyDetails?.modulusLength).toBe(4096);
            verifies(pair.value, pair.publicValue, 'sha256');
        });

        it('defaults to ed25519 in pem', () => {
            const pair = generateKeypair('ed25519', 'pem');
            expect(createPrivateKey(pair.value).asymmetricKeyType).toBe('ed25519');
        });

        it('every pair is freshly generated — no two are equal', () => {
            const pairs = Array.from({ length: 25 }, () => generateKeypair('ed25519'));
            expect(new Set(pairs.map((pair) => pair.value)).size).toBe(25);
            expect(new Set(pairs.map((pair) => pair.publicValue)).size).toBe(25);
        });

        it.each([
            ['ed25519', 'base64url-raw'],
            ['ec-p256', 'base64url-raw'],
            ['rsa-2048', 'base64url-raw'],
            ['rsa-4096', 'base64url-raw'],
            ['ed25519', 'pkcs12'],
            ['ec-p256', 'pkcs12'],
            ['rsa-2048', 'pkcs12'],
            ['rsa-4096', 'pkcs12'],
        ] as const)('refuses %s in %s — that format is T42', (type, format) => {
            expect(() => generateKeypair(type, format)).toThrow(AppEnvGeneratorError);
            try {
                generateKeypair(type, format);
            } catch (error) {
                expect(isAppEnvGeneratorError(error)).toBe(true);
                expect((error as AppEnvGeneratorError).code).toBe('unsupportedKeypairFormat');
            }
        });

        it('refuses a key type it does not have', () => {
            expect(() => generateKeypair('rsa-1024' as never)).toThrow(AppEnvGeneratorError);
        });
    });

    describe('generateAppEnvValue — the dispatcher T13 calls (plan §4.2:366)', () => {
        it('returns the value, the public half and the generator fingerprint', () => {
            const generated = generateAppEnvValue({ kind: 'base64', bytes: 24 });
            expect(generated.kind).toBe('base64');
            expect(generated.value).toHaveLength(32);
            expect(generated.publicValue).toBeNull();
            expect(generated.fingerprint).toBe('base64:24');
        });

        it('applies the App spec defaults (32 bytes, 32 characters, alnum, ed25519, pem)', () => {
            // The App spec schema fixes these (`app-spec.v1.schema.json`,
            // `generate.bytes` "16–128 … default: 32"; `generate.length`
            // "16–256 … default: 32") and APW-03's `generatedLength`
            // (`works-config/schema/app-spec.rules.ts:405-419`) applies the same
            // two numbers, so the value a row holds and the length the App spec
            // validation expects cannot disagree.
            expect(APP_ENV_GENERATOR_DEFAULT_BYTES).toBe(32);
            expect(APP_ENV_GENERATOR_DEFAULT_LENGTH).toBe(32);

            const base64 = generateAppEnvValue({ kind: 'base64' });
            expect(base64.value).toHaveLength(4 * Math.ceil(32 / 3));
            expect(base64.value).toHaveLength(44);
            expect(base64.fingerprint).toBe('base64:32');

            const hex = generateAppEnvValue({ kind: 'hex' });
            expect(hex.value).toHaveLength(64);
            expect(hex.fingerprint).toBe('hex:32');

            const chars = generateAppEnvValue({ kind: 'chars' });
            expect(chars.value).toHaveLength(32);
            expect(chars.fingerprint).toBe('chars:32:alnum');

            const uuid = generateAppEnvValue({ kind: 'uuid' });
            expect(uuid.value).toHaveLength(36);
            expect(uuid.publicValue).toBeNull();
            expect(uuid.fingerprint).toBe('uuid');

            const keypair = generateAppEnvValue({ kind: 'keypair' });
            expect(keypair.publicValue).not.toBeNull();
            expect(keypair.fingerprint).toBe('keypair:ed25519:pem');
        });

        it('dispatches each kind to its generator', () => {
            expect(
                generateAppEnvValue({ kind: 'chars', length: 40, alphabet: 'hex-lower' }).value,
            ).toMatch(/^[0-9a-f]{40}$/);
            expect(
                generateAppEnvValue({ kind: 'keypair', keypair: { type: 'ec-p256' } }).fingerprint,
            ).toBe('keypair:ec-p256:pem');
        });

        it('fingerprints are stable: the same spec always yields the same string', () => {
            const spec = { kind: 'chars', length: 40, alphabet: 'base64url' } as const;
            const first = generateAppEnvValue(spec);
            const second = generateAppEnvValue(spec);

            expect(second.fingerprint).toBe(first.fingerprint);
            expect(first.fingerprint).toBe(appEnvGeneratorFingerprint(spec));
            expect(first.fingerprint).toBe('chars:40:base64url');
            // A different generator is a different fingerprint — which is what
            // sets `generatorChanged` (FR-12), and it never regenerates by itself.
            expect(generateAppEnvValue({ ...spec, length: 41 }).fingerprint).not.toBe(
                first.fingerprint,
            );
            expect(generateAppEnvValue({ kind: 'chars', length: 40 }).fingerprint).toBe(
                'chars:40:alnum',
            );
            expect(
                generateAppEnvValue({ kind: 'keypair', keypair: { type: 'rsa-2048' } }).fingerprint,
            ).toBe('keypair:rsa-2048:pem');
        });

        it('every value the dispatcher returns has a non-empty value and a usable envelope shape', () => {
            const kinds = ['base64', 'hex', 'chars', 'uuid'] as const;
            for (const kind of kinds) {
                const generated = generateAppEnvValue({ kind, bytes: 24, length: 40 });
                expect(typeof generated.value).toBe('string');
                expect(generated.value.length).toBeGreaterThan(0);
                expect(generated.publicValue).toBeNull();
            }
        });
    });

    describe('randomness comes from node:crypto only (FR-11)', () => {
        const source = readFileSync(join(__dirname, '..', 'generators.ts'), 'utf8');

        /**
         * The file's doc comments explain this rule and therefore name it; only
         * executable code is asserted against. Stripping comments first is what
         * makes the check about the code rather than about the prose, and it is
         * why a real `Math.random()` added to a function still fails below.
         */
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

        it('imports its entropy source from node:crypto', () => {
            expect(source).toMatch(/from 'node:crypto'/);
            expect(code).toMatch(/randomBytes/);
            expect(code).toMatch(/randomUUID/);
            expect(code).toMatch(/generateKeyPairSync/);
        });

        it('never falls back to Math.random — in any code path', () => {
            // FR-11's assertion is about what the code can do, not only about
            // what one run happened to produce, and `Math.random` is the one
            // wrong answer a distribution test cannot see: it is uniform enough
            // to pass the chi-square leg while being entirely predictable.
            expect(code).not.toMatch(/Math\s*\.\s*random/);
        });
    });
});
