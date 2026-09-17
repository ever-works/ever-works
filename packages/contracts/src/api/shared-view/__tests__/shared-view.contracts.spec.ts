import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	PUBLISHABLE_ACTIVITY_ACTIONS,
	PUBLISHED_COLUMN_KEYS,
	SHARED_VIEW_LIMITS,
	SHARED_VIEW_STATUSES,
	isPublishableActivityAction,
	isSharedViewStatus,
	type PublishedActivityLineDto,
	type PublishedAgentDto,
	type PublishedBoardDto,
	type PublishedTaskCardDto
} from '../index.js';
import { TASK_BOARD_FOCUS_COLUMNS } from '../../../tasks/task-board-columns.types.js';

describe('shared view contracts', () => {
	it('publishes the Focus layout columns in board order, without Cancelled', () => {
		const focus = TASK_BOARD_FOCUS_COLUMNS.filter((column) => !column.toggleOnly).map((column) => column.key);
		expect([...PUBLISHED_COLUMN_KEYS]).toEqual(focus);
		expect(PUBLISHED_COLUMN_KEYS).not.toContain('cancelled');
	});

	it('pins the numbers the published page promises', () => {
		expect(SHARED_VIEW_LIMITS.tokenLength).toBe(43);
		expect(SHARED_VIEW_LIMITS.tokenBytes * 8).toBe(256);
		expect(SHARED_VIEW_LIMITS.viewSessionTtlSeconds).toBe(900);
		expect(SHARED_VIEW_LIMITS.columnCardLimit).toBe(50);
		expect(SHARED_VIEW_LIMITS.activityLineLimit).toBe(20);
		expect(SHARED_VIEW_LIMITS.requestsPerTokenPerMinute).toBe(60);
		expect(SHARED_VIEW_LIMITS.requestsPerClientPerHour).toBe(600);
		expect(SHARED_VIEW_LIMITS.retryAfterSeconds).toBe(60);
	});

	it('accepts only the two statuses', () => {
		expect([...SHARED_VIEW_STATUSES]).toEqual(['active', 'paused']);
		expect(isSharedViewStatus('active')).toBe(true);
		expect(isSharedViewStatus('paused')).toBe(true);
		for (const value of ['deleted', 'ACTIVE', '', null, undefined, 1]) {
			expect(isSharedViewStatus(value)).toBe(false);
		}
	});

	it('keeps the publishable activity list frozen and closed', () => {
		expect(Object.isFrozen(PUBLISHABLE_ACTIVITY_ACTIONS)).toBe(true);
		expect(isPublishableActivityAction('task_completed')).toBe(true);
		for (const value of ['task_commented', 'kb_document_created', 'git_pushed', 'agent_run_failed', 42]) {
			expect(isPublishableActivityAction(value)).toBe(false);
		}
	});

	it('declares the published shapes as closed objects', () => {
		expectTypeOf<keyof PublishedTaskCardDto>().toEqualTypeOf<
			'title' | 'column' | 'priority' | 'labels' | 'lastProgressAt' | 'stale' | 'agent'
		>();
		expectTypeOf<keyof PublishedAgentDto>().toEqualTypeOf<'name' | 'status' | 'inFlightCount'>();
		expectTypeOf<keyof PublishedActivityLineDto>().toEqualTypeOf<'actorKind' | 'actorName' | 'narration' | 'at'>();
		expectTypeOf<keyof PublishedBoardDto>().toEqualTypeOf<
			'workspaceName' | 'sections' | 'columns' | 'agents' | 'recent' | 'generatedAt'
		>();
	});
});
