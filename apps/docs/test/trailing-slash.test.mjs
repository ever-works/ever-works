/**
 * docs.ever.works serves every page in its SLASH form (`/help/`), because Docusaurus writes each
 * route as `<route>/index.html` and nginx answers the slash-less `/help` with a directory 301.
 *
 * Until 2026-09 the site emitted the slash-less form in its sitemap, canonical, og:url and hreflang,
 * so every one of its 800+ sitemap URLs was a redirect - and nginx's absolute redirect pointed at
 * `http://` - and Google Search Console filed them as "Page with redirect" instead of indexing them.
 *
 * These checks keep the three pieces of that fix in place:
 *   1. `trailingSlash: true` in docusaurus.config.ts (the site emits the URL nginx serves).
 *   2. `absolute_redirect off;` in the docs nginx.conf (any residual redirect keeps https).
 *   3. No relative doc link whose destination `trailingSlash` moves. With `trailingSlash: true` the
 *      page `docs/a/b.md` lives at `/a/b/` instead of `/a/b`, so the extension-less `[x](./c)` now
 *      resolves to `/a/b/c/` (a 404) instead of `/a/c`, and `[x](../c)` to `/a/c/` instead of `/c`.
 *      File links (`./c.md`, `./dir/index.md`) resolve by FILE and are immune - use those.
 *
 * Run: `pnpm --filter ever-works-docs test` (node's built-in runner, no dependencies).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '../..');

/** Lines of `source` that are not comments, so a commented-out setting does not count. */
function activeLines(source, commentPrefix) {
	return source
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(commentPrefix));
}

/** Doc files the docs plugin loads (it skips `_`-prefixed files/folders and `__tests__`). */
function listDocFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('_') || entry.name === 'node_modules') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listDocFiles(full));
		else if (/\.mdx?$/i.test(entry.name)) out.push(full);
	}
	return out;
}

/**
 * A category index doc is served at its FOLDER URL (`docs/a/index.md` -> `/a/`), which ends in a
 * slash with or without `trailingSlash`. Docusaurus treats `index`, `README` and `<folder>/<folder>`
 * as the index doc.
 */
function isIndexDoc(file) {
	const base = path.basename(file).replace(/\.mdx?$/i, '');
	const parent = path.basename(path.dirname(file));
	return /^(index|readme)$/i.test(base) || base === parent;
}

