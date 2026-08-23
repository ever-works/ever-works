import { BadRequestException } from '@nestjs/common';
import { WorkRuntimeEnvService } from './work-runtime-env.service';
import {
    WORK_RUNTIME_ENV_ALLOWED_KEYS,
    WORK_RUNTIME_ENV_MAX_VALUE_LENGTH,
    WORK_RUNTIME_ENV_SECRET_KEYS,
    maskWorkRuntimeEnvValue,
} from './work-runtime-env.constants';

/**
 * Allow-listed per-Work runtime env (Stripe keys & co.) — the operator-managed
 * map stored encrypted on `works.deployRuntimeEnvEncrypted`.
 *
 * Covers: allow-list rejection (nothing written), merge / overwrite / remove
 * semantics, trimming + length cap, AES-256-GCM round-trip through the real
 * encrypt/decrypt helpers, and the masked API view.
 */
describe('WorkRuntimeEnvService — allow-listed per-Work env vars', () => {
    const ORIGINAL_KEY = process.env.PLATFORM_ENCRYPTION_KEY;
    // 32 bytes, hex-encoded — what the service expects for AES-256-GCM.
    const TEST_KEY_HEX = 'ab'.repeat(32);

    type StoredWork = {
        id: string;
        deployRuntimeEnvEncrypted: string | null;
        deployAuthSecretEncrypted?: string | null;
        deployCookieSecretEncrypted?: string | null;
        deployDatabaseUrlEncrypted?: string | null;
        deployDatabaseMode?: 'shared' | 'custom' | null;
    };

    let work: StoredWork;
    let workRepository: {
        findById: jest.Mock;
        update: jest.Mock;
    };
    let service: WorkRuntimeEnvService;

    beforeEach(() => {
        process.env.PLATFORM_ENCRYPTION_KEY = TEST_KEY_HEX;
        work = { id: 'work-1', deployRuntimeEnvEncrypted: null };
        workRepository = {
            findById: jest.fn(async (id: string) => (id === work.id ? { ...work } : null)),
            update: jest.fn(async (_id: string, patch: Partial<StoredWork>) => {
                Object.assign(work, patch);
                return { ...work };
            }),
        };
        service = new WorkRuntimeEnvService(workRepository as never);
    });

    afterEach(() => {
        if (ORIGINAL_KEY === undefined) {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
        } else {
            process.env.PLATFORM_ENCRYPTION_KEY = ORIGINAL_KEY;
        }
        jest.restoreAllMocks();
    });

    describe('allow-list', () => {
        it('exposes the allow-list in display order', () => {
            expect(service.getAllowedEnvKeys()).toEqual(WORK_RUNTIME_ENV_ALLOWED_KEYS);
            expect(WORK_RUNTIME_ENV_ALLOWED_KEYS).toEqual(
                expect.arrayContaining([
                    'STRIPE_SECRET_KEY',
                    'STRIPE_PUBLISHABLE_KEY',
                    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
                    'STRIPE_WEBHOOK_SECRET',
                    'NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING',
                    'STRIPE_SPONSOR_WEEKLY_PRICE_ID',
                    'STRIPE_SPONSOR_MONTHLY_PRICE_ID',
                    'NEXT_PUBLIC_PAYMENT_PROVIDER',
                ]),
            );
        });

        it('never allow-lists the platform-managed keys', () => {
            for (const managed of [
                'AUTH_SECRET',
                'COOKIE_SECRET',
                'DATABASE_URL',
                'GH_TOKEN',
                'DATA_REPOSITORY',
                'TENANT_ID',
                'WORK_ID',
                'SITE_URL',
                'PLATFORM_API_SECRET_TOKEN',
            ]) {
                expect(WORK_RUNTIME_ENV_ALLOWED_KEYS as readonly string[]).not.toContain(managed);
            }
        });

        it('rejects keys outside the allow-list with a 400 and writes nothing', async () => {
            await expect(
                service.setRuntimeEnvVars('work-1', {
                    STRIPE_SECRET_KEY: 'sk_live_abc',
                    DATABASE_URL: 'postgres://evil',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.setRuntimeEnvVars('work-1', { AUTH_SECRET: 'x' })).rejects.toThrow(
                /Unsupported runtime env key\(s\): AUTH_SECRET/,
            );
            // The whole call is rejected atomically — the valid key was NOT written.
            expect(workRepository.update).not.toHaveBeenCalled();
            expect(work.deployRuntimeEnvEncrypted).toBeNull();
        });

        it('rejects non-string values', async () => {
            await expect(
                service.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: 42 as never }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('throws when the Work does not exist', async () => {
            await expect(
                service.setRuntimeEnvVars('missing', { STRIPE_SECRET_KEY: 'sk' }),
            ).rejects.toThrow(/Work not found/);
        });
    });

    describe('merge / remove semantics', () => {
        it('returns an empty map when nothing is configured', async () => {
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({});
            await expect(service.getRuntimeEnvVars('missing')).resolves.toEqual({});
        });

        it('provided keys overwrite, untouched keys persist, and null/empty removes', async () => {
            await service.setRuntimeEnvVars('work-1', {
                STRIPE_SECRET_KEY: 'sk_live_one',
                NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe',
            });
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({
                NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe',
                STRIPE_SECRET_KEY: 'sk_live_one',
            });

            // Overwrite one key; the other survives.
            const afterOverwrite = await service.setRuntimeEnvVars('work-1', {
                STRIPE_SECRET_KEY: 'sk_live_two',
            });
            expect(afterOverwrite).toEqual({
                NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe',
                STRIPE_SECRET_KEY: 'sk_live_two',
            });

            // null removes; '' / whitespace-only remove too.
            await service.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: null });
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({
                NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe',
            });
            await service.setRuntimeEnvVars('work-1', { NEXT_PUBLIC_PAYMENT_PROVIDER: '   ' });
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({});
            // Removing the last key clears the column entirely (NULL, not an
            // encrypted "{}").
            expect(work.deployRuntimeEnvEncrypted).toBeNull();
        });

        it('removing a key that was never set is a no-op', async () => {
            const result = await service.setRuntimeEnvVars('work-1', {
                STRIPE_WEBHOOK_SECRET: null,
            });
            expect(result).toEqual({});
            expect(work.deployRuntimeEnvEncrypted).toBeNull();
        });

        it('trims values and enforces the maximum length', async () => {
            await service.setRuntimeEnvVars('work-1', {
                STRIPE_PUBLISHABLE_KEY: '  pk_live_trimmed  ',
            });
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({
                STRIPE_PUBLISHABLE_KEY: 'pk_live_trimmed',
            });

            const tooLong = 'x'.repeat(WORK_RUNTIME_ENV_MAX_VALUE_LENGTH + 1);
            await expect(
                service.setRuntimeEnvVars('work-1', { STRIPE_PUBLISHABLE_KEY: tooLong }),
            ).rejects.toThrow(/exceeds the maximum length/);
            // Exactly the cap is fine.
            const atCap = 'y'.repeat(WORK_RUNTIME_ENV_MAX_VALUE_LENGTH);
            await service.setRuntimeEnvVars('work-1', { STRIPE_PUBLISHABLE_KEY: atCap });
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({
                STRIPE_PUBLISHABLE_KEY: atCap,
            });
        });

        it('rejects values containing control characters (e.g. a stray newline)', async () => {
            const withNewline = 'sk_live_abc' + String.fromCharCode(10) + 'def';
            await expect(
                service.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: withNewline }),
            ).rejects.toThrow(/control characters/);
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('persists keys in allow-list order regardless of input order', async () => {
            await service.setRuntimeEnvVars('work-1', {
                STRIPE_SPONSOR_MONTHLY_PRICE_ID: 'price_m',
                NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe',
                STRIPE_SECRET_KEY: 'sk',
            });
            const keys = Object.keys(await service.getRuntimeEnvVars('work-1'));
            expect(keys).toEqual([
                'NEXT_PUBLIC_PAYMENT_PROVIDER',
                'STRIPE_SECRET_KEY',
                'STRIPE_SPONSOR_MONTHLY_PRICE_ID',
            ]);
        });
    });

    describe('encryption round-trip', () => {
        it('stores ciphertext (not plaintext) and decrypts back to the same map', async () => {
            await service.setRuntimeEnvVars('work-1', {
                STRIPE_SECRET_KEY: 'sk_live_supersecret',
                STRIPE_WEBHOOK_SECRET: 'whsec_123',
            });
            const stored = work.deployRuntimeEnvEncrypted as string;
            expect(stored).toBeTruthy();
            expect(stored).not.toContain('sk_live_supersecret');
            expect(stored).not.toContain('whsec_123');
            expect(stored).not.toContain('STRIPE_SECRET_KEY');
            // base64 envelope: iv(12) + tag(16) + ciphertext
            expect(Buffer.from(stored, 'base64').length).toBeGreaterThan(12 + 16);

            // A fresh service instance (cold key cache) decrypts it.
            const fresh = new WorkRuntimeEnvService(workRepository as never);
            await expect(fresh.getRuntimeEnvVars('work-1')).resolves.toEqual({
                STRIPE_SECRET_KEY: 'sk_live_supersecret',
                STRIPE_WEBHOOK_SECRET: 'whsec_123',
            });
        });

        it('uses a random IV — re-encrypting the same map yields a different envelope', async () => {
            await service.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: 'sk' });
            const first = work.deployRuntimeEnvEncrypted;
            await service.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: 'sk' });
            const second = work.deployRuntimeEnvEncrypted;
            expect(first).toBeTruthy();
            expect(second).toBeTruthy();
            expect(first).not.toBe(second);
        });

        it('drops keys that are no longer allow-listed when reading a stored map', async () => {
            // Simulate a legacy envelope that carries an extra key: encrypt
            // through the service's own helper so the envelope is valid.
            const encrypt = (service as unknown as { encrypt: (s: string) => string }).encrypt.bind(
                service,
            );
            work.deployRuntimeEnvEncrypted = encrypt(
                JSON.stringify({
                    STRIPE_SECRET_KEY: 'sk',
                    DATABASE_URL: 'postgres://should-not-leak',
                    NOT_A_KEY: 1,
                }),
            );
            await expect(service.getRuntimeEnvVars('work-1')).resolves.toEqual({
                STRIPE_SECRET_KEY: 'sk',
            });
        });

        it('fails loudly (not silently) on a tampered envelope', async () => {
            await service.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: 'sk' });
            const buf = Buffer.from(work.deployRuntimeEnvEncrypted as string, 'base64');
            buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
            work.deployRuntimeEnvEncrypted = buf.toString('base64');
            jest.spyOn(
                (service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger,
                'error',
            ).mockImplementation(() => {});
            await expect(service.getRuntimeEnvVars('work-1')).rejects.toThrow(/malformed/);
        });

        it('refuses to encrypt without PLATFORM_ENCRYPTION_KEY', async () => {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
            const noKey = new WorkRuntimeEnvService(workRepository as never);
            await expect(
                noKey.setRuntimeEnvVars('work-1', { STRIPE_SECRET_KEY: 'sk' }),
            ).rejects.toThrow(/PLATFORM_ENCRYPTION_KEY is not set/);
            expect(work.deployRuntimeEnvEncrypted).toBeNull();
        });
    });

    describe('masked API view', () => {
        it('lists every allow-listed key, unset ones as { set:false, masked:null }', async () => {
            const view = await service.describeRuntimeEnvVars('work-1');
            expect(view.map((v) => v.key)).toEqual([...WORK_RUNTIME_ENV_ALLOWED_KEYS]);
            for (const entry of view) {
                expect(entry.set).toBe(false);
                expect(entry.masked).toBeNull();
                expect(entry.secret).toBe(WORK_RUNTIME_ENV_SECRET_KEYS.has(entry.key));
            }
        });

        it('masks secrets to *** and non-secrets to a short prefix', async () => {
            await service.setRuntimeEnvVars('work-1', {
                STRIPE_SECRET_KEY: 'sk_live_1234567890',
                STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghij',
                NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_1234567890',
                NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe',
            });
            const view = await service.describeRuntimeEnvVars('work-1');
            const byKey = Object.fromEntries(view.map((v) => [v.key, v]));

            expect(byKey.STRIPE_SECRET_KEY).toEqual({
                key: 'STRIPE_SECRET_KEY',
                set: true,
                masked: '***',
                secret: true,
            });
            expect(byKey.STRIPE_WEBHOOK_SECRET.masked).toBe('***');
            expect(byKey.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toEqual({
                key: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
                set: true,
                masked: 'pk_live…',
                secret: false,
            });
            // Short non-secret toggles/enum values are shown verbatim.
            expect(byKey.NEXT_PUBLIC_PAYMENT_PROVIDER.masked).toBe('stripe');
            expect(byKey.STRIPE_PUBLISHABLE_KEY).toEqual({
                key: 'STRIPE_PUBLISHABLE_KEY',
                set: false,
                masked: null,
                secret: false,
            });

            // Never the plaintext.
            const serialized = JSON.stringify(view);
            expect(serialized).not.toContain('sk_live_1234567890');
            expect(serialized).not.toContain('whsec_abcdefghij');
            expect(serialized).not.toContain('pk_live_1234567890');
        });

        it('maskWorkRuntimeEnvValue helper matches the service view', () => {
            expect(maskWorkRuntimeEnvValue('STRIPE_SECRET_KEY', 'sk_live_x')).toBe('***');
            expect(maskWorkRuntimeEnvValue('STRIPE_SPONSOR_WEEKLY_PRICE_ID', 'price_1Hxyz')).toBe(
                'price_1…',
            );
            expect(maskWorkRuntimeEnvValue('NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING', 'true')).toBe(
                'true',
            );
        });
    });
});
