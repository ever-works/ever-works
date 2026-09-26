import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
    APP_ENV_ALPHABETS,
    APP_ENV_BASE64_MAX_BYTES,
    APP_ENV_BASE64_MIN_BYTES,
    APP_ENV_CHARS_MAX_LENGTH,
    APP_ENV_CHARS_MIN_LENGTH,
    APP_ENV_KEYPAIR_DEFAULT_FORMAT,
    appEnvGeneratorFingerprint,
    type AppEnvAlphabet,
    type AppEnvGeneratorKind,
    type AppEnvKeypairFormat,
    type AppEnvKeypairType,
    type AppEnvRecipeGenerateSpec,
} from '@ever-works/contracts';

/**
 * APW-07 (App env & dependencies) — the five generators of plan §4.3
 * (`plan.md:377-402`).
 *
 * Spec: FR-10 (`spec.md:217-220`, the exact lengths and the four alphabets),
 * FR-11 (`spec.md:221`, "Randomness comes from the operating system's
 * cryptographically secure source"), FR-14/FR-15 (`spec.md:231-240`, the keypair
 * formats and the public half). Plan §4.2:366 is the one caller that matters:
 * `AppEnvService.ensureGenerated` generates every `generate` entry that has no
 * row yet, and §4.6.1:447's runner recipe is the second (`generateAppEnvValue`
 * is the same dispatcher both go through).
 *
 * ## Every octet comes from `node:crypto` (FR-11)
 *
 * `randomBytes` for `base64`/`hex`/`chars`, `randomUUID` for `uuid` and
 * `generateKeyPairSync` for `keypair` — and nothing else. There is no
 * `Math.random` fallback anywhere in this file (a spec asserts the source
 * contains none), no seeded PRNG and no cached entropy: a value this module
 * returns is unpredictable even to this process. `chars` draws by **rejection
 * sampling** exactly as §4.3:382 fixes it — a batch of `randomBytes(length·2)`,
 * each octet accepted while `b < 256 − (256 mod n)` and mapped to
 * `alphabet[b mod n]`, refilled until `length` characters exist — so no
 * character is more likely than another. `b % n` over a range that is a whole
 * multiple of `n` is the reason: a naive `b % n` over all 256 octets would make
 * the first `256 mod n` characters of the alphabet slightly likelier, which is
 * the bias the 99.9% chi-square bound of the spec exists to catch.
 *
 * ## The App spec owns the windows; this module enforces them
 *
 * `bytes` is 16–128 and `length` is 16–256 (`app-spec.v1.schema.json`,
 * `generate.bytes` / `generate.length`), and the contract's numeric constants are
 * those bounds. A generator called outside its window refuses rather than
 * producing a value the App spec validation would reject afterwards — the App
 * spec is a repository file and this is the last place a wrong number can still
 * be turned into a stored secret.
 *
 * ## Defaults: the App spec's, not the minimums
 *
 * `bytes` and `length` are optional in the App spec and default to **32**
 * (`app-spec.v1.schema.json`, "default: 32"; APW-03's `generatedLength` applies
 * the same two numbers, `works-config/schema/app-spec.rules.ts:405-419`), so
 * {@link generateAppEnvValue} fills those in before dispatching.
 *
 * ⚠️ **Reported, not silently absorbed:** `appEnvGeneratorFingerprint` in
 * `packages/contracts/src/apps/app-env.ts:218-222` defaults an omitted `bytes` /
 * `length` to the **minimum** (`APP_ENV_BASE64_MIN_BYTES` = 16,
 * `APP_ENV_CHARS_MIN_LENGTH` = 16), so a caller that fingerprints an unresolved
 * App spec block records `base64:16` for a value that is 44 characters long.
 * This module therefore fingerprints the **resolved** spec (defaults applied), so
 * a row's `generatorFingerprint` always describes the value beside it; the
 * contract's bare-call default is for T1's owner to reconcile.
 *
 * ## Only `pem` here (T42 owns the rest)
 *
 * T10's text is explicit — "the `pem` keypair format here; other formats in
 * T42" — so `base64url-raw` and `pkcs12` are refused with
 * {@link AppEnvGeneratorError} `unsupportedKeypairFormat` instead of being
 * half-implemented. `pem` is Resolution R-11's default and the format every
 * entry gets when the App spec says nothing.
 */

