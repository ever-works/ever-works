import { AgentRunService } from '../agent-run.service';
import { PromptAssemblerService } from '../prompt-assembler.service';
import type {
	AgentRunChatBackPoster,
	AgentRunTaskFinisher,
} from '../agent-run-post-processor';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 15.5.
 *
 * Tests for `AgentRunService.finalize()`. Side-effects are best-effort
 * by design: the AgentRun row is always marked completed (or failed
 * for `errored`) regardless of whether the chat-back / task-finish
 * hooks succeed, so the LLM work isn't unwound by a flaky downstream.
 *
 * The hooks themselves are pluggable tokens, so unit tests inject
 * jest-mock implementations rather than the real `TaskChatService` /
 * `TasksService`.
 */
describe('AgentRunService.finalize()', () => {
	let agents: any;
	let runs: any;
	let runLogs: any;
	let budgets: any;
	let skillBindings: any;
	let activity: any;
	let assembler: PromptAssemblerService;
	let chatBackPoster: jest.Mocked<AgentRunChatBackPoster>;
	let taskFinisher: jest.Mocked<AgentRunTaskFinisher>;
	let svc: AgentRunService;

	beforeEach(() => {
		agents = { findById: jest.fn() };
		runs = {
			findByAgent: jest.fn().mockResolvedValue([]),
			markFailed: jest.fn().mockResolvedValue(undefined),
			markCompleted: jest.fn().mockResolvedValue(undefined),
		};
		runLogs = { append: jest.fn().mockResolvedValue(undefined) };
		budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
		skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
		activity = { log: jest.fn().mockResolvedValue(undefined) };
		assembler = new PromptAssemblerService();
		chatBackPoster = {
			postReply: jest.fn().mockResolvedValue({ messageId: 'msg-new' }),
		};
		taskFinisher = {
			finishTask: jest.fn().mockResolvedValue({ status: 'done' }),
		};
		svc = new AgentRunService(
			agents,
			runs,
			runLogs,
			budgets,
			assembler,
			skillBindings,
			activity,
			chatBackPoster,
			taskFinisher,
		);
	});

	const baseContext = (over: Record<string, unknown> = {}) => ({
		runId: 'r1',
		agentId: 'a1',
		userId: 'u1',
		kind: 'chat' as const,
		taskId: 't1',
		...over,
	});

	it('errored outcome → marks the AgentRun failed and skips side effects', async () => {
		const result = await svc.finalize(baseContext(), {
			errored: true,
			errorMessage: 'AI provider 429',
			replyBody: 'this should NOT post',
			taskFinishStatus: 'done',
		});
		expect(result.status).toBe('failed');
		expect(runs.markFailed).toHaveBeenCalledWith('r1', 'AI provider 429');
		expect(runs.markCompleted).not.toHaveBeenCalled();
		expect(chatBackPoster.postReply).not.toHaveBeenCalled();
		expect(taskFinisher.finishTask).not.toHaveBeenCalled();
	});

	it('chat kind + replyBody → marks completed AND posts a chat-back reply', async () => {
		const result = await svc.finalize(baseContext({ kind: 'chat' }), {
			summary: 'replied',
			replyBody: 'Hi! Here is what I found.',
		});
		expect(result.status).toBe('completed');
		expect(result.postedMessageId).toBe('msg-new');
		expect(runs.markCompleted).toHaveBeenCalledWith('r1', 'replied');
		expect(chatBackPoster.postReply).toHaveBeenCalledWith({
			userId: 'u1',
			taskId: 't1',
			agentId: 'a1',
			body: 'Hi! Here is what I found.',
		});
		expect(runLogs.append).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 'INFO',
				step: 'post-process',
				message: expect.stringContaining('msg-new'),
			}),
		);
	});

	it('chat kind + empty/blank replyBody → completes without posting', async () => {
		await svc.finalize(baseContext({ kind: 'chat' }), { replyBody: '   ' });
		expect(runs.markCompleted).toHaveBeenCalled();
		expect(chatBackPoster.postReply).not.toHaveBeenCalled();
	});

	it('chat kind + chat-back poster failure → completes anyway with WARN log row', async () => {
		chatBackPoster.postReply.mockRejectedValueOnce(new Error('chat row insert failed'));
		const result = await svc.finalize(baseContext({ kind: 'chat' }), {
			replyBody: 'hello',
		});
		expect(result.status).toBe('completed');
		expect(result.postedMessageId).toBeUndefined();
		expect(runLogs.append).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 'WARN',
				step: 'post-process',
				message: expect.stringContaining('Chat-back post failed'),
			}),
		);
	});

	it('chat kind without taskId → completes but logs WARN about missing taskId', async () => {
		await svc.finalize(baseContext({ kind: 'chat', taskId: null }), {
			replyBody: 'orphan reply',
		});
		expect(chatBackPoster.postReply).not.toHaveBeenCalled();
		expect(runLogs.append).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 'WARN',
				message: expect.stringContaining('chat-kind run has no taskId'),
			}),
		);
	});

	it('task kind + taskFinishStatus="done" → flips status via the finisher', async () => {
		const result = await svc.finalize(baseContext({ kind: 'task' }), {
			summary: 'completed',
			taskFinishStatus: 'done',
		});
		expect(result.status).toBe('completed');
		expect(result.finishedTaskStatus).toBe('done');
		expect(taskFinisher.finishTask).toHaveBeenCalledWith({
			userId: 'u1',
			taskId: 't1',
			to: 'done',
			force: false,
		});
	});

	it('task kind + force=true is plumbed into the finisher payload', async () => {
		await svc.finalize(baseContext({ kind: 'task' }), {
			taskFinishStatus: 'done',
			force: true,
		});
		expect(taskFinisher.finishTask).toHaveBeenCalledWith(
			expect.objectContaining({ force: true }),
		);
	});

	it('task kind + finisher failure → completes anyway with WARN log row', async () => {
		taskFinisher.finishTask.mockRejectedValueOnce(new Error('blocker gate'));
		const result = await svc.finalize(baseContext({ kind: 'task' }), {
			taskFinishStatus: 'done',
		});
		expect(result.status).toBe('completed');
		expect(result.finishedTaskStatus).toBeUndefined();
		expect(runLogs.append).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 'WARN',
				message: expect.stringContaining('Task-finish failed'),
			}),
		);
	});

	it('heartbeat kind → no side effects, just markCompleted', async () => {
		await svc.finalize(baseContext({ kind: 'heartbeat', taskId: null }), {
			summary: 'tick complete',
			replyBody: 'ignored',
			taskFinishStatus: 'done',
		});
		expect(runs.markCompleted).toHaveBeenCalledWith('r1', 'tick complete');
		expect(chatBackPoster.postReply).not.toHaveBeenCalled();
		expect(taskFinisher.finishTask).not.toHaveBeenCalled();
	});

	it('without poster/finisher bound → completes with WARN log instead of throwing', async () => {
		const bareSvc = new AgentRunService(
			agents,
			runs,
			runLogs,
			budgets,
			assembler,
			skillBindings,
			activity,
		);
		const result = await bareSvc.finalize(baseContext({ kind: 'chat' }), {
			replyBody: 'hello',
		});
		expect(result.status).toBe('completed');
		expect(runs.markCompleted).toHaveBeenCalled();
		expect(runLogs.append).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 'WARN',
				message: expect.stringContaining('chat-back poster not bound'),
			}),
		);
	});
});
