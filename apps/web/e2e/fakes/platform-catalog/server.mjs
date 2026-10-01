/**
 * The platform-catalog fixture server — the App Launcher's "versioned catalog" for the PR
 * lane's flags-on job (`.github/workflows/e2e.yml`, `e2e-app-works-flags-on`; ACC-E2E-12).
 *
 * ## Why it exists
 *
 * The launcher's Ever apps are read at runtime from a versioned catalog repository
 * (`ever-works/platforms`, private) **by the API process** —
 * `apps/api/src/app-launcher/platform-catalog.service.ts` — so a Playwright route cannot stand
 * in for it (APW11-G06): the tiles are composed server-side. Outside production, and only with
 * `EVER_WORKS_E2E_FAKES` on, the API replaces the raw host with
 * `EVER_WORKS_PLATFORM_CATALOG_BASE_URL`; every other rule of the read still applies — the
 * repository coordinates, the schema, the icon size cap and the SVG deny patterns. This server is
 * that base URL. It answers the two paths the reader builds (`indexUrl` / `iconUrl`):
 *
 *     GET <base>/<owner>/<repo>/<ref>/platforms.json
 *     GET <base>/<owner>/<repo>/<ref>/icons/<name>.svg|png
 *
 * from the checked-in `platforms.json` and `icons/` beside this file, for exactly the
 * coordinates the API reads: `EVER_WORKS_PLATFORM_CATALOG_REPO` / `EVER_WORKS_PLATFORM_CATALOG_REF`,
 * defaulting as the API does to `ever-works/platforms` at `main`. A read for any other
 * coordinates is a `404` that `/_control/calls` records, so a mismatch between the lane and the
 * API shows up as a named miss instead of a catalog that was silently never read.
 *
 * ## Running it
 *
 *     node apps/web/e2e/fakes/platform-catalog/server.mjs     # APW_E2E_PLATFORM_CATALOG_PORT, default 4084
 *
 * The port variable is deliberately **not** `PORT`: the fake GitHub reads `PORT`, and a script
 * that has already exported `PORT=3100` for the API starts it on the API's port
 * (`docs/runbooks/app-works-acceptance-lanes.md` §4, "Traps"). This server cannot fall into it.
 *
 * ## Control routes (never recorded as catalog reads)
 *
 *   - `GET /_control/health` — `{ status, repo, ref, catalogVersion, platforms, icons }`: what is
 *     served. The lane waits on it before it starts the API.
 *   - `GET /_control/calls`  — `{ calls: [{ method, path, status, at }], count }`: every catalog
 *     read, hit or miss, in order. The flags-on job prints it when a run fails.
 *
 * ## What is checked where
 *
 * The fixture is checked at startup for what the server itself needs — valid JSON, and every
 * referenced icon a real `icons/<name>.svg|png` file — and startup refuses otherwise, naming the
 * problem. Whether the API's reader **accepts** it (schema, safe addresses, size cap, deny
 * patterns) is asserted by `__tests__/server.unit.spec.ts` against the reader's own parser, so the
 * fixture and the reader cannot drift apart without a red harness run.
 *
 * Exported (`createPlatformCatalogFake`, `loadCatalogFixture`) so the unit specs can drive it on an
 * ephemeral port without a second process.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The port the flags-on job points `EVER_WORKS_PLATFORM_CATALOG_BASE_URL` at. */
export const DEFAULT_PORT = 4084;

/** This server's own port variable — never `PORT` (see the header). */
export const PORT_ENV = 'APW_E2E_PLATFORM_CATALOG_PORT';

/** The API's defaults (`DEFAULT_CATALOG_REPO`, `DEFAULT_CATALOG_REF`). */
export const DEFAULT_REPO = 'ever-works/platforms';
export const DEFAULT_REF = 'main';

/** The directory the fixture lives in: `platforms.json` and `icons/`. */
export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `PLATFORM_ICON_PATH_RE` in the reader — a file inside `icons/`, nothing else. */
const ICON_PATH_RE = /^icons\/[a-z0-9-]+\.(svg|png)$/;

/** Two plain path segments, the shape the reader's `CATALOG_REPO_RE` narrows further. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const CONTENT_TYPES = { svg: 'image/svg+xml', png: 'image/png' };

/**
 * @typedef {object} CatalogFixture
 * @property {Buffer} indexBytes The `platforms.json` bytes, served verbatim.
 * @property {string | null} catalogVersion
 * @property {number} platformCount
 * @property {Map<string, { bytes: Buffer, contentType: string }>} icons Keyed by the catalog's
 *   `icon` path (`icons/<name>.svg`).
 */

/**
 * Read the fixture from `dir` and check what serving it needs. Throws — naming the file, the
 * entry or the icon — rather than starting a server that would answer a broken catalog.
 *
 * @param {string} [dir]
 * @returns {CatalogFixture}
 */
