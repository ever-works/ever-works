import { EventEmitter } from 'events';
import * as http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsService } from '../credentials.service';
import { WEB_URL } from '../../../utils/constants';

/**
 * Characterisation of `ever-works auth login` without `--ever-id` (APW-12, FR-43,
 * ACC-12-32).
 *
 * Written before the Ever ID device sign-in existed and kept unchanged after it was
 * added: the browser hand-off of `oauth.service.ts` and the `--manual` prompt must
 * behave exactly as they did before. Only the edges are faked — the browser launcher,
 * the profile request, the prompt library and the credentials file — so the real
 * command, the real loopback hand-off and the real credentials service run.
 */

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    prompt: vi.fn(),
    getProfile: vi.fn(),
    fs: {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        chmod: vi.fn(),
        readJson: vi.fn(),
        pathExists: vi.fn(),
        remove: vi.fn(),
    },
}));

vi.mock('fs-extra', () => ({ default: mocks.fs, ...mocks.fs }));

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));

vi.mock('../../../services/api.service', () => ({
    getApiService: () => ({ getProfile: mocks.getProfile }),
}));

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    spawn: mocks.spawn,
}));

const API_URL = 'https://api.example.test';
const CREDENTIALS_PATH = CredentialsService.credentialsPath;

function jwt(payload: Record<string, unknown>): string {
    const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const SESSION_TOKEN = jwt({
    sub: 'user-1',
    email: 'alice@example.com',
    username: 'alice',
    exp: Math.floor(Date.now() / 1000) + 3600,
});

/** Answers the browser launch the way an operating system does, then reports the page it was asked to open. */
function browserOpens(onOpen: (url: string) => void): void {
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        setImmediate(() => {
            child.emit('spawn');
            onOpen(args[args.length - 1]);
        });
        return child;
    });
}

function get(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            response.resume();
            response.on('end', () => resolve());
        }).on('error', reject);
    });
}

/**
 * Finishes the browser side of the hand-off: loads the CLI's redirect address the
 * way the web app does once the person has signed in, with `params` appended.
 * Retries briefly in case the loopback listener is still binding.
 */
