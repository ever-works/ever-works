import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkPromptService, WorkMemberRole, type Work } from '../work-prompt.service.js';

// Mock inquirer at the module level so the prompt methods don't try to read
// from stdin during tests. Each test resets the mock implementation as needed.
vi.mock('inquirer', () => {
	const prompt = vi.fn();
	const Separator = class {
		constructor(public sep?: string) {}
	};
	return {
		default: { prompt, Separator },
		prompt,
		Separator
	};
});

import inquirer from 'inquirer';

const mockedPrompt = inquirer.prompt as unknown as ReturnType<typeof vi.fn>;

class TestWorkPromptService extends WorkPromptService {
	public exposeFormatRoleLabel = (role: WorkMemberRole, isShared: boolean) => this.formatRoleLabel(role, isShared);
}

const makeWork = (overrides: Partial<Work> = {}): Work => ({
	id: 'w1',
	name: 'My Work',
	slug: 'my-work',
	owner: 'alice',
	organization: false,
	description: 'Some description',
	...overrides
});

describe('WorkPromptService.generateIncrementedSlug', () => {
	const svc = new WorkPromptService();

	it('appends -N to the base slug', () => {
		expect(svc.generateIncrementedSlug('hello', 1)).toBe('hello-1');
		expect(svc.generateIncrementedSlug('a-b', 42)).toBe('a-b-42');
	});

	it('handles zero / large numbers', () => {
		expect(svc.generateIncrementedSlug('foo', 0)).toBe('foo-0');
		expect(svc.generateIncrementedSlug('foo', 9999)).toBe('foo-9999');
	});
});

describe('WorkPromptService.formatRoleLabel', () => {
	const svc = new TestWorkPromptService();

	it('returns the human-readable label name regardless of color', () => {
		// Strip ANSI escape codes for stable assertions.
		const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');
		expect(strip(svc.exposeFormatRoleLabel(WorkMemberRole.OWNER, false))).toBe('[Owner]');
		expect(strip(svc.exposeFormatRoleLabel(WorkMemberRole.MANAGER, true))).toBe('[Manager]');
		expect(strip(svc.exposeFormatRoleLabel(WorkMemberRole.EDITOR, true))).toBe('[Editor]');
		expect(strip(svc.exposeFormatRoleLabel(WorkMemberRole.VIEWER, false))).toBe('[Viewer]');
	});

	it('produces a label containing the role name regardless of shared flag', () => {
		// chalk may strip colors when stdout is not a TTY (vitest pipes output),
		// so we don't assert color differences — just that the role text is
		// present in both shared and non-shared paths.
		const a = svc.exposeFormatRoleLabel(WorkMemberRole.MANAGER, true);
		const b = svc.exposeFormatRoleLabel(WorkMemberRole.MANAGER, false);
		expect(a).toMatch(/Manager/);
		expect(b).toMatch(/Manager/);
	});
});

describe('WorkPromptService.formatSelectedWork', () => {
	const svc = new WorkPromptService();
	const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');

	it('includes the work name, slug and the role label', () => {
		const work = makeWork();
		const out = strip(svc.formatSelectedWork(work, WorkMemberRole.OWNER, false));
		expect(out).toContain('My Work');
		expect(out).toContain('(my-work)');
		expect(out).toContain('[Owner]');
	});
});

describe('WorkPromptService.promptWorkSelection', () => {
	let svc: WorkPromptService;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		svc = new WorkPromptService();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockedPrompt.mockReset();
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('returns cancelled=true with null work when no works are provided', async () => {
		const r = await svc.promptWorkSelection([]);
		expect(r).toEqual({ work: null, cancelled: true });

		const r2 = await svc.promptWorkSelection(undefined);
		expect(r2).toEqual({ work: null, cancelled: true });

		// Should not have called inquirer because the list short-circuited.
		expect(mockedPrompt).not.toHaveBeenCalled();
	});

	it('returns the selected work with OWNER role when userRole is missing', async () => {
		const work = makeWork({ id: 'w1', slug: 'one' });
		mockedPrompt.mockResolvedValueOnce({ selectedWork: work });

		const r = await svc.promptWorkSelection([work]);
		expect(r.work).toBe(work);
		expect(r.cancelled).toBe(false);
		expect(r.role).toBe(WorkMemberRole.OWNER);
		expect(r.isShared).toBe(false);
	});

	it('marks the selection as shared when userRole is non-OWNER', async () => {
		const work = makeWork({ id: 'w2', slug: 'two', userRole: WorkMemberRole.MANAGER });
		mockedPrompt.mockResolvedValueOnce({ selectedWork: work });

		const r = await svc.promptWorkSelection([work]);
		expect(r.role).toBe(WorkMemberRole.MANAGER);
		expect(r.isShared).toBe(true);
	});

	it('returns cancelled=true when the user picks the cancel choice (null)', async () => {
		const work = makeWork();
		mockedPrompt.mockResolvedValueOnce({ selectedWork: null });

		const r = await svc.promptWorkSelection([work]);
		expect(r).toEqual({ work: null, cancelled: true });
	});
});

