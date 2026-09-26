import { Injectable, Optional } from '@nestjs/common';
import { appEnvErrorMessageKey } from '@ever-works/contracts';
import { PluginSecretEncService } from '../plugins/services/plugin-secret-enc.service';

/**
 * APW-07 (App env & dependencies) — the crypto seam of the Environment table.
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * FR-5 (a stored value exists only as ciphertext), FR-18/FR-31 (the byte
 * ceilings), S21 (`spec.md:168-170`), ACC-07-12 (`spec.md:592`).
 * Plan: §4.1 (`plan.md:355-359`) is this file's contract of record;
 * §3.1 (`plan.md:176-193`) is the column this writes into
 * (`work_app_env_values.valueEncrypted`, NOT NULL);
 * §4.6.1 (`plan.md:444-447`) and §2.2 (`plan.md:127-150`) are the two callers
 * that read through it.
 *
 * ## It WRAPS `PluginSecretEncService`; it does not re-implement it
 *
 * The AES-256-GCM envelope — random 12-byte IV, 16-byte GCM auth tag,
 * base64(`IV ‖ tag ‖ ciphertext`) behind the `enc::v1::` prefix — is C-08's
 * (`packages/agent/src/plugins/services/plugin-secret-enc.service.ts:22-26,
 * 59-71`) and is reused verbatim. Two behaviours of that service are
 * **deliberate for plugin settings and wrong for this table**, and closing them
 * is the whole reason this class exists:
 *
 *   1. **Passthrough with no key.** `encryptValue` returns the plaintext
 *      unchanged when `PLUGIN_SECRET_ENCRYPTION_KEY` is unset — "useful for
 *      dev / preview / tests" (`:9-12, 59-64`). `work_app_env_values` is a table
 *      of secrets and its `valueEncrypted` column is NOT NULL, so there is no
 *      such thing as a plaintext row: {@link encrypt} answers
 *      {@link AppEnvEncryptionUnavailableError} (HTTP 503
 *      `secureStorageUnavailable`, S21) instead, **in every `NODE_ENV`** —
 *      `production` where the plugin enforces it at boot
 *      (`assertKeyAvailableInProd`, `:44-51`), and `development`/`test` where
 *      the plugin would have silently degraded. ACC-07-12's "the table has zero
 *      rows written" is a property of the ORDER the callers use (encrypt, then
 *      write — plan §4.2:366,375) and not of a check inside the repository, so
 *      nothing here may return a value the caller could store.
 *   2. **Legacy plaintext on read.** `decryptValue` returns an unprefixed string
 *      unchanged, which is the Q-5(a) migration arm for rows that predate the
 *      plugin cutover (`:14-20, 81-84`). These two tables are new, so an
 *      unprefixed `valueEncrypted` is a defect rather than a migration, and a
 *      ciphertext the plugin could not read must never be handed to an app as
 *      if it were the value: {@link decrypt} refuses both
 *      ({@link AppEnvEnvelopeError}).
 *
 * ## An invalid key is loud, not a 503
 *
 * `PLUGIN_SECRET_ENCRYPTION_KEY` that is present but not 32 hex bytes makes the
 * plugin's `tryGetKey` **throw** (`:161-169`). That is an operator error with
 * exactly one fix and it propagates: turning it into `secureStorageUnavailable`
 * would tell the member "this installation has no encryption key" when the
 * truth is "the key is malformed", which is a different person's problem.
 * Only an ABSENT key is the 503.
 *
 * ## Fail closed when the collaborator is absent
 *
 * `PluginSecretEncService` is `@Optional()` so a hand-rolled construction (a
 * unit test, a lean CLI context) can build this class, exactly as
 * `app-upstream-state.service.ts:416-439` documents for its own seams. An
 * unbound service means no envelope can be produced, which is
 * {@link isAvailable} `false` — never a plaintext fallback.
 */

/**
 * The envelope prefix — the plugin's own constant, restated here because the
 * plugin does not export it (`plugin-secret-enc.service.ts:26`) and this module
 * must be able to answer "is this an envelope?" without decrypting anything.
 * The last case of `__tests__/app-env-crypto.spec.ts` pins the two against each
 * other, so a change on either side fails a test instead of silently writing
 * rows the other side cannot read.
 */
export const APP_ENV_ENVELOPE_PREFIX = 'enc::v1::';