/**
 * The `bytes` an omitted `generate.bytes` means — the App spec's default
 * (`app-spec.v1.schema.json`, `generate.bytes`, "default: 32"), not the
 * contract's minimum.
 */
export const APP_ENV_GENERATOR_DEFAULT_BYTES = 32;

/** The `length` an omitted `generate.length` means — the App spec's default. */
export const APP_ENV_GENERATOR_DEFAULT_LENGTH = 32;

/** The alphabet an omitted `generate.alphabet` means (FR-10, the App spec's default). */
export const APP_ENV_GENERATOR_DEFAULT_ALPHABET: AppEnvAlphabet = 'alnum';

/** The key type an omitted `generate.keypair.type` means (the App spec's default). */
export const APP_ENV_GENERATOR_DEFAULT_KEYPAIR_TYPE: AppEnvKeypairType = 'ed25519';

/**
 * A refusal of {@link generateAppEnvValue} and friends.
 *
 * Two codes, because there are exactly two ways a generator call can be wrong
 * and they belong to different people:
 *
 *   - `invalidGenerator` — the caller passed a size outside the App spec's
 *     window, an alphabet that does not exist, or a `passwordEnv` beside a
 *     format that cannot use one. This is a defect in the caller (the App spec
 *     schema refuses all three earlier, so it can only be reached by code).
 *   - `unsupportedKeypairFormat` — `base64url-raw` or `pkcs12`, which exist in
 *     the contract (FR-14) and are **T42's to implement**. Failing closed beats
 *     returning a PEM value an app expecting a raw key would silently misuse.
 *
 * There is deliberately no member-facing message key: nothing a member types
 * reaches this class — a member's value goes through
 * `packages/agent/src/app-env/validation.ts` (T11), whose refusals are the
 * contract's `APP_ENV_VALIDATION_REFUSAL_CODES`.
 */
export class AppEnvGeneratorError extends Error {
    readonly code: 'invalidGenerator' | 'unsupportedKeypairFormat';

    constructor(code: 'invalidGenerator' | 'unsupportedKeypairFormat', message: string) {
        super(message);
        this.name = 'AppEnvGeneratorError';
        this.code = code;
    }
}