describe('WorkPromptService.promptSlugConflictResolution', () => {
	let svc: WorkPromptService;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		svc = new WorkPromptService();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockedPrompt.mockReset();
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('returns the suggested slug when user picks "use_suggested"', async () => {
		mockedPrompt.mockResolvedValueOnce({ value: 'use_suggested' });

		const r = await svc.promptSlugConflictResolution('mine', 'mine-2');
		expect(r).toEqual({ action: 'use_suggested', finalSlug: 'mine-2' });
	});

	it('prompts again for a custom slug when user picks "modify"', async () => {
		mockedPrompt.mockResolvedValueOnce({ value: 'modify' }).mockResolvedValueOnce({ value: 'my-custom-slug' });

		const r = await svc.promptSlugConflictResolution('mine', 'mine-2');
		expect(r).toEqual({ action: 'modify', finalSlug: 'my-custom-slug' });
		expect(mockedPrompt).toHaveBeenCalledTimes(2);
	});

	it('returns cancel without a finalSlug when user picks "cancel"', async () => {
		mockedPrompt.mockResolvedValueOnce({ value: 'cancel' });

		const r = await svc.promptSlugConflictResolution('mine', 'mine-2');
		expect(r.action).toBe('cancel');
		expect(r.finalSlug).toBeUndefined();
	});
});

describe('WorkPromptService.promptGitProviderSelection', () => {
	let svc: WorkPromptService;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		svc = new WorkPromptService();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockedPrompt.mockReset();
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('returns the provider id selected by the user', async () => {
		mockedPrompt.mockResolvedValueOnce({ value: 'github' });

		const r = await svc.promptGitProviderSelection([
			{ id: 'github', name: 'GitHub', enabled: true, connected: true, username: 'alice' },
			{ id: 'gitlab', name: 'GitLab', enabled: true, connected: false }
		]);
		expect(r).toBe('github');
	});

	it('re-prompts when user selects a disabled provider, then accepts a real one', async () => {
		mockedPrompt
			.mockResolvedValueOnce({ value: '__disabled__bitbucket' })
			.mockResolvedValueOnce({ value: 'github' });

		const r = await svc.promptGitProviderSelection([
			{ id: 'github', name: 'GitHub', enabled: true, connected: true },
			{ id: 'bitbucket', name: 'Bitbucket', enabled: false, connected: false }
		]);
		expect(r).toBe('github');
		expect(mockedPrompt).toHaveBeenCalledTimes(2);
	});
});

describe('WorkPromptService.promptDeployProviderSelection', () => {
	let svc: WorkPromptService;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		svc = new WorkPromptService();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockedPrompt.mockReset();
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('returns null when user picks "None"', async () => {
		mockedPrompt.mockResolvedValueOnce({ value: '__none__' });

		const r = await svc.promptDeployProviderSelection([{ id: 'vercel', name: 'Vercel', enabled: true }]);
		expect(r).toBeNull();
	});

	it('returns the selected provider id when user picks an enabled provider', async () => {
		mockedPrompt.mockResolvedValueOnce({ value: 'vercel' });

		const r = await svc.promptDeployProviderSelection([{ id: 'vercel', name: 'Vercel', enabled: true }]);
		expect(r).toBe('vercel');
	});

	it('re-prompts when user picks a disabled provider, then accepts None', async () => {
		mockedPrompt
			.mockResolvedValueOnce({ value: '__disabled__netlify' })
			.mockResolvedValueOnce({ value: '__none__' });

		const r = await svc.promptDeployProviderSelection([{ id: 'netlify', name: 'Netlify', enabled: false }]);
		expect(r).toBeNull();
		expect(mockedPrompt).toHaveBeenCalledTimes(2);
	});
});

describe('WorkPromptService.promptWorkCreation', () => {
	let svc: WorkPromptService;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		svc = new WorkPromptService();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mockedPrompt.mockReset();
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('returns name/slug/description/owner=undefined when no orgs are provided', async () => {
		mockedPrompt
			.mockResolvedValueOnce({ value: 'My Cool Work' }) // name
			.mockResolvedValueOnce({ value: 'my-cool-work' }) // slug
			.mockResolvedValueOnce({ value: 'A reasonably long description.' }); // description

		const r = await svc.promptWorkCreation();
		expect(r).toEqual({
			name: 'My Cool Work',
			slug: 'my-cool-work',
			description: 'A reasonably long description.',
			owner: undefined
		});
		expect(mockedPrompt).toHaveBeenCalledTimes(3);
	});

	it('returns the selected owner when orgs list is provided', async () => {
		mockedPrompt
			.mockResolvedValueOnce({ value: 'My Cool Work' }) // name
			.mockResolvedValueOnce({ value: 'my-cool-work' }) // slug
			.mockResolvedValueOnce({ value: 'A reasonably long description.' }) // description
			.mockResolvedValueOnce({ value: 'org-acme' }); // owner select

		const r = await svc.promptWorkCreation('alice', [
			{ name: 'Personal', value: 'alice' },
			{ name: 'Acme Inc.', value: 'org-acme' }
		]);
		expect(r.owner).toBe('org-acme');
		expect(mockedPrompt).toHaveBeenCalledTimes(4);
	});
});
