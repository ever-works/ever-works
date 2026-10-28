import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiOperations } from '../ai-operations';

/**
 * A provider that rejects a request parameter gets the request again without it
 * (`withParamRetry`). The Claude API words that rejection with the parameter in
 * BACKTICKS — "`temperature` is deprecated for this model." — on Claude 4.7 and
 * later models, which reject any non-default temperature. Only single and double
 * quotes were recognised, so the error went straight to the caller and every
 * call to a current Claude model with the default temperature (0.7) failed,
 * connection tests included.
 */

type Sent = { body: Record<string, unknown> };

const TEMPERATURE_REJECTION = {
	type: 'error',
	error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' }
};

function okCompletion(message: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			id: 'r1',
			object: 'chat.completion',
			created: 1,
			model: 'claude-opus-5-5',
			choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
			usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

/** Answers 400 to any request that carries `temperature`, 200 otherwise. */
function stubProviderRejectingTemperature(): Sent[] {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init: { body: string }) => {
			const body = JSON.parse(init.body) as Record<string, unknown>;
			sent.push({ body });
			if ('temperature' in body) {
				return new Response(JSON.stringify(TEMPERATURE_REJECTION), {
					status: 400,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				JSON.stringify({
					id: 'r1',
					object: 'chat.completion',
					created: 1,
					model: String(body.model),
					choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		})
	);
	return sent;
}

const anthropicOps = () =>
	new AiOperations({
		apiKey: 'sk-ant-test',
		model: 'claude-opus-5-5',
		baseURL: 'https://api.anthropic.com/v1/',
		temperature: 0.7,
		maxTokens: 64,
		providerType: 'anthropic'
	});

describe('AiOperations — a parameter the provider rejects in backticks', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('retries a chat completion without `temperature` and returns the answer', async () => {
		const sent = stubProviderRejectingTemperature();

		const response = await anthropicOps().createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

		expect(response.choices[0].message.content).toBe('OK');
		expect(sent).toHaveLength(2);
		expect(sent[0].body.temperature).toBe(0.7);
		expect(sent[1].body).not.toHaveProperty('temperature');
	});

	it('does not send `temperature` to that model again once it was rejected', async () => {
		const sent = stubProviderRejectingTemperature();
		const ops = anthropicOps();

		await ops.createChatCompletion({ messages: [{ role: 'user', content: 'one' }] });
		await ops.createChatCompletion({ messages: [{ role: 'user', content: 'two' }] });

		expect(sent).toHaveLength(3);
		expect(sent[2].body).not.toHaveProperty('temperature');
	});

	it('passes a connection test (the per-tier model validation) on such a model', async () => {
		const sent = stubProviderRejectingTemperature();

		const result = await anthropicOps().testConnection(undefined, 'claude-opus-5-5');

		expect(result.error).toBeUndefined();
		expect(result.success).toBe(true);
		expect(sent).toHaveLength(2);
		expect(sent[1].body).not.toHaveProperty('temperature');
	});

	it('keeps a rejection to the endpoint it came from', async () => {
		// The proxy rejects `temperature`; the default endpoint accepts it.
		const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: unknown, init: { body: string }) => {
				const body = JSON.parse(init.body) as Record<string, unknown>;
				sent.push({ url: String(url), body });
				if (String(url).startsWith('https://proxy.example.com/') && 'temperature' in body) {
					return new Response(JSON.stringify(TEMPERATURE_REJECTION), {
						status: 400,
						headers: { 'content-type': 'application/json' }
					});
				}
				return okCompletion({ role: 'assistant', content: 'OK' });
			})
		);
		const ops = anthropicOps();

		await ops.testConnection({ baseURL: 'https://proxy.example.com/v1/' }, 'claude-opus-5-5');
		await ops.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

		const last = sent[sent.length - 1];
		expect(last.url).toMatch(/^https:\/\/api\.anthropic\.com\//);
		expect(last.body.temperature).toBe(0.7);
	});

	describe('a forced tool choice the model rejects', () => {
		// What the Claude API answers on models without forced tool use.
		const TOOL_CHOICE_REJECTION = {
			type: 'error',
			error: {
				type: 'invalid_request_error',
				message: 'tool_choice: type "tool" and "any" are not supported for this model.'
			}
		};
		const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
		const tools = [
			{ type: 'function' as const, function: { name: 'get_weather', description: 'Weather', parameters } }
		];

		/** Rejects `temperature`, then any forced `tool_choice`; otherwise answers a tool call. */
		function stubProviderRejectingForcedChoice(): Sent[] {
			const sent: Sent[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_url: unknown, init: { body: string }) => {
					const body = JSON.parse(init.body) as Record<string, unknown>;
					sent.push({ body });
					const reject = (payload: unknown) =>
						new Response(JSON.stringify(payload), {
							status: 400,
							headers: { 'content-type': 'application/json' }
						});
					if ('temperature' in body) return reject(TEMPERATURE_REJECTION);
					if (body.tool_choice === 'required' || typeof body.tool_choice === 'object') {
						return reject(TOOL_CHOICE_REJECTION);
					}
					return okCompletion({
						role: 'assistant',
						content: null,
						tool_calls: [
							{
								id: 'call_1',
								type: 'function',
								function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
							}
						]
					});
				})
			);
			return sent;
		}

		it('retries with the tools kept and the choice left to the model', async () => {
			const sent = stubProviderRejectingForcedChoice();

			const response = await anthropicOps().createChatCompletion({
				messages: [{ role: 'user', content: 'weather?' }],
				tools,
				toolChoice: 'required'
			});

			const last = sent[sent.length - 1].body;
			expect(last.tools).toEqual(tools);
			expect(last).not.toHaveProperty('tool_choice');
			expect(response.choices[0].message.toolCalls?.[0].function.name).toBe('get_weather');
		});

		it('gets a stream through on the first call too (temperature, then the choice, refused)', async () => {
			const sent: Sent[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_url: unknown, init: { body: string }) => {
					const body = JSON.parse(init.body) as Record<string, unknown>;
					sent.push({ body });
					const reject = (payload: unknown) =>
						new Response(JSON.stringify(payload), {
							status: 400,
							headers: { 'content-type': 'application/json' }
						});
					if ('temperature' in body) return reject(TEMPERATURE_REJECTION);
					if (body.tool_choice === 'required') return reject(TOOL_CHOICE_REJECTION);
					const chunk = {
						id: 'r1',
						object: 'chat.completion.chunk',
						created: 1,
						model: 'claude-opus-5-5',
						choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed' }, finish_reason: null }]
					};
					return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
						status: 200,
						headers: { 'content-type': 'text/event-stream' }
					});
				})
			);

			let text = '';
			for await (const chunk of anthropicOps().createStreamingChatCompletion({
				messages: [{ role: 'user', content: 'weather?' }],
				tools,
				toolChoice: 'required'
			})) {
				text += chunk.choices[0]?.delta?.content ?? '';
			}

			expect(text).toBe('streamed');
			const last = sent[sent.length - 1].body;
			expect(last.tools).toEqual(tools);
			expect(last).not.toHaveProperty('tool_choice');
		});

		it('still sends tool_choice "none" to that model afterwards', async () => {
			const sent = stubProviderRejectingForcedChoice();
			const ops = anthropicOps();

			await ops.createChatCompletion({
				messages: [{ role: 'user', content: 'weather?' }],
				tools,
				toolChoice: { type: 'function', function: { name: 'get_weather' } }
			});
			await ops.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'none' });

			const last = sent[sent.length - 1].body;
			expect(last.tools).toEqual(tools);
			expect(last.tool_choice).toBe('none');
		});
	});

	it('drops the tools for a provider that refuses every tool_choice, as before', async () => {
		const sent: Sent[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: unknown, init: { body: string }) => {
				const body = JSON.parse(init.body) as Record<string, unknown>;
				sent.push({ body });
				if ('tool_choice' in body) {
					return new Response(
						JSON.stringify({
							error: { type: 'invalid_request_error', message: 'tool_choice is not supported' }
						}),
						{ status: 400, headers: { 'content-type': 'application/json' } }
					);
				}
				return okCompletion({ role: 'assistant', content: 'plain answer' });
			})
		);
		const ops = new AiOperations({ apiKey: 'k', model: 'local-model', providerType: 'openai' });

		const response = await ops.createChatCompletion({
			messages: [{ role: 'user', content: 'hi' }],
			tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
			toolChoice: 'auto'
		});

		expect(response.choices[0].message.content).toBe('plain answer');
		expect(sent[sent.length - 1].body).not.toHaveProperty('tools');
	});

	it('still reports a failure the retry cannot fix', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							type: 'error',
							error: { type: 'not_found_error', message: 'model: claude-sonnet-4-5-20250514' }
						}),
						{ status: 404, headers: { 'content-type': 'application/json' } }
					)
			)
		);

		const result = await anthropicOps().testConnection(undefined, 'claude-sonnet-4-5-20250514');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/claude-sonnet-4-5-20250514/);
	});
});
