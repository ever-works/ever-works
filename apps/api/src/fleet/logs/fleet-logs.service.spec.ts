import { FLEET_LINK_FRAME_KINDS, FLEET_LOGS_MAX_CHANNELS_PER_VIEWER, encodeFleetLogLines } from '@ever-works/contracts';
import { FleetLinkException, fleetLinkError } from '../../fleet-link/fleet-link.errors';
import type { FleetLinkChannelEvents } from '../../fleet-link/fleet-link-channel';
import { FleetLogsService, sanitizeFleetLogSourceList } from './fleet-logs.service';

/**
 * Logs on computers (FL-08, T-09) — the platform's half: the source list is
 * sanitised, the one-shot read collects the batch and credits it back, every
 * read and refusal is audited with counts and never a line, and a ninth log
 * channel is refused `limit_exceeded`.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-1';

function harness(options: { openError?: Error; batch?: { lines: string[]; redactions?: number; error?: { code: string; hint: string } } } = {}) {
    const audit = { tryRecord: jest.fn().mockResolvedValue(true) };
    const sentJson: Array<Record<string, unknown>> = [];
    const acks: number[] = [];
    let events: FleetLinkChannelEvents = {};
    const channel = {
        isClosed: false,
        sendJson: (message: Record<string, unknown>) => {
            sentJson.push(message);
            if (message.type === 'logs.read' && options.batch) {
                const lines = options.batch.lines.map((text) => ({
                    ts: null,
                    level: 'info' as const,
                    text,
                    src: 0,
                    redactions: 0,
                }));
                if (lines.length > 0) {
                    events.binary?.(FLEET_LINK_FRAME_KINDS.DATA, new TextEncoder().encode(encodeFleetLogLines(lines)));
                }
                events.json?.({
                    type: 'logs.initial-done',
                    count: lines.length,
                    redactions: options.batch.redactions ?? 0,
                    bytes: 10,
                    following: false,
                    ...(options.batch.error ? { error: options.batch.error } : {}),
                });
            }
            return true;
        },
        sendBinary: (kind: number, payload: Uint8Array) => {
            if (kind === FLEET_LINK_FRAME_KINDS.ACK) acks.push(payload.byteLength);
            return true;
        },
        close: jest.fn(),
    };
    const link = {
        request: jest.fn(),
        openChannel: jest.fn(async (input: { events: FleetLinkChannelEvents }) => {
            if (options.openError) throw options.openError;
            events = input.events;
            return channel;
        }),
    };
    const fleet = {
        getVisibleForUser: jest.fn().mockResolvedValue({ view: { id: NODE_ID, name: 'build-01' }, role: 'owner' }),
    };
    const nodes = { findById: jest.fn().mockResolvedValue({ id: NODE_ID, name: 'build-01', userId: OWNER }) };
    const attach = { mint: jest.fn().mockResolvedValue({ token: 't', wsPath: `/ws/fleet/logs/${NODE_ID}`, expiresInSec: 60, role: 'viewer' }) };
    const service = new FleetLogsService(fleet as never, nodes as never, link as never, attach as never, audit as never);
    return { service, audit, link, attach, sentJson, acks, channel };
}

describe('sanitizeFleetLogSourceList', () => {
    it('keeps known shapes and drops forged ones', () => {
        const list = sanitizeFleetLogSourceList({
            platform: 'linux',
            sources: [
                { id: 'system:journal', kind: 'system', label: 'System journal', readable: true, supportsEarlier: true },
                { id: 'file:relative.log', kind: 'file', label: 'x', readable: true },
                { id: 'container:api', kind: 'file', label: 'kind mismatch', readable: true },
                { id: 'file:/var/log/auth.log', kind: 'file', label: '/var/log/auth.log', readable: false, unreadableReason: 'root-only', hint: 'Readable by root only' },
            ],
            roots: ['/var/log'],
            listedAt: '2026-10-21T10:00:00.000Z',
        });
        expect(list.sources.map((source) => source.id)).toEqual(['system:journal', 'file:/var/log/auth.log']);
        expect(list.sources[1]).toMatchObject({ readable: false, unreadableReason: 'root-only' });
    });
});

describe('FleetLogsService.readOnce', () => {
    it('collects the batch, credits it back, filters, and audits counts without a line', async () => {
        const h = harness({ batch: { lines: ['GET /health nginx', 'postgres ready', 'NGINX reload'], redactions: 1 } });
        const result = await h.service.readForUser(OWNER, NODE_ID, { source: 'service:nginx.service', lines: 200, filter: 'nginx' });
        expect(h.sentJson[0]).toEqual({ type: 'logs.read', lines: 200 });
        expect(result).toMatchObject({ count: 3, matched: 2, filter: 'nginx', source: 'service:nginx.service' });
        expect(result.lines.map((line) => line.text)).toEqual(['GET /health nginx', 'NGINX reload']);
        expect(h.acks.length).toBeGreaterThan(0);
        expect(h.channel.close).toHaveBeenCalledWith('normal');
        const row = h.audit.tryRecord.mock.calls[0][0];
        expect(row).toMatchObject({
            action: 'node.logs.read',
            nodeId: NODE_ID,
            ownerUserId: OWNER,
            details: { source: 'service:nginx.service', kind: 'service', requestedBy: `user:${OWNER}`, lines: 3, redactions: 1, confirmationClass: 'plain', outcome: 'read' },
        });
        expect(JSON.stringify(row)).not.toContain('GET /health');
    });

    it('audits an Agent read as agent:<id>', async () => {
        const h = harness({ batch: { lines: ['x'] } });
        await h.service.read({ agentId: 'agent-9', ownerUserId: OWNER }, NODE_ID, { source: 'system:journal', lines: 500, filter: null });
        expect(h.audit.tryRecord.mock.calls[0][0].details.requestedBy).toBe('agent:agent-9');
    });

    it('refuses a path outside the roots before contacting the machine, and audits the refusal (U14)', async () => {
        const h = harness();
        await expect(h.service.readOnce({ kind: 'user', userId: OWNER }, NODE_ID, { source: 'etc/shadow' })).rejects.toMatchObject({
            linkError: { code: 'invalid' },
        });
        expect(h.link.openChannel).not.toHaveBeenCalled();
        expect(h.audit.tryRecord.mock.calls[0][0].details).toMatchObject({ outcome: 'refused', code: 'invalid' });
    });

    it('carries the machine refusal and the batch error as the CONTRACTS envelope', async () => {
        const refused = harness({ openError: fleetLinkError('consent_missing', 'start the node with --manage on build-01') });
        await expect(refused.service.readForUser(OWNER, NODE_ID, { source: 'system:journal' })).rejects.toBeInstanceOf(FleetLinkException);
        expect(refused.audit.tryRecord.mock.calls[0][0].details.code).toBe('consent_missing');

        const failed = harness({ batch: { lines: [], error: { code: 'operation_failed', hint: 'journalctl exited 1' } } });
        await expect(failed.service.readForUser(OWNER, NODE_ID, { source: 'system:journal' })).rejects.toMatchObject({
            linkError: { code: 'operation_failed', hint: 'journalctl exited 1' },
        });
    });
});

describe('FleetLogsService viewer cap (U11)', () => {
    it('refuses the ninth log channel on one computer for one person', async () => {
        const h = harness();
        const viewer = (n: number) => ({
            id: `v${n}`,
            acceptedAt: 0,
            claims: { userId: OWNER, nodeId: NODE_ID, family: 'logs' as const, target: NODE_ID, role: 'viewer' as const, params: { source: 'system:journal' }, requirement: {} },
        });
        for (let n = 0; n < FLEET_LOGS_MAX_CHANNELS_PER_VIEWER; n += 1) await h.service.admit(viewer(n));
        await expect(h.service.admit(viewer(99))).rejects.toMatchObject({ linkError: { code: 'limit_exceeded' } });
        await expect(h.service.mintForUser(OWNER, NODE_ID, { source: 'system:journal' })).rejects.toMatchObject({
            linkError: { code: 'limit_exceeded' },
        });
        h.service.closed(viewer(0));
        await expect(h.service.mintForUser(OWNER, NODE_ID, { source: 'system:journal', follow: true })).resolves.toMatchObject({
            sources: ['system:journal'],
            follow: true,
        });
    });

    it('audits a viewer’s read and follow from the node’s initial-done', async () => {
        const h = harness();
        const viewer = {
            id: 'v1',
            acceptedAt: 0,
            claims: { userId: OWNER, nodeId: NODE_ID, family: 'logs' as const, target: NODE_ID, role: 'viewer' as const, params: { source: 'container:acme-api', follow: true }, requirement: {} },
        };
        await h.service.admit(viewer);
        h.service.nodeMessage(viewer, { type: 'logs.initial-done', count: 500, redactions: 3, bytes: 1, following: true });
        await new Promise((resolve) => setImmediate(resolve));
        expect(h.audit.tryRecord.mock.calls.map((call) => call[0].action)).toEqual(['node.logs.read', 'node.logs.follow']);
        expect(h.audit.tryRecord.mock.calls[0][0].details).toMatchObject({ lines: 500, redactions: 3, kind: 'container', via: 'viewer' });
    });
});
