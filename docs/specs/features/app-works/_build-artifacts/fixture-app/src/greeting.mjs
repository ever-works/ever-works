/**
 * The evolve loop's target (App Blueprint README: "`src/greeting.mjs` holds the string `GET /` renders;
 * the agent changes it").
 *
 * One string, one place to change it, one observable result: an agent asked for a greeting change edits
 * the export below and the live page shows it (ACC-E2E-07 — the lane proves the new marker is absent
 * before the merge and present after it). Keep the change in this file; `src/server.mjs` only calls
 * `homePage()`.
 */

export const greeting = 'Hello from app-fixture-hello';

/**
 * The home page. Everything variable is passed in, so this stays a pure function the unit tests can
 * read without starting a server.
 * @param {{publicUrl?: string}} [options]
 */
export function homePage({ publicUrl = '' } = {}) {
	const footer = publicUrl ? `\n\t\t\t<p data-testid="public-url">Served at <code>${escapeHtml(publicUrl)}</code></p>` : '';
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>app-fixture-hello</title>
		<link rel="icon" href="/brand/logo.svg" type="image/svg+xml" />
	</head>
	<body>
		<main>
			<img src="/brand/logo.svg" alt="app-fixture-hello" width="96" height="96" />
			<h1 data-testid="greeting">${escapeHtml(greeting)}</h1>
			<p>Acceptance fixture for Ever Works App Works. See <a href="/marker">/marker</a> and <a href="/state">/state</a>.</p>${footer}
		</main>
	</body>
</html>
`;
}

/** @param {string} value */
export function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
