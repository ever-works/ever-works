import * as http from 'http';
import * as crypto from 'crypto';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { WEB_URL } from '../../utils/constants';

const execAsync = promisify(exec);

const DEFAULT_PORT = 44663;

const escapeHtml = (value?: string | null) =>
    (value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        // Security: escape single quotes too so the helper is safe in HTML
        // attribute contexts as well as element text (defense-in-depth).
        .replace(/'/g, '&#x27;');

// Security: the OAuth `error` query parameter is attacker-influenceable (it
// is reflected from whatever the browser was redirected with). Before it is
// surfaced to the terminal via `reject(new Error(error))` (printed with
// chalk in login.command.ts) strip ANSI/C0 control characters so a crafted
// redirect cannot clear the screen, rewrite earlier output, or forge a
// "success" line, and cap the length to keep the message readable.
const sanitizeErrorMessage = (value: string): string =>
    value
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .trim()
        .slice(0, 200);

// Security: constant-time comparison of the OAuth `state` nonce to avoid
// leaking timing information while validating the callback.
const safeStateEquals = (a: string, b: string): boolean => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

type OAuthPageState = 'success' | 'error' | 'waiting';

const renderOAuthPage = (state: OAuthPageState, message?: string) => {
    const palette = {
        success: {
            heading: 'Authentication Successful',
            closingScript: '<script>window.setTimeout(() => window.close(), 15 * 1000);</script>',
            detail: 'You can close this window and return to the terminal. This tab will close automatically in a few seconds.',
            svg: `<svg class="icon-svg" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
              </svg>`,
        },
        error: {
            heading: 'Authentication Failed',
            closingScript: '',
            detail: 'Please return to the terminal window to retry the login process.',
            svg: `<svg class="icon-svg" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>`,
        },
        waiting: {
            heading: 'Waiting for Authentication',
            closingScript: '',
            detail: 'Follow the instructions in the opened tab or terminal to continue.',
            svg: `<svg class="icon-svg spinner" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke-width="2" stroke-dasharray="32" stroke-dashoffset="8"/>
              </svg>`,
        },
    }[state];

    const safeMessage = message ? escapeHtml(message) : undefined;

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Ever Works CLI Authentication</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      :root {
        color-scheme: light dark;
        --color-background: #ffffff;
        --color-surface: #f8fafc;
        --color-text: #0f172a;
        --color-text-secondary: #475569;
        --color-text-muted: #94a3b8;
        --color-border: #e2e8f0;
        --color-primary: #3b82f6;
        --color-success: #10b981;
        --color-danger: #ef4444;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --color-background: #0f1419;
          --color-surface: #1e293b;
          --color-text: #e2e8f0;
          --color-text-secondary: #94a3b8;
          --color-text-muted: #64748b;
          --color-border: #334155;
        }
      }

      body {
        margin: 0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--color-background);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        color: var(--color-text);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      .container {
        width: 100%;
        max-width: 480px;
      }

      .card {
        background: var(--color-background);
        border: 1px solid var(--color-border);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        border-radius: 16px;
        padding: 48px 40px;
        text-align: center;
        animation: fadeIn 0.3s ease-out;
      }

      .header {
        margin-bottom: 32px;
        padding-bottom: 24px;
        border-bottom: 1px solid var(--color-border);
      }

      .brand-text {
        font-size: 18px;
        font-weight: 600;
        color: var(--color-text);
      }

      .icon-wrapper {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 80px;
        height: 80px;
        border-radius: 16px;
        margin-bottom: 24px;
        background: var(--color-surface);
      }

      .icon-wrapper.success {
        color: var(--color-success);
      }

      .icon-wrapper.error {
        color: var(--color-danger);
      }

      .icon-wrapper.waiting {
        color: var(--color-primary);
      }

      .icon-svg {
        width: 40px;
        height: 40px;
        stroke-width: 2;
      }

      h1 {
        margin: 0 0 12px;
        font-size: 24px;
        font-weight: 700;
        line-height: 1.3;
        color: var(--color-text);
      }

      .message {
        margin: 0 0 8px;
        font-size: 15px;
        line-height: 1.5;
        color: var(--color-text);
        font-weight: 500;
      }

      .detail {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--color-text-secondary);
      }

      .footer {
        margin-top: 32px;
        padding-top: 24px;
        border-top: 1px solid var(--color-border);
        font-size: 13px;
        color: var(--color-text-muted);
      }

      /* Animations */
      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }

      .spinner {
        animation: spin 1.5s linear infinite;
      }

      /* Responsive */
      @media (max-width: 640px) {
        .card {
          padding: 40px 32px;
        }

        h1 {
          font-size: 20px;
        }

        .icon-wrapper {
          width: 64px;
          height: 64px;
        }

        .icon-svg {
          width: 32px;
          height: 32px;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <div class="header">
          <div class="brand-text">Ever Works CLI</div>
        </div>

        <div class="icon-wrapper ${state}">
          ${palette.svg}
        </div>

        <h1>${palette.heading}</h1>

        ${safeMessage ? `<p class="message">${safeMessage}</p>` : ''}
        <p class="detail">${palette.detail}</p>

        <div class="footer">
          CLI Authentication
        </div>
      </div>
    </div>
    ${palette.closingScript}
  </body>
</html>`;
};

// Helper function to find an available port
export async function getAvailablePort(): Promise<number> {
    return new Promise((resolve) => {
        const server = http.createServer();
        // Security: bind the probe socket to the loopback interface only so
        // the OS-assigned free port reflects availability on 127.0.0.1 (where
        // the callback server actually listens), not on all interfaces.
        server.listen(0, '127.0.0.1', () => {
            let port = DEFAULT_PORT;
            const address = server.address();

            if (address && typeof address === 'object') {
                port = address.port;
            }

            server.close(() => resolve(port));
        });
    });
}

// Helper function to start OAuth server
// Security: `expectedState` is the CSRF/session-fixation nonce that the CLI
// generated and embedded in the authorization redirect_uri. When provided,
// the callback MUST echo back a matching `state` before any `sessionToken`
// is accepted, so a local page/process that races the callback port cannot
// inject an attacker-chosen token (login/session fixation).
export async function startOAuthServer(port: number, expectedState?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let resolved = false;
        const connections = new Set<import('net').Socket>();

        const closeAllConnections = (error?: string, sessionToken?: string) => {
            if (!resolved) {
                resolved = true;
                // Force close all connections
                setTimeout(() => {
                    connections.forEach((conn) => conn.destroy());
                    server.close(() => {
                        if (error) {
                            reject(new Error(error));
                        } else if (sessionToken) {
                            resolve(sessionToken);
                        }
                    });
                }, 100);
            }
        };

        const server = http.createServer((req, res) => {
            const url = new URL(req.url!, `http://127.0.0.1:${port}`);
            const sessionToken = url.searchParams.get('sessionToken');
            const state = url.searchParams.get('state');
            // Security: neutralize ANSI/control sequences in the reflected
            // error before it reaches the terminal or the HTML page.
            const error = url.searchParams.get('error');
            const safeError = error ? sanitizeErrorMessage(error) : null;

            // Disable keep-alive to ensure connection closes
            res.setHeader('Connection', 'close');
            res.writeHead(200, { 'Content-Type': 'text/html' });

            if (safeError) {
                res.end(renderOAuthPage('error', safeError));
                closeAllConnections(safeError);
            } else if (sessionToken) {
                // Security: reject the credential unless the callback carries
                // the exact `state` nonce we generated (constant-time compare).
                // Missing or mismatched state means this is not our callback.
                if (expectedState && (!state || !safeStateEquals(state, expectedState))) {
                    res.end(
                        renderOAuthPage(
                            'error',
                            'Authentication state mismatch. Please retry the login from the CLI.',
                        ),
                    );
                    closeAllConnections('Authentication state mismatch');
                    return;
                }
                res.end(renderOAuthPage('success'));
                closeAllConnections(undefined, sessionToken);
            } else {
                res.end(renderOAuthPage('waiting'));
            }
        });

        // Track connections to force close them
        server.on('connection', (connection) => {
            connections.add(connection);
            connection.on('close', () => {
                connections.delete(connection);
            });
        });

        // Security: bind to the loopback interface explicitly. Without the
        // host argument Node listens on all interfaces (0.0.0.0/::), exposing
        // the credential-accepting callback to the LAN; `127.0.0.1` keeps it
        // reachable only from this machine.
        server.listen(port, '127.0.0.1');

        // Set a timeout for the OAuth flow
        const timeoutHandle = setTimeout(
            () => {
                if (!resolved) {
                    resolved = true;
                    connections.forEach((conn) => conn.destroy());
                    server.close(() => {
                        reject(new Error('Authentication timeout'));
                    });
                }
            },
            5 * 60 * 1000,
        ); // 5 minutes timeout

        // Clear timeout if resolved
        server.on('close', () => {
            clearTimeout(timeoutHandle);
        });
    });
}

