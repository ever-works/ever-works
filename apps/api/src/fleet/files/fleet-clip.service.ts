import { Injectable, Optional } from '@nestjs/common';
import { ComputerControlArbiter } from '@ever-works/agent/computer';
import { FleetNodeRepository, FleetService } from '@ever-works/agent/fleet';
import {
    FLEET_CLIP_MAX_BYTES,
    FLEET_CLIP_MESSAGES,
    FLEET_CLIP_PASTE_TIMEOUT_MS,
    FLEET_LINK_FRAME_KINDS,
    fleetClipByteLength,
    isFleetClipViewId,
    isFleetLinkErrorCode,
    type FleetClipPasteResult,
    type FleetClipViewState,
} from '@ever-works/contracts';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkException, fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import { FleetFilesService } from './fleet-files.service';

/**
 * Paste into a desktop (FL-11 P2, plan §5, T-20) — the platform's half.
 *
 * A paste is ONE text payload into ONE live view's machine (FR-33, never
 * broadcast), admitted only when all of these hold:
 *
 *  - the view is the person's own and still live, on this computer
 *    (`ComputerControlArbiter.getState`: null = not theirs, or ended);
 *  - that view holds control right now (`mode: 'controlling'`) — else
 *    `permission_denied` "Take control first" (FR-31, U11);
 *  - the person switched paste on for that view — off by default, kept in
 *    memory for the view only, never persisted, and dropped as soon as the
 *    view is found ended — else `permission_denied` "Switch on paste for this
 *    desktop first";
 *  - the text is UTF-8, no NUL, at most 256 KiB (`limit_exceeded` naming the
 *    cap, FR-30).
 *
 * Then the node link's gate runs for the `clip` family (kill switch, `--attend`
 * on the machine, the `desktop` audience) and one `CLIP` frame goes on a
 * `clip` channel opened with `{ viewId }` (R-27). The machine answers
 * `clip.pasted { bytes }` or `clip.failed { error }`. One `node.clip.paste`
 * audit row per paste carries the byte count only — never the text (FR-35).
 *
 * The switch is per API replica (lane log decision 6's posture): a paste served
 * by another replica reads the switch as off and says so, which fails closed.
 */
@Injectable()
export class FleetClipService {
    /** `viewId` → who switched paste on for it. */
    private readonly switches = new Map<string, { userId: string; nodeId: string; at: number }>();

    constructor(
        private readonly fleet: FleetService,
        private readonly nodes: FleetNodeRepository,
        private readonly link: FleetLinkService,
        private readonly files: FleetFilesService,
        @Optional() private readonly control?: ComputerControlArbiter,
    ) {}

    /** The view as the person sees it, or `not_found` (never theirs, ended, or on another computer). */
    private async view(
        userId: string,
        nodeId: string,
        input: { viewId: unknown; agentId: unknown },
    ) {
        await this.fleet.getVisibleForUser(userId, nodeId);
        if (!isFleetClipViewId(input.viewId) || typeof input.agentId !== 'string') {
            throw fleetLinkError('invalid', 'viewId', { field: 'viewId' });
        }
        if (!this.control) {
            throw fleetLinkError(
                'unsupported_on_node',
                'Desktop views are not available on this deployment',
            );
        }
        const state = await this.control.getState({
            userId,
            agentId: input.agentId,
            sessionId: input.viewId,
        });
        if (!state || state.nodeId !== nodeId) {
            this.switches.delete(input.viewId);
            throw fleetLinkError('not_found', 'That desktop view has ended');
        }
        return { viewId: input.viewId, state };
    }

    async getSwitch(
        userId: string,
        nodeId: string,
        input: { viewId: unknown; agentId: unknown },
    ): Promise<FleetClipViewState> {
        const { viewId } = await this.view(userId, nodeId, input);
        return { viewId, pasteAllowed: this.allowed(viewId, userId) };
    }

    /** "Allow paste into this desktop" (spec §5.8): off by default, for this view only. */
    async setSwitch(
        userId: string,
        nodeId: string,
        input: { viewId: unknown; agentId: unknown; allowed: boolean },
    ): Promise<FleetClipViewState> {
        const { viewId } = await this.view(userId, nodeId, input);
        if (input.allowed) this.switches.set(viewId, { userId, nodeId, at: Date.now() });
        else this.switches.delete(viewId);
        return { viewId, pasteAllowed: input.allowed };
    }

