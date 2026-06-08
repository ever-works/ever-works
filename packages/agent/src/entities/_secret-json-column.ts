import { Column, type ColumnOptions } from 'typeorm';
import { PluginSecretEncService } from '../plugins/services/plugin-secret-enc.service';

/**
 * EW-716 #22 — a `simple-json` column whose values are envelope-encrypted at
 * rest. Every value in the stored JSON object is AES-256-GCM encrypted with the
 * `enc::v1::` envelope (the same `PluginSecretEncService` used for plugin
 * `secretSettings`), so credentials carried in the column (e.g. a
 * `notification_channels.targetConfig` Telegram `botToken`, Slack/Discord
 * `webhookUrl`, WhatsApp `accessToken`, Novu `apiKey`) are never persisted in
 * plaintext.
 *
 * The encryption is a TypeORM column transformer, so it is fully transparent:
 * EVERY reader (service responses, the channel-send facade, future call sites)
 * receives the decrypted plaintext object, and EVERY writer stores ciphertext —
 * there is no read path to forget. Behaviour notes:
 *   - **No key configured** (dev/preview): values pass through as plaintext
 *     (PluginSecretEncService dev-convenience) — no boot break for contributors.
 *   - **Legacy plaintext rows** (written before this column was encrypted):
 *     decrypt passes them through unchanged (no `enc::v1::` prefix) and they are
 *     re-encrypted on the next write.
 *   - **Value types**: non-string values are JSON-stringified on encrypt and
 *     return as strings on decrypt (the documented `PluginSecretEncService`
 *     contract). Every known `targetConfig` field is already a string, so this
 *     is lossless in practice.
 *   - **No DDL change**: the column stays `simple-json` (portable Postgres
 *     `jsonb` / SQLite text); the transformer is application-layer only, so no
 *     migration is required.
 */

// Stateless except a lazily-cached key read from PLUGIN_SECRET_ENCRYPTION_KEY;
// safe to instantiate once at module load (no DI dependencies, no env read
// until the first encrypt/decrypt).
const enc = new PluginSecretEncService();

export const EncryptedJsonColumn = ({ nullable = false }: { nullable?: boolean } = {}) => {
    // DTS-emit gotcha (CLAUDE.md): build options imperatively rather than with
    // conditional spreads, which produce `string | false` and break declaration
    // generation.
    const opts: ColumnOptions = {
        type: 'simple-json',
        nullable,
        transformer: {
            to: (value: Record<string, unknown> | null | undefined) =>
                value == null ? value : enc.encryptRecord(value),
            from: (value: Record<string, unknown> | null | undefined) =>
                value == null ? value : enc.decryptRecord(value),
        },
    };
    return Column(opts);
};
