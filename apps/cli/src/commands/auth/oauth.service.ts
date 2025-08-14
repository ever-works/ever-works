import * as http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { WEB_URL } from '../../utils/constants';

const execAsync = promisify(exec);

const DEFAULT_PORT = 44663;

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
                res.end(`
                    <html>
                        <body style="font-family: system-ui; padding: 40px; text-align: center;">
                            <h2 style="color: #dc2626;">Authentication Failed</h2>
                            <p>${error.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                            <p>You can close this window.</p>
                        </body>
                    </html>
                `);

                closeAllConnections(error);
            } else if (sessionToken) {
                res.end(`
                    <html>
                        <body style="font-family: system-ui; padding: 40px; text-align: center;">
                            <h2 style="color: #059669;">Authentication Successful!</h2>
                            <p>You can close this window and return to the terminal.</p>
                            <script>window.setTimeout(() => window.close(), 10000);</script>
                        </body>
                    </html>
                `);

                closeAllConnections(undefined, sessionToken);
            } else {
                res.end(`
                    <html>
                        <body style="font-family: system-ui; padding: 40px; text-align: center;">
                            <h2>Waiting for authentication...</h2>
                        </body>
                    </html>
                `);
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

    if (platform === 'darwin') {
        command = `open "${url}"`;
    } else if (platform === 'win32') {
        command = `start "${url}"`;
    } else {
        command = `xdg-open "${url}"`;
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
