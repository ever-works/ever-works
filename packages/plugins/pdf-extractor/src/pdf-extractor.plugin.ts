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
import { PdfTextExtractor } from './pdf-text-extractor.js';
import { MistralOcrService } from './mistral-ocr.service.js';

/**
 * Hybrid PDF extractor: text-layer extraction (pdf-parse) with Mistral OCR fallback
 * for scanned/image-based PDFs. Non-system, additive — only handles .pdf URLs.
 */
export class PdfExtractorPlugin implements IPlugin, IContentExtractorPlugin {
	readonly id = 'pdf-extractor';
	readonly name = 'PDF Content Processor';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['content-extractor'];
	readonly providerName = 'PDF';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			mistralApiKey: {
				type: 'string',
				title: 'Mistral API Key',
				description:
					'Optional - Your Mistral AI API key. Required only for OCR fallback on scanned/image-based PDFs. Text-layer extraction works without it.',
				minLength: 10,
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'PLUGIN_PDF_EXTRACTOR_API_KEY'
			},
			ocrModel: {
				type: 'string',
				title: 'OCR Model',
				description: 'Mistral OCR model ID',
				default: 'mistral-ocr-latest',
				'x-hidden': true
			},
			textDensityThreshold: {
				type: 'number',
				title: 'Text Density Threshold',
				description: 'Characters per page below which OCR is triggered',
				default: 100,
				minimum: 0,
				maximum: 10000,
				'x-hidden': true
			},
			maxPages: {
				type: 'number',
				title: 'Max Pages',
				description: 'Maximum number of pages to process',
				default: 50,
				minimum: 1,
				maximum: 500,
				'x-hidden': true
			},
			timeout: {
				type: 'number',
				title: 'Request Timeout',
				description: 'HTTP request timeout in milliseconds',
				default: 60000,
				minimum: 5000,
				maximum: 300000,
				'x-hidden': true
			}
		}
	};

	readonly systemPlugin = false;
	readonly isDefault = false;

	private context?: PluginContext;
	private pdfTextExtractor?: PdfTextExtractor;
	private mistralOcrService?: MistralOcrService;

	async canExtract(url: string): Promise<boolean> {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return false;
			}
			return /\.pdf$/i.test(parsed.pathname);
		} catch {
			return false;
		}
	}

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;

		if (!this.pdfTextExtractor || !this.mistralOcrService) {
			return {
				success: false,
				url,
				error: 'PDF extractor services not initialized. Plugin may not be properly loaded.',
				duration: Date.now() - startTime
			};
		}

		const mistralApiKey = (settings?.mistralApiKey as string) || '';
		const textDensityThreshold = (settings?.textDensityThreshold as number) ?? 100;
		const maxPages = (settings?.maxPages as number) ?? 50;
		const timeout = (settings?.timeout as number) ?? 60000;
		const ocrModel = (settings?.ocrModel as string) || 'mistral-ocr-latest';

		try {
			this.context?.logger.debug(`Fetching PDF from ${url}`);
			const response = await axios.get(url, {
				responseType: 'arraybuffer',
				timeout,
				headers: {
					'User-Agent': 'EverWorks/PDF-Extractor'
				}
			});
			const pdfBuffer = Buffer.from(response.data);

			const textResult = await this.pdfTextExtractor.extractText(pdfBuffer, maxPages);
			const density = this.pdfTextExtractor.calculateTextDensity(textResult.text, textResult.numPages);
			this.context?.logger.debug(
				`Text density: ${density.toFixed(1)} chars/page (threshold: ${textDensityThreshold})`
			);

			if (density >= textDensityThreshold) {
				const wordCount = this.countWords(textResult.text);
				const title = this.extractTitle(textResult.text, url);

				return {
					success: true,
					url,
					title,
					content: textResult.text,
					markdown: textResult.text,
					duration: Date.now() - startTime,
					wordCount,
					readingTime: Math.ceil(wordCount / 200)
				};
			}

			if (mistralApiKey) {
				this.context?.logger.debug('Low text density, attempting OCR via Mistral');
				try {
					const ocrResponse = await this.mistralOcrService.processDocument(url, mistralApiKey, {
						model: ocrModel,
						timeout
					});

					const ocrMarkdown = this.mistralOcrService.combinePages(ocrResponse);

					if (ocrMarkdown) {
						const wordCount = this.countWords(ocrMarkdown);
						const title = this.extractTitle(ocrMarkdown, url);

						return {
							success: true,
							url,
							title,
							content: ocrMarkdown,
							markdown: ocrMarkdown,
							duration: Date.now() - startTime,
							wordCount,
							readingTime: Math.ceil(wordCount / 200)
						};
					}
				} catch (ocrError) {
					const errorMessage = ocrError instanceof Error ? ocrError.message : String(ocrError);
					this.context?.logger.warn(`OCR fallback failed: ${errorMessage}. Using text-layer result.`);
				}
			} else {
				this.context?.logger.warn(
					'Low text density detected but no Mistral API key configured. Returning sparse text-layer content.'
				);
			}

			const wordCount = this.countWords(textResult.text);
			const title = this.extractTitle(textResult.text, url);

			return {
				success: true,
				url,
				title,
				content: textResult.text,
				markdown: textResult.text,
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Failed to extract PDF content: ${errorMessage}`);

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
		this.pdfTextExtractor = new PdfTextExtractor();
		this.mistralOcrService = new MistralOcrService();
		context.logger.log('PDF Processor Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.pdfTextExtractor = undefined;
		this.mistralOcrService = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		if (!this.pdfTextExtractor) {
			return {
				status: 'unhealthy',
				message: 'PDF extractor services not initialized',
				checkedAt: Date.now()
			};
		}

		return {
			status: 'healthy',
			message: 'PDF processor is ready (text-layer processing available)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Process text content from PDF files to use as source material for your work',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: false,
			supplementary: true,
			icon: {
				type: 'svg',
				value: `<svg width="800px" height="800px" viewBox="-4 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M25.6686 26.0962C25.1812 26.2401 24.4656 26.2563 23.6984 26.145C22.875 26.0256 22.0351 25.7739 21.2096 25.403C22.6817 25.1888 23.8237 25.2548 24.8005 25.6009C25.0319 25.6829 25.412 25.9021 25.6686 26.0962ZM17.4552 24.7459C17.3953 24.7622 17.3363 24.7776 17.2776 24.7939C16.8815 24.9017 16.4961 25.0069 16.1247 25.1005L15.6239 25.2275C14.6165 25.4824 13.5865 25.7428 12.5692 26.0529C12.9558 25.1206 13.315 24.178 13.6667 23.2564C13.9271 22.5742 14.193 21.8773 14.468 21.1894C14.6075 21.4198 14.7531 21.6503 14.9046 21.8814C15.5948 22.9326 16.4624 23.9045 17.4552 24.7459ZM14.8927 14.2326C14.958 15.383 14.7098 16.4897 14.3457 17.5514C13.8972 16.2386 13.6882 14.7889 14.2489 13.6185C14.3927 13.3185 14.5105 13.1581 14.5869 13.0744C14.7049 13.2566 14.8601 13.6642 14.8927 14.2326ZM9.63347 28.8054C9.38148 29.2562 9.12426 29.6782 8.86063 30.0767C8.22442 31.0355 7.18393 32.0621 6.64941 32.0621C6.59681 32.0621 6.53316 32.0536 6.44015 31.9554C6.38028 31.8926 6.37069 31.8476 6.37359 31.7862C6.39161 31.4337 6.85867 30.8059 7.53527 30.2238C8.14939 29.6957 8.84352 29.2262 9.63347 28.8054ZM27.3706 26.1461C27.2889 24.9719 25.3123 24.2186 25.2928 24.2116C24.5287 23.9407 23.6986 23.8091 22.7552 23.8091C21.7453 23.8091 20.6565 23.9552 19.2582 24.2819C18.014 23.3999 16.9392 22.2957 16.1362 21.0733C15.7816 20.5332 15.4628 19.9941 15.1849 19.4675C15.8633 17.8454 16.4742 16.1013 16.3632 14.1479C16.2737 12.5816 15.5674 11.5295 14.6069 11.5295C13.948 11.5295 13.3807 12.0175 12.9194 12.9813C12.0965 14.6987 12.3128 16.8962 13.562 19.5184C13.1121 20.5751 12.6941 21.6706 12.2895 22.7311C11.7861 24.0498 11.2674 25.4103 10.6828 26.7045C9.04334 27.3532 7.69648 28.1399 6.57402 29.1057C5.8387 29.7373 4.95223 30.7028 4.90163 31.7107C4.87693 32.1854 5.03969 32.6207 5.37044 32.9695C5.72183 33.3398 6.16329 33.5348 6.6487 33.5354C8.25189 33.5354 9.79489 31.3327 10.0876 30.8909C10.6767 30.0029 11.2281 29.0124 11.7684 27.8699C13.1292 27.3781 14.5794 27.011 15.985 26.6562L16.4884 26.5283C16.8668 26.4321 17.2601 26.3257 17.6635 26.2153C18.0904 26.0999 18.5296 25.9802 18.976 25.8665C20.4193 26.7844 21.9714 27.3831 23.4851 27.6028C24.7601 27.7883 25.8924 27.6807 26.6589 27.2811C27.3486 26.9219 27.3866 26.3676 27.3706 26.1461ZM30.4755 36.2428C30.4755 38.3932 28.5802 38.5258 28.1978 38.5301H3.74486C1.60224 38.5301 1.47322 36.6218 1.46913 36.2428L1.46884 3.75642C1.46884 1.6039 3.36763 1.4734 3.74457 1.46908H20.263L20.2718 1.4778V7.92396C20.2718 9.21763 21.0539 11.6669 24.0158 11.6669H30.4203L30.4753 11.7218L30.4755 36.2428ZM28.9572 10.1976H24.0169C21.8749 10.1976 21.7453 8.29969 21.7424 7.92417V2.95307L28.9572 10.1976ZM31.9447 36.2428V11.1157L21.7424 0.871022V0.823357H21.6936L20.8742 0H3.74491C2.44954 0 0 0.785336 0 3.75711V36.2435C0 37.5427 0.782956 40 3.74491 40H28.2001C29.4952 39.9997 31.9447 39.2143 31.9447 36.2428Z" fill="#EB5757"/></svg>`
			},
			readme: [
				'## What does the PDF Content Processor do?',
				'',
				'This plugin processes text content from PDF files and converts it to clean markdown for use as source material during work generation. It uses a hybrid approach: fast text-layer processing for text-based PDFs, with optional OCR fallback via Mistral AI for scanned or image-based documents.',
				'',
				'## Why use it?',
				'',
				'- **Use PDFs as source material** — process content from research papers, reports, and documentation',
				'- **No API key required for text PDFs** — text-layer processing works out of the box',
				'- **OCR for scanned documents** — optionally configure a Mistral AI key for image-based PDFs',
				'- **Smart detection** — automatically determines if a PDF needs OCR based on text density',
				'',
				'## How it works in Ever Works',
				'',
				'When a source URL points to a PDF file (.pdf extension), the content processor delegates to this plugin instead of the default processor. It downloads the PDF, retrieves text from the text layer, and if the text density is too low (indicating a scanned document), falls back to Mistral OCR if an API key is configured.',
				'',
				'## Getting started',
				'',
				'1. Enable the PDF Content Processor plugin on this page',
				'2. For text-based PDFs, no additional configuration is required',
				'3. For scanned/image-based PDFs, get a Mistral AI API key from [console.mistral.ai](https://console.mistral.ai) and enter it in the settings below',
				'4. Add PDF URLs as source material when generating your work'
			].join('\n')
		};
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
			return filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
		} catch {
			return 'PDF Document';
		}
	}
}

export default PdfExtractorPlugin;