/** Whether a caught value is {@link AppEnvGeneratorError}, across bundles. */
export function isAppEnvGeneratorError(value: unknown): value is AppEnvGeneratorError {
    if (value instanceof AppEnvGeneratorError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppEnvGeneratorError' &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

/** One generated key pair, `pem` (FR-14). */
export interface AppEnvKeypair {
    /** The private half, PKCS#8 PEM — what the entry's own name holds. */
    readonly value: string;
    /** The public half, SPKI PEM — delivered as `<NAME>_PUBLIC` and nothing else (FR-15). */
    readonly publicValue: string;
}

/**
 * What one generation produced: the value, the public half (a keypair is the
 * only kind that has one) and the canonical `generate` block it was made with.
 */
export interface AppEnvGeneratedValue {
    readonly kind: AppEnvGeneratorKind;
    /** The entry's value — never logged, never returned by an endpoint (FR-5). */
    readonly value: string;
    /** `<NAME>_PUBLIC`'s value for a keypair; `null` for the other four kinds. */
    readonly publicValue: string | null;
    /**
     * The row's `generatorFingerprint` (`plan.md:186, 397`), computed from the
     * RESOLVED spec — so it always describes the value beside it. A later change
     * is what sets `generatorChanged` (FR-12) and never regenerates by itself.
     */
    readonly fingerprint: string;
}

/** `base64` — standard base64 of `bytes` random octets, `4·ceil(bytes/3)` characters. */
export function generateBase64(bytes: number): string {
    assertByteCount(bytes, 'base64');
    return randomBytes(bytes).toString('base64');
}

/** `hex` — lower-case, `2·bytes` characters. */
export function generateHex(bytes: number): string {
    assertByteCount(bytes, 'hex');
    return randomBytes(bytes).toString('hex');
}

/**
 * `chars` — `length` characters drawn WITHOUT bias from `alphabet`
 * (plan §4.3:382).
 *
 * The batch size is `2·length` and the acceptance bound is
 * `256 − (256 mod n)`, so every accepted octet maps onto the alphabet exactly
 * the same number of times; a batch that runs out (rare — the acceptance rate is
 * 248/256 for `alnum`) is followed by another one rather than by a shortened
 * value, which is what "refill until `length` characters" means.
 */
export function generateChars(
    length: number,
    alphabet: AppEnvAlphabet = APP_ENV_GENERATOR_DEFAULT_ALPHABET,
): string {
    assertLength(length, 'chars');
    const characters = alphabetCharacters(alphabet);
    const size = characters.length;
    const acceptBelow = 256 - (256 % size);

    let value = '';
    while (value.length < length) {
        const draw = randomBytes((length - value.length) * 2);
        for (const octet of draw) {
            if (octet >= acceptBelow) {
                continue;
            }
            value += characters[octet % size];
            if (value.length === length) {
                break;
            }
        }
    }
    return value;
}

/** `uuid` — a random version-4 UUID, 36 characters (FR-10). */
export function generateUuid(): string {
    return randomUUID();
}

/**
 * `keypair` — a fresh pair in `pem` (FR-14, Resolution R-11's default format).
 *
 * The private half is PKCS#8 PEM and the public half is SPKI PEM, exactly as
 * plan §4.3:386-387 fixes the encodings, so both halves are the plainest thing an
 * app can read back. `ec-p256` is `ec` with `namedCurve: 'P-256'`; the two RSA
 * types differ only in `modulusLength`.
 *
 * `format` is accepted as the plan's second parameter so the call sites read the
 * same as §4.3, but only `pem` is implemented here: `base64url-raw` and `pkcs12`
 * are T42's, and a `passwordEnv` (which only `pkcs12` can use) is refused beside
 * any other format rather than ignored.
 */
export function generateKeypair(
    type: AppEnvKeypairType,
    format: AppEnvKeypairFormat = APP_ENV_KEYPAIR_DEFAULT_FORMAT,
    passwordEnv?: string,
): AppEnvKeypair {
    if (format !== APP_ENV_KEYPAIR_DEFAULT_FORMAT) {
        throw new AppEnvGeneratorError(
            'unsupportedKeypairFormat',
            `The \`${format}\` keypair format is not implemented yet; use \`${APP_ENV_KEYPAIR_DEFAULT_FORMAT}\`.`,
        );
    }
    if (passwordEnv !== undefined && passwordEnv !== null && passwordEnv !== '') {
        throw new AppEnvGeneratorError(
            'invalidGenerator',
            '`keypair.passwordEnv` is only meaningful with the `pkcs12` format.',
        );
    }

    const publicKeyEncoding = { type: 'spki', format: 'pem' } as const;
    const privateKeyEncoding = { type: 'pkcs8', format: 'pem' } as const;
    // `node:crypto` names the halves `privateKey`/`publicKey`; this module names
    // them after what they become — the entry's value and `<NAME>_PUBLIC`.
    const pair = (generated: { publicKey: string; privateKey: string }): AppEnvKeypair => ({
        value: generated.privateKey,
        publicValue: generated.publicKey,
    });

    switch (type) {
        case 'ed25519':
            return pair(generateKeyPairSync('ed25519', { publicKeyEncoding, privateKeyEncoding }));
        case 'ec-p256':
            return pair(
                generateKeyPairSync('ec', {
                    namedCurve: 'P-256',
                    publicKeyEncoding,
                    privateKeyEncoding,
                }),
            );
        case 'rsa-2048':
            return pair(
                generateKeyPairSync('rsa', {
                    modulusLength: 2048,
                    publicKeyEncoding,
                    privateKeyEncoding,
                }),
            );
        case 'rsa-4096':
            return pair(
                generateKeyPairSync('rsa', {
                    modulusLength: 4096,
                    publicKeyEncoding,
                    privateKeyEncoding,
                }),
            );
        default:
            throw new AppEnvGeneratorError(
                'invalidGenerator',
                `Unknown keypair type \`${String(type)}\`.`,
            );
    }
}

/**
 * The one dispatcher: an App spec `generate` block in, a generated value out
 * (plan §4.2:366, §4.6.1:447).
 *
 * Omitted parameters take the App spec's documented defaults — 32 bytes, 32
 * characters, `alnum`, `ed25519`, `pem` — which is what makes the fingerprint it
 * returns (computed from the RESOLVED spec; see the module docstring) describe
 * the value it returns. The `rotate` mode is deliberately not part of this
 * function: FR-13's rotation is `AppEnvService.rotate`'s, and a generator that
 * decided when to rotate would be a second place that rule lives.
 */
export function generateAppEnvValue(spec: AppEnvRecipeGenerateSpec): AppEnvGeneratedValue {
    const kind = spec?.kind;
    switch (kind) {
        case 'base64': {
            const bytes = spec.bytes ?? APP_ENV_GENERATOR_DEFAULT_BYTES;
            return {
                kind,
                value: generateBase64(bytes),
                publicValue: null,
                fingerprint: appEnvGeneratorFingerprint({ kind, bytes }),
            };
        }
        case 'hex': {
            const bytes = spec.bytes ?? APP_ENV_GENERATOR_DEFAULT_BYTES;
            return {
                kind,
                value: generateHex(bytes),
                publicValue: null,
                fingerprint: appEnvGeneratorFingerprint({ kind, bytes }),
            };
        }
        case 'chars': {
            const length = spec.length ?? APP_ENV_GENERATOR_DEFAULT_LENGTH;
            const alphabet = spec.alphabet ?? APP_ENV_GENERATOR_DEFAULT_ALPHABET;
            return {
                kind,
                value: generateChars(length, alphabet),
                publicValue: null,
                fingerprint: appEnvGeneratorFingerprint({ kind, length, alphabet }),
            };
        }
        case 'uuid':
            return {
                kind,
                value: generateUuid(),
                publicValue: null,
                fingerprint: appEnvGeneratorFingerprint({ kind }),
            };
        case 'keypair': {
            const type = spec.keypair?.type ?? APP_ENV_GENERATOR_DEFAULT_KEYPAIR_TYPE;
            const format = spec.keypair?.format ?? APP_ENV_KEYPAIR_DEFAULT_FORMAT;
            const passwordEnv = spec.keypair?.passwordEnv;
            const pair = generateKeypair(type, format, passwordEnv);
            return {
                kind,
                value: pair.value,
                publicValue: pair.publicValue,
                fingerprint: appEnvGeneratorFingerprint({
                    kind,
                    keypair: { type, format, passwordEnv },
                }),
            };
        }
        default:
            throw new AppEnvGeneratorError(
                'invalidGenerator',
                `Unknown generator kind \`${String(kind)}\`.`,
            );
    }
}

/** The alphabet a `chars` call draws from, or a refusal for a name it does not have. */
function alphabetCharacters(alphabet: AppEnvAlphabet): string {
    if (
        typeof alphabet !== 'string' ||
        !Object.prototype.hasOwnProperty.call(APP_ENV_ALPHABETS, alphabet)
    ) {
        throw new AppEnvGeneratorError(
            'invalidGenerator',
            `Unknown \`chars\` alphabet \`${String(alphabet)}\`.`,
        );
    }
    return APP_ENV_ALPHABETS[alphabet];
}

/** FR-10's 16–128 window, enforced for the two kinds that take `bytes`. */
function assertByteCount(bytes: number, kind: AppEnvGeneratorKind): void {
    if (
        !Number.isInteger(bytes) ||
        bytes < APP_ENV_BASE64_MIN_BYTES ||
        bytes > APP_ENV_BASE64_MAX_BYTES
    ) {
        throw new AppEnvGeneratorError(
            'invalidGenerator',
            `\`${kind}\` needs an integer \`bytes\` between ${APP_ENV_BASE64_MIN_BYTES} and ${APP_ENV_BASE64_MAX_BYTES}.`,
        );
    }
}

/** FR-10's 16–256 window for `chars`. */
function assertLength(length: number, kind: AppEnvGeneratorKind): void {
    if (
        !Number.isInteger(length) ||
        length < APP_ENV_CHARS_MIN_LENGTH ||
        length > APP_ENV_CHARS_MAX_LENGTH
    ) {
        throw new AppEnvGeneratorError(
            'invalidGenerator',
            `\`${kind}\` needs an integer \`length\` between ${APP_ENV_CHARS_MIN_LENGTH} and ${APP_ENV_CHARS_MAX_LENGTH}.`,
        );
    }
}
