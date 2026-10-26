import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnApplicationShutdown,
    Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { config } from '@ever-works/agent/config';
import {
    FleetNodeRepository,
    FleetPortTunnelService,
    type FleetPortTunnelAuthorization,
} from '@ever-works/agent/fleet';
import {
    filterFleetPortTunnelHeaders,
    FLEET_PORT_TUNNEL_COOKIE,
    FLEET_PORT_TUNNEL_DROPPED_REQUEST_HEADERS,
    FLEET_PORT_TUNNEL_METHODS,
    FLEET_PORT_TUNNEL_PATH_PREFIX,
    fleetPortTunnelEndsAt,
    fleetPortTunnelUrl,
    rewriteFleetPortTunnelLocation,
    stripFleetPortTunnelCookies,
} from '@ever-works/contracts';
import { FleetPortTunnelBridge, type TunnelUpgradeHandle } from './fleet-port-tunnel.bridge';
import { fleetPortTunnelAuthCookieName, FleetPortTunnelTokens } from './fleet-port-tunnel-tokens';
import { isFleetPreviewHostRequest } from './preview-host.match';
import { renderPreviewHostPage, type PreviewHostPage } from './preview-host.pages';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS R-17, spec FR-23 … FR-28,
 * U12 … U14) — the preview host: `https://<FLEET_PREVIEW_HOST>/p/<tunnelId>/…`.
 *
 * Mounted in `main.ts` BEFORE the body parsers and the Nest router, and it
 * acts ONLY when the request's `Host` is exactly the configured preview host
 * — every other request passes straight on. On the preview host nothing
 * reaches the platform's own routes: the host is dedicated, so a tunnelled
 * page can never read Ever Works' cookies or storage (different origin by
 * construction).
 *
 * Per request:
 *
 *  1. the flag (`FLEET_PORT_TUNNEL_ENABLED`) — off answers 404 (FR-31);
 *  2. which tunnel: `/p/<id>/…`, or — for a page's root-absolute assets
 *     (`/_next/…`, `/assets/…`) — the sticky `ew_tunnel` cookie the last
 *     prefixed page set (spec §8: no page content is rewritten);
 *  3. who: a `?t=` hand-off is redeemed once for the tunnel's own cookie and
 *     the browser is sent to the same address without it; otherwise the
 *     tunnel cookie names the person. Neither → 401 "open it from Ever Works";
 *  4. `FleetPortTunnelService.authorizeRequest`: open, unexpired, the fleet
 *     not stopped, and the person's own — someone else's gets 403 and NOTHING
 *     is forwarded (FR-24);
 *  5. forward over the node link (`FleetPortTunnelBridge`) with the preview
 *     host's own cookies (`ew_*`), the web's session cookie and every
 *     credential header stripped (FR-28); stream the answer back with the
 *     server's `Set-Cookie` unchanged and an absolute `Location` on the
 *     tunnelled port rewritten to the preview address (a redirect elsewhere
 *     is shown as a link, never followed — U13);
 *  6. advance the tunnel's counters and idle clock (never an audit row).
 */

/** Cookies of the web tier that must never reach a tunnelled server, whatever the domain set-up. */
const PLATFORM_COOKIE_NAMES: readonly string[] = ['everworks_auth_token'];

const METHODS: ReadonlySet<string> = new Set(FLEET_PORT_TUNNEL_METHODS);
const TUNNEL_PATH = /^\/p\/([0-9a-fA-F-]{36})(\/.*)?$/;

function parseCookies(header: string | undefined): Map<string, string> {
    const out = new Map<string, string>();
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
    }
    return out;
}

