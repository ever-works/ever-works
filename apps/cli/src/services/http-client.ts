import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import chalk from 'chalk';
import { getCredentials } from '../commands/auth';

export class HttpClient {
	private client: AxiosInstance;
	private apiUrl: string;

	constructor(apiUrl?: string) {
		this.apiUrl = apiUrl || process.env.API_URL || 'http://localhost:3100';
		this.client = axios.create({
			baseURL: this.apiUrl,
			timeout: 30000,
			headers: {
				'Content-Type': 'application/json'
			}
		});

		// Add request interceptor for authentication
		this.client.interceptors.request.use(
			async (config) => {
				const credentials = await getCredentials();
				if (credentials) {
					config.headers.Authorization = `Bearer ${credentials.token}`;
					// Update base URL if different from stored credentials
					if (credentials.apiUrl !== this.apiUrl) {
						this.apiUrl = credentials.apiUrl;
						config.baseURL = credentials.apiUrl;
					}
				}
				return config;
			},
			(error) => {
				return Promise.reject(error);
			}
		);

		// Add response interceptor for error handling
		this.client.interceptors.response.use(
			(response) => response,
			(error) => {
				if (error.response?.status === 401) {
					console.error(
						chalk.red('\n✗ Authentication failed. Please login again with "ever-works auth login".')
					);
					process.exit(1);
				}
				return Promise.reject(error);
			}
		);
	}

	async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
		return this.client.get(url, config);
	}

	async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
		return this.client.post(url, data, config);
	}

	async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
		return this.client.put(url, data, config);
	}

	async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
		return this.client.delete(url, config);
	}

	async patch<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
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
