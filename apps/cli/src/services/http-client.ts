import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../commands/auth';
import { API_URL } from '../utils/constants';

// Security: `credentials.apiUrl` is read from `~/.ever-works/.credentials.json`
// on every request and used as the base URL the Bearer JWT is sent to. A tampered
// credentials file could therefore point that URL at an attacker host and exfiltrate
// the token. Mirror the `--api-url` guard in commands/auth/login.command.ts &
// commands/work/register.ts: require http(s) and refuse to attach the token when it
// would be sent in cleartext (`http:`) to a non-loopback host — that is never a
// legitimate flow (it is an attacker host or a misconfiguration). HTTPS to any host
// (self-hosted/custom domains stay supported, so no host allowlist) and loopback
// http (local dev, e.g. http://localhost:3100) remain fully permitted.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
    return LOOPBACK_HOSTNAMES.has(hostname) || hostname.startsWith('127.');
}

function assertApiUrlSafeForToken(apiUrl: string): void {
    let parsed: URL;
    try {
        parsed = new URL(apiUrl);
    } catch {
        throw new Error(`Refusing to send credentials to an invalid API URL: ${apiUrl}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Refusing to send credentials to a non-http(s) API URL: ${parsed.protocol}`);
    }
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
        throw new Error(
            `Refusing to send credentials over insecure HTTP to a non-local host (${parsed.host}). Re-authenticate against an https:// API URL.`,
        );
    }
}

export class HttpClient {
    private client: AxiosInstance;
    private apiUrl: string;

    constructor(apiUrl?: string) {
        this.apiUrl = apiUrl || API_URL;
        this.apiUrl = this.ensureApiEndpoint(this.apiUrl);

        this.client = axios.create({
            baseURL: this.apiUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // Add request interceptor for authentication
        this.client.interceptors.request.use(
            async (config) => {
                const credentials = await getCredentials();
                if (credentials) {
                    // Security: validate the stored apiUrl (which the token is sent to)
                    // before attaching the Bearer header, so a tampered credentials file
                    // cannot silently exfiltrate the token to an attacker-controlled host.
                    assertApiUrlSafeForToken(credentials.apiUrl);
                    config.headers.Authorization = `Bearer ${credentials.token}`;
                    // Update base URL if different from stored credentials
                    if (credentials.apiUrl !== this.apiUrl) {
                        this.apiUrl = this.ensureApiEndpoint(credentials.apiUrl);
                        config.baseURL = this.apiUrl;
                    }
                }
                return config;
            },
            (error) => {
                return Promise.reject(error);
            },
        );

        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            (response) => response,
            (error) => {
                if (error.response?.status === 401) {
                    console.error(
                        chalk.red(
                            '\n✗ Authentication failed. Please login again with "ever-works auth login".',
                        ),
                    );
                    process.exit(1);
                }
                return Promise.reject(error);
            },
        );
    }

    private ensureApiEndpoint(apiUrl: string) {
        if (!apiUrl.endsWith('/api')) {
            apiUrl = apiUrl.endsWith('/') ? apiUrl + 'api' : apiUrl + '/api';
        }

        return apiUrl;
    }

    async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        return this.client.get(url, config);
    }

    async post<T = any>(
        url: string,
        data?: any,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return this.client.post(url, data, config);
    }

    async put<T = any>(
        url: string,
        data?: any,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return this.client.put(url, data, config);
    }

    async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        return this.client.delete(url, config);
    }

    async patch<T = any>(
        url: string,
        data?: any,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return this.client.patch(url, data, config);
    }
}

// Singleton instance
let httpClientInstance: HttpClient | null = null;

export function getHttpClient(): HttpClient {
    if (!httpClientInstance) {
        httpClientInstance = new HttpClient();
    }
    return httpClientInstance;
}
