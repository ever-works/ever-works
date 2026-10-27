import { Logger } from '@nestjs/common';

/**
 * `GET /api/account/export`, written as it is produced.
 *
 * The export used to be built whole — every Work's data repo cloned or pulled,
 * every item in memory — and only then sent, so on a large account the first
 * byte left after more than the 100 s an edge proxy waits for one, and the
 * owner got a 524 instead of their data. The payload is now produced as JSON
 * fragments (`AccountExportService.exportAccountDataChunks`) and written one by
 * one, with a single space every {@link accountExportKeepaliveMs} while a Work
 * is being read: fragment boundaries fall between JSON tokens, and whitespace
 * there is insignificant, so the body still parses to the same document.
 *
 * What a caller observes is otherwise unchanged:
 *
 *  - Every failure the endpoint has always answered with an error status
 *    (no such account, a database read failing) happens while the FIRST
 *    fragment is produced, before any byte is written, so it still reaches the
 *    exception filter and still answers with that status.
 *  - Status, `Content-Disposition` and the security headers are set by the
 *    decorators and middleware before the handler runs, as before;
 *    `Content-Type` is the `application/json; charset=utf-8` `res.json` sent.
 *  - A failure after the first byte can no longer change the status, so the
 *    response is destroyed: the client sees a truncated body, never a
 *    complete-looking document with data missing from it.
 *  - A client that goes away stops the walk at the next Work instead of the
 *    server reading every remaining repository for nobody.
 */

/** What the stream needs of the HTTP response — Express's, structurally. */
export interface ExportResponse {
    setHeader(name: string, value: string): unknown;
    write(chunk: string): boolean;
    end(): unknown;
    on(event: 'close' | 'drain' | 'error', listener: (...args: unknown[]) => void): unknown;
    off(event: 'close' | 'drain' | 'error', listener: (...args: unknown[]) => void): unknown;
    destroy(error?: Error): unknown;
    readonly writableEnded?: boolean;
}

const DEFAULT_KEEPALIVE_MS = 15_000;

/**
 * Seconds of silence between two keepalive spaces (`ACCOUNT_EXPORT_KEEPALIVE_MS`).
 * Well under every idle timeout between the API and a browser: the edge's 100 s,
 * an ingress's default 60 s.
 */
export function accountExportKeepaliveMs(): number {
    const configured = Number(process.env.ACCOUNT_EXPORT_KEEPALIVE_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_KEEPALIVE_MS;
}

const logger = new Logger('AccountExportStream');

export async function streamAccountExport(
    res: ExportResponse,
    chunks: AsyncGenerator<string, void, undefined>,
    keepaliveMs: number = accountExportKeepaliveMs(),
): Promise<void> {
    // Before any byte: a rejection here propagates to the exception filter
    // exactly as the un-streamed handler's did.
    const first = await chunks.next();

    let closed = false;
    const onClose = () => {
        closed = true;
    };
    // Writes after the peer has gone can emit `error` on the response; with
    // no listener that would be an uncaught exception in the API process.
    const onError = () => {
        closed = true;
    };
    res.on('close', onClose);
    res.on('error', onError);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Ask a buffering proxy in front of the API to pass the bytes on as they
    // come, so the keepalive actually reaches the edge.
    res.setHeader('X-Accel-Buffering', 'no');

    const write = async (text: string): Promise<void> => {
        if (closed || res.writableEnded) return;
        if (!res.write(text)) {
            await new Promise<void>((resolve) => {
                const done = () => {
                    res.off('drain', done);
                    res.off('close', done);
                    resolve();
                };
                res.on('drain', done);
                res.on('close', done);
            });
        }
    };

    const keepalive = setInterval(
        () => {
            // Only ever between two whole fragments: `res.write` of a fragment
            // is synchronous, so this tick cannot land inside one.
            if (!closed && !res.writableEnded) res.write(' ');
        },
        Math.max(1, keepaliveMs),
    );
    keepalive.unref?.();

    try {
        if (typeof first.value === 'string') await write(first.value);
        for (;;) {
            if (closed) {
                // Nobody is reading: stop starting new Works.
                await chunks.return(undefined);
                return;
            }
            const next = await chunks.next();
            if (next.done || typeof next.value !== 'string') break;
            await write(next.value);
        }
        clearInterval(keepalive);
        if (!closed && !res.writableEnded) res.end();
    } catch (error) {
        clearInterval(keepalive);
        logger.warn(
            `Account export failed after the response had started: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
        clearInterval(keepalive);
        res.off('close', onClose);
        res.off('error', onError);
    }
}
