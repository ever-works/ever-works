import { Column, DataSource, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { EncryptedJsonColumn } from './_secret-json-column';

@Entity({ name: 'encrypted_json_test_records' })
class EncryptedJsonTestRecord {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    label: string;

    @EncryptedJsonColumn()
    config: Record<string, unknown>;
}

// 32-byte key as hex (PluginSecretEncService requires a 64-hex-char key).
const TEST_KEY = '0'.repeat(64);

describe('EncryptedJsonColumn (EW-716 #22 — targetConfig encryption at rest)', () => {
    let dataSource: DataSource;
    let repository: Repository<EncryptedJsonTestRecord>;
    const prevKey = process.env.PLUGIN_SECRET_ENCRYPTION_KEY;

    beforeAll(async () => {
        // Set before the first save so the module-level enc instance caches it.
        process.env.PLUGIN_SECRET_ENCRYPTION_KEY = TEST_KEY;
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [EncryptedJsonTestRecord],
            synchronize: true,
        });
        await dataSource.initialize();
        repository = dataSource.getRepository(EncryptedJsonTestRecord);
    });

    afterAll(async () => {
        await dataSource.destroy();
        if (prevKey === undefined) delete process.env.PLUGIN_SECRET_ENCRYPTION_KEY;
        else process.env.PLUGIN_SECRET_ENCRYPTION_KEY = prevKey;
    });

    beforeEach(async () => {
        await repository.clear();
    });

    it('stores every value as ciphertext at rest but hydrates the plaintext object', async () => {
        const config = { botToken: '123456:SECRET-bot-token', chatId: '@ops' };
        const saved = await repository.save(repository.create({ label: 'telegram', config }));

        // Raw column: each value is an `enc::v1::` envelope; no plaintext leaks.
        const raw = await dataSource.query(
            'SELECT config FROM encrypted_json_test_records WHERE id = ?',
            [saved.id],
        );
        const stored = JSON.parse(raw[0].config) as Record<string, string>;
        expect(stored.botToken.startsWith('enc::v1::')).toBe(true);
        expect(stored.chatId.startsWith('enc::v1::')).toBe(true);
        expect(JSON.stringify(stored)).not.toContain('SECRET-bot-token');
        expect(JSON.stringify(stored)).not.toContain('@ops');

        // Read path: transparent decrypt back to the original plaintext.
        const hydrated = await repository.findOneByOrFail({ id: saved.id });
        expect(hydrated.config).toEqual(config);
    });

    it('decrypts values returned via find operators', async () => {
        const config = { webhookUrl: 'https://hooks.slack.com/services/T/B/x' };
        await repository.save(repository.create({ label: 'slack', config }));
        const found = await repository.findOneByOrFail({ label: 'slack' });
        expect(found.config).toEqual(config);
    });

    it('encrypts targetConfig written via repository.update() (partial-update path)', async () => {
        // The service rotates credentials via `repository.update({ id }, patch)`
        // (QueryBuilder partial update), NOT save() — verify the transformer
        // still runs on this path, otherwise an edited botToken leaks plaintext.
        const saved = await repository.save(
            repository.create({ label: 'tg', config: { botToken: 'orig-token' } }),
        );
        await repository.update({ id: saved.id }, { config: { botToken: 'rotated-SECRET-token' } });

        const raw = await dataSource.query(
            'SELECT config FROM encrypted_json_test_records WHERE id = ?',
            [saved.id],
        );
        const stored = JSON.parse(raw[0].config) as Record<string, string>;
        expect(stored.botToken.startsWith('enc::v1::')).toBe(true);
        expect(JSON.stringify(stored)).not.toContain('rotated-SECRET-token');

        const hydrated = await repository.findOneByOrFail({ id: saved.id });
        expect(hydrated.config).toEqual({ botToken: 'rotated-SECRET-token' });
    });

    it('passes through legacy plaintext rows (no enc:: prefix) on read', async () => {
        // A row written before encryption landed: raw plaintext JSON in the column.
        const id = '11111111-1111-1111-1111-111111111111';
        const legacy = { webhookUrl: 'https://discord.com/api/webhooks/1/legacy' };
        await dataSource.query(
            'INSERT INTO encrypted_json_test_records (id, label, config) VALUES (?, ?, ?)',
            [id, 'legacy', JSON.stringify(legacy)],
        );
        const hydrated = await repository.findOneByOrFail({ id });
        expect(hydrated.config).toEqual(legacy);
    });

    it('re-encrypts a legacy plaintext row on its next write', async () => {
        const id = '22222222-2222-2222-2222-222222222222';
        await dataSource.query(
            'INSERT INTO encrypted_json_test_records (id, label, config) VALUES (?, ?, ?)',
            [id, 'legacy2', JSON.stringify({ apiKey: 'nv-legacy-key' })],
        );
        // Load (decrypts/pass-through), mutate a sibling field, save (re-encrypts).
        const row = await repository.findOneByOrFail({ id });
        row.label = 'rotated';
        await repository.save(row);

        const raw = await dataSource.query(
            'SELECT config FROM encrypted_json_test_records WHERE id = ?',
            [id],
        );
        const stored = JSON.parse(raw[0].config) as Record<string, string>;
        expect(stored.apiKey.startsWith('enc::v1::')).toBe(true);
        expect(JSON.stringify(stored)).not.toContain('nv-legacy-key');
    });
});
