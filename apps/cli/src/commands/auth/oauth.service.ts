import * as http from 'http';
import { exec } from 'child_process';
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
        .replace(/"/g, '&quot;');

type OAuthPageState = 'success' | 'error' | 'waiting';

const renderOAuthPage = (state: OAuthPageState, message?: string) => {
    const palette = {
        success: {
            heading: 'Authentication Successful',
            closingScript: '<script>window.setTimeout(() => window.close(), 30 * 1000);</script>',
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
        server.listen(0, () => {
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
export async function startOAuthServer(port: number): Promise<string> {
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
            const url = new URL(req.url!, `http://localhost:${port}`);
            const sessionToken = url.searchParams.get('sessionToken');
            const error = url.searchParams.get('error');

            // Disable keep-alive to ensure connection closes
            res.setHeader('Connection', 'close');
            res.writeHead(200, { 'Content-Type': 'text/html' });

            if (error) {
                res.end(renderOAuthPage('error', error));
                closeAllConnections(error);
            } else if (sessionToken) {
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

        server.listen(port);

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
export async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;
    let command: string;
    const escapedUrl = url.replace(/"/g, '\\"');

    if (platform === 'darwin') {
        command = `open "${escapedUrl}"`;
    } else if (platform === 'win32') {
        // Pass empty title argument to avoid spawning a new console window instead of the browser
        command = `start "" "${escapedUrl}"`;
    } else {
        command = `xdg-open "${escapedUrl}"`;
    }

    try {
        await execAsync(command);
    } catch (error) {
        console.log(chalk.yellow('\n⚠ Could not open browser automatically.'));
        console.log(chalk.cyan(`Please open this URL manually: ${url}`));
    }
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
    const redirectUri = `http://localhost:${port}`;

    // Build authorization URL
    const authUrl = buildAuthUrl(redirectUri);

    console.log(chalk.gray(`\nStarting local server on port ${port}...`));

    // Start OAuth callback server
    const tokenPromise = startOAuthServer(port);

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