/**
 * The 503 of S21 / plan §5:798-802: this installation has no encryption key, so
 * nothing can be stored at all — saving **and** generating are refused
 * (ACC-07-12), and the message is the spec's sentence, never a paraphrase.
 *
 * The `code`/`status`/`messageKey` trio follows the package's existing typed
 * refusals (`app-works/app-upstream-state.service.ts:172-189`), so a controller
 * can map it without re-deriving the HTTP answer; `messageKey` comes from the
 * contract's one resolver (`app-env.ts:398-400`) rather than a second copy of
 * the path.
 */
export class AppEnvEncryptionUnavailableError extends Error {
    readonly code = 'secureStorageUnavailable' as const;
    readonly status = 503 as const;
    readonly messageKey = appEnvErrorMessageKey('secureStorageUnavailable');

    constructor() {
        super("Secure storage isn't configured on this installation.");
        this.name = 'AppEnvEncryptionUnavailableError';
    }
}

/** Whether a caught value is {@link AppEnvEncryptionUnavailableError}, across bundles. */
export function isAppEnvEncryptionUnavailableError(
    value: unknown,
): value is AppEnvEncryptionUnavailableError {
    if (value instanceof AppEnvEncryptionUnavailableError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppEnvEncryptionUnavailableError' &&
        (value as { code?: unknown }).code === 'secureStorageUnavailable'
    );
}

/**
 * A stored string that is not a readable `enc::v1::` envelope of this
 * installation — plan §4.1:359.
 *
 * There is deliberately **no** member-facing message key for this: the contract's
 * `APP_ENV_ERROR_CODES` (`app-env.ts:331-343`) is the vocabulary of what a member
 * can be told, and this is not one of them. Nothing a member types reaches this
 * error — the value is always written by {@link AppEnvCrypto.encrypt} first — so
 * it is a defect signal (Q-5(a) legacy rows, a truncated column, a rotated key)
 * that must fail closed and be reported, not a refusal to render.
 */
export class AppEnvEnvelopeError extends Error {
    /**
     * `envelopeInvalid` — not an envelope of this shape;
     * `envelopeUndecryptable` — right shape, wrong key / truncated body;
     * `valueUnstorable` — a plaintext this envelope cannot carry (see
     * {@link AppEnvCrypto.encrypt}).
     */
    readonly code: 'envelopeInvalid' | 'envelopeUndecryptable' | 'valueUnstorable';

    /** The underlying plugin failure, when there was one (`Error.cause`, declared for ES2021). */
    readonly cause?: unknown;

    constructor(
        code: 'envelopeInvalid' | 'envelopeUndecryptable' | 'valueUnstorable',
        message: string,
        cause?: unknown,
    ) {
        super(message);
        this.name = 'AppEnvEnvelopeError';
        this.code = code;
        if (cause !== undefined) {
            // `Error`'s `{ cause }` option is ES2022 and this package targets
            // ES2021, so the field is attached here rather than through `super`.
            this.cause = cause;
        }
    }
}