async function finishInBrowser(
    authorizationUrl: string,
    params: Record<string, string>,
    overrideState?: string,
): Promise<void> {
    const redirect = new URL(new URL(authorizationUrl).searchParams.get('redirect_uri') ?? '');
    if (overrideState !== undefined) {
        redirect.searchParams.set('state', overrideState);
    }
    for (const [key, value] of Object.entries(params)) {
        redirect.searchParams.set(key, value);
    }
    for (let attempt = 0; ; attempt++) {
        try {
            await get(redirect.toString());
            return;
        } catch (error) {
            if (attempt >= 40) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
}

describe('ever-works auth login without --ever-id (characterisation)', () => {
    let output: string[];
    let fetchSpy: ReturnType<typeof vi.fn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    async function login(...args: string[]): Promise<void> {
        // A fresh module per test: a commander command keeps parsed option values.
        const { loginCommand } = await import('../login.command');
        await loginCommand.parseAsync(args, { from: 'user' });
    }

    beforeEach(() => {
        vi.resetModules();
        for (const mock of [
            mocks.spawn,
            mocks.prompt,
            mocks.getProfile,
            ...Object.values(mocks.fs),
        ]) {
            mock.mockReset();
        }
        mocks.fs.ensureDir.mockResolvedValue(undefined);
        mocks.fs.writeJson.mockResolvedValue(undefined);
        mocks.fs.chmod.mockResolvedValue(undefined);
        mocks.fs.remove.mockResolvedValue(undefined);
        // Nobody is signed in yet.
        mocks.fs.pathExists.mockResolvedValue(false);

        // Neither sign-in path makes a request of its own: the browser does the work and
        // the profile request goes through the API service faked above. A direct request
        // would mean another sign-in flow ran.
        fetchSpy = vi.fn(async () => {
            throw new Error('unexpected network request');
        });
        vi.stubGlobal('fetch', fetchSpy);

        output = [];
        const capture = (...args: unknown[]) => {
            output.push(args.map(String).join(' '));
        };
        vi.spyOn(console, 'log').mockImplementation(capture);
        vi.spyOn(console, 'error').mockImplementation(capture);
        exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation((() => undefined as never) as typeof process.exit);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('browser hand-off (default)', () => {
        it('opens the authorize page for the CLI client with a loopback redirect address and a fresh state', async () => {
            let opened = '';
            browserOpens((url) => {
                opened = url;
                void finishInBrowser(url, { sessionToken: SESSION_TOKEN });
            });
            mocks.getProfile.mockResolvedValue({ email: 'alice@example.com', username: 'alice' });

            await login('--api-url', API_URL);

            expect(mocks.spawn).toHaveBeenCalledTimes(1);
            const authorizeUrl = new URL(opened);
            expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
                new URL('/api/auth/authorize', WEB_URL).toString(),
            );
            expect(authorizeUrl.searchParams.get('response_type')).toBe('token');
            expect(authorizeUrl.searchParams.get('client_id')).toBe('cli');
            expect(authorizeUrl.searchParams.get('redirect_uri')).toMatch(
                /^http:\/\/127\.0\.0\.1:\d+\/\?state=[0-9a-f]{64}$/,
            );
        });

        it('accepts the credential the hand-off returns and stores it exactly where it does today', async () => {
            browserOpens((url) => void finishInBrowser(url, { sessionToken: SESSION_TOKEN }));
            mocks.getProfile.mockResolvedValue({
                email: 'alice@works.example',
                username: 'alice',
            });

            await login('--api-url', API_URL);

            // Saved once to verify the credential, then again with the profile's address.
            expect(mocks.fs.writeJson).toHaveBeenCalledTimes(2);
            expect(mocks.fs.writeJson).toHaveBeenLastCalledWith(
                CREDENTIALS_PATH,
                expect.objectContaining({
                    token: SESSION_TOKEN,
                    apiUrl: API_URL,
                    email: 'alice@works.example',
                    username: 'alice',
                }),
                { spaces: 2 },
            );
            expect(CREDENTIALS_PATH).toMatch(/\.ever-works[\\/]\.credentials\.json$/);
            expect(mocks.fs.chmod).toHaveBeenLastCalledWith(CREDENTIALS_PATH, 0o600);
            expect(mocks.getProfile).toHaveBeenCalledTimes(1);
            expect(output.join('\n')).toContain('Successfully logged in as');
            expect(exitSpy).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('defaults --api-url to the configured API address', async () => {
            const { API_URL: DEFAULT_API_URL } = await import('../../../utils/constants');
            browserOpens((url) => void finishInBrowser(url, { sessionToken: SESSION_TOKEN }));
            mocks.getProfile.mockResolvedValue({ email: 'alice@example.com', username: 'alice' });

            await login();

            expect(mocks.fs.writeJson).toHaveBeenLastCalledWith(
                CREDENTIALS_PATH,
                expect.objectContaining({ token: SESSION_TOKEN, apiUrl: DEFAULT_API_URL }),
                { spaces: 2 },
            );
        });

        it('still stores the credential when the profile cannot be read', async () => {
            browserOpens((url) => void finishInBrowser(url, { sessionToken: SESSION_TOKEN }));
            mocks.getProfile.mockRejectedValue(new Error('profile unavailable'));

            await login('--api-url', API_URL);

            expect(mocks.fs.writeJson).toHaveBeenLastCalledWith(
                CREDENTIALS_PATH,
                expect.objectContaining({
                    token: SESSION_TOKEN,
                    apiUrl: API_URL,
                    email: 'alice@example.com',
                }),
                { spaces: 2 },
            );
            expect(output.join('\n')).toContain('Could not fetch user profile');
            expect(exitSpy).not.toHaveBeenCalled();
        });

        it('refuses a callback that does not carry the state it generated, stores nothing and exits 1', async () => {
            browserOpens(
                (url) => void finishInBrowser(url, { sessionToken: SESSION_TOKEN }, 'f'.repeat(64)),
            );

            await login('--api-url', API_URL);

            expect(mocks.fs.writeJson).not.toHaveBeenCalled();
            expect(mocks.getProfile).not.toHaveBeenCalled();
            expect(output.join('\n')).toContain('Login failed');
            expect(output.join('\n')).toContain('Authentication state mismatch');
            expect(exitSpy).toHaveBeenCalledWith(1);
        });

        it('ends with exit code 1 and stores nothing when the browser reports an error', async () => {
            browserOpens((url) => void finishInBrowser(url, { error: 'access_denied' }));

            await login('--api-url', API_URL);

            expect(mocks.fs.writeJson).not.toHaveBeenCalled();
            expect(output.join('\n')).toContain('Login failed');
            expect(output.join('\n')).toContain('access_denied');
            expect(exitSpy).toHaveBeenCalledWith(1);
        });

        it('falls back to port 44663 when no free port is reported', async () => {
            vi.doMock('http', async (importOriginal) => ({
                ...(await importOriginal<typeof import('http')>()),
                createServer: () => ({
                    listen: (_port: number, _host: string, onListening: () => void) =>
                        onListening(),
                    address: () => null,
                    close: (onClose: () => void) => onClose(),
                }),
            }));
            try {
                const { getAvailablePort } = await import('../oauth.service');
                await expect(getAvailablePort()).resolves.toBe(44663);
            } finally {
                vi.doUnmock('http');
            }
        });
    });

    describe('--manual', () => {
        it('prompts for the API address and a token, verifies it, stores it and never opens a browser', async () => {
            mocks.prompt.mockResolvedValue({ apiUrl: API_URL, token: SESSION_TOKEN });
            mocks.getProfile.mockResolvedValue({ email: 'alice@works.example', username: 'alice' });

            await login('--manual');

            expect(mocks.prompt).toHaveBeenCalledTimes(1);
            const questions = mocks.prompt.mock.calls[0][0] as Array<Record<string, unknown>>;
            expect(questions.map(({ type, name, message }) => ({ type, name, message }))).toEqual([
                { type: 'input', name: 'apiUrl', message: 'API URL:' },
                { type: 'password', name: 'token', message: 'API Token:' },
            ]);
            expect(mocks.getProfile).toHaveBeenCalledTimes(1);
            expect(mocks.fs.writeJson).toHaveBeenLastCalledWith(
                CREDENTIALS_PATH,
                expect.objectContaining({
                    token: SESSION_TOKEN,
                    apiUrl: API_URL,
                    email: 'alice@works.example',
                }),
                { spaces: 2 },
            );
            expect(mocks.spawn).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        });
    });

    describe('when already signed in', () => {
        it('keeps the current login and starts no sign-in when the person declines', async () => {
            const current = {
                token: SESSION_TOKEN,
                apiUrl: API_URL,
                email: 'alice@example.com',
            };
            mocks.fs.pathExists.mockResolvedValue(true);
            mocks.fs.readJson.mockResolvedValue(current);
            mocks.prompt.mockResolvedValue({ proceed: false });

            await login('--api-url', API_URL);

            expect(output.join('\n')).toContain('You are already logged in as');
            expect(output.join('\n')).toContain('Operation cancelled.');
            expect(mocks.spawn).not.toHaveBeenCalled();
            expect(mocks.fs.writeJson).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        });
    });
});
