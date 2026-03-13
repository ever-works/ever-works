import { GenerationLogCollector, type FlushFn } from './generation-log-collector';
import type { GenerationStepLog } from '@ever-works/contracts/api';

describe('GenerationLogCollector', () => {
	let flushFn: jest.Mock<ReturnType<FlushFn>, Parameters<FlushFn>>;
	let collector: GenerationLogCollector;

	beforeEach(() => {
		jest.useFakeTimers();
		flushFn = jest.fn().mockResolvedValue(undefined);
		collector = new GenerationLogCollector('history-123', flushFn);
	});

	afterEach(async () => {
		await collector.dispose();
		jest.useRealTimers();
	});

	describe('log()', () => {
		it('should buffer log entries', () => {
			const entry: GenerationStepLog = {
				timestamp: new Date().toISOString(),
				level: 'info',
				source: 'pipeline',
				event: 'message',
				message: 'test message',
			};

			collector.log(entry);
			const recent = collector.getRecentLogs();
			expect(recent).toHaveLength(1);
			expect(recent[0].message).toBe('test message');
		});
	});

	describe('stepStarted()', () => {
		it('should create a step_started log entry', () => {
			collector.stepStarted(0, 'Setup');
			const logs = collector.getRecentLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].event).toBe('step_started');
			expect(logs[0].stepIndex).toBe(0);
			expect(logs[0].stepName).toBe('Setup');
			expect(logs[0].source).toBe('pipeline');
		});
	});

	describe('stepCompleted()', () => {
		it('should create a step_completed log entry with duration', () => {
			collector.stepCompleted(1, 'Generate', 1500);
			const logs = collector.getRecentLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].event).toBe('step_completed');
			expect(logs[0].durationMs).toBe(1500);
		});
	});

	describe('stepFailed()', () => {
		it('should create a step_failed log entry with error level', () => {
			collector.stepFailed(2, 'Collect', 'timeout');
			const logs = collector.getRecentLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].event).toBe('step_failed');
			expect(logs[0].level).toBe('error');
			expect(logs[0].message).toContain('timeout');
		});
	});

	describe('message()', () => {
		it('should create a message log entry with custom source', () => {
			collector.message('Generation started', 'info', 'orchestrator');
			const logs = collector.getRecentLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].source).toBe('orchestrator');
			expect(logs[0].event).toBe('message');
		});
	});

	describe('getRecentLogs()', () => {
		it('should return only the last N entries', () => {
			for (let i = 0; i < 20; i++) {
				collector.message(`msg ${i}`);
			}

			const recent = collector.getRecentLogs(5);
			expect(recent).toHaveLength(5);
			expect(recent[0].message).toBe('msg 15');
			expect(recent[4].message).toBe('msg 19');
		});

		it('should default to 20 entries', () => {
			for (let i = 0; i < 30; i++) {
				collector.message(`msg ${i}`);
			}

			const recent = collector.getRecentLogs();
			expect(recent).toHaveLength(20);
		});
	});

	describe('flush()', () => {
		it('should call flushFn with buffered entries and clear pending buffer', async () => {
			collector.message('one');
			collector.message('two');

			await collector.flush();

			expect(flushFn).toHaveBeenCalledWith('history-123', expect.any(Array));
			expect(flushFn.mock.calls[0][1]).toHaveLength(2);

			// Pending buffer should be cleared (no double-flush)
			flushFn.mockClear();
			await collector.flush();
			expect(flushFn).not.toHaveBeenCalled();
		});

		it('should preserve recent ring buffer after flush for live UI', async () => {
			collector.message('one');
			collector.message('two');

			await collector.flush();

			// Recent logs should still be available for live UI polling
			const recent = collector.getRecentLogs();
			expect(recent).toHaveLength(2);
			expect(recent[0].message).toBe('one');
			expect(recent[1].message).toBe('two');
		});

		it('should not call flushFn if buffer is empty', async () => {
			await collector.flush();
			expect(flushFn).not.toHaveBeenCalled();
		});
	});

	describe('auto-flush timer', () => {
		it('should auto-flush every 5 seconds', async () => {
			collector.message('auto');

			jest.advanceTimersByTime(5_000);
			// Allow the promise to resolve
			await Promise.resolve();

			expect(flushFn).toHaveBeenCalledTimes(1);
		});
	});

	describe('dispose()', () => {
		it('should do a final flush and clear the timer', async () => {
			collector.message('final');

			await collector.dispose();

			expect(flushFn).toHaveBeenCalledTimes(1);
			expect(flushFn.mock.calls[0][1]).toHaveLength(1);

			// Timer should be cleared — advancing time should not trigger another flush
			flushFn.mockClear();
			jest.advanceTimersByTime(10_000);
			await Promise.resolve();
			expect(flushFn).not.toHaveBeenCalled();
		});
	});
});
