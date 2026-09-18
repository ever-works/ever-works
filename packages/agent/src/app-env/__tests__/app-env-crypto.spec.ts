import { Logger } from '@nestjs/common';
import { appEnvErrorMessageKey } from '@ever-works/contracts';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import {
    APP_ENV_ENVELOPE_PREFIX,
    AppEnvCrypto,
    AppEnvEncryptionUnavailableError,
    AppEnvEnvelopeError,
    hasAppEnvEnvelope,
    isAppEnvEncryptionUnavailableError,
    isAppEnvEnvelopeError,
} from '../app-env-crypto';

/**
 * APW-07 T9 — `AppEnvCrypto`, the `enc::v1::` envelope of `work_app_env_values`.
 *
 * Plan §4.1 (`plan.md:355-359`) is the contract; spec FR-5 (nothing stores a
 * value in the clear), FR-18/FR-31 (the byte ceilings), S21 (`spec.md:168-170`,
 * "Secure storage isn't configured on this installation.") and **ACC-07-12**
 * (`spec.md:592`, "Encryption not configured → saving and generating are
 * refused; the table has zero rows written") are what it proves.
 *
 * ## What is deliberately NOT re-implemented
 *
 * The AES-256-GCM envelope itself belongs to
 * `plugins/services/plugin-secret-enc.service.ts` (C-08) and this spec never
 * asserts its internals — it asserts the two things `AppEnvCrypto` adds on top
 * of it, and those two are the whole point of the class:
 *
 *   1. **No plaintext door, in any `NODE_ENV`.** `PluginSecretEncService`
 *      deliberately degrades to *passthrough* when `PLUGIN_SECRET_ENCRYPTION_KEY`
 *      is unset ("useful for dev / preview / tests"). A table whose column is
 *      NOT NULL and whose rows are secrets must not inherit that convenience,
 *      so `AppEnvCrypto.encrypt` refuses with
 *      `AppEnvEncryptionUnavailableError` in `production` **and**
 *      `development` **and** `test`. The three-environment loop below is the
 *      assertion; the value that must never appear is asserted absent too.
 *   2. **No legacy plaintext on read.** The plugin treats an unprefixed string
 *      as a legacy plaintext row and returns it unchanged (Q-5(a)); these tables
 *      are new, so an unprefixed envelope is a defect, not a migration — it is
 *      refused rather than handed back.
 *
 * ## Why the repository is a spy in the "zero writes" case
 *
 * ACC-07-12 is a statement about the TABLE, not only about the error: a refusal
 * that happened after the row was written would still leave a value stored. The
 * write door below is the order plan §4.2 fixes for `apply`/`ensureGenerated`
 * — encrypt first, then write — and the spy is a real counter-backed row store,
 * so `rows.length === 0` is the assertion rather than "the mock was not called".
 *
 * ## Isolation between cases
 *
 * `PluginSecretEncService` caches the key it resolved (`tryGetKey`,
 * `plugin-secret-enc.service.ts:149-172`), so every case builds a FRESH
 * instance; `process.env` is snapshotted and restored around each case, and the
 * service's "no key configured" warning is silenced so this spec's output stays
 * readable. Nothing here reads the wall clock or sleeps.
 */

const VALID_KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const WORK_ID = '11111111-1111-4111-8111-111111111111';

/** A value distinctive enough that "is it in the output?" is a real question. */
const SECRET = 'c4l3nds0-ENCRYPTION-KEY-must-never-appear';

const ENVIRONMENT_NAMES = ['production', 'development', 'test'] as const;

/**
 * The T8 write doors, as a counter-backed spy: `insertIfAbsent` is what
 * `ensureGenerated` uses and `upsertValue` is what `apply`/`rotate` use
 * (`work-app-env-value.repository.ts:148,172`).
 */
function createSpyStore() {
    const rows: { workId: string; name: string; valueEncrypted: string }[] = [];
    return {
        rows,
        insertIfAbsent: jest.fn(
            async (input: { workId: string; name: string; valueEncrypted: string }) => {
                rows.push({ ...input });
                return input;
            },
        ),
        upsertValue: jest.fn(
            async (
                workId: string,
                name: string,
                input: { valueEncrypted: string },
            ): Promise<void> => {
                rows.push({ workId, name, valueEncrypted: input.valueEncrypted });
            },
        ),
    };
}

