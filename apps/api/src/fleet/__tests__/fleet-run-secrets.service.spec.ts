import { Logger } from '@nestjs/common';
import {
    FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON,
    FLEET_RUN_SECRETS_DISABLED_REASON,
    FLEET_RUN_SECRETS_UNRESOLVED_REASON,
} from '@ever-works/contracts';
import { FleetRunSecretsError, FleetRunSecretsService } from '../fleet-run-secrets.service';

/**
 * Run secrets (self-build slice Y, EW-781) — the resolution half.
 *
 * The load-bearing test in this file is the SENTINEL one. A unique string
 * is put in a registry row and the assertion is not "the response
 * contains it" but "nothing else does": not a log line, not a thrown
 * message, not the authorization argument, not the job the caller was
 * authorized against. That is the property the whole slice rests on, and
 * it is the one a refactor is most likely to break silently.
 *
 * Everything else here pins fail-closed: an unknown row, a disabled row,
 * a path the row no longer carries, a value that is still ciphertext, a
 * decrypt that throws from the TypeORM transformer, and the instance kill
 * switch each abort the whole delivery with a stable reason rather than
 * returning a partial file list.
 */

const SENTINEL = 'sentinel-9d41f0c2-postgres://u:p@db/app';
const JOB = 'job-1';
const USER = 'owner-1';
const NODE = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';

