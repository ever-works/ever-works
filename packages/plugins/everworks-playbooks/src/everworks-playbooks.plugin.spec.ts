import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PLAYBOOKS } from './builtin-catalog.js';
import { EverWorksPlaybooksPlugin } from './everworks-playbooks.plugin.js';

function logger() {
	return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('EverWorksPlaybooksPlugin', () => {
	let plugin: EverWorksPlaybooksPlugin;
	let log: ReturnType<typeof logger>;

	beforeEach(async () => {
		plugin = new EverWorksPlaybooksPlugin();
		log = logger();
		await plugin.onLoad({ logger: log } as never);
	});

	it('exposes the playbook-provider capability', () => {
		expect(plugin.id).toBe('everworks-playbooks');
		expect(plugin.capabilities).toEqual(['playbook-provider']);
		expect(plugin.isAvailable()).toBe(true);
	});

	it('lists every built-in playbook by default', async () => {
		const result = await plugin.listPlaybooks({ limit: 50, offset: 0 });
		expect(result.total).toBe(BUILTIN_PLAYBOOKS.length);
		expect(result.entries.map((entry) => entry.slug)).toEqual(BUILTIN_PLAYBOOKS.map((entry) => entry.slug));
	});

	it('pages with limit and offset while reporting the true total', async () => {
		const first = await plugin.listPlaybooks({ limit: 3, offset: 0 });
		const second = await plugin.listPlaybooks({ limit: 3, offset: 3 });
		const past = await plugin.listPlaybooks({ limit: 3, offset: 99 });
		expect(first.entries).toHaveLength(3);
		expect(second.entries[0]!.slug).toBe(BUILTIN_PLAYBOOKS[3]!.slug);
		expect(past.entries).toEqual([]);
		expect(past.total).toBe(BUILTIN_PLAYBOOKS.length);
	});

	it('filters by category', async () => {
		const result = await plugin.listPlaybooks({ limit: 50, offset: 0, category: 'research' });
		expect(result.entries.map((entry) => entry.slug)).toEqual(['market-watch-brief']);
	});

	it('searches titles, tags and step titles case-insensitively', async () => {
		const byTitle = await plugin.listPlaybooks({ limit: 50, offset: 0, search: 'WEEKLY OPERATIONS' });
		expect(byTitle.entries.map((entry) => entry.slug)).toEqual(['weekly-operations-report']);
		const byStep = await plugin.listPlaybooks({ limit: 50, offset: 0, search: 'raise the big ones' });
		expect(byStep.entries.map((entry) => entry.slug)).toEqual(['market-watch-brief']);
		const none = await plugin.listPlaybooks({ limit: 50, offset: 0, search: 'zzz-nothing' });
		expect(none).toEqual({ entries: [], total: 0 });
	});

	it('returns one playbook by slug and null for an unknown slug', async () => {
		expect((await plugin.getPlaybook('market-watch-brief'))?.title).toBe('Market watch brief');
		expect(await plugin.getPlaybook('does-not-exist')).toBeNull();
	});

	it('drops an invalid or duplicate entry with a warning instead of throwing', async () => {
		const good = BUILTIN_PLAYBOOKS[0]!;
		const custom = new EverWorksPlaybooksPlugin([
			good,
			{ ...good, slug: 'BAD SLUG' },
			{ ...good },
			{ ...good, slug: 'too-few-steps', steps: good.steps.slice(0, 1) }
		]);
		const warn = logger();
		await custom.onLoad({ logger: warn } as never);
		const result = await custom.listPlaybooks({ limit: 50, offset: 0 });
		expect(result.entries.map((entry) => entry.slug)).toEqual([good.slug]);
		expect(warn.warn).toHaveBeenCalledTimes(3);
	});

	it('strips markup and caps an over-long title before returning it', async () => {
		const good = BUILTIN_PLAYBOOKS[0]!;
		const custom = new EverWorksPlaybooksPlugin([
			{ ...good, title: `<b>${'x'.repeat(300)}</b>`, outcome: '<script>alert(1)</script>Outcome' }
		]);
		const entry = await custom.getPlaybook(good.slug);
		expect(entry?.title).toBe('x'.repeat(120));
		expect(entry?.outcome).toBe('alert(1)Outcome');
	});

	it('clamps a zero or oversized page size', async () => {
		expect((await plugin.listPlaybooks({ limit: 0, offset: 0 })).entries.length).toBe(BUILTIN_PLAYBOOKS.length);
		expect((await plugin.listPlaybooks({ limit: 10_000, offset: -5 })).entries.length).toBe(
			BUILTIN_PLAYBOOKS.length
		);
	});

	it('rebuilds its catalogue after unload', async () => {
		await plugin.onUnload();
		expect((await plugin.listPlaybooks({ limit: 50, offset: 0 })).total).toBe(BUILTIN_PLAYBOOKS.length);
	});
});