describe('AppEnvCrypto (T9, plan §4.1:355-359)', () => {
    let savedKey: string | undefined;
    let savedNodeEnv: string | undefined;

    beforeEach(() => {
        savedKey = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        savedNodeEnv = process.env.NODE_ENV;
        // The plugin warns loudly when it has no key and `NODE_ENV !== 'test'`.
        // That warning is the plugin's own behaviour and carries no value; it is
        // silenced here only so three deliberately-keyless cases do not print it.
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (savedKey === undefined) {
            delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        } else {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = savedKey;
        }
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = savedNodeEnv;
        }
    });

    /** A crypto over a freshly constructed plugin service — the key is cached per instance. */
    const withKey = (hex: string | undefined): AppEnvCrypto => {
        if (hex === undefined) {
            delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        } else {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = hex;
        }
        return new AppEnvCrypto(new PluginSecretEncService());
    };

    describe('no key configured — refused in every environment (ACC-07-12, S21)', () => {
        it.each(ENVIRONMENT_NAMES)('refuses to encrypt under NODE_ENV=%s', (nodeEnv) => {
            process.env.NODE_ENV = nodeEnv;
            const crypto = withKey(undefined);

            expect(crypto.isAvailable()).toBe(false);
            expect(() => crypto.encrypt(SECRET)).toThrow(AppEnvEncryptionUnavailableError);
            try {
                crypto.encrypt(SECRET);
                throw new Error('encrypt returned instead of refusing');
            } catch (error) {
                expect(error).toBeInstanceOf(AppEnvEncryptionUnavailableError);
                const refusal = error as AppEnvEncryptionUnavailableError;
                // S21's sentence verbatim (`spec.md:169`) and its one message key
                // (`app-env.ts:398-400`, plan §5:802-805).
                expect(refusal.message).toBe(
                    "Secure storage isn't configured on this installation.",
                );
                expect(refusal.code).toBe('secureStorageUnavailable');
                expect(refusal.status).toBe(503);
                expect(refusal.messageKey).toBe(appEnvErrorMessageKey('secureStorageUnavailable'));
                // The value is not in the refusal.
                expect(refusal.message).not.toContain(SECRET);
                expect(JSON.stringify(refusal.message)).not.toContain(SECRET);
                expect(isAppEnvEncryptionUnavailableError(refusal)).toBe(true);
            }
        });

        it.each(ENVIRONMENT_NAMES)(
            'records ZERO repository writes for save and generate under NODE_ENV=%s (ACC-07-12)',
            async (nodeEnv) => {
                process.env.NODE_ENV = nodeEnv;
                const crypto = withKey(undefined);
                const store = createSpyStore();

                // The `apply` door of plan §4.2:375: encrypt, then `upsertValue`.
                const save = async (name: string, value: string): Promise<void> => {
                    const envelope = crypto.encrypt(value);
                    await store.upsertValue(WORK_ID, name, {
                        origin: 'user',
                        valueEncrypted: envelope,
                        valueBytes: Buffer.byteLength(value, 'utf8'),
                    } as never);
                };

                // The `ensureGenerated` door of plan §4.2:366: generate, encrypt, then
                // `insertIfAbsent` — `generateAppEnvValue` is T10's, so the generated
                // plaintext is stood in for here and only the refusal is under test.
                const ensureGenerated = async (name: string, generated: string): Promise<void> => {
                    const envelope = crypto.encrypt(generated);
                    await store.insertIfAbsent({
                        workId: WORK_ID,
                        name,
                        origin: 'generated',
                        valueEncrypted: envelope,
                        valueBytes: Buffer.byteLength(generated, 'utf8'),
                    } as never);
                };

                await expect(save('CALENDSO_ENCRYPTION_KEY', SECRET)).rejects.toBeInstanceOf(
                    AppEnvEncryptionUnavailableError,
                );
                await expect(ensureGenerated('JWT_SECRET', SECRET)).rejects.toBeInstanceOf(
                    AppEnvEncryptionUnavailableError,
                );

                expect(store.upsertValue).not.toHaveBeenCalled();
                expect(store.insertIfAbsent).not.toHaveBeenCalled();
                expect(store.rows).toHaveLength(0);
            },
        );

        it('fails closed on decrypt too — never hands back the ciphertext', () => {
            const crypto = withKey(undefined);
            const envelope = `${APP_ENV_ENVELOPE_PREFIX}Zm9v`;

            expect(() => crypto.decrypt(envelope)).toThrow(AppEnvEncryptionUnavailableError);
            try {
                crypto.decrypt(envelope);
                throw new Error('decrypt returned instead of refusing');
            } catch (error) {
                expect((error as Error).message).not.toContain('Zm9v');
            }
        });

        it('reports unavailable when the plugin service itself is absent (fail closed)', () => {
            const crypto = new AppEnvCrypto(undefined);
            expect(crypto.isAvailable()).toBe(false);
            expect(() => crypto.encrypt(SECRET)).toThrow(AppEnvEncryptionUnavailableError);
        });
    });

    describe('with a key configured — the round trip (FR-5)', () => {
        it('writes the enc::v1:: envelope and reads the exact value back', () => {
            const crypto = withKey(VALID_KEY);
            expect(crypto.isAvailable()).toBe(true);

            const envelope = crypto.encrypt(SECRET);
            expect(envelope.startsWith(APP_ENV_ENVELOPE_PREFIX)).toBe(true);
            expect(hasAppEnvEnvelope(envelope)).toBe(true);
            // The plaintext is not in the stored string, and neither is a
            // recognisable slice of it.
            expect(envelope).not.toContain(SECRET);
            expect(envelope).not.toContain(SECRET.slice(0, 12));
            expect(crypto.decrypt(envelope)).toBe(SECRET);
        });

        it('is the plugin envelope: another AppEnvCrypto over the same key reads it', () => {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = VALID_KEY;
            const first = new AppEnvCrypto(new PluginSecretEncService());
            const second = new AppEnvCrypto(new PluginSecretEncService());

            expect(second.decrypt(first.encrypt(SECRET))).toBe(SECRET);
        });

        it('never reuses an IV — the same value encrypts to a different envelope each time', () => {
            const crypto = withKey(VALID_KEY);
            const envelopes = new Set(Array.from({ length: 50 }, () => crypto.encrypt(SECRET)));
            expect(envelopes.size).toBe(50);
        });

        it.each([
            ['a single character', 'x'],
            ['a value at the 65,536-byte ceiling (FR-18)', 'q'.repeat(65_536)],
            ['a multi-byte value counted in bytes, not characters', 'é'.repeat(32)],
            ['an astral-plane value (surrogate pair)', '🔐-secret-🔐'],
            ['a value with a NUL-adjacent control character', 'line1\nline2\ttab'],
        ])('round-trips %s', (_label, value) => {
            const crypto = withKey(VALID_KEY);
            const envelope = crypto.encrypt(value);
            expect(crypto.decrypt(envelope)).toBe(value);
        });

        it('refuses the empty string, whose envelope the plugin cannot read back', () => {
            // Not a rule of this epic: `PluginSecretEncService.decryptValue`
            // rejects any body shorter than IV + TAG + 1 = 29 bytes
            // (`plugin-secret-enc.service.ts:97-100`) and returns the ENVELOPE
            // unchanged, and an empty plaintext produces exactly 28 bytes. So
            // `encrypt('')` would create a row whose ciphertext reaches an app as
            // the value. It is refused here, and reported to the coordinator as
            // the one line of the plugin that would close it.
            const crypto = withKey(VALID_KEY);

            expect(() => crypto.encrypt('')).toThrow(AppEnvEnvelopeError);
            try {
                crypto.encrypt('');
            } catch (error) {
                expect((error as AppEnvEnvelopeError).code).toBe('valueUnstorable');
            }
            expect(crypto.isAvailable()).toBe(true);
        });

        it("refuses a second key's envelope instead of returning ciphertext", () => {
            const writer = withKey(VALID_KEY);
            const envelope = writer.encrypt(SECRET);
            const reader = withKey(OTHER_KEY);

            expect(() => reader.decrypt(envelope)).toThrow(AppEnvEnvelopeError);
            try {
                reader.decrypt(envelope);
            } catch (error) {
                expect((error as Error).message).not.toContain(envelope);
            }
        });
    });

    describe('unprefixed input is refused (plan §4.1:359)', () => {
        it.each([
            ['a bare plaintext value', SECRET],
            ['a value with no prefix at all', 'Zm9vYmFy'],
            ['the wrong case', `ENC::V1::Zm9v`],
            ['a later envelope version', 'enc::v2::Zm9v'],
            ['the empty string', ''],
            ['just the prefix', APP_ENV_ENVELOPE_PREFIX],
            ['a prefix with nothing after it but spaces', `${APP_ENV_ENVELOPE_PREFIX}   `],
        ])('refuses %s', (_label, input) => {
            const crypto = withKey(VALID_KEY);

            expect(() => crypto.decrypt(input)).toThrow(AppEnvEnvelopeError);
            try {
                crypto.decrypt(input);
                throw new Error('decrypt returned instead of refusing');
            } catch (error) {
                const refusal = error as AppEnvEnvelopeError;
                expect(refusal).toBeInstanceOf(AppEnvEnvelopeError);
                // Two doors, two codes: input that is not an envelope at all is
                // `envelopeInvalid`; input that carries the prefix but no readable
                // body is `envelopeUndecryptable` (the plugin hands it back).
                expect(refusal.code).toBe(
                    hasAppEnvEnvelope(input) ? 'envelopeUndecryptable' : 'envelopeInvalid',
                );
                expect(isAppEnvEnvelopeError(refusal)).toBe(true);
                // The refused input is never echoed back. The prefix itself is the
                // one exception: the refusal legitimately names the envelope shape,
                // and naming `enc::v1::` says nothing about the stored value.
                if (input.length > 0 && input !== APP_ENV_ENVELOPE_PREFIX) {
                    expect(refusal.message).not.toContain(input);
                }
            }
        });

        it('answers hasAppEnvEnvelope false for anything that is not a prefixed body', () => {
            const crypto = withKey(VALID_KEY);

            for (const input of [
                SECRET,
                'Zm9vYmFy',
                `ENC::V1::Zm9v`,
                'enc::v2::Zm9v',
                '',
                APP_ENV_ENVELOPE_PREFIX,
            ]) {
                expect(hasAppEnvEnvelope(input)).toBe(false);
                expect(() => crypto.decrypt(input)).toThrow(AppEnvEnvelopeError);
            }

            // The positive direction, so the guard is not vacuous: a body after
            // the prefix is what makes it an envelope.
            const envelope = crypto.encrypt(SECRET);
            expect(hasAppEnvEnvelope(envelope)).toBe(true);
            expect(hasAppEnvEnvelope(`${APP_ENV_ENVELOPE_PREFIX}   `)).toBe(true);
        });

        it('refuses a whitespace-only body the plugin would hand back unchanged', () => {
            const crypto = withKey(VALID_KEY);
            expect(() => crypto.decrypt(`${APP_ENV_ENVELOPE_PREFIX}   `)).toThrow(
                AppEnvEnvelopeError,
            );
        });

        it('refuses a malformed body that carries the prefix', () => {
            const crypto = withKey(VALID_KEY);
            expect(() => crypto.decrypt(`${APP_ENV_ENVELOPE_PREFIX}not-base64!!`)).toThrow(
                AppEnvEnvelopeError,
            );
        });
    });

    describe("the envelope prefix is the plugin's, not a second copy", () => {
        it('is literally enc::v1:: (plan §4.1:359, entity doc `work-app-env-value.entity.ts:29`)', () => {
            expect(APP_ENV_ENVELOPE_PREFIX).toBe('enc::v1::');
        });

        it('agrees with PluginSecretEncService: an envelope it wrote is accepted here', () => {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = VALID_KEY;
            const plugin = new PluginSecretEncService();
            const crypto = new AppEnvCrypto(plugin);

            expect(crypto.decrypt(plugin.encryptValue(SECRET))).toBe(SECRET);
        });
    });
});
