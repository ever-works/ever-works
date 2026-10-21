import { FLEET_CLIP_MAX_BYTES, FLEET_LINK_FRAME_KINDS } from '@ever-works/contracts';
import type { FleetLinkChannelEvents } from '../../fleet-link/fleet-link-channel';
import { FleetClipService } from './fleet-clip.service';

/**
 * Paste into a desktop (FL-11 P2, T-20) — the platform gate: the view is the
 * person's and live, it holds control, the switch is on (off by default, never
 * for another person), the text is within 256 KB; then one CLIP on a clip
 * channel and an audit row with the byte count only. Written, not run.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const VIEW = 'view-1';

function setup(
    mode: 'controlling' | 'watching' = 'controlling',
    reply: Record<string, unknown> = { type: 'clip.pasted', bytes: 5 },
) {
    let events: FleetLinkChannelEvents = {};
    const sent: Array<{ kind: number; payload: Uint8Array }> = [];
    const channel = {
        isClosed: false,
        sendBinary: jest.fn((kind: number, payload: Uint8Array) => {
            sent.push({ kind, payload });
            queueMicrotask(() => events.json?.(reply));
            return true;
        }),
        close: jest.fn(),
    };
    const link = {
        openChannel: jest.fn(async (input: { events?: FleetLinkChannelEvents }) => {
            events = input.events ?? {};
            return channel;
        }),
    };
    const control = {
        getState: jest.fn(async () => ({ nodeId: NODE_ID, sessionId: VIEW, mode })),
    };
    const files = { record: jest.fn(async () => undefined) };
    const service = new FleetClipService(
        { getVisibleForUser: jest.fn(async () => ({ view: {}, role: 'owner' })) } as never,
        { findById: jest.fn(async () => ({ id: NODE_ID, userId: 'owner-1' })) } as never,
        link as never,
        files as never,
        control as never,
    );
    return { service, link, sent, files, control };
}

const input = (text = 'hello') => ({ viewId: VIEW, agentId: AGENT_ID, text });

describe('FleetClipService', () => {
    it('refuses until paste is switched on for the view (FR-31, U11)', async () => {
        const { service, link } = setup();
        await expect(service.paste('owner-1', NODE_ID, input())).rejects.toMatchObject({
            linkError: {
                code: 'permission_denied',
                hint: 'Switch on paste for this desktop first',
            },
        });
        expect(link.openChannel).not.toHaveBeenCalled();
    });

    it('refuses when the view does not hold control', async () => {
        const { service } = setup('watching');
        await service.setSwitch('owner-1', NODE_ID, {
            viewId: VIEW,
            agentId: AGENT_ID,
            allowed: true,
        });
        await expect(service.paste('owner-1', NODE_ID, input())).rejects.toMatchObject({
            linkError: { code: 'permission_denied', hint: 'Take control first' },
        });
    });

    it('pastes one CLIP on a clip channel bound to the view and audits the bytes only (FR-30, FR-33, FR-35)', async () => {
        const { service, link, sent, files } = setup();
        await service.setSwitch('owner-1', NODE_ID, {
            viewId: VIEW,
            agentId: AGENT_ID,
            allowed: true,
        });
        await expect(service.paste('owner-1', NODE_ID, input())).resolves.toMatchObject({
            bytes: 5,
        });
        expect(link.openChannel).toHaveBeenCalledWith(
            expect.objectContaining({ family: 'clip', params: { viewId: VIEW } }),
        );
        expect(sent).toHaveLength(1);
        expect(sent[0].kind).toBe(FLEET_LINK_FRAME_KINDS.CLIP);
        const row = (files.record as jest.Mock).mock.calls[0];
        expect(row[0]).toBe('node.clip.paste');
        expect(JSON.stringify(row[4])).not.toContain('hello');
        expect(row[4]).toMatchObject({ bytes: 5, outcome: 'done' });
    });

    it('caps the text at 256 KB measured in UTF-8 (U8)', async () => {
        const { service } = setup();
        await expect(
            service.paste('owner-1', NODE_ID, input('é'.repeat(FLEET_CLIP_MAX_BYTES / 2 + 1))),
        ).rejects.toMatchObject({
            linkError: { code: 'limit_exceeded' },
        });
    });

    it("never lets one person use another person's switch", async () => {
        const { service } = setup();
        await service.setSwitch('owner-1', NODE_ID, {
            viewId: VIEW,
            agentId: AGENT_ID,
            allowed: true,
        });
        await expect(
            service.getSwitch('someone-else', NODE_ID, { viewId: VIEW, agentId: AGENT_ID }),
        ).resolves.toEqual({
            viewId: VIEW,
            pasteAllowed: false,
        });
    });

    it('forgets the switch once the view has ended', async () => {
        const { service, control } = setup();
        await service.setSwitch('owner-1', NODE_ID, {
            viewId: VIEW,
            agentId: AGENT_ID,
            allowed: true,
        });
        control.getState.mockResolvedValueOnce(null as never);
        await expect(
            service.getSwitch('owner-1', NODE_ID, { viewId: VIEW, agentId: AGENT_ID }),
        ).rejects.toMatchObject({
            linkError: { code: 'not_found' },
        });
        await expect(
            service.getSwitch('owner-1', NODE_ID, { viewId: VIEW, agentId: AGENT_ID }),
        ).resolves.toEqual({
            viewId: VIEW,
            pasteAllowed: false,
        });
    });

    it('carries the machine refusal back', async () => {
        const { service } = setup('controlling', {
            type: 'clip.failed',
            error: {
                code: 'unsupported_on_node',
                hint: 'That desktop view is not open on design-mac',
            },
        });
        await service.setSwitch('owner-1', NODE_ID, {
            viewId: VIEW,
            agentId: AGENT_ID,
            allowed: true,
        });
        await expect(service.paste('owner-1', NODE_ID, input())).rejects.toMatchObject({
            linkError: { code: 'unsupported_on_node' },
        });
    });
});
