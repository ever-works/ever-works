import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverCheckouts } from './checkout-discovery';

/**
 * A fake tree: every key is a directory; `git` marks a clone (its `.git`),
 * `link` a symbolic link (never followed).
 */
type Node = { git?: boolean; link?: boolean; children?: Record<string, Node> };

function fakeFs(rootPath: string, tree: Node) {
	const find = (path: string): Node | null => {
		const rel = path.slice(resolve(rootPath).length).split(/[\\/]/).filter(Boolean);
		let current: Node | null = tree;
		for (const part of rel) {
			if (!current?.children?.[part]) return null;
			current = current.children[part];
		}
		return current;
	};
	return {
		readdir: async (path: string) =>
			Object.entries(find(path)?.children ?? {}).map(([name, node]) => ({
				name,
				isDirectory: () => !node.link,
				isSymbolicLink: () => node.link === true
			})),
		lstat: async (path: string) => {
			if (path.endsWith(`${'.git'}`)) {
				const parent = find(path.slice(0, -'.git'.length - 1));
				return parent?.git ? { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } : null;
			}
			const node = find(path);
			if (!node) return null;
			return {
				isDirectory: () => !node.link,
				isFile: () => false,
				isSymbolicLink: () => node.link === true
			};
		}
	};
}

const ROOT = resolve('/home/nina/code');

describe('discoverCheckouts (FL-14 spec FR-4, ACC-FL14-01)', () => {
	it('finds clones up to three folders deep, prunes at .git and skips dependency folders', async () => {
		const tree: Node = {
			children: {
				api: { git: true, children: { packages: { children: { inner: { git: true } } } } },
				clients: { children: { acme: { children: { web: { git: true } } } } },
				deep: { children: { a: { children: { b: { children: { c: { git: true } } } } } } },
				node_modules: { children: { lib: { git: true } } },
				'.cache': { children: { hidden: { git: true } } },
				escape: { link: true, children: { other: { git: true } } }
			}
		};
		const fs = fakeFs(ROOT, tree);
		const result = await discoverCheckouts([ROOT], fs);
		expect(result.paths).toEqual([join(ROOT, 'api'), join(ROOT, 'clients', 'acme', 'web')]);
		expect(result.truncated).toBe(false);
	});

	it('stops at the cap and says so', async () => {
		const children: Record<string, Node> = {};
		for (let index = 0; index < 301; index += 1) children[`repo-${index}`] = { git: true };
		const fs = fakeFs(ROOT, { children });
		const result = await discoverCheckouts([ROOT], { ...fs, cap: 300 });
		expect(result.paths).toHaveLength(300);
		expect(result.truncated).toBe(true);
	});

	it('stops when the time budget runs out', async () => {
		let clock = 0;
		const fs = fakeFs(ROOT, { children: { a: { git: true }, b: { git: true } } });
		const result = await discoverCheckouts([ROOT], {
			...fs,
			budgetMs: 5,
			now: () => {
				clock += 10;
				return clock;
			}
		});
		expect(result.truncated).toBe(true);
	});

	it('never walks a code folder that is itself a link', async () => {
		const fs = fakeFs(ROOT, { link: true, children: { api: { git: true } } });
		expect((await discoverCheckouts([ROOT], fs)).paths).toEqual([]);
	});
});