function frontMatterValue(markdown, key) {
	const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const line = block && block[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
	return line ? line[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/** The route of a doc, without a trailing slash (`/` for the root), as the docs plugin derives it. */
function routeOf(file, root, markdown) {
	const slug = frontMatterValue(markdown, 'slug');
	if (slug && slug.startsWith('/')) return trimSlash(slug);
	const dir = path.relative(root, path.dirname(file)).split(path.sep).join('/');
	const prefix = dir ? `/${dir}` : '';
	if (slug) return trimSlash(`${prefix}/${slug}`);
	if (isIndexDoc(file)) return prefix || '/';
	const id = frontMatterValue(markdown, 'id') ?? path.basename(file).replace(/\.mdx?$/i, '');
	return `${prefix}/${id}`;
}

function trimSlash(route) {
	const trimmed = route.replace(/\/+$/, '');
	return trimmed || '/';
}

/** Remove fenced code blocks, HTML comments and inline code - links there are not rendered. */
function stripNonRendered(markdown) {
	return markdown
		.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(`+)[\s\S]*?\1/g, '');
}

/** Every link target on the page: inline `[x](t)`, reference `[id]: t` and JSX/HTML `href="t"`. */
function linkTargets(markdown) {
	const body = stripNonRendered(markdown);
	const targets = [];
	for (const m of body.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+["'(][^)]*)?\)/g)) targets.push(m[1]);
	for (const m of body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) targets.push(m[1]);
	for (const m of body.matchAll(/\bhref=["']([^"']+)["']/g)) targets.push(m[1]);
	return targets;
}

/**
 * A relative URL link - resolved by the browser against the PAGE URL: not absolute (`/x`), not a
 * fragment (`#x`), not a scheme (`https:`, `mailto:`), and not a file (`./x.md`, `./diagram.png`),
 * which Docusaurus resolves against the source FILE instead.
 */
function isPageRelativeLink(target) {
	if (/^(\/|#|[a-z][a-z0-9+.-]*:)/i.test(target)) return false;
	const pathPart = target.split(/[?#]/)[0];
	if (!pathPart) return false;
	const lastSegment = pathPart.replace(/\/+$/, '').split('/').pop();
	return !/\.[a-z0-9]+$/i.test(lastSegment) || pathPart.endsWith('/');
}

/** Route a relative `target` lands on from `pageUrl` (browser URL resolution). */
function resolveRoute(target, pageUrl) {
	const { pathname } = new URL(target, `https://docs.invalid${pageUrl}`);
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// keep the raw pathname
	}
	return trimSlash(decoded);
}

/**
 * The destination `trailingSlash: true` moves a relative link away from: the route the link
 * reached when a non-index page was served slash-less, when that was a real doc and the slash form
 * of the page URL resolves the same link somewhere else. `undefined` when the link is unaffected.
 */
function movedDestination(target, pageRoute, isIndex, routes) {
	if (!isPageRelativeLink(target) || isIndex) return undefined;
	const before = resolveRoute(target, pageRoute);
	const after = resolveRoute(target, pageRoute === '/' ? '/' : `${pageRoute}/`);
	return routes.has(before) && before !== after ? before : undefined;
}

describe('docs.ever.works emits the URL form nginx serves', () => {
	it('sets trailingSlash: true in docusaurus.config.ts', () => {
		const config = readFileSync(path.join(appDir, 'docusaurus.config.ts'), 'utf8');
		assert.ok(
			activeLines(config, '//').some((line) => /^trailingSlash:\s*true,?$/.test(line)),
			'apps/docs/docusaurus.config.ts must set `trailingSlash: true`'
		);
	});

	it('turns absolute_redirect off in the docs nginx.conf', () => {
		const nginx = readFileSync(path.join(repoRoot, '.deploy/docker/docs/nginx.conf'), 'utf8');
		assert.ok(
			activeLines(nginx, '#').includes('absolute_redirect off;'),
			'.deploy/docker/docs/nginx.conf must contain `absolute_redirect off;`'
		);
	});
});

describe('relative doc links keep their destination under trailingSlash', () => {
	const docsRoot = path.join(repoRoot, 'docs');
	const localeRoots = readdirSync(path.join(appDir, 'i18n'), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(appDir, 'i18n', entry.name, 'docusaurus-plugin-content-docs', 'current'));
	const load = (root) => {
		let files = [];
		try {
			files = listDocFiles(root);
		} catch {
			return [];
		}
		return files.map((file) => {
			const markdown = readFileSync(file, 'utf8');
			return { file, markdown, route: routeOf(file, root, markdown), isIndex: isIndexDoc(file) };
		});
	};
	const docs = load(docsRoot);
	const docRoutes = new Set(docs.map((doc) => doc.route));
	// A translated locale serves every English doc too (untranslated ones fall back), under /<locale>/.
	const sites = [{ pages: docs, routes: docRoutes }].concat(
		localeRoots.map((root) => {
			const pages = load(root);
			return { pages, routes: new Set([...docRoutes, ...pages.map((doc) => doc.route)]) };
		})
	);

	it('finds the doc pages it is meant to check', () => {
		// Guards against a vacuous pass: a wrong root would scan nothing and report no offenders.
		assert.ok(docs.length > 100, `expected the docs tree, found ${docs.length} pages`);
		assert.ok(docs.filter((doc) => !doc.isIndex).length > 100, 'expected non-index pages to scan');
		assert.ok(docRoutes.has('/') && docRoutes.has('/getting-started') && docRoutes.has('/features'));
	});

	it('classifies the link shapes it is meant to catch', () => {
		for (const bad of ['./page', '../page', 'page', './dir/', '../dir/', './page#anchor', '../../database/']) {
			assert.equal(isPageRelativeLink(bad), true, `${bad} should be flagged`);
		}
		for (const ok of [
			'./page.md',
			'../dir/index.md',
			'./page.mdx#anchor',
			'/features/analytics',
			'#anchor',
			'https://ever.works',
			'mailto:ever@ever.co',
			'./diagram.png'
		]) {
			assert.equal(isPageRelativeLink(ok), false, `${ok} should not be flagged`);
		}
		assert.deepEqual(linkTargets('[a](./x) `[b](./y)`\n[c]: ../z\n<a href="./w">w</a>\n```\n[d](./v)\n```'), [
			'./x',
			'../z',
			'./w'
		]);
	});

	it('detects a destination that the slash form of the page URL moves', () => {
		const routes = new Set(['/a/c', '/c', '/a/b', '/a']);
		// Non-index page /a/b: `./c` meant /a/c; from /a/b/ it would be /a/b/c.
		assert.equal(movedDestination('./c', '/a/b', false, routes), '/a/c');
		// `../c` meant /c; from /a/b/ it would silently become /a/c.
		assert.equal(movedDestination('../c', '/a/b', false, routes), '/c');
		// File links and index pages are unaffected; a link that was already broken is not this check's.
		assert.equal(movedDestination('./c.md', '/a/b', false, routes), undefined);
		assert.equal(movedDestination('./c', '/a', true, routes), undefined);
		assert.equal(movedDestination('./missing', '/a/b', false, routes), undefined);
	});

	it('has no relative doc link whose destination moves (link the FILE: ./page.md, ./dir/index.md)', () => {
		const offenders = [];
		for (const { pages, routes } of sites) {
			for (const { file, markdown, route, isIndex } of pages) {
				for (const target of linkTargets(markdown)) {
					const meant = movedDestination(target, route, isIndex, routes);
					if (meant) {
						const source = path.relative(repoRoot, file).split(path.sep).join('/');
						offenders.push(`${source}: ${target} (meant ${meant})`);
					}
				}
			}
		}
		assert.deepEqual(offenders, [], `link the FILE instead:\n${offenders.join('\n')}`);
	});
});