// Helper function to open URL in browser
// L-08: use `spawn` with argv arrays instead of `exec` + a manually
// escaped string. The previous form `"${escapedUrl}"` only escaped the
// `"` character and trusted every other shell metacharacter to be
// inert; safe in today's narrow callsite (the URL is platform-generated
// with a small fixed port), but the spawn-argv pattern removes the
// shell-injection class entirely.
export async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;

    // Refuse anything that isn't a well-formed http(s) URL to keep the
    // attack surface minimal. The CLI's localhost-OAuth callback URLs are
    // always shaped like `http://127.0.0.1:<port>/...`.
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Refusing to open non-http(s) URL: ${parsed.protocol}`);
        }
    } catch (err) {
        console.log(chalk.yellow('\n⚠ Could not open browser automatically.'));
        console.log(chalk.cyan(`Please open this URL manually: ${url}`));
        return;
    }

    let cmd: string;
    let args: string[];
    if (platform === 'darwin') {
        cmd = 'open';
        args = [url];
    } else if (platform === 'win32') {
        // `cmd /c start "" <url>` — the empty quoted title prevents
        // cmd.exe from treating the URL as the new window title.
        cmd = 'cmd';
        args = ['/c', 'start', '', url];
    } else {
        cmd = 'xdg-open';
        args = [url];
    }

    await new Promise<void>((resolve) => {
        try {
            const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false });
            child.on('error', () => {
                console.log(chalk.yellow('\n⚠ Could not open browser automatically.'));
                console.log(chalk.cyan(`Please open this URL manually: ${url}`));
                resolve();
            });
            child.on('spawn', () => {
                child.unref();
                resolve();
            });
        } catch {
            console.log(chalk.yellow('\n⚠ Could not open browser automatically.'));
            console.log(chalk.cyan(`Please open this URL manually: ${url}`));
            resolve();
        }
    });
}

// Build OAuth authorization URL
export function buildAuthUrl(redirectUri: string): string {
    const authUrl = new URL(`${WEB_URL}/api/auth/authorize`);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('response_type', 'token');
    authUrl.searchParams.append('client_id', 'cli');
    return authUrl.toString();
}

// Main OAuth flow
export async function performOAuthFlow(): Promise<string> {
    console.log(chalk.cyan('Starting OAuth authentication flow...'));

    // Get available port for callback server
    const port = await getAvailablePort();

    // Security: generate a cryptographically random CSRF/session-fixation
    // nonce and embed it in the redirect_uri. The web authorize flow appends
    // the sessionToken to this exact URL (preserving existing query params),
    // so the nonce round-trips back to the callback where it is verified
    // before any token is accepted. This binds the authorization to THIS CLI
    // invocation and defeats forged/raced callbacks.
    const state = crypto.randomBytes(32).toString('hex');
    // Use 127.0.0.1 (not `localhost`) to match the callback server, which binds
    // only to 127.0.0.1. On hosts that resolve `localhost` to IPv6 `::1` first,
    // a `localhost` redirect would hit `[::1]:<port>` where nothing is
    // listening and the OAuth login would hang.
    const redirectUri = `http://127.0.0.1:${port}/?state=${state}`;

    // Build authorization URL
    const authUrl = buildAuthUrl(redirectUri);

    console.log(chalk.gray(`\nStarting local server on port ${port}...`));

    // Start OAuth callback server
    const tokenPromise = startOAuthServer(port, state);

    // Open browser
    console.log(chalk.cyan('\nOpening browser for authentication...'));
    await openBrowser(authUrl);

    console.log(chalk.gray('\nWaiting for authentication...'));
    console.log(chalk.gray(`If the browser doesn't open, visit: ${authUrl}`));

    // Wait for token
    const sessionToken = await tokenPromise;

    console.log(chalk.green('\n✓ Authentication successful!'));

    return sessionToken;
}
