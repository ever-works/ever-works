import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiOperations } from '../ai-operations';

/**
 * Every AI provider plugin is an OpenAI-compatible Chat Completions endpoint, and
 * `AiOperations` reads the answer as a plain string. @langchain/openai 1.x's
 * `ChatOpenAI` sends some model names (`*codex*`, `gpt-5.6`, `gpt-5.x-pro`) to the
 * Responses API instead, where the answer comes back as content blocks and
 * `createChatCompletion` returned `''`. These pin the request to
 * `/chat/completions` for those names, and pin the tool binding that replaced the
 * `Runnable.bind()` LangChain 1.x removed.
 */

type Sent = { url: string; body: Record<string, any> };

function stubChatCompletions(message: Record<string, unknown>): Sent[] {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: unknown, init: { body: string }) => {
			sent.push({ url: String(url), body: JSON.parse(init.body) });
			return new Response(
				JSON.stringify({
					id: 'r1',
					object: 'chat.completion',
					created: 1,
					model: 'm',
					choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		})
	);
	return sent;
}

const ops = () => new AiOperations({ apiKey: 'sk-test', model: 'gpt-4o-mini', providerType: 'openai' });

describe('AiOperations — Chat Completions for every model', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each(['gpt-5.6', 'gpt-5.1-codex', 'gpt-5.2-pro', 'openai/gpt-5.1-codex'])(
		'sends %s to /chat/completions and returns its text',
		async (model) => {
			const sent = stubChatCompletions({ role: 'assistant', content: 'OK' });

			const response = await ops().createChatCompletion({ model, messages: [{ role: 'user', content: 'hi' }] });

			expect(sent).toHaveLength(1);
			expect(sent[0].url).toMatch(/\/chat\/completions$/);
			expect(sent[0].body.messages).toEqual([{ role: 'user', content: 'hi' }]);
			expect(response.choices[0].message.content).toBe('OK');
			expect(response.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
		}
	);

	it('sends the tools and tool_choice as written and maps the tool call back', async () => {
		const sent = stubChatCompletions({
			role: 'assistant',
			content: null,
			tool_calls: [
				{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }
			]
		});
		const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

		const response = await ops().createChatCompletion({
			messages: [{ role: 'user', content: 'weather?' }],
			tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters } }],
			toolChoice: 'required'
		});

		expect(sent[0].body.tools).toEqual([
			{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters } }
		]);
		expect(sent[0].body.tool_choice).toBe('required');
		expect(response.choices[0].finishReason).toBe('tool_calls');
		expect(response.choices[0].message.toolCalls).toEqual([
			{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }
		]);
	});
});