function cookie(name: string, value: string, maxAgeSec: number): string {
    return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Lax`;
}

async function* emptyBody(): AsyncIterable<Buffer> {
    // a request without a body
}

/**
 * Why a request was refused. This app compiles with `strictNullChecks: false`, under which
 * `!decision.ok` does not narrow the authorization union, so the refusal is read through this.
 */
function refusalOf(
    decision: FleetPortTunnelAuthorization,
): Extract<FleetPortTunnelAuthorization, { ok: false }>['why'] {
    return (decision as Extract<FleetPortTunnelAuthorization, { ok: false }>).why;
}

/** Answer an upgrade we will not pass through, then drop the socket. */
function refuseUpgrade(socket: Duplex, status: number): void {
    if (socket.destroyed) return;
    try {
        socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
        // gone
    }
    socket.destroy();
}

@Injectable()
export class FleetPreviewHostHandler implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(FleetPreviewHostHandler.name);
    private upgradeListener: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;

    constructor(
        private readonly tunnels: FleetPortTunnelService,
        private readonly bridge: FleetPortTunnelBridge,
        private readonly tokens: FleetPortTunnelTokens,
        private readonly nodes: FleetNodeRepository,
        // Phase 3 — the HTTP server whose upgrades it listens to. APPENDED LAST + @Optional().
        @Optional() private readonly adapterHost?: HttpAdapterHost,
    ) {}

    /** The Express middleware `main.ts` mounts. */
    middleware(): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
        return (req, res, next) => {
            const previewHost = config.fleet.getPortPreviewHost();
            const host = (req.headers.host ?? '').trim().toLowerCase();
            if (!previewHost || host !== previewHost) {
                next();
                return;
            }
            this.handle(req, res, previewHost).catch((error: unknown) => {
                this.logger.warn(
                    `preview host request failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                if (!res.headersSent) this.page(res, 'nodeDidNotAnswer');
                else res.end();
            });
        };
    }

    private page(
        res: ServerResponse,
        page: PreviewHostPage,
        options: { computer?: string; link?: string; status?: number } = {},
    ): void {
        const rendered = renderPreviewHostPage(page, options);
        res.statusCode = options.status ?? rendered.status;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.end(rendered.html);
    }

    private async handle(req: IncomingMessage, res: ServerResponse, previewHost: string): Promise<void> {
        if (!config.fleet.isPortTunnelEnabled()) return this.page(res, 'notFound');
        const url = new URL(req.url ?? '/', `https://${previewHost}`);
        const cookies = parseCookies(req.headers.cookie);
        const match = TUNNEL_PATH.exec(url.pathname);
        let tunnelId: string;
        let path: string;
        if (match) {
            tunnelId = match[1].toLowerCase();
            if (match[2] === undefined) {
                // `/p/<id>` → `/p/<id>/`: relative assets then resolve under the prefix.
                res.statusCode = 308;
                res.setHeader('Location', `${FLEET_PORT_TUNNEL_PATH_PREFIX}${tunnelId}/${url.search}`);
                res.end();
                return;
            }
            path = match[2];
        } else {
            const sticky = cookies.get(FLEET_PORT_TUNNEL_COOKIE);
            if (!sticky || !/^[0-9a-f-]{36}$/.test(sticky)) return this.page(res, 'notFound');
            tunnelId = sticky;
            path = url.pathname;
        }

        // The one-time hand-off (R-17): trade it for the tunnel's cookie, then drop it from the address.
        const handoff = url.searchParams.get('t');
        if (handoff !== null) {
            const userId = this.tokens.redeemHandoff(handoff, tunnelId);
            const row = userId ? await this.tunnels.authorizeRequest(tunnelId, userId) : null;
            if (!userId || !row || !row.ok) {
                return this.page(res, row && !row.ok && refusalOf(row) === 'ended' ? 'ended' : 'signIn');
            }
            const endsAt = fleetPortTunnelEndsAt(row.tunnel.openedAt);
            const value = this.tokens.mintCookie(tunnelId, userId, endsAt);
            if (!value) return this.page(res, 'signIn');
            const maxAge = (endsAt.getTime() - Date.now()) / 1000;
            url.searchParams.delete('t');
            res.statusCode = 303;
            res.setHeader('Set-Cookie', [
                cookie(fleetPortTunnelAuthCookieName(tunnelId), value, maxAge),
                cookie(FLEET_PORT_TUNNEL_COOKIE, tunnelId, maxAge),
            ]);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Location', `${url.pathname}${url.search}`);
            res.end();
            return;
        }

        const userId = this.tokens.readCookie(cookies.get(fleetPortTunnelAuthCookieName(tunnelId)), tunnelId);
        if (!userId) return this.page(res, 'signIn');
        const decision = await this.tunnels.authorizeRequest(tunnelId, userId);
        if (!decision.ok) {
            const why = refusalOf(decision);
            if (why === 'off') return this.page(res, 'notFound');
            if (why === 'not-yours') return this.page(res, 'notYours');
            return this.page(res, 'ended', { computer: await this.computerOf(tunnelId) });
        }
        const tunnel = decision.tunnel;
        const method = (req.method ?? 'GET').toUpperCase();
        if (!METHODS.has(method)) return this.page(res, 'notFound', { status: 405 });

        // FR-28: never an Ever Works credential toward the machine.
        const headers = filterFleetPortTunnelHeaders(
            req.headers as Record<string, unknown>,
            FLEET_PORT_TUNNEL_DROPPED_REQUEST_HEADERS,
        );
        delete headers.cookie;
        const appCookies = stripFleetPortTunnelCookies(req.headers.cookie ?? '', PLATFORM_COOKIE_NAMES);
        if (appCookies.length > 0) headers.cookie = appCookies;

        const tunnelUrl = fleetPortTunnelUrl(previewHost, tunnel.id);
        const node = await this.nodes.findById(tunnel.nodeId).catch(() => null);
        const computer = node?.name;
        let bytesIn = 0;
        let bytesOut = 0;
        let finished = false;
        const body: AsyncIterable<Buffer> =
            method === 'GET' || method === 'HEAD'
                ? emptyBody()
                : (async function* counted() {
                      for await (const chunk of req as AsyncIterable<Buffer>) {
                          bytesIn += chunk.length;
                          yield chunk;
                      }
                  })();

        await new Promise<void>((resolve) => {
            const done = () => {
                if (finished) return;
                finished = true;
                void this.tunnels.touch(tunnel.id, { requests: 1, bytesIn, bytesOut });
                resolve();
            };
            res.once('close', done);
            void this.bridge.forward(
                {
                    tunnel: {
                        id: tunnel.id,
                        nodeId: tunnel.nodeId,
                        port: tunnel.port,
                        ownerUserId: tunnel.ownerUserId,
                    },
                    method,
                    path,
                    query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
                    headers,
                    body,
                },
                {
                    onResponse: (status, upstream) => {
                        const location = upstream.location;
                        if (typeof location === 'string') {
                            const rewritten = rewriteFleetPortTunnelLocation(location, tunnel.port, tunnelUrl);
                            if (rewritten === null) {
                                // U13: a redirect off the tunnelled port is shown, never followed.
                                this.page(res, 'redirect', { link: location });
                                done();
                                return;
                            }
                            upstream.location = rewritten;
                        }
                        res.statusCode = status;
                        for (const [name, value] of Object.entries(upstream)) {
                            try {
                                res.setHeader(name, value);
                            } catch {
                                // a header Node refuses (invalid characters): dropped
                            }
                        }
                        if (match) {
                            // The sticky cookie routes this page's root-absolute assets (plan §3).
                            const existing = res.getHeader('set-cookie');
                            const list = Array.isArray(existing)
                                ? existing.map(String)
                                : existing !== undefined
                                  ? [String(existing)]
                                  : [];
                            const maxAge = (fleetPortTunnelEndsAt(tunnel.openedAt).getTime() - Date.now()) / 1000;
                            res.setHeader('Set-Cookie', [...list, cookie(FLEET_PORT_TUNNEL_COOKIE, tunnel.id, maxAge)]);
                        }
                        if (method === 'HEAD') res.flushHeaders();
                    },
                    onData: (bytes) => {
                        if (res.writableEnded) return;
                        bytesOut += bytes.byteLength;
                        res.write(Buffer.from(bytes));
                    },
                    onEnd: () => {
                        if (!res.writableEnded) res.end();
                        done();
                    },
                    onError: (code, hint) => {
                        if (res.headersSent) {
                            res.end();
                        } else if (code === 'timeout') {
                            this.page(res, 'timeout', { computer });
                        } else if (code === 'busy') {
                            this.page(res, 'nodeDidNotAnswer', { computer, status: 503 });
                        } else {
                            this.logger.debug(`tunnel ${tunnel.id}: ${hint}`);
                            this.page(res, 'nodeDidNotAnswer', { computer });
                        }
                        done();
                    },
                },
            );
        });
    }

    // ─── Phase 3 (FR-32): WebSocket upgrades on the preview host ───────────

    onApplicationBootstrap(): void {
        const httpServer = this.adapterHost?.httpAdapter?.getHttpServer?.();
        if (!httpServer || typeof httpServer.on !== 'function') return;
        this.upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            if (!isFleetPreviewHostRequest(req)) return; // another gateway's
            this.handleUpgrade(req, socket, head).catch((error: unknown) => {
                this.logger.debug(
                    `preview host upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                refuseUpgrade(socket, 502);
            });
        };
        httpServer.on('upgrade', this.upgradeListener);
    }

    onApplicationShutdown(): void {
        const httpServer = this.adapterHost?.httpAdapter?.getHttpServer?.();
        if (httpServer && this.upgradeListener) httpServer.off?.('upgrade', this.upgradeListener);
    }

    /**
     * A tunnelled page's own WebSocket (a dev server's hot reload, spec S12):
     * the same tunnel and owner checks as a request, then the upgrade is passed
     * through to the loopback port and the two byte streams are relayed raw
     * until either side ends. An open socket counts as activity for the idle
     * clock (FR-32): the tunnel is touched every minute while it is open.
     */
    private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        const previewHost = config.fleet.getPortPreviewHost();
        if (!previewHost || !config.fleet.isPortTunnelEnabled()) return refuseUpgrade(socket, 404);
        const url = new URL(req.url ?? '/', `https://${previewHost}`);
        const cookies = parseCookies(req.headers.cookie);
        const match = TUNNEL_PATH.exec(url.pathname);
        let tunnelId: string;
        let path: string;
        if (match && match[2] !== undefined) {
            tunnelId = match[1].toLowerCase();
            path = match[2];
        } else {
            const sticky = cookies.get(FLEET_PORT_TUNNEL_COOKIE);
            if (!sticky || !/^[0-9a-f-]{36}$/.test(sticky)) return refuseUpgrade(socket, 404);
            tunnelId = sticky;
            path = url.pathname;
        }
        const userId = this.tokens.readCookie(cookies.get(fleetPortTunnelAuthCookieName(tunnelId)), tunnelId);
        if (!userId) return refuseUpgrade(socket, 401);
        const decision = await this.tunnels.authorizeRequest(tunnelId, userId);
        if (!decision.ok) return refuseUpgrade(socket, refusalOf(decision) === 'not-yours' ? 403 : 404);
        const tunnel = decision.tunnel;

        const headers = filterFleetPortTunnelHeaders(
            req.headers as Record<string, unknown>,
            FLEET_PORT_TUNNEL_DROPPED_REQUEST_HEADERS.filter((name) => name !== 'connection' && name !== 'upgrade'),
        );
        delete headers.cookie;
        const appCookies = stripFleetPortTunnelCookies(req.headers.cookie ?? '', PLATFORM_COOKIE_NAMES);
        if (appCookies.length > 0) headers.cookie = appCookies;

        let bytesIn = 0;
        let bytesOut = 0;
        let ended = false;
        let accepted = false;
        let handle: TunnelUpgradeHandle | null = null;
        const early: Buffer[] = [];
        const activity = setInterval(() => {
            void this.tunnels.touch(tunnel.id, { requests: 0, bytesIn, bytesOut });
            bytesIn = 0;
            bytesOut = 0;
        }, 60_000);
        activity.unref?.();
        const finish = () => {
            if (ended) return;
            ended = true;
            clearInterval(activity);
            handle?.end();
            void this.tunnels.touch(tunnel.id, { requests: 1, bytesIn, bytesOut });
            if (!socket.destroyed) socket.destroy();
        };
        socket.on('error', finish);
        socket.on('close', finish);
        socket.on('data', (chunk: Buffer) => {
            bytesIn += chunk.length;
            if (!accepted || !handle) early.push(chunk);
            else if (!handle.send(chunk)) finish();
        });
        if (head.length > 0) early.push(head);

        handle = await this.bridge.upgrade(
            {
                tunnel: { id: tunnel.id, nodeId: tunnel.nodeId, port: tunnel.port, ownerUserId: tunnel.ownerUserId },
                path,
                query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
                headers,
            },
            {
                onAccept: (status, upstream) => {
                    if (ended) return;
                    accepted = true;
                    const lines = [`HTTP/1.1 ${status === 101 ? '101 Switching Protocols' : `${status} Upgrade`}`];
                    for (const [name, value] of Object.entries(upstream)) {
                        for (const one of Array.isArray(value) ? value : [value]) {
                            if (/[\r\n]/.test(one) || /[\r\n:]/.test(name)) continue;
                            lines.push(`${name}: ${one}`);
                        }
                    }
                    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
                    for (const chunk of early.splice(0)) handle?.send(chunk);
                },
                onRefused: (status) => {
                    refuseUpgrade(socket, status >= 400 && status <= 599 ? status : 502);
                    finish();
                },
                onResponse: () => undefined,
                onData: (bytes) => {
                    if (ended) return;
                    bytesOut += bytes.byteLength;
                    socket.write(Buffer.from(bytes));
                },
                onEnd: () => finish(),
                onError: (_code, hint) => {
                    this.logger.debug(`tunnel ${tunnel.id} upgrade: ${hint}`);
                    if (!accepted) refuseUpgrade(socket, 502);
                    finish();
                },
            },
        );
        if (!handle && !ended) finish();
    }

    /** The computer's name for the "ended" page's sentence (the cookie already named its owner). */
    private async computerOf(tunnelId: string): Promise<string | undefined> {
        try {
            const nodeId = await this.tunnels.nodeIdOf(tunnelId);
            if (!nodeId) return undefined;
            return (await this.nodes.findById(nodeId))?.name ?? undefined;
        } catch {
            return undefined;
        }
    }
}