describe('FleetRunSecretsService', () => {
    let jobs: { authorizeRunSecretRequest: jest.Mock };
    let repoConnections: { findByIdAndUser: jest.Mock };
    let service: FleetRunSecretsService;
    let logs: string[];

    beforeEach(() => {
        delete process.env.FLEET_NODE_RUN_ENV_FILES;
        logs = [];
        jobs = {
            authorizeRunSecretRequest: jest
                .fn()
                .mockResolvedValue({ jobId: JOB, userId: USER, nodeId: NODE }),
        };
        repoConnections = {
            findByIdAndUser: jest.fn().mockResolvedValue({
                id: ROW,
                enabled: true,
                envFiles: { 'apps/api/.env': `DATABASE_URL=${SENTINEL}` },
            }),
        };
        service = new FleetRunSecretsService(jobs as never, repoConnections as never);
        for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
            jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
                logs.push(args.map((arg) => String(arg)).join(' '));
            });
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.FLEET_NODE_RUN_ENV_FILES;
    });

    const resolve = (refs = [{ repoConnectionId: ROW, paths: ['apps/api/.env'] }]) =>
        service.resolve({
            nodeId: NODE,
            secret: 's'.repeat(24),
            jobId: JOB,
            leaseGeneration: 3,
            refs,
        });

    it('delivers the content, and the sentinel appears NOWHERE else', async () => {
        const response = await resolve();
        expect(response).toEqual({
            files: [
                {
                    repoConnectionId: ROW,
                    path: 'apps/api/.env',
                    content: `DATABASE_URL=${SENTINEL}`,
                },
            ],
        });

        // Not in any log line the service wrote…
        expect(logs.join('\n')).not.toContain(SENTINEL);
        expect(logs.join('\n')).toContain(JOB);
        // …not in what was sent to the authorization gate (which is all the
        // job row ever sees of this request)…
        expect(JSON.stringify(jobs.authorizeRunSecretRequest.mock.calls)).not.toContain(SENTINEL);
        // …and not in the arguments the registry read was made with.
        expect(JSON.stringify(repoConnections.findByIdAndUser.mock.calls)).not.toContain(SENTINEL);
    });

    it('scopes the registry read to the JOB owner, never to anything the node sent', async () => {
        await resolve();
        expect(repoConnections.findByIdAndUser).toHaveBeenCalledWith(ROW, USER);
    });

    it('returns null (→ the shared 401) when the claim does not verify', async () => {
        jobs.authorizeRunSecretRequest.mockResolvedValue(null);
        await expect(resolve()).resolves.toBeNull();
        expect(repoConnections.findByIdAndUser).not.toHaveBeenCalled();
    });

    it('lets a stale-lease refusal propagate untouched (it is the 409 of this channel)', async () => {
        const stale = Object.assign(new Error('stale'), { name: 'FleetJobStaleLeaseError' });
        jobs.authorizeRunSecretRequest.mockRejectedValue(stale);
        await expect(resolve()).rejects.toBe(stale);
    });

    it.each([
        ['an unknown or foreign row', null],
        ['a disabled row', { id: ROW, enabled: false, envFiles: { 'apps/api/.env': 'A=1' } }],
    ])('fails closed on %s with the unresolved reason', async (_label, row) => {
        repoConnections.findByIdAndUser.mockResolvedValue(row);
        await expect(resolve()).rejects.toMatchObject({
            name: 'FleetRunSecretsError',
            reason: FLEET_RUN_SECRETS_UNRESOLVED_REASON,
        });
    });

    it('fails closed when the row no longer carries a requested path', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue({
            id: ROW,
            enabled: true,
            envFiles: { '.env': 'A=1' },
        });
        await expect(resolve()).rejects.toMatchObject({
            reason: FLEET_RUN_SECRETS_UNRESOLVED_REASON,
        });
    });

    it('delivers NOTHING when one reference of several cannot be resolved', async () => {
        // All-or-nothing: half an environment is the failure this feature
        // exists to remove, and it would otherwise look like success.
        repoConnections.findByIdAndUser.mockImplementation(async (id: string) =>
            id === ROW ? { id: ROW, enabled: true, envFiles: { '.env': 'A=1' } } : null,
        );
        await expect(
            resolve([
                { repoConnectionId: ROW, paths: ['.env'] },
                { repoConnectionId: '33333333-3333-4333-8333-333333333333', paths: ['.env'] },
            ]),
        ).rejects.toBeInstanceOf(FleetRunSecretsError);
    });

    it('refuses a value that is still an encryption envelope rather than writing ciphertext', async () => {
        // `PluginSecretEncService.decryptValue` returns a malformed envelope
        // UNCHANGED (its one soft path). Without this check the node would
        // write ciphertext to `.env` and nothing would say why the suite
        // failed against a "misconfigured" database.
        repoConnections.findByIdAndUser.mockResolvedValue({
            id: ROW,
            enabled: true,
            envFiles: { 'apps/api/.env': 'enc::v1::dGhpcyBpcyBub3QgcmVhbA' },
        });
        await expect(resolve()).rejects.toMatchObject({
            reason: FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON,
        });
    });

    it('maps a THROWING decrypt transformer to a stable reason, never the crypto message', async () => {
        // The encrypted column is a TypeORM transformer, so a corrupt
        // envelope or a missing PLUGIN_SECRET_ENCRYPTION_KEY throws from the
        // READ, not from the service body.
        repoConnections.findByIdAndUser.mockRejectedValue(
            new Error('Unsupported state or unable to authenticate data (aes-256-gcm, row 42)'),
        );
        await expect(resolve()).rejects.toMatchObject({
            reason: FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON,
        });
        expect(logs.join('\n')).not.toContain('aes-256-gcm');
    });

    it('fails closed — not partially — when the instance kill switch is off', async () => {
        process.env.FLEET_NODE_RUN_ENV_FILES = 'false';
        await expect(resolve()).rejects.toMatchObject({
            reason: FLEET_RUN_SECRETS_DISABLED_REASON,
        });
        expect(repoConnections.findByIdAndUser).not.toHaveBeenCalled();
    });

    it('refuses a traversing path even if it somehow passed the DTO', async () => {
        repoConnections.findByIdAndUser.mockResolvedValue({
            id: ROW,
            enabled: true,
            envFiles: { '../../.env': 'A=1' },
        });
        await expect(
            resolve([{ repoConnectionId: ROW, paths: ['../../.env'] }]),
        ).rejects.toMatchObject({ reason: FLEET_RUN_SECRETS_UNRESOLVED_REASON });
    });
});
