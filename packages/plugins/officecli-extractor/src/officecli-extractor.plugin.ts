import type {
	IPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ContentExtractionOptions,
	ContentExtractionResult
} from '@ever-works/plugin';

import axios from 'axios';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';
import { OfficeCliTextExtractor } from './officecli-text-extractor.js';
import type { OfficeExtension, OfficeRenderMode } from './types.js';

// Cap the downloaded Office document size so an attacker who picks `source_url`
// (community-PR LLM, anonymous submission) can't OOM the extractor with a
// multi-GB file. Mirrors pdf-extractor's PDF_EXTRACTOR_MAX_BYTES; overridable
// per-call via the `maxBytes` setting. 25 MB covers every legitimate Office
// document we'd extract content from.
const OFFICECLI_MAX_BYTES = Number(process.env.OFFICECLI_EXTRACTOR_MAX_BYTES ?? 25 * 1024 * 1024);

/**
 * OfficeCLI content extractor: extracts text/markdown from Office documents
 * (.docx/.xlsx/.pptx) via the official OfficeCLI tool. Non-system, additive,
 * off by default — only handles Office document URLs, complementing
 * pdf-extractor (`.pdf`) with zero overlap.
 */
export class OfficeCliExtractorPlugin implements IPlugin, IContentExtractorPlugin {
	readonly id = 'officecli-extractor';
	readonly name = 'OfficeCLI Content Processor';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['content-extractor'];
	readonly providerName = 'OfficeCLI';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			renderMode: {
				type: 'string',
				title: 'Render Mode',
				description: 'Output format for extracted content: plain text or markdown.',
				enum: ['text', 'markdown'],
				default: 'text'
			},
			maxBytes: {
				type: 'number',
				title: 'Max Download Size (bytes)',
				description: 'Maximum size of the Office document to download and process, in bytes.',
				default: 25 * 1024 * 1024,
				minimum: 1024,
				maximum: 200 * 1024 * 1024
			},
			timeout: {
				type: 'number',
				title: 'Request Timeout',
				description: 'HTTP download + OfficeCLI command timeout in milliseconds',
				default: 30000,
				minimum: 5000,
				maximum: 300000,
				'x-hidden': true
			},
			binaryPath: {
				type: 'string',
				title: 'OfficeCLI Binary Path',
				description:
					'Optional absolute path to a specific officecli binary. Leave blank to use the bundled binary.',
				'x-hidden': true
			}
		}
	};

	readonly systemPlugin = false;
	readonly isDefault = false;

	private context?: PluginContext;
	private officeCliExtractor?: OfficeCliTextExtractor;

	async canExtract(url: string): Promise<boolean> {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return false;
			}
			return /\.(docx|xlsx|pptx)$/i.test(parsed.pathname);
		} catch {
			return false;
		}
	}

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;

		// Refuse to fetch URLs pointing at private, loopback, link-local, or
		// cloud-metadata IPs. `canExtract()` only enforces the file suffix, which
		// still admits `http://169.254.169.254/foo.docx`. Mirrors pdf-extractor.
		if (!isSafeWebhookUrl(url)) {
			return {
				success: false,
				url,
				error: `URL host is not safe to fetch (SSRF guard blocked: ${url})`,
				duration: Date.now() - startTime
			};
		}

		if (!this.officeCliExtractor) {
			return {
				success: false,
				url,
				error: 'OfficeCLI extractor service not initialized. Plugin may not be properly loaded.',
				duration: Date.now() - startTime
			};
		}

		const extension = this.detectExtension(url);
		if (!extension) {
			return {
				success: false,
				url,
				error: `Unsupported Office document URL (expected .docx/.xlsx/.pptx): ${url}`,
				duration: Date.now() - startTime
			};
		}

		const renderMode: OfficeRenderMode = (settings?.renderMode as string) === 'markdown' ? 'markdown' : 'text';
		const maxBytes = (settings?.maxBytes as number) ?? OFFICECLI_MAX_BYTES;
		const timeout = (settings?.timeout as number) ?? 30000;
		const binaryPath = (settings?.binaryPath as string) || undefined;

		try {
			this.context?.logger.debug(`Fetching Office document from ${url}`);
			const response = await axios.get(url, {
				responseType: 'arraybuffer',
				timeout,
				maxContentLength: maxBytes,
				maxBodyLength: maxBytes,
				maxRedirects: 5,
				// Security (SSRF): the lexical `isSafeWebhookUrl(url)` check above
				// only vets the INITIAL url. axios/follow-redirects transparently
				// follows up to 5 3xx hops, so a public, guard-passing
				// `https://evil.example.com/report.docx` can redirect to
				// http://169.254.169.254/... (cloud metadata) or http://127.0.0.1.
				// Re-run isSafeWebhookUrl on every redirect target (follow-redirects
				// populates options.href with the fully-resolved next URL before
				// invoking this hook); throwing here aborts the request and is
				// surfaced by the catch block below as a failed extraction. Mirrors
				// pdf-extractor / local-content-extractor.
				beforeRedirect: (options: Record<string, unknown>) => {
					const next = typeof options.href === 'string' ? options.href : '';
					if (!next || !isSafeWebhookUrl(next)) {
						throw new Error(`Redirect blocked by SSRF guard: ${next || '<unknown target>'}`);
					}
				},
				headers: {
					'User-Agent': 'EverWorks/OfficeCLI-Extractor'
				}
			});
			const buffer = Buffer.from(response.data);

			const { text } = await this.officeCliExtractor.extractText(buffer, extension, {
				renderMode,
				binary: binaryPath,
				timeoutMs: timeout
			});

			const wordCount = this.countWords(text);
			const title = this.extractTitle(text, url);

			return {
				success: true,
				url,
				title,
				content: text,
				markdown: text,
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Failed to extract Office document content: ${errorMessage}`);

			return {
				success: false,
				url,
				error: errorMessage,
				duration: Date.now() - startTime
			};
		}
	}

	async extractBatch(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]> {
		const results: ContentExtractionResult[] = [];

		for (const url of urls) {
			const result = await this.extract({
				url,
				...options
			});
			results.push(result);
		}

		return results;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	getSupportedFormats(): readonly ('text' | 'html' | 'markdown')[] {
		return ['text', 'markdown'];
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.officeCliExtractor = new OfficeCliTextExtractor();
		context.logger.log('OfficeCLI Processor Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.officeCliExtractor = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		if (!this.officeCliExtractor) {
			return {
				status: 'unhealthy',
				message: 'OfficeCLI extractor service not initialized',
				checkedAt: Date.now()
			};
		}

		return {
			status: 'healthy',
			message: 'OfficeCLI processor is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Process text content from Office documents (.docx/.xlsx/.pptx) via the OfficeCLI tool',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: false,
			supplementary: true,
			icon: {
				type: 'svg',
				value: `<svg width="800px" height="800px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="#2B579A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="#2B579A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 13h8M8 17h8M8 9h2" stroke="#2B579A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
			},
			readme: [
				'## What does the OfficeCLI Content Processor do?',
				'',
				'This plugin processes text content from Office documents (Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx`) and converts it to clean text or markdown for use as source material during work generation. It delegates to the [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) tool (Apache-2.0) via its official Node SDK.',
				'',
				'## Why use it?',
				'',
				'- **Use Office documents as source material** — process content from reports, spreadsheets, and slide decks',
				'- **Optional and off by default** — enable it only when you need Office extraction; `.pdf` is handled separately by the PDF extractor',
				'- **Text or markdown output** — choose the render mode that best fits your workflow',
				'',
				'## How it works in Ever Works',
				'',
				'When a source URL points to an Office document (`.docx` / `.xlsx` / `.pptx`), the content processor delegates to this plugin. It downloads the document (behind an SSRF guard and a byte cap), hands it to OfficeCLI, and returns the extracted text.',
				'',
				'## Getting started',
				'',
				'1. Enable the OfficeCLI Content Processor plugin on this page',
				'2. Choose a render mode (text or markdown) in the settings below',
				'3. Add Office document URLs as source material when generating your work',
				'',
				'## Attribution',
				'',
				'This plugin bundles and invokes the OfficeCLI binary, which is licensed under Apache-2.0. See the package README for the full NOTICE and attribution.'
			].join('\n')
		};
	}

	private detectExtension(url: string): OfficeExtension | null {
		try {
			const pathname = new URL(url).pathname;
			const match = pathname.match(/\.(docx|xlsx|pptx)$/i);
			return match ? (match[1].toLowerCase() as OfficeExtension) : null;
		} catch {
			return null;
		}
	}

	private countWords(text: string): number {
		return text.split(/\s+/).filter((word) => word.length > 0).length;
	}

	private extractTitle(text: string, url: string): string {
		const headingMatch = text.match(/^#\s+(.+)$/m);
		if (headingMatch) {
			return headingMatch[1];
		}

		const firstLine = text.split('\n').find((line) => line.trim().length > 0);
		if (firstLine && firstLine.trim().length <= 200) {
			return firstLine.trim();
		}

		try {
			const pathname = new URL(url).pathname;
			const filename = pathname.split('/').pop() || '';
			return filename.replace(/\.(docx|xlsx|pptx)$/i, '').replace(/[-_]/g, ' ');
		} catch {
			return 'Office Document';
		}
	}
}

export default OfficeCliExtractorPlugin;
