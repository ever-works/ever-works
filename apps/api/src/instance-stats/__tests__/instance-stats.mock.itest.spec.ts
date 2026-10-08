import { readFileSync } from 'fs';
import { join } from 'path';
import type { DataSource } from 'typeorm';
import { STATS_HEADERS, STATS_SIGNATURE_PREFIX, statsKeyId } from '@ever-co/connect-sdk';
import type { SignedStatsReport } from '@ever-works/contracts';
import { EverInstance } from '@ever-works/agent/entities';
import { newStoredStatsKey } from '@ever-works/agent/ever-instance';
import { StatsSinkFacadeService } from '@ever-works/agent/facades';
import { PluginSecretEncService, type PluginRegistryService } from '@ever-works/agent/plugins';
import EverStatsSinkPlugin from '@ever-works/ever-stats-sink-plugin';
import { STATS_FIXTURES_DIR } from './contract-files.helper-spec';
import { createHarness, type StatsHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * The real sender against the MOCK PLATFORM of the Ever Platform SDK
 * (`ever-mock-platform` from the pinned `@ever-co/connect-tools`) — the same
 * answers, problem codes and checks as the statistics ingest (signature over
 * the exact bytes, key id, size, the strict JSON reader, the published schema,
 * the key pinned to the instance id on first sight).
 *
 * Runs only where a mock is listening: `EVER_STATS_MOCK_URL` (the egress
 * audit workflow starts the mock from the installed package). Elsewhere the
 * suite is skipped; `instance-stats.receiver.spec.ts` covers the same flow
 * against a receiver written from the contract.
 *
 * - The one-person installation's report is accepted (202), and the mock
 *   pinned its key.
 * - Every fixture of the published contract, signed by this installation and
 *   posted by the Works sender, gets the ingest's answer — `422` with the
 *   refused path and code; the oversize body is refused by the sender before
 *   any request.
 * - A second key for the pinned instance is `409`, stored `rejected
 *   key_mismatch`; after *Reset instance identity* the next report is `202`.
 */
const MOCK_URL = process.env.EVER_STATS_MOCK_URL?.replace(/\/+$/, '');
const describeMock = MOCK_URL ? describe : describe.skip;

/** The statistics fixtures of the pinned `@ever-co/connect-contracts`. */
const FIXTURES = STATS_FIXTURES_DIR;

interface Expected {
    status: number;
    code?: string;
    path?: string;
    error?: string;
}

interface MockEntry {
    row: number | null;
    status: number;
    method: string;
}

async function mock<T>(path: string, method = 'GET'): Promise<T> {
    const response = await fetch(`${MOCK_URL}${path}`, { method });
    if (!response.ok) throw new Error(`mock ${method} ${path} answered ${response.status}`);
    return (await response.json()) as T;
}

describeMock('instance statistics — against the SDK mock platform', () => {
    let dataSource: DataSource;
    let plugin: EverStatsSinkPlugin;
    let h: StatsHarness;

    beforeEach(async () => {
        await mock('/__mock/reset', 'POST');
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        plugin = new EverStatsSinkPlugin();
        const registry = {
            get: (id: string) =>
                id === 'ever-stats-sink'
                    ? { plugin, manifest: { id, capabilities: ['stats-sink'] }, state: 'loaded' }
                    : undefined,
        } as unknown as PluginRegistryService;
        h = createHarness(dataSource, {
            env: { EVER_STATS_API_URL: MOCK_URL },
            now: new Date('2026-10-15T08:00:00Z'),
            sink: new StatsSinkFacadeService(registry),
        });
        await h.identity.ensure();
        await h.lease.ensureSchedule(new Date('2026-10-15T08:00:00Z'));
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    /**
     * Sign `body` with this installation's key and the module's headers — but
     * without the module's checks, so a fixture the ingest must refuse is
     * posted all the same.
     */
    async function signed(body: Buffer): Promise<SignedStatsReport> {
        const bytes = new Uint8Array(body);
        const signer = await h.identity.statsSigner();
        const signature = Buffer.from(signer.sign(bytes)).toString('base64url');
        return {
            body: bytes,
            headers: {
                [STATS_HEADERS.key]: signer.publicKey,
                [STATS_HEADERS.signature]: `${STATS_SIGNATURE_PREFIX}${signature}`,
                [STATS_HEADERS.key_id]: statsKeyId(signer.publicKey),
            },
            reportId: '00000000-0000-4000-8000-000000000000',
            period: '2026-10',
            final: false,
        };
    }

    it('the one-person installation’s report is accepted (202) and its key pinned', async () => {
        const outcome = await h.sender.runDue();
        expect(outcome).toEqual({
            ran: true,
            results: [{ status: 'sent', httpStatus: 202, errorCode: null }],
        });

        const requests = await mock<MockEntry[]>('/__mock/requests');
        expect(requests.map((entry) => [entry.row, entry.status])).toEqual([[17, 202]]);
        const state = await mock<{
            stats: { pinned_ids: number; reports: Array<{ instance_id: string; product: string }> };
        }>('/__mock/state');
        const instance = (await h.identity.get())!;
        expect(state.stats.pinned_ids).toBe(1);
        expect(state.stats.reports).toEqual([
            expect.objectContaining({ instance_id: instance.instanceId, product: 'works' }),
        ]);
        expect(await h.lease.lastReport()).toMatchObject({ status: 'sent', httpStatus: 202 });
    });

    it('every published fixture gets the ingest’s answer through the Works sender', async () => {
        const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8'))
            .fixtures as Record<string, Expected>;
        const names = Object.keys(expected);
        expect(names.length).toBeGreaterThanOrEqual(18);

        for (const name of names) {
            const want = expected[name];
            const body = readFileSync(join(FIXTURES, name));
            const before = (await mock<MockEntry[]>('/__mock/requests')).length;
            const result = await plugin.send(await signed(body), {
                baseUrl: MOCK_URL!,
                timeoutMs: 10_000,
                userAgent: h.sender.userAgent(),
            });
            const after = (await mock<MockEntry[]>('/__mock/requests')).length;

            if (want.status === 413) {
                // Never posted: the sender refuses a body above 16 KiB itself.
                expect({ name, result }).toEqual({
                    name,
                    result: { status: 'rejected', httpStatus: null, errorCode: 'too_large' },
                });
                expect(after).toBe(before);
                continue;
            }
            expect(after).toBe(before + 1);
            expect({ name, httpStatus: result.httpStatus }).toEqual({
                name,
                httpStatus: want.status,
            });
            if (want.status === 202) {
                expect({ name, status: result.status }).toEqual({ name, status: 'sent' });
            } else {
                expect({ name, result }).toMatchObject({
                    name,
                    result: {
                        status: 'rejected',
                        errorCode: want.code,
                        errors: [{ path: want.path, code: want.error }],
                    },
                });
            }
        }
    });

    it('a second key for the pinned instance is 409 key_mismatch; after a reset the next report is 202', async () => {
        expect((await h.sender.runDue()).ran).toBe(true);

        // The same instance id with another key: what a copied database with a
        // regenerated key would send.
        await dataSource
            .getRepository(EverInstance)
            .update({ id: 'self' }, newStoredStatsKey(new PluginSecretEncService()));
        h.clock.now = new Date('2026-10-16T09:00:00Z');
        await h.lease.updateSchedule({ nextSendAt: h.clock.now });
        expect(await h.sender.runDue()).toEqual({
            ran: true,
            results: [{ status: 'rejected', httpStatus: 409, errorCode: 'key_mismatch' }],
        });
        expect(await h.lease.lastReport()).toMatchObject({
            status: 'rejected',
            httpStatus: 409,
            errorCode: 'key_mismatch',
        });

        const before = (await h.identity.get())!;
        const reset = await h.service.resetIdentity('operator-user');
        expect(reset.instanceId).not.toBe(before.instanceId);

        h.clock.now = new Date('2026-10-16T09:20:00Z');
        expect(await h.service.sendNow('operator-user')).toEqual({
            ran: true,
            results: [{ status: 'sent', httpStatus: 202, errorCode: null }],
        });
        const requests = await mock<MockEntry[]>('/__mock/requests');
        expect(requests.map((entry) => entry.status)).toEqual([202, 409, 202]);
        expect(requests.every((entry) => entry.row === 17)).toBe(true);
    });
});
