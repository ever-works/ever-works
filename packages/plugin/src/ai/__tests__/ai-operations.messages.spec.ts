import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { AiOperations } from '../ai-operations';
import type { ChatMessage } from '../../contracts/capabilities/ai-provider.interface';

/**
 * `toLangChainMessages` is the boundary where our `ChatMessage` union meets
 * LangChain. It used to read:
 *
 *     const content = typeof msg.content === 'string' ? msg.content : '';
 *
 * so ANY array-shaped content — the multimodal form the contract has always
 * declared — became an empty string. No throw, no warning: the request went
 * out, the model answered, and the answer was about nothing. That failure is
 * invisible to every other kind of test, which is why it survived; these
 * pin it directly.
 *
 * The method is private, so the tests reach it the way the class's own
 * callers effectively do — via a typed cast — rather than by widening the
 * public API just to be testable.
 */

type MessageConverter = {
	toLangChainMessages(messages: readonly ChatMessage[]): unknown[];
};

const convert = (messages: readonly ChatMessage[]) =>
	(Object.create(AiOperations.prototype) as MessageConverter).toLangChainMessages(messages);

describe('AiOperations.toLangChainMessages', () => {
	it('passes a plain string through unchanged', () => {
		const [msg] = convert([{ role: 'user', content: 'hello' }]) as HumanMessage[];
		expect(msg).toBeInstanceOf(HumanMessage);
		expect(msg.content).toBe('hello');
	});

	it('does NOT drop multimodal content — the regression this file exists for', () => {
		const [msg] = convert([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'what is in this image?' },
					{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
				]
			}
		]) as HumanMessage[];

		expect(Array.isArray(msg.content)).toBe(true);
		const parts = msg.content as Array<Record<string, unknown>>;
		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatchObject({ type: 'text', text: 'what is in this image?' });
		expect(parts[1]).toMatchObject({
			type: 'image_url',
			image_url: { url: 'https://example.com/a.png' }
		});
	});

	it('preserves the image detail hint when one is supplied', () => {
		const [msg] = convert([
			{
				role: 'user',
				content: [{ type: 'image_url', image_url: { url: 'u', detail: 'high' } }]
			}
		]) as HumanMessage[];
		const parts = msg.content as Array<Record<string, unknown>>;
		expect(parts[0]).toMatchObject({ image_url: { url: 'u', detail: 'high' } });
	});

	it('collapses an all-text array back to a plain string', () => {
		// No reason to hand a provider a parts array for what is just text.
		const [msg] = convert([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'line one' },
					{ type: 'text', text: 'line two' }
				]
			}
		]) as HumanMessage[];
		expect(msg.content).toBe('line one\nline two');
	});

	it('flattens to TEXT for system messages rather than dropping them', () => {
		// Providers reject structured parts in a system message, so the
		// words have to survive as a string — previously they became ''.
		const [msg] = convert([
			{
				role: 'system',
				content: [
					{ type: 'text', text: 'be terse' },
					{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
				]
			}
		]) as SystemMessage[];
		expect(msg).toBeInstanceOf(SystemMessage);
		expect(msg.content).toBe('be terse\n[image]');
	});

	it('flattens to TEXT for tool messages and keeps the tool_call_id', () => {
		const [msg] = convert([
			{
				role: 'tool',
				toolCallId: 'call_42',
				content: [{ type: 'text', text: '{"ok":true}' }]
			}
		]) as ToolMessage[];
		expect(msg).toBeInstanceOf(ToolMessage);
		expect(msg.content).toBe('{"ok":true}');
		expect(msg.tool_call_id).toBe('call_42');
	});

	it('still carries assistant tool calls across', () => {
		const [msg] = convert([
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'doThing', arguments: '{"a":1}' }
					}
				]
			}
		]) as AIMessage[];
		expect(msg).toBeInstanceOf(AIMessage);
		expect(msg.tool_calls?.[0]).toMatchObject({
			id: 'call_1',
			name: 'doThing',
			args: { a: 1 }
		});
	});

	it('treats an empty array as empty string rather than throwing', () => {
		const [msg] = convert([{ role: 'user', content: [] }]) as HumanMessage[];
		expect(msg.content).toBe('');
	});
});
