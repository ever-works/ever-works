import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as realFs from 'fs';

// Point the service's homedir at an isolated temp dir so the module-level token
// path resolves under the temp dir and the real ~/.ever-works is never touched.
// `vi.hoisted` runs before the `vi.mock` factory and the imports below, so the
// temp dir exists when the service module computes its paths at load time.
const { TMP_HOME } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeOs = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    return { TMP_HOME: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ew-serve-token-')) };
});

vi.mock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, homedir: () => TMP_HOME };
});

// Imported after the os mock is installed (vi.mock is hoisted above imports).
import { ServeTokenService, isLoopbackHost, LOOPBACK_HOSTS } from '../serve-token.service';

describe('ServeTokenService.generateToken', () => {
    it('returns a 64-char hex string (256 bits of entropy)', () => {
        const token = ServeTokenService.generateToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns a different token on each call', () => {
        const a = ServeTokenService.generateToken();
        const b = ServeTokenService.generateToken();
        expect(a).not.toBe(b);
    });
});

describe('ServeTokenService.writeToken / removeToken', () => {
    afterAll(() => {
        realFs.rmSync(TMP_HOME, { recursive: true, force: true });
    });

    it('writes the token under the mocked home dir and reads it back', async () => {
        const token = ServeTokenService.generateToken();
        const tokenPath = await ServeTokenService.writeToken(token);

        expect(tokenPath).toBe(path.join(TMP_HOME, '.ever-works', 'serve-token'));
        expect(realFs.readFileSync(tokenPath, 'utf8')).toBe(token);
    });

    it('writes the token file with owner-only (0600) perms on POSIX', async () => {
        const token = ServeTokenService.generateToken();
        const tokenPath = await ServeTokenService.writeToken(token);

        // chmod/mode is a no-op on Windows, so only assert on POSIX.
        if (process.platform !== 'win32') {
            const mode = realFs.statSync(tokenPath).mode & 0o777;
            expect(mode).toBe(0o600);
        }
    });

    it('overwrites an existing token file with the new value', async () => {
        const first = ServeTokenService.generateToken();
        const second = ServeTokenService.generateToken();
        const tokenPath = await ServeTokenService.writeToken(first);
        await ServeTokenService.writeToken(second);
        expect(realFs.readFileSync(tokenPath, 'utf8')).toBe(second);
    });

    it('removeToken deletes the file and is a no-op when absent', async () => {
        const token = ServeTokenService.generateToken();
        const tokenPath = await ServeTokenService.writeToken(token);
        expect(realFs.existsSync(tokenPath)).toBe(true);

        await ServeTokenService.removeToken();
        expect(realFs.existsSync(tokenPath)).toBe(false);

        // Second removal must not throw.
        await expect(ServeTokenService.removeToken()).resolves.toBeUndefined();
    });
});

describe('isLoopbackHost (binding gate)', () => {
    it('treats loopback literals as loopback', () => {
        expect(isLoopbackHost('localhost')).toBe(true);
        expect(isLoopbackHost('127.0.0.1')).toBe(true);
        expect(isLoopbackHost('::1')).toBe(true);
        expect(isLoopbackHost('[::1]')).toBe(true);
        // Whole 127.0.0.0/8 block.
        expect(isLoopbackHost('127.5.5.5')).toBe(true);
        // Case/whitespace insensitive.
        expect(isLoopbackHost('  LOCALHOST ')).toBe(true);
    });

    it('treats wildcard and remote hosts as NON-loopback (require --allow-remote)', () => {
        // Wildcard binds expose non-loopback interfaces — must NOT be loopback.
        expect(isLoopbackHost('0.0.0.0')).toBe(false);
        expect(isLoopbackHost('::')).toBe(false);
        expect(isLoopbackHost('192.168.1.10')).toBe(false);
        expect(isLoopbackHost('10.0.0.5')).toBe(false);
        expect(isLoopbackHost('example.com')).toBe(false);
    });

    it('keeps wildcard literals out of the loopback gate even though they are catalogued', () => {
        // 0.0.0.0 / :: are listed for messaging purposes but must never pass
        // the loopback gate.
        expect(LOOPBACK_HOSTS.has('0.0.0.0')).toBe(true);
        expect(isLoopbackHost('0.0.0.0')).toBe(false);
    });
});
