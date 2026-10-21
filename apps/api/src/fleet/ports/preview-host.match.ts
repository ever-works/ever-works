import type { IncomingMessage } from 'node:http';
import { config } from '@ever-works/agent/config';

/**
 * Servers and ports (FL-10, CONTRACTS R-17) — is this request for the
 * dedicated preview host (`FLEET_PREVIEW_HOST`)? Every request on that host —
 * HTTP or a WebSocket upgrade — belongs to a tunnelled page, never to a
 * platform route or socket: the preview host handler serves it, and every
 * other upgrade listener on the HTTP server (terminal, computer, fleet link)
 * leaves it alone (it would otherwise refuse a path it does not know, or any
 * upgrade URL with a query — which a dev server's hot-reload socket has).
 *
 * False whenever no preview host is configured, so nothing changes for a
 * deployment without phase 2.
 */
export function isFleetPreviewHostRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
    const previewHost = config.fleet.getPortPreviewHost();
    if (!previewHost) return false;
    const host = (req.headers?.host ?? '').trim().toLowerCase();
    return host === previewHost;
}
