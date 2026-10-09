import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { statsKeyId } from '@ever-co/connect-sdk';
import { DataSource } from 'typeorm';
import { EverInstance } from '../../entities/ever-instance.entity';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import { EverInstanceKeyUnreadableError, EverInstanceService } from '../ever-instance.service';

/**
 * The installation identity: one row however many replicas boot at once, the
 * Ever Platform SDK's `StatsSigner` over the stored key (a signature that
 * verifies with the stored public key over exactly the bytes signed), a
 * private key that is stored only wrapped, and a reset that changes both the
 * id and the key.
 */
describe('EverInstanceService', () => {
    let dataSource: DataSource;
    const previousKey = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;

    beforeAll(() => {
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = 'ab'.repeat(32);
    });

    afterAll(() => {
        if (previousKey === undefined) delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        else process.env.PLUGIN_SECRET_ENCRYPTION_KEY = previousKey;
    });

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [EverInstance],
            synchronize: true,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const service = () =>
        new EverInstanceService(
            dataSource.getRepository(EverInstance),
            new PluginSecretEncService(),
        );

    it('creates exactly one identity when replicas race on first boot', async () => {
        const rows = await Promise.all([
            service().ensure(),
            service().ensure(),
            service().ensure(),
        ]);
        expect(new Set(rows.map((row) => row.instanceId)).size).toBe(1);
        expect(await dataSource.getRepository(EverInstance).count()).toBe(1);
        expect(rows[0]).toMatchObject({ id: 'self', statsEnabledUi: true, resetCount: 0 });
        expect(rows[0].instanceId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(rows[0].connectPublicKey ?? null).toBeNull();
    });

    it('signs exactly the given bytes; the signature verifies with the stored public key', async () => {
        const identity = service();
        const row = await identity.ensure();
        const body = Buffer.from('{"schema":"ever.stats.v1"}', 'utf8');
        const signer = await identity.statsSigner();
        const signature = Buffer.from(signer.sign(new Uint8Array(body)));

        expect(signer.publicKey).toBe(row.statsPublicKey);
        const key = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: row.statsPublicKey },
            format: 'jwk',
        });
        expect(cryptoVerify(null, body, key, signature)).toBe(true);
        expect(cryptoVerify(null, Buffer.from(`${body} `), key, signature)).toBe(false);
        expect(Buffer.from(row.statsPublicKey, 'base64url')).toHaveLength(32);
        expect(signature).toHaveLength(64);
        expect(row.statsKeyId).toBe(statsKeyId(row.statsPublicKey));
        expect(row.statsKeyId).toHaveLength(11);
    });

    it('stores the private key only in its wrapped form', async () => {
        const row = await service().ensure();
        expect(row.statsPrivateKeyEncrypted.startsWith('enc::v1::')).toBe(true);
        // A different process (another replica) reads and uses the same key.
        const body = new Uint8Array(Buffer.from('x'));
        const a = await service().statsSigner();
        const b = await service().statsSigner();
        expect(a.publicKey).toBe(b.publicKey);
        expect(Buffer.from(a.sign(body))).toEqual(Buffer.from(b.sign(body)));
    });

    it('cannot sign once the encryption key is gone, and says only that', async () => {
        await service().ensure();
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = 'cd'.repeat(32);
        try {
            const identity = service();
            await expect(identity.statsSigner()).rejects.toBeInstanceOf(
                EverInstanceKeyUnreadableError,
            );
            expect(await identity.isKeyReadable()).toBe(false);
        } finally {
            process.env.PLUGIN_SECRET_ENCRYPTION_KEY = 'ab'.repeat(32);
        }
    });

    it('reset gives a new instance id AND a new key, and counts the reset', async () => {
        const identity = service();
        const before = await identity.ensure();
        const after = await identity.reset();
        expect(after.instanceId).not.toBe(before.instanceId);
        expect(after.statsPublicKey).not.toBe(before.statsPublicKey);
        expect(after.statsKeyId).not.toBe(before.statsKeyId);
        expect(after.resetCount).toBe(1);
        expect((await identity.statsSigner()).publicKey).toBe(after.statsPublicKey);
    });

    it('keeps the operator switch', async () => {
        const identity = service();
        expect((await identity.setStatsEnabledUi(false)).statsEnabledUi).toBe(false);
        expect((await service().get())?.statsEnabledUi).toBe(false);
    });

    it('never logs key material', async () => {
        const logs: string[] = [];
        const identity = service();
        const logger = (identity as unknown as { logger: { log: (m: string) => void } }).logger;
        jest.spyOn(logger, 'log').mockImplementation((message: string) => {
            logs.push(String(message));
        });
        const row = await identity.ensure();
        await identity.reset();
        expect(logs.length).toBeGreaterThan(0);
        for (const line of logs) {
            expect(line).not.toContain(row.statsPublicKey);
            expect(line).not.toContain('enc::v1::');
            expect(line).not.toContain(row.instanceId);
        }
    });
});
