import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { DataSource } from 'typeorm';
import { EverInstance } from '../../entities/ever-instance.entity';
import { PluginSecretEncService } from '../../plugins/services/plugin-secret-enc.service';
import { EverInstanceService, keyIdOf } from '../ever-instance.service';

/**
 * The installation identity: one row however many replicas boot at once, a
 * signature that verifies with the published public key over exactly the
 * bytes signed, a private key that is stored only wrapped, and a reset that
 * changes both the id and the key.
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

    it('signs exactly the given bytes; the signature verifies with the public key', async () => {
        const identity = service();
        const body = Buffer.from('{"schema":"ever.stats.v1"}', 'utf8');
        const { signature, publicKey, keyId } = await identity.sign(body);

        const key = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
            format: 'jwk',
        });
        expect(cryptoVerify(null, body, key, Buffer.from(signature, 'base64url'))).toBe(true);
        expect(
            cryptoVerify(null, Buffer.from(`${body} `), key, Buffer.from(signature, 'base64url')),
        ).toBe(false);
        expect(Buffer.from(publicKey, 'base64url')).toHaveLength(32);
        expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
        expect(keyId).toBe(keyIdOf(Buffer.from(publicKey, 'base64url')));
        expect(keyId).toHaveLength(11);
    });

    it('stores the private key only in its wrapped form', async () => {
        const row = await service().ensure();
        expect(row.statsPrivateKeyEncrypted.startsWith('enc::v1::')).toBe(true);
        // A different process (another replica) reads and uses the same key.
        const other = service();
        const body = Buffer.from('x');
        const a = await service().sign(body);
        const b = await other.sign(body);
        expect(a.publicKey).toBe(b.publicKey);
    });

    it('reset gives a new instance id AND a new key, and counts the reset', async () => {
        const identity = service();
        const before = await identity.ensure();
        const after = await identity.reset();
        expect(after.instanceId).not.toBe(before.instanceId);
        expect(after.statsPublicKey).not.toBe(before.statsPublicKey);
        expect(after.statsKeyId).not.toBe(before.statsKeyId);
        expect(after.resetCount).toBe(1);
        const signed = await identity.sign(Buffer.from('y'));
        expect(signed.publicKey).toBe(after.statsPublicKey);
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