    private allowed(viewId: string, userId: string): boolean {
        return this.switches.get(viewId)?.userId === userId;
    }

    async paste(
        userId: string,
        nodeId: string,
        input: { viewId: unknown; agentId: unknown; text: unknown },
    ): Promise<FleetClipPasteResult> {
        if (
            typeof input.text !== 'string' ||
            input.text.length === 0 ||
            input.text.includes('\0')
        ) {
            throw fleetLinkError('invalid', 'text', { field: 'text' });
        }
        const bytes = fleetClipByteLength(input.text);
        if (bytes > FLEET_CLIP_MAX_BYTES) {
            throw fleetLinkError('limit_exceeded', 'A paste carries at most 256 KB of text', {
                limit: FLEET_CLIP_MAX_BYTES,
            });
        }
        const { viewId, state } = await this.view(userId, nodeId, input);
        if (state.mode !== 'controlling')
            throw fleetLinkError('permission_denied', 'Take control first');
        if (!this.allowed(viewId, userId)) {
            throw fleetLinkError('permission_denied', 'Switch on paste for this desktop first');
        }
        const caller = { kind: 'user' as const, userId };
        let outcome: { pasted: number } | { error: { code: string; hint: string } } | null = null;
        let settle: () => void = () => undefined;
        const answered = new Promise<void>((resolve) => {
            settle = resolve;
        });
        let channel: FleetLinkChannel;
        try {
            channel = await this.link.openChannel({
                nodeId,
                family: 'clip',
                params: { viewId },
                caller,
                requirement: { actionFamily: 'desktop', stateChanging: true, target: viewId },
                events: {
                    json: (message) => {
                        if (message.type === FLEET_CLIP_MESSAGES.pasted) {
                            outcome = {
                                pasted: typeof message.bytes === 'number' ? message.bytes : bytes,
                            };
                        } else if (message.type === FLEET_CLIP_MESSAGES.failed) {
                            const error = (message.error ?? {}) as {
                                code?: unknown;
                                hint?: unknown;
                            };
                            outcome = {
                                error: {
                                    code: isFleetLinkErrorCode(error.code)
                                        ? error.code
                                        : 'operation_failed',
                                    hint:
                                        typeof error.hint === 'string'
                                            ? error.hint.slice(0, 300)
                                            : 'The paste failed',
                                },
                            };
                        } else {
                            return;
                        }
                        settle();
                    },
                    close: () => settle(),
                },
            });
        } catch (error) {
            await this.audit(
                caller,
                nodeId,
                viewId,
                bytes,
                'refused',
                error instanceof FleetLinkException ? error.code : 'internal',
            );
            throw error;
        }
        const timer = setTimeout(settle, FLEET_CLIP_PASTE_TIMEOUT_MS);
        timer.unref?.();
        try {
            if (
                !channel.sendBinary(
                    FLEET_LINK_FRAME_KINDS.CLIP,
                    new TextEncoder().encode(input.text),
                )
            ) {
                throw fleetLinkError('unreachable', 'the computer went away before the paste');
            }
            await answered;
        } finally {
            clearTimeout(timer);
            if (!channel.isClosed) channel.close('normal');
        }
        const result = outcome as
            | { pasted: number }
            | { error: { code: string; hint: string } }
            | null;
        if (!result) {
            await this.audit(caller, nodeId, viewId, bytes, 'failed', 'unreachable');
            throw fleetLinkError('unreachable', 'the computer did not confirm the paste in time');
        }
        if ('error' in result) {
            await this.audit(caller, nodeId, viewId, bytes, 'failed', result.error.code);
            throw fleetLinkError(result.error.code as never, result.error.hint);
        }
        await this.audit(caller, nodeId, viewId, bytes, 'done');
        return { bytes, pastedAt: new Date().toISOString() };
    }

    /** FR-35: the byte count only — the text is never logged, stored or audited. */
    private async audit(
        caller: { kind: 'user'; userId: string },
        nodeId: string,
        viewId: string,
        bytes: number,
        outcome: string,
        code?: string,
    ): Promise<void> {
        const node = await this.nodes.findById(nodeId).catch(() => null);
        await this.files.record('node.clip.paste', caller, nodeId, node?.userId ?? null, {
            family: 'desktop',
            target: viewId,
            bytes,
            confirmationClass: 'plain',
            outcome,
            ...(code ? { code } : {}),
        });
    }
}