/** Whether a caught value is {@link AppEnvEnvelopeError}, across bundles. */
export function isAppEnvEnvelopeError(value: unknown): value is AppEnvEnvelopeError {
    if (value instanceof AppEnvEnvelopeError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppEnvEnvelopeError' &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

/**
 * True when `value` is a string that carries the `enc::v1::` prefix **and**
 * something after it — i.e. could be an envelope this class wrote.
 *
 * The body check is not pedantry: `'enc::v1::'` alone is a truncated column read,
 * and `PluginSecretEncService.decryptValue` answers it by returning the input
 * unchanged (`:97-100`), which is exactly the "ciphertext handed to an app" case
 * {@link AppEnvCrypto.decrypt} refuses.
 */
export function hasAppEnvEnvelope(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.startsWith(APP_ENV_ENVELOPE_PREFIX) &&
        value.length > APP_ENV_ENVELOPE_PREFIX.length
    );
}

@Injectable()
export class AppEnvCrypto {
    constructor(
        // `@Optional()` for the reason the class docstring gives: an unbound
        // service is "no key", which is a 503, not a plaintext fallback.
        @Optional() private readonly secrets?: PluginSecretEncService,
    ) {}

    /**
     * True when this installation can produce and read envelopes — the check
     * every caller needs before it decides whether a save is even attempted
     * (`AppEnvService.apply` / `ensureGenerated`, plan §4.2:366-367).
     *
     * Unbound collaborator or unset key ⇒ `false`. A malformed key **throws**,
     * deliberately — see the class docstring.
     */
    isAvailable(): boolean {
        return this.secrets !== undefined && this.secrets !== null && this.secrets.isEnabled();
    }

    /**
     * Throw {@link AppEnvEncryptionUnavailableError} unless a value can be
     * encrypted. Callers that must answer before doing any work (the 503 of
     * ACC-07-12) call this directly; {@link encrypt} calls it too, so the
     * refusal can never be skipped by accident.
     */
    assertAvailable(): void {
        if (!this.isAvailable()) {
            throw new AppEnvEncryptionUnavailableError();
        }
    }

    /**
     * Encrypt one value into the `enc::v1::` envelope `valueEncrypted` stores.
     *
     * Refuses before anything is produced when the installation has no key, in
     * every `NODE_ENV` — the caller's next statement is the repository write, so
     * a throw here is what makes ACC-07-12's "zero rows written" true.
     *
     * ⚠️ **The empty string is refused, and that is a limitation of the wrapped
     * envelope rather than a rule of this epic.** `PluginSecretEncService`
     * encrypts `''` to a 28-byte body (12-byte IV + 16-byte auth tag + zero
     * ciphertext), and its reader classifies anything shorter than
     * `IV + TAG + 1 = 29` bytes as malformed and returns the ENVELOPE unchanged
     * (`plugin-secret-enc.service.ts:97-100`). So a stored empty value would be a
     * row whose ciphertext is handed to an app as if it were the value — the one
     * outcome FR-5 exists to prevent. Refusing here keeps `encrypt`/`decrypt`
     * consistent: every envelope this method returns is one {@link decrypt} can
     * read back. Closing it properly needs one line in the plugin
     * (`<= IV + TAG`, or a `+ 1` dropped), which T9 must not edit — it is
     * reported to the coordinator instead. A caller that treats "the member
     * cleared the field" as `unset` rather than as a stored `''` never meets it.
     *
     * Every other value — including a single character and one at the 65,536-byte
     * ceiling — round-trips exactly.
     */
    encrypt(value: string): string {
        this.assertAvailable();

        if (value.length === 0) {
            throw new AppEnvEnvelopeError(
                'valueUnstorable',
                'An empty value cannot be stored: its encryption envelope is not readable back.',
            );
        }

        return this.secrets!.encryptValue(value);
    }

    /**
     * Decrypt one stored envelope back to its value.
     *
     * Three refusals, and each one is a case that would otherwise hand something
     * that is not the value to an app:
     *
     *   1. **No key** ⇒ {@link AppEnvEncryptionUnavailableError}. The plugin would
     *      throw its own error here (`:86-95`); answering the epic's 503 keeps one
     *      meaning for "this installation cannot read its own storage".
     *   2. **Not an envelope** (no prefix, or the prefix with nothing after it) ⇒
     *      {@link AppEnvEnvelopeError} `envelopeInvalid`. The plugin returns
     *      unprefixed input unchanged, which for these tables would be a
     *      plaintext value that no code path can have written (§4.1:359).
     *   3. **An envelope this class wrote but cannot read** — a truncated body,
     *      a rotated key, another installation's row ⇒ `envelopeUndecryptable`.
     *      The plugin's too-short arm returns the input unchanged (`:97-100`), so
     *      the post-condition below is what stops ciphertext reaching the app.
     */
    decrypt(envelope: string): string {
        this.assertAvailable();

        if (!hasAppEnvEnvelope(envelope)) {
            throw new AppEnvEnvelopeError(
                'envelopeInvalid',
                `The stored value is not an ${APP_ENV_ENVELOPE_PREFIX} envelope of this installation.`,
            );
        }

        let plaintext: string;
        try {
            plaintext = this.secrets!.decryptValue(envelope);
        } catch (error) {
            throw new AppEnvEnvelopeError(
                'envelopeUndecryptable',
                'The stored value could not be decrypted with this installation’s key.',
                error,
            );
        }

        if (plaintext === envelope) {
            // The plugin's own "malformed / too short, return the input" arm.
            throw new AppEnvEnvelopeError(
                'envelopeUndecryptable',
                'The stored value is not a readable envelope of this installation.',
            );
        }

        return plaintext;
    }
}
