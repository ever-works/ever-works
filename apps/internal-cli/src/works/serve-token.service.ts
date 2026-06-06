import { randomBytes } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

/**
 * Loopback host literals. Binding `serve` to anything outside this set widens
 * the (now token-gated) API to the LAN, so it requires an explicit opt-in.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '0.0.0.0',
    '::',
]);

/**
 * Returns true when `host` resolves to a loopback / wildcard-loopback literal.
 * Note: `0.0.0.0` / `::` are wildcard binds that DO expose non-loopback
 * interfaces — they are intentionally NOT treated as loopback by
 * {@link isLoopbackHost}; they live in {@link LOOPBACK_HOSTS} only so callers
 * can special-case the messaging. Use {@link isLoopbackHost} for the gate.
 */
export function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return (
        normalized === 'localhost' ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === '[::1]' ||
        // The entire 127.0.0.0/8 block is loopback.
        normalized.startsWith('127.')
    );
}

const SERVE_TOKEN_DIR = path.join(os.homedir(), '.ever-works');
const SERVE_TOKEN_FILE = path.join(SERVE_TOKEN_DIR, 'serve-token');

/**
 * Manages the random per-start token that gates the internal-cli `serve` API.
 *
 * The token is generated once per server start and persisted to
 * `~/.ever-works/serve-token` so the operator (and tools they run) can read it
 * to authenticate. The file is written owner-only (0600) inside an owner-only
 * (0700) directory so other local users can't lift the token and drive the
 * unauthenticated-by-design API. POSIX modes are a no-op on Windows.
 */
export class ServeTokenService {
    static get tokenPath(): string {
        return SERVE_TOKEN_FILE;
    }

    /**
     * Generates a cryptographically random token (256 bits, URL-safe hex).
     */
    static generateToken(): string {
        return randomBytes(32).toString('hex');
    }

    /**
     * Persists the token to the CLI config file with hardened permissions and
     * returns the path it was written to.
     */
    static async writeToken(token: string): Promise<string> {
        // Create the dir owner-only so siblings can't traverse in to read the
        // token file. Matches CredentialsService.ensureCredentialsDir.
        await fs.ensureDir(SERVE_TOKEN_DIR, { mode: 0o700 });

        // Write with an owner-only mode. `writeFile`'s `mode` only applies when
        // the file is created, so explicitly chmod afterwards to harden a
        // pre-existing (possibly world-readable) file. chmod is a no-op on
        // Windows but harmless.
        await fs.writeFile(SERVE_TOKEN_FILE, token, { mode: 0o600, encoding: 'utf8' });
        try {
            await fs.chmod(SERVE_TOKEN_FILE, 0o600);
        } catch {
            // chmod is unsupported on some platforms (Windows); ignore.
        }

        return SERVE_TOKEN_FILE;
    }

    /**
     * Best-effort removal of the token file on shutdown so a stale token can't
     * be replayed against a future server instance.
     */
    static async removeToken(): Promise<void> {
        try {
            if (await fs.pathExists(SERVE_TOKEN_FILE)) {
                await fs.remove(SERVE_TOKEN_FILE);
            }
        } catch {
            // Ignore removal errors — we tried.
        }
    }
}
