import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cloud computers from a shell (FL-17 P3, T-31) — `create` without
 * `--acknowledge-price` exits 2 before any call (spec FR-34); `--json` prints
 * the API's own DTO in the `{ ok, data }` envelope; the verbs call the routes
 * the web uses (idle-policy through `PATCH`, the catalogue's route); a missing
 * confirmation exits 2 with the price sentence; the overlay-VPN key is never
 * taken on a command line.
 */

const http = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
}));

vi.mock('../../auth', () => ({ requireAuth: vi.fn(async () => undefined) }));
vi.mock('../../../services/http-client', () => ({ getHttpClient: () => http }));

import { cloudCommand, parseAcknowledgedPrice, parseCloudSoftware, parseIdleHours } from '../cloud';

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`);
    }
}

const NODE = '0f8fad5b-d9cb-469f-a165-70867728950e';

/**
 * `process.exit` is mocked to throw so a verb stops where a real exit would;
 * a success exit thrown inside `runFleetVerb`'s try is caught and re-exits,
 * so the FIRST code recorded is the one the process would have ended with.
 */
let exits: number[] = [];

async function run(args: string[]): Promise<number> {
    exits = [];
    try {
        await cloudCommand.parseAsync(args, { from: 'user' });
    } catch (error) {
        if (!(error instanceof Exit)) throw error;
    }
    return exits.length > 0 ? exits[0] : -1;
}

describe('fleet cloud (FL-17 P3)', () => {
    let stdout: string[];
    let stderr: string[];

    beforeEach(() => {
        stdout = [];
        stderr = [];
        vi.clearAllMocks();
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            stdout.push(String(chunk));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            stderr.push(String(chunk));
            return true;
        });
        vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
            stdout.push(parts.join(' '));
        });
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            exits.push(code ?? 0);
            throw new Exit(code ?? 0);
        }) as never);
    });

    afterEach(() => vi.restoreAllMocks());

    it('refuses create without --acknowledge-price, exit 2, before any call', async () => {
        const code = await run(['create', 'nyc-ops', '--provider', 'machines-plugin', '--region', 'nyc3', '--size', 's-2', '--json']);
        expect(code).toBe(2);
        expect(http.post).not.toHaveBeenCalled();
        const envelope = JSON.parse(stdout[0]);
        expect(envelope).toMatchObject({ ok: false, error: { code: 'invalid', details: { field: 'acknowledgedPriceCents' } } });
    });

    it('creates with the acknowledged price and --yes, printing the API DTO with --json', async () => {
        http.post.mockResolvedValueOnce({ data: { nodeId: NODE, operationId: NODE } });
        const code = await run([
            'create',
            'nyc-ops',
            '--provider',
            'machines-plugin',
            '--region',
            'nyc3',
            '--size',
            's-2',
            '--acknowledge-price',
            '2400',
            '--software',
            'docker,codex',
            '--yes',
            '--json',
        ]);
        expect(code).toBe(0);
        expect(http.post).toHaveBeenCalledWith('/fleet/cloud', {
            providerPluginId: 'machines-plugin',
            name: 'nyc-ops',
            regionId: 'nyc3',
            sizeId: 's-2',
            acknowledgedPriceCents: 2400,
            software: ['docker', 'codex'],
            confirm: true,
        });
        expect(JSON.parse(stdout[0])).toEqual({ ok: true, data: { nodeId: NODE, operationId: NODE } });
    });

    it('exits 2 with the price sentence when the confirmation is missing (no terminal)', async () => {
        http.post.mockRejectedValueOnce({
            response: {
                status: 409,
                data: {
                    error: {
                        code: 'confirmation_required',
                        hint: 'send confirm: true to confirm',
                        details: { class: 'confirm', summary: 'About $24/month ($0.036/hour), billed by Provider …' },
                    },
                },
            },
        });
        const code = await run([
            'create',
            'nyc-ops',
            '--provider',
            'machines-plugin',
            '--region',
            'nyc3',
            '--size',
            's-2',
            '--acknowledge-price',
            '2400',
        ]);
        expect(code).toBe(2);
        expect(stderr.join('')).toContain('About $24/month');
    });

    it('sets the idle policy through the catalogue route, and checks the hours first', async () => {
        http.patch.mockResolvedValueOnce({ data: { id: NODE, name: 'nyc-ops' } });
        expect(await run(['idle-policy', NODE, 'power-off', '--after', '2', '--json'])).toBe(0);
        expect(http.patch).toHaveBeenCalledWith(`/fleet/cloud/${NODE}/idle-policy`, { mode: 'power-off', afterHours: 2 });

        stdout = [];
        expect(await run(['idle-policy', NODE, 'power-off', '--after', '99', '--json'])).toBe(2);
        expect(await run(['idle-policy', NODE, 'destroy', '--json'])).toBe(2);
        expect(http.patch).toHaveBeenCalledTimes(1);
    });

    it('reads usage, one machine or all, as the API DTO', async () => {
        const usage = {
            hourlyCents: 3.6,
            monthToDateCents: 284,
            projectedMonthCents: 2400,
            currency: 'USD',
            estimate: true,
            machines: [],
            computedAt: '2026-10-26T00:00:00.000Z',
        };
        http.get.mockResolvedValueOnce({ data: usage });
        expect(await run(['usage', '--json'])).toBe(0);
        expect(http.get).toHaveBeenCalledWith('/fleet/cloud/usage');
        expect(JSON.parse(stdout[0])).toEqual({ ok: true, data: usage });

        http.get.mockResolvedValueOnce({ data: usage });
        expect(await run(['usage', NODE, '--json'])).toBe(0);
        expect(http.get).toHaveBeenLastCalledWith(`/fleet/cloud/${NODE}/usage`);
    });

    it('destroys with the typed name, and powers with on / off only', async () => {
        http.post.mockResolvedValueOnce({ data: { operationId: NODE, costSoFarCents: 284 } });
        expect(await run(['destroy', NODE, '--confirm-name', 'nyc-ops', '--json'])).toBe(0);
        expect(http.post).toHaveBeenCalledWith(`/fleet/cloud/${NODE}/destroy`, { confirmName: 'nyc-ops' });
        expect(await run(['power', NODE, 'reboot', '--json'])).toBe(2);
    });

    it('parses the flags strictly', () => {
        const json = true;
        expect(parseAcknowledgedPrice(json, '2400')).toBe(2400);
        expect(() => parseAcknowledgedPrice(json, '')).toThrow(new Exit(2));
        expect(() => parseAcknowledgedPrice(json, '-5')).toThrow(new Exit(2));
        expect(parseCloudSoftware(json, undefined)).toBeUndefined();
        expect(parseCloudSoftware(json, 'docker, node')).toEqual(['docker', 'node']);
        // The overlay-VPN preset needs a key, which a shell history must never hold.
        expect(() => parseCloudSoftware(json, 'overlay-vpn')).toThrow(new Exit(2));
        expect(parseIdleHours(json, undefined)).toBe(3);
        expect(() => parseIdleHours(json, '0')).toThrow(new Exit(2));
        expect(cloudCommand.commands.map((command) => command.name())).toEqual([
            'providers',
            'options',
            'list',
            'create',
            'power',
            'destroy',
            'usage',
            'idle-policy',
        ]);
    });
});
