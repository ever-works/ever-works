import { Command } from 'commander';
import chalk from 'chalk';
import {
    decodeFleetLinkExit,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkFrame,
    encodeFleetLinkJson,
    encodeFleetLinkResize,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LINK_VIEWER_CHANNEL,
    FLEET_SESSION_BROWSER_ATTACH_VERB,
    parseFleetSessionNotice,
} from '@ever-works/contracts';
import { requireAuth } from '../../auth';
import { getHttpClient } from '../../../services/http-client';
import { API_URL } from '../../../utils/constants';
import { createDetachChord, sessionSocketUrl, SESSION_CLI_EXIT } from './attach.shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ever-works fleet session attach <id> [--watch]` (FL-04 P2, spec FR-53) —
 * this terminal becomes the session's terminal, through the same viewer path
 * a browser uses (`/ws/fleet/session/<id>`, FL-02):
 *
 *  - a driver by default (raw input, the local window size, `SIGWINCH` →
 *    resize); `--watch` attaches read-only;
 *  - `Ctrl-]` then `d` detaches — the session keeps running on its computer;
 *  - exit `0` on detach or when the process ends, `1` when the platform or the
 *    node refused, `2` on a usage error.
 *
 * The token is minted by the platform for this person and presented as the
 * socket's first message; it never appears on a command line or in a URL.
 * Needs a runtime with a global `WebSocket` (Node 22+, this repo runs 26).
 */
export const attachCommand = new Command('attach')
    .description('Attach this terminal to a session on one of your computers (Ctrl-] then d detaches)')
    .argument('<sessionId>', 'Session id')
    .option('--watch', 'Watch only — never type into the session')
    // FL-19 (spec FR-22) names `--drive` for typing; accepted beside FL-04's default (driver unless --watch).
    .option('--drive', 'Type into the session (the default unless --watch)')
    .action(async (sessionId: string, options: { watch?: boolean; drive?: boolean }) => {
        if (!UUID.test(sessionId)) {
            console.error(chalk.red('Error: <sessionId> must be a session id (a UUID)'));
            process.exit(SESSION_CLI_EXIT.usage);
        }
        const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
        if (!WS) {
            console.error(chalk.red('Error: this Node.js has no WebSocket client; use Node 22 or newer'));
            process.exit(SESSION_CLI_EXIT.usage);
        }
        await requireAuth();
        const role = options.watch && !options.drive ? 'viewer' : 'driver';
        const size = () => ({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 32 });
        let grant: { token: string; wsPath: string; role: string };
        try {
            const { data } = await getHttpClient().post<{ token: string; wsPath: string; role: string }>(
                `/fleet/sessions/${sessionId}/attach-token`,
                { role, ...size() },
            );
            grant = data;
        } catch (error) {
            const body = (error as { response?: { data?: { error?: { hint?: string } } } }).response?.data;
            console.error(chalk.red(`Refused: ${body?.error?.hint ?? (error instanceof Error ? error.message : 'error')}`));
            process.exit(SESSION_CLI_EXIT.refused);
        }

        const socket = new WS(sessionSocketUrl(API_URL, grant.wsPath));
        socket.binaryType = 'arraybuffer';
        const driver = grant.role === 'driver';
        const chord = createDetachChord();
        let exitCode: number = SESSION_CLI_EXIT.ok;
        let closeReason: string | null = null;
        const stdin = process.stdin;

        const send = (frame: Uint8Array | null) => {
            if (frame && socket.readyState === 1) socket.send(frame);
        };
        const restore = () => {
            if (stdin.isTTY) stdin.setRawMode(false);
            stdin.pause();
        };
        const detach = () => {
            restore();
            socket.close(1000, 'detach');
        };

        socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: grant.token }));
        socket.onmessage = (event: MessageEvent) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const frame = decodeFleetLinkFrame(new Uint8Array(event.data));
            if (!frame) return;
            if (frame.channel === 0) {
                const message = decodeFleetLinkJson(frame.payload);
                if (message?.type === 'viewer.ready') {
                    send(
                        encodeFleetLinkJson(FLEET_LINK_VIEWER_CHANNEL, {
                            requestId: 'cli-attach-1',
                            type: FLEET_SESSION_BROWSER_ATTACH_VERB,
                            params: size(),
                        }),
                    );
                    if (stdin.isTTY) stdin.setRawMode(true);
                    stdin.resume();
                    process.stderr.write(
                        chalk.gray(`[attached as ${driver ? 'driver' : 'watcher'} — Ctrl-] then d detaches]\r\n`),
                    );
                } else if (message?.type === 'channel.close') {
                    closeReason = typeof message.hint === 'string' ? message.hint : String(message.reason ?? '');
                    if (message.reason !== 'normal') exitCode = SESSION_CLI_EXIT.refused;
                }
                return;
            }
            if (frame.channel !== FLEET_LINK_VIEWER_CHANNEL) return;
            if (frame.kind === FLEET_LINK_FRAME_KINDS.DATA) {
                process.stdout.write(frame.payload);
            } else if (frame.kind === FLEET_LINK_FRAME_KINDS.EXIT) {
                const code = decodeFleetLinkExit(frame.payload);
                process.stderr.write(chalk.gray(`\r\n[the session ended — exit code ${code ?? 'unknown'}]\r\n`));
            } else if (frame.kind === FLEET_LINK_FRAME_KINDS.JSON) {
                const message = decodeFleetLinkJson(frame.payload);
                if (message?.requestId === 'cli-attach-1' && message.error) {
                    const hint = (message.error as { hint?: string }).hint;
                    closeReason = hint ?? 'the computer refused';
                    exitCode = SESSION_CLI_EXIT.refused;
                    detach();
                    return;
                }
                const notice = message ? parseFleetSessionNotice(message) : null;
                if (notice?.notice === 'paused') process.stderr.write(chalk.yellow('\r\n[paused by the fleet stop]\r\n'));
                if (notice?.notice === 'drain') {
                    process.stderr.write(chalk.yellow(`\r\n[fleet drain: this session ends in ${notice.seconds} s]\r\n`));
                }
            }
        };
        socket.onclose = () => {
            restore();
            if (closeReason && exitCode !== SESSION_CLI_EXIT.ok) process.stderr.write(chalk.red(`\r\n${closeReason}\r\n`));
            process.exit(exitCode);
        };

        stdin.on('data', (chunk: Buffer) => {
            const { forward, detach: wantsDetach } = chord(new Uint8Array(chunk));
            if (driver && forward.byteLength > 0) {
                send(encodeFleetLinkFrame(FLEET_LINK_VIEWER_CHANNEL, FLEET_LINK_FRAME_KINDS.DATA, forward));
            }
            if (wantsDetach) detach();
        });
        if (driver) {
            process.stdout.on('resize', () => {
                const { cols, rows } = size();
                const payload = encodeFleetLinkResize(cols, rows);
                if (payload) send(encodeFleetLinkFrame(FLEET_LINK_VIEWER_CHANNEL, FLEET_LINK_FRAME_KINDS.RESIZE, payload));
            });
        }
    });
