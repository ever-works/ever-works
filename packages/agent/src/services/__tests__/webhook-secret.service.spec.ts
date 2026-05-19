import { randomBytes } from 'crypto';
import { WebhookSecretService } from '../webhook-secret.service';
import { WorkRepository } from '../../database/repositories/work.repository';
import { Work } from '../../entities';

type RepoMock = jest.Mocked<Pick<WorkRepository, 'findById' | 'setWebhookSecretIfNull' | 'update'>>;

const VALID_KEY_HEX = randomBytes(32).toString('hex');

function buildRepoMock(): RepoMock {
    return {
        findById: jest.fn(),
        setWebhookSecretIfNull: jest.fn(),
        update: jest.fn(),
    } as unknown as RepoMock;
}

function makeWork(overrides: Partial<Work> = {}): Work {
    const work = new Work();
    work.id = 'work-1';
    work.webhookSecretEncrypted = null;
    Object.assign(work, overrides);
    return work;
}

describe('WebhookSecretService', () => {
    let repo: RepoMock;
    let service: WebhookSecretService;
    const ORIGINAL_ENV_KEY = process.env.PLATFORM_ENCRYPTION_KEY;

    beforeEach(() => {
        process.env.PLATFORM_ENCRYPTION_KEY = VALID_KEY_HEX;
        repo = buildRepoMock();
        service = new WebhookSecretService(repo as unknown as WorkRepository);
    });

    afterEach(() => {
        if (ORIGINAL_ENV_KEY === undefined) {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
        } else {
            process.env.PLATFORM_ENCRYPTION_KEY = ORIGINAL_ENV_KEY;
        }
    });

    describe('configuration validation', () => {
        it('throws when PLATFORM_ENCRYPTION_KEY is missing', async () => {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
            service = new WebhookSecretService(repo as unknown as WorkRepository);
            repo.findById.mockResolvedValue(makeWork());
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(
                /PLATFORM_ENCRYPTION_KEY is not set/,
            );
        });

        it('throws when PLATFORM_ENCRYPTION_KEY is not hex', async () => {
            process.env.PLATFORM_ENCRYPTION_KEY = 'not-hex-string!!';
            service = new WebhookSecretService(repo as unknown as WorkRepository);
            repo.findById.mockResolvedValue(makeWork());
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(/must be a hex string/);
        });

        it('throws when key decodes to wrong byte length', async () => {
            process.env.PLATFORM_ENCRYPTION_KEY = '00112233';
            service = new WebhookSecretService(repo as unknown as WorkRepository);
            repo.findById.mockResolvedValue(makeWork());
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(
                /must decode to 32 bytes/,
            );
        });
    });

    describe('getOrGenerate', () => {
        it('generates, persists, and returns plaintext when no secret exists', async () => {
            repo.findById.mockResolvedValueOnce(makeWork({ webhookSecretEncrypted: null }));
            repo.setWebhookSecretIfNull.mockResolvedValue(true);

            const plaintext = await service.getOrGenerate('work-1');

            expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
            expect(repo.setWebhookSecretIfNull).toHaveBeenCalledWith('work-1', expect.any(String));
            // Persistence must not leak plaintext — the conditional UPDATE
            // gets the encrypted envelope, never the raw value.
            const enc = repo.setWebhookSecretIfNull.mock.calls[0][1];
            expect(enc).not.toBe(plaintext);
            expect(enc.length).toBeGreaterThan(0);
        });

        it('decrypts and returns the existing secret on subsequent calls (no rotation)', async () => {
            // Round-trip a known plaintext.
            repo.findById.mockResolvedValueOnce(makeWork());
            repo.setWebhookSecretIfNull.mockResolvedValue(true);
            const first = await service.getOrGenerate('work-1');
            const persistedEnvelope = repo.setWebhookSecretIfNull.mock.calls[0][1];

            // Second call: row now has the encrypted value.
            repo.findById.mockResolvedValueOnce(
                makeWork({ webhookSecretEncrypted: persistedEnvelope }),
            );
            const second = await service.getOrGenerate('work-1');

            expect(second).toBe(first);
            // setWebhookSecretIfNull only called once (the first time).
            expect(repo.setWebhookSecretIfNull).toHaveBeenCalledTimes(1);
        });

        it('re-reads the persisted value when the conditional UPDATE loses the race', async () => {
            // First findById sees no secret, the UPDATE returns false
            // (someone else won), the loser re-reads and decrypts.
            //
            // Round-trip a known plaintext into an envelope first so the
            // re-read can decrypt it back.
            repo.findById.mockResolvedValueOnce(makeWork());
            repo.setWebhookSecretIfNull.mockResolvedValueOnce(true);
            const winningPlaintext = await service.getOrGenerate('work-1');
            const persistedEnvelope = repo.setWebhookSecretIfNull.mock.calls[0][1];

            // New service instance to clear state; simulate the losing race.
            service = new WebhookSecretService(repo as unknown as WorkRepository);
            repo.findById
                .mockResolvedValueOnce(makeWork({ webhookSecretEncrypted: null }))
                .mockResolvedValueOnce(makeWork({ webhookSecretEncrypted: persistedEnvelope }));
            repo.setWebhookSecretIfNull.mockResolvedValueOnce(false);

            const result = await service.getOrGenerate('work-1');

            expect(result).toBe(winningPlaintext);
            expect(repo.findById).toHaveBeenCalledTimes(3); // 1 winner + 1 loser-first + 1 loser-reread
        });

        it('throws when Work does not exist', async () => {
            repo.findById.mockResolvedValueOnce(null);
            await expect(service.getOrGenerate('missing')).rejects.toThrow(/Work not found/);
        });

        it('throws when the bootstrap race is lost but the value remains absent on re-read', async () => {
            repo.findById
                .mockResolvedValueOnce(makeWork())
                .mockResolvedValueOnce(makeWork({ webhookSecretEncrypted: null }));
            repo.setWebhookSecretIfNull.mockResolvedValueOnce(false);

            await expect(service.getOrGenerate('work-1')).rejects.toThrow(/bootstrap race lost/);
        });
    });

    describe('rotate', () => {
        it('writes a fresh secret unconditionally and returns the new plaintext', async () => {
            repo.findById.mockResolvedValueOnce(makeWork({ webhookSecretEncrypted: 'old-env' }));
            repo.update.mockResolvedValue(undefined as never);

            const newPlaintext = await service.rotate('work-1');

            expect(newPlaintext).toMatch(/^[0-9a-f]{64}$/);
            expect(repo.update).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({ webhookSecretEncrypted: expect.any(String) }),
            );
            const enc = (repo.update.mock.calls[0][1] as { webhookSecretEncrypted: string })
                .webhookSecretEncrypted;
            expect(enc).not.toBe(newPlaintext);
            expect(enc).not.toBe('old-env');
        });

        it('throws when Work does not exist', async () => {
            repo.findById.mockResolvedValueOnce(null);
            await expect(service.rotate('missing')).rejects.toThrow(/Work not found/);
        });
    });
});