export function loadCatalogFixture(dir = FIXTURE_DIR) {
    const indexPath = path.join(dir, 'platforms.json');
    const indexBytes = fs.readFileSync(indexPath);
    let document;
    try {
        document = JSON.parse(indexBytes.toString('utf8'));
    } catch (error) {
        throw new Error(
            `platform-catalog fixture: ${indexPath}: platforms.json is not valid JSON (${error?.message})`,
        );
    }

    const platforms = Array.isArray(document?.platforms) ? document.platforms : [];
    /** @type {CatalogFixture['icons']} */
    const icons = new Map();
    for (const entry of platforms) {
        const icon = entry?.icon;
        const id = typeof entry?.id === 'string' ? entry.id : '<no id>';
        if (typeof icon !== 'string' || !ICON_PATH_RE.test(icon)) {
            throw new Error(
                `platform-catalog fixture: entry ${id} names icon ${JSON.stringify(icon)}, which is not an icons/<name>.svg|png path`,
            );
        }
        if (icons.has(icon)) continue;
        const file = path.join(dir, ...icon.split('/'));
        let bytes;
        try {
            bytes = fs.readFileSync(file);
        } catch {
            throw new Error(
                `platform-catalog fixture: entry ${id} names ${icon}, and ${file} does not exist`,
            );
        }
        const extension = /** @type {'svg' | 'png'} */ (icon.slice(icon.lastIndexOf('.') + 1));
        icons.set(icon, { bytes, contentType: CONTENT_TYPES[extension] });
    }

    return {
        indexBytes,
        catalogVersion:
            typeof document?.catalogVersion === 'string' ? document.catalogVersion : null,
        platformCount: platforms.length,
        icons,
    };
}

/** @param {string | undefined} value */
function resolvePort(value) {
    if (value === undefined || value.trim() === '') return DEFAULT_PORT;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`${PORT_ENV}=${JSON.stringify(value)} is not a TCP port`);
    }
    return port;
}

/** @param {string | undefined} value */
function resolveRepo(value) {
    const repo = (value ?? '').trim() || DEFAULT_REPO;
    if (!REPO_RE.test(repo)) {
        throw new Error(
            `EVER_WORKS_PLATFORM_CATALOG_REPO=${JSON.stringify(repo)} is not <owner>/<repo>`,
        );
    }
    return repo;
}

/**
 * Build the fake. Nothing listens until `start()`; `port: 0` asks for an ephemeral one.
 *
 * @param {{ port?: number, dir?: string, repo?: string, ref?: string }} [options]
 */
export function createPlatformCatalogFake(options = {}) {
    const fixture = loadCatalogFixture(options.dir);
    const repo = resolveRepo(options.repo ?? process.env.EVER_WORKS_PLATFORM_CATALOG_REPO);
    const ref =
        (options.ref ?? process.env.EVER_WORKS_PLATFORM_CATALOG_REF ?? '').trim() || DEFAULT_REF;
    const requestedPort = options.port ?? resolvePort(process.env[PORT_ENV]);

    // The prefix the reader builds: `/${owner}/${repo}/${encodeURIComponent(ref)}/`.
    const prefix = `/${repo}/${encodeURIComponent(ref)}/`;
    /** @type {Map<string, { bytes: Buffer, contentType: string }>} */
    const served = new Map([
        [
            `${prefix}platforms.json`,
            { bytes: fixture.indexBytes, contentType: 'application/json; charset=utf-8' },
        ],
    ]);
    for (const [icon, file] of fixture.icons) {
        served.set(`${prefix}${icon}`, file);
    }

    /** @type {Array<{ method: string, path: string, status: number, at: string }>} */
    const calls = [];
    let origin = `http://127.0.0.1:${requestedPort}`;

    /**
     * @param {http.ServerResponse} res
     * @param {number} status
     * @param {Buffer | string} body
     * @param {string} contentType
     */
    function send(res, status, body, contentType) {
        const bytes = typeof body === 'string' ? Buffer.from(body) : body;
        res.writeHead(status, {
            'content-type': contentType,
            'content-length': bytes.length,
            'cache-control': 'no-store',
        });
        res.end(bytes);
    }

    /** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
    function sendJson(res, status, body) {
        send(res, status, JSON.stringify(body, null, 2), 'application/json; charset=utf-8');
    }

    const server = http.createServer((req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        // The path exactly as sent — never normalised, so `..` cannot reach a file.
        const pathname = (req.url ?? '/').split('?')[0];

        if (method === 'GET' && pathname === '/_control/health') {
            sendJson(res, 200, {
                status: 'ok',
                repo,
                ref,
                catalogVersion: fixture.catalogVersion,
                platforms: fixture.platformCount,
                icons: fixture.icons.size,
            });
            return;
        }
        if (method === 'GET' && pathname === '/_control/calls') {
            sendJson(res, 200, { calls, count: calls.length });
            return;
        }

        const record = (status) =>
            calls.push({ method, path: pathname, status, at: new Date().toISOString() });

        if (method !== 'GET') {
            record(405);
            sendJson(res, 405, { message: `${method} is not served; the catalog is read-only` });
            return;
        }
        const file = served.get(pathname);
        if (!file) {
            record(404);
            sendJson(res, 404, {
                message: `not in the fixture catalog (${repo}@${ref} is served under ${prefix})`,
            });
            return;
        }
        record(200);
        send(res, 200, file.bytes, file.contentType);
    });

    return {
        server,
        repo,
        ref,
        requestedPort,
        get origin() {
            return origin;
        },
        /** @returns {Promise<string>} the origin it listens on */
        start() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(requestedPort, '127.0.0.1', () => {
                    const address = server.address();
                    if (address && typeof address === 'object') {
                        origin = `http://127.0.0.1:${address.port}`;
                    }
                    resolve(origin);
                });
            });
        },
        /** @returns {Promise<void>} */
        stop() {
            return new Promise((resolve) => {
                if (!server.listening) {
                    resolve();
                    return;
                }
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
    };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    const fake = createPlatformCatalogFake();
    fake.start().then(
        (url) => {
            // The lanes wait on /_control/health; this line is for the job log.
            process.stdout.write(
                `platform catalog fake listening on ${url} (${fake.repo}@${fake.ref})\n`,
            );
        },
        (error) => {
            process.stderr.write(`platform catalog fake failed to start: ${error?.message}\n`);
            process.exit(1);
        },
    );
    const shutdown = () => {
        fake.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
