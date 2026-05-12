import { randomBytes } from 'crypto';
import { PlatformSyncSecretService } from '../platform-sync-secret.service';
import { WorkRepository } from '../../database/repositories/work.repository';
import { Work } from '../../entities';

type RepoMock = jest.Mocked<
    Pick<WorkRepository, 'findById' | 'setPlatformSyncSecretIfNull' | 'updatePlatformSyncStatus'>
>;

const VALID_KEY_HEX = randomBytes(32).toString('hex');

function buildRepoMock(): RepoMock {
    return {
        findById: jest.fn(),
        setPlatformSyncSecretIfNull: jest.fn(),
        updatePlatformSyncStatus: jest.fn(),
    } as unknown as RepoMock;
}

function makeWork(overrides: Partial<Work> = {}): Work {
    const work = new Work();
    work.id = 'work-1';
    work.platformSyncEnabled = true;
    work.platformSyncSecretEncrypted = null;
    Object.assign(work, overrides);
    return work;
}

describe('PlatformSyncSecretService', () => {
    let repo: RepoMock;
    let service: PlatformSyncSecretService;
    const ORIGINAL_ENV_KEY = process.env.PLATFORM_ENCRYPTION_KEY;

    beforeEach(() => {
        process.env.PLATFORM_ENCRYPTION_KEY = VALID_KEY_HEX;
        repo = buildRepoMock();
        service = new PlatformSyncSecretService(repo as unknown as WorkRepository);
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
            service = new PlatformSyncSecretService(repo as unknown as WorkRepository);
            repo.findById.mockResolvedValue(makeWork());
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(
                /PLATFORM_ENCRYPTION_KEY is not set/,
            );
        });

        it('throws when PLATFORM_ENCRYPTION_KEY is not hex', async () => {
            process.env.PLATFORM_ENCRYPTION_KEY = 'not-hex-string!!';
            service = new PlatformSyncSecretService(repo as unknown as WorkRepository);
            repo.findById.mockResolvedValue(makeWork());
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(/must be a hex string/);
        });

        it('throws when key decodes to wrong byte length', async () => {
            process.env.PLATFORM_ENCRYPTION_KEY = '00112233'; // 4 bytes, not 32
            service = new PlatformSyncSecretService(repo as unknown as WorkRepository);
            repo.findById.mockResolvedValue(makeWork());
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(
                /must decode to 32 bytes/,
            );
        });
    });

    describe('getOrGenerate', () => {
        it('generates, persists, and returns plaintext when no secret exists', async () => {
            repo.findById.mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValue(true);

            const plaintext = await service.getOrGenerate('work-1');

            expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
            expect(repo.setPlatformSyncSecretIfNull).toHaveBeenCalledWith(
                'work-1',
                expect.any(String),
            );
            const [, encrypted] = repo.setPlatformSyncSecretIfNull.mock.calls[0];
            expect(encrypted).not.toContain(plaintext);
            expect(encrypted.length).toBeGreaterThan(0);
        });

        it('decrypts and returns existing secret without re-generating', async () => {
            // Seed: first call generates so we have a valid envelope to reuse.
            repo.findById.mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValue(true);
            const original = await service.getOrGenerate('work-1');
            const persistedEnvelope = repo.setPlatformSyncSecretIfNull.mock.calls[0][1];

            // Second call: the work now has the encrypted secret.
            repo.findById.mockResolvedValueOnce(
                makeWork({ platformSyncSecretEncrypted: persistedEnvelope }),
            );
            repo.setPlatformSyncSecretIfNull.mockClear();

            const second = await service.getOrGenerate('work-1');
            expect(second).toBe(original);
            expect(repo.setPlatformSyncSecretIfNull).not.toHaveBeenCalled();
        });

        it('on concurrent first-deploy race, the loser reads back the winner value', async () => {
            // Step 1: produce a real winner envelope via a separate run so we
            // have a known plaintext/ciphertext pair to assert against.
            repo.findById.mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValueOnce(true);
            const winnerSecret = await service.getOrGenerate('work-1');
            const winnerEnvelope = repo.setPlatformSyncSecretIfNull.mock.calls[0][1];

            // Step 2: reset BOTH mocks so winner-phase queue entries don't
            // leak into the loser scenario.
            repo.findById.mockReset();
            repo.setPlatformSyncSecretIfNull.mockReset();

            // Step 3: simulate loser — initial findById sees NULL → write
            // fails (loser) → re-read returns the winner's envelope.
            repo.findById
                .mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }))
                .mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: winnerEnvelope }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValueOnce(false);

            const loserResult = await service.getOrGenerate('work-1');
            expect(loserResult).toBe(winnerSecret);
            // Loser must have attempted the write exactly once and not retried.
            expect(repo.setPlatformSyncSecretIfNull).toHaveBeenCalledTimes(1);
        });

        it('throws when the Work is missing', async () => {
            repo.findById.mockResolvedValueOnce(null as unknown as Work);
            await expect(service.getOrGenerate('missing')).rejects.toThrow(/Work not found/);
        });

        it('throws if race-loss reread finds no value (impossible-state guard)', async () => {
            repo.findById
                .mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }))
                .mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValueOnce(false);
            await expect(service.getOrGenerate('work-1')).rejects.toThrow(/race lost but no value/);
        });
    });

    describe('decryptForWork', () => {
        it('returns null when work has no secret', () => {
            const work = makeWork({ platformSyncSecretEncrypted: null });
            expect(service.decryptForWork(work)).toBeNull();
        });

        it('returns plaintext when work has an encrypted secret', async () => {
            repo.findById.mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValue(true);
            const plaintext = await service.getOrGenerate('work-1');
            const envelope = repo.setPlatformSyncSecretIfNull.mock.calls[0][1];

            const work = makeWork({ platformSyncSecretEncrypted: envelope });
            expect(service.decryptForWork(work)).toBe(plaintext);
        });

        it('throws on tampered ciphertext (auth tag mismatch)', async () => {
            repo.findById.mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValue(true);
            await service.getOrGenerate('work-1');
            const envelope = repo.setPlatformSyncSecretIfNull.mock.calls[0][1];

            // Flip the last byte of the base64-decoded envelope.
            const buf = Buffer.from(envelope, 'base64');
            buf[buf.length - 1] ^= 0xff;
            const tampered = buf.toString('base64');

            expect(() =>
                service.decryptForWork(makeWork({ platformSyncSecretEncrypted: tampered })),
            ).toThrow(/decryption failed/);
        });
    });

    describe('encryption properties', () => {
        it('produces a different envelope for each call with the same plaintext (fresh IV)', async () => {
            repo.findById
                .mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }))
                .mockResolvedValueOnce(makeWork({ platformSyncSecretEncrypted: null }));
            repo.setPlatformSyncSecretIfNull.mockResolvedValue(true);

            await service.getOrGenerate('work-1');
            await service.getOrGenerate('work-2');

            const env1 = repo.setPlatformSyncSecretIfNull.mock.calls[0][1];
            const env2 = repo.setPlatformSyncSecretIfNull.mock.calls[1][1];
            expect(env1).not.toBe(env2);
        });
    });
});
