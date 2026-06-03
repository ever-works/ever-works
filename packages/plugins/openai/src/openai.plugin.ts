import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';
import type {
	PluginContext,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	PluginSettings,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse,
	TranscriptionOptions,
	TranscriptionResponse,
	AiModel,
	AiModelCapabilities
} from '@ever-works/plugin';

/**
 * OpenAI AI provider plugin
 *
 * Provides AI capabilities through OpenAI's API.
 * Uses 'user-required' configuration mode - users MUST provide their own API key.
 */
export class OpenAiPlugin extends BaseAiProvider {
	readonly id = 'openai';
	readonly name = 'OpenAI';
	readonly version = '1.0.0';
	readonly providerType = 'openai';
	readonly providerName = 'OpenAI';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'OpenAI API Key',
				description: 'Connects to OpenAI for content generation and chat',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				description: 'Used for all AI tasks unless a tier-specific model is set',
				default: 'gpt-5.1',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Handles tags, short descriptions, and quick classifications',
				default: 'gpt-5-nano',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Handles listings, summaries, and content reformatting',
				default: 'gpt-4o-mini',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description: 'Handles full page generation and multi-step analysis',
				default: 'gpt-5.1',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			embeddingModel: {
				type: 'string',
				title: 'Embedding Model',
				description:
					"Used by the Knowledge Base's semantic search to turn documents into vectors. text-embedding-3-small is the cheapest (1c/1M tokens) and a strong default for English-heavy KBs.",
				default: 'text-embedding-3-small',
				'x-widget': 'model-select',
				'x-scope': 'global'
			},
			transcriptionModel: {
				type: 'string',
				title: 'Transcription Model',
				description:
					'Speech-to-text model for Knowledge Base media (video/audio) ingest. whisper-1 is the broadest-supported and the cheapest at $0.006/min. gpt-4o-transcribe yields higher accuracy on noisy audio at higher cost.',
				default: 'whisper-1',
				'x-widget': 'model-select',
				'x-scope': 'global',
				'x-envVar': 'OPENAI_TRANSCRIPTION_MODEL'
			},
			temperature: {
				type: 'number',
				title: 'Temperature',
				description: 'Lower values give consistent output, higher values add variety',
				default: 0.7,
				minimum: 0,
				maximum: 2,
				'x-hidden': true
			},
			maxTokens: {
				type: 'number',
				title: 'Max Tokens',
				description: 'Limits the length of each AI-generated response',
				default: 4096,
				'x-hidden': true
			},
			baseUrl: {
				type: 'string',
				title: 'Base URL',
				description: 'OpenAI API endpoint',
				default: 'https://api.openai.com/v1',
				'x-hidden': true
			}
		},
		required: ['apiKey', 'defaultModel']
	};

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'gpt-5-nano',
			temperature: 0.7,
			baseURL: 'https://api.openai.com/v1',
			maxTokens: 4096,
			providerType: 'openai'
		});
		context.logger.log('OpenAI Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		return this.aiOps.createChatCompletion(options, resolvedConfig);
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		yield* this.aiOps.createStreamingChatCompletion(options, resolvedConfig);
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		// EW-641 Phase 2/a row 27 — thread per-call `options.settings`
		// through `BaseAiProvider.resolveConfig` so `apiKey` +
		// `embeddingModel` from user/work-scoped settings reach the
		// underlying LangChain `OpenAIEmbeddings` call. Final fallback to
		// `text-embedding-3-small` (OpenAI's default KB-workload embedding
		// model, 1536-dim, cheapest in the embedding tier) so callers that
		// supply neither `options.model` nor a settings override still get
		// a working call instead of the "Embedding model must be specified"
		// throw from `AiOperations.createEmbedding`.
		const resolvedConfig = this.resolveConfig(options.settings);
		if (!options.model && !resolvedConfig.embeddingModel) {
			resolvedConfig.embeddingModel = 'text-embedding-3-small';
		}
		return this.aiOps.createEmbedding(options, resolvedConfig);
	}

	/**
	 * Whisper-backed speech-to-text. Wraps OpenAI's `/v1/audio/transcriptions`
	 * REST endpoint directly with `fetch` + `FormData` so the plugin avoids
	 * pulling the heavy `openai` SDK just for this code path (we already do
	 * everything else via LangChain).
	 *
	 * The handler accepts any of the three binary shapes the KB ingest task
	 * forwards — Web ReadableStream (from the upload route), Node Buffer (from
	 * the Trigger.dev local runner), or Uint8Array (from tests). We normalize
	 * to a Blob before constructing the multipart body so the OpenAI server's
	 * MIME sniffer sees a real file part with the original filename.
	 *
	 * Disabled-by-omission: when `apiKey` is unset the call throws — the
	 * facade catches and falls through to the next provider in the chain.
	 */
	async transcribe(options: TranscriptionOptions): Promise<TranscriptionResponse> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		const resolvedConfig = this.resolveConfig(options.settings);
		const apiKey = resolvedConfig.apiKey;
		if (!apiKey || typeof apiKey !== 'string') {
			throw new Error('OpenAI apiKey is required for transcribe()');
		}
		const baseUrl = (resolvedConfig.baseURL as string) || 'https://api.openai.com/v1';
		const model = options.model || (resolvedConfig.transcriptionModel as string | undefined) || 'whisper-1';
		const url = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;

		const bytes = await this.normaliseAudioInput(options.file);
		const blob = new Blob([bytes], { type: this.detectMimeFromName(options.filename) });
		const form = new FormData();
		form.append('file', blob, options.filename);
		form.append('model', model);
		form.append('response_format', 'verbose_json');
		if (options.language) form.append('language', options.language);
		if (options.prompt) form.append('prompt', options.prompt);

		const response = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}` },
			body: form
		});
		if (!response.ok) {
			const errBody = await response.text();
			throw new Error(`OpenAI transcribe HTTP ${response.status}: ${errBody.slice(0, 400)}`);
		}
		const payload = (await response.json()) as {
			text: string;
			language?: string;
			duration?: number;
			segments?: Array<{ start: number; end: number; text: string }>;
		};
		return {
			text: payload.text,
			model,
			language: payload.language,
			durationSeconds: payload.duration,
			segments: payload.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text }))
		};
	}

	private async normaliseAudioInput(input: TranscriptionOptions['file']): Promise<Uint8Array> {
		if (input instanceof Uint8Array) return input;
		// Node Buffer is a Uint8Array subclass — handled above. Otherwise
		// drain the Web ReadableStream into a single Uint8Array.
		const reader = (input as ReadableStream<Uint8Array>).getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			// Loop until end-of-stream. We avoid `for await` so this runs
			// unchanged on Node runtimes that don't yet expose async
			// iteration on the global ReadableStream.
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) {
					chunks.push(value);
					total += value.byteLength;
				}
			}
		} finally {
			// Greptile P2: must release the lock even on read() error —
			// otherwise the stream stays locked and any retry blocks forever.
			try {
				reader.releaseLock();
			} catch {
				// releaseLock throws if the stream is already closed; ignore.
			}
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			out.set(c, offset);
			offset += c.byteLength;
		}
		return out;
	}

	private detectMimeFromName(filename: string): string {
		const ext = filename.toLowerCase().split('.').pop() ?? '';
		const map: Record<string, string> = {
			mp3: 'audio/mpeg',
			m4a: 'audio/mp4',
			mp4: 'audio/mp4',
			mpeg: 'audio/mpeg',
			mpga: 'audio/mpeg',
			wav: 'audio/wav',
			webm: 'audio/webm',
			oga: 'audio/ogg',
			ogg: 'audio/ogg',
			flac: 'audio/flac'
		};
		return map[ext] ?? 'application/octet-stream';
	}

	async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
		if (!this.aiOps) {
			throw new Error('OpenAI plugin not loaded');
		}
		return this.aiOps.listModels(this.resolveConfig(settings));
	}

	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength: 128000
		};
	}

	protected getDefaultModelId(): string {
		return 'gpt-5-nano';
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'OpenAI plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Use OpenAI models like GPT-4o for content generation and AI features',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			uiHints: {
				completionFields: ['apiKey', 'defaultModel']
			},
			readme: [
				'## What is the OpenAI plugin?',
				'',
				"This plugin connects Ever Works directly to OpenAI's API, providing access to models such as GPT-4o, GPT-4o mini, and OpenAI's text-embedding models. Use it when you prefer a direct connection to OpenAI with your own API key.",
				'',
				'## Why use it?',
				'',
				'- **Direct API access** — connect to OpenAI without an intermediary for the lowest possible latency',
				'- **Latest models** — access new OpenAI releases as soon as they become available',
				'- **Embedding support** — use text-embedding-3-small or other models for semantic search within your works',
				'- **Vision capabilities** — models with image understanding for richer content analysis',
				'',
				'## How it works in Ever Works',
				'',
				'When selected as the AI provider, OpenAI handles content generation during work creation, powers the conversational AI assistant, and produces embeddings for semantic search. You can assign different models to simple, standard, and complex task tiers to control cost and output quality.',
				'',
				'## Getting started',
				'',
				'1. Obtain an API key from [platform.openai.com](https://platform.openai.com/api-keys)',
				'2. Enable the OpenAI plugin on this page',
				'3. Enter your API key in the settings below',
				'4. Select your preferred models for each task complexity level'
			].join('\n'),
			homepage: 'https://platform.openai.com',
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 6.34c.19-.95.02-1.93-.47-2.76A3.67 3.67 0 0 0 9.38 1.7a3.59 3.59 0 0 0-2.7-1.2A3.67 3.67 0 0 0 3.2 3.54c-.98.17-1.84.72-2.4 1.53A3.67 3.67 0 0 0 1.26 9.6c-.18.95-.02 1.93.47 2.76a3.67 3.67 0 0 0 3.93 1.88 3.59 3.59 0 0 0 2.7 1.2 3.67 3.67 0 0 0 3.48-3.04c.98-.17 1.84-.72 2.4-1.53a3.67 3.67 0 0 0-.46-4.53zM8.36 14.1a2.74 2.74 0 0 1-1.76-.64l.09-.05 2.92-1.68c.15-.09.24-.25.24-.42V7.28l1.23.71s.02.01.02.03v3.41c0 1.47-1.23 2.67-2.74 2.67zm-5.9-2.45a2.68 2.68 0 0 1-.32-1.82l.09.05 2.92 1.69c.15.09.33.09.48 0l3.56-2.06v1.42s0 .03-.02.04l-2.95 1.7a2.76 2.76 0 0 1-3.76-1.02zm-.77-6.2A2.7 2.7 0 0 1 3.1 4.1v.1l-.01 3.37c0 .17.09.34.24.42l3.56 2.06-1.24.71-.02-.01-2.95-1.7a2.68 2.68 0 0 1-.99-3.61zm10.14 2.36L8.27 5.75l1.23-.71s.02-.01.03 0l2.95 1.7a2.68 2.68 0 0 1 .42 4.42v-3.47c0-.18-.1-.34-.25-.43l.18.1zm1.23-1.84-.09-.05-2.92-1.69a.47.47 0 0 0-.48 0L6.01 6.29V4.87l.02-.04 2.95-1.7a2.76 2.76 0 0 1 4.08 2.84zM5.37 8.72 4.14 8s0-.03.01-.04V4.55c0-1.48 1.24-2.68 2.75-2.68.56 0 1.1.17 1.56.48l-.09.05-2.92 1.68a.48.48 0 0 0-.24.43l.16 4.21zm.67-1.48L8 6.14l1.96 1.13v2.26L8 10.66l-1.96-1.13V7.24z"/></svg>',
				backgroundColor: '#000000'
			}
		};
	}
}

export default OpenAiPlugin;
