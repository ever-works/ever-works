// Ever Works' adapter for the Ever Platform egress audit (see README.md).
//
// The audit's driver runs the API hooks inside the sealed audit network, so they reach the API by
// its compose service name. The browser runs the browser hooks (uiLogin, routeParams) in its own
// sniffed namespace and reaches the web app as `ever-works-web`. The hooks only do what an operator
// and a person would do in a fresh installation: create the platform admin, switch anonymous usage
// statistics off in Settings for `loaded_off`, and sign in through the web app's sign-in page.

/** The installation's first person, made platform admin by the bootstrap list below. Test-only. */
const ADMIN = {
	username: 'egressaudit',
	email: 'egress-audit-admin@example.test',
	password: 'egress-audit-only-1!'
};

/** Every statistics route, with the method the settings page uses. */
const STATS_ROUTES = [
	['GET', '/api/instance-stats/status'],
	['POST', '/api/instance-stats/preview'],
	['GET', '/api/instance-stats/last'],
	['POST', '/api/instance-stats/send-now'],
	['PUT', '/api/instance-stats/toggle'],
	['POST', '/api/instance-stats/reset-identity']
];

/**
 * The modes in which the module is switched off by configuration — explicitly (`off`,
 * `off_env_file`) or by the default, with nothing configured (`default_off`).
 */
const OFF_MODES = new Set(['off', 'off_env_file', 'default_off']);

/** The web app's sign-in page, the first page uiLogin opens. */
const SIGN_IN_ROUTE = '/en/login';

/** Where the web app sends a visitor without a session. */
const SIGNED_OUT_PATH = /^\/(en\/)?(login|register|forgot-password|reset-password|resend-verification)(\/|$)/;

/** How long the web app may take to answer its first request. */
const WEB_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** A page behind the sign-in, opened to prove the session holds. */
const SIGNED_IN_CHECK_PAGE = '/en/settings';

/** Settings → Ever Platform: the statistics section, rendered by the web app from the API's answer. */
const STATS_SETTINGS_PAGE = '/en/settings/ever-platform';

/**
 * Every mode makes the audit's person a platform admin, so the walk sees what an operator sees
 * (the statistics section, the admin pages).
 */
const BOOTSTRAP_ADMIN = { EVER_WORKS_BOOTSTRAP_PLATFORM_ADMIN_EMAILS: ADMIN.email };

const pathOf = (url) => {
	try {
		return new URL(url).pathname;
	} catch {
		return String(url);
	}
};

/** The records of a list answer: an array, or the array under `items`, `plugins` or `data`. */
const listOf = (data) => {
	if (Array.isArray(data)) return data;
	for (const key of ['items', 'plugins', 'data']) if (Array.isArray(data?.[key])) return data[key];
	return [];
};

/** The id of a created record, wherever the answer puts it. */
const idOf = (data) =>
	[
		data?.id,
		data?.data?.id,
		data?.item?.id,
		data?.goal?.id,
		data?.idea?.id,
		data?.task?.id,
		data?.meeting?.id,
		data?.team?.id
	].find((value) => typeof value === 'string' && value);

/** The id of the first record of a list answer. */
const firstId = (data) => listOf(data).find((record) => typeof record?.id === 'string' && record.id)?.id;

/** Which fixture fills the id of which route (the rest keep the placeholders of route-params.json). */
const FIXTURE_ROUTES = {
	organizationId: [],
	teamId: [
		['/:locale/teams/:id', 'id'],
		['/:locale/teams/:id/settings', 'id']
	],
	goalId: [['/:locale/goals/:id', 'id']],
	ideaId: [
		['/:locale/ideas/:id', 'id'],
		['/:locale/ideas/:id/agents/new', 'id'],
		['/:locale/ideas/:id/tasks', 'id']
	],
	taskId: [['/:locale/tasks/:id', 'id']],
	meetingId: [['/:locale/meetings/:id', 'id']],
	pluginId: [['/:locale/plugins/:pluginId', 'pluginId']],
	workflowId: [['/:locale/catalog/workflows/:id', 'id']],
	playbookSlug: [['/:locale/catalog/playbooks/:slug', 'slug']]
};

async function json(response) {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return null;
	}
}

export default {
	// Extra environment per mode (the harness adds it to every process service: the API and the web app).
	//
	// `CI=true` lets the statistics module honour the modes' short send interval (it is raised to
	// one hour otherwise): in `off`, `off_env_file` and `default_off` a module that were loaded by
	// mistake would then try to send within the watched window, and be seen doing it.
	env: {
		off: { CI: 'true', ...BOOTSTRAP_ADMIN },
		off_env_file: { CI: 'true', ...BOOTSTRAP_ADMIN },
		default_off: { CI: 'true', ...BOOTSTRAP_ADMIN },
		// Loaded, switched off in Settings. The first send is due a minute after first boot, well
		// after the switch is off (the driver acts as soon as the API answers); an installation
		// whose switch did not hold would then try the default endpoint and be seen doing it.
		loaded_off: { CI: 'true', EVER_STATS_SEND_INTERVAL_S: '60', ...BOOTSTRAP_ADMIN },
		positive_stats: { CI: 'true', ...BOOTSTRAP_ADMIN }
	},

	/** Register the platform admin (the installation's first person) and answer its session header. */
	async login({ baseUrl, fetch, log }) {
		const response = await fetch(`${baseUrl}/api/auth/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(ADMIN)
		});
		const body = await json(response);
		if (response.status !== 200 && response.status !== 201) {
			throw new Error(`registering the admin answered ${response.status}`);
		}
		const token = body?.access_token;
		if (typeof token !== 'string' || token.length === 0)
			throw new Error('registering the admin answered no session');
		log('adapter: the platform admin is signed in');
		return { authorization: `Bearer ${token}` };
	},

	/**
	 * What a person does before using the app: close the onboarding wizard (so the walk sees the
	 * pages, not the wizard), then create one of each plain record a detail page shows, so those
	 * pages render their content instead of their not-found state. Each record is best effort: one
	 * the API refuses keeps its pages on the placeholder of route-params.json, and the log says
	 * which. Works, agents and missions stay placeholders: creating one starts background work
	 * (generation, runs) that needs AI providers and GitHub. Answers ids and slugs, never a token.
	 */
	async createFixtures({ baseUrl, fetch, headers, log }) {
		const dismissed = await fetch(`${baseUrl}/api/onboarding/dismiss`, { method: 'POST', headers });
		if (!dismissed.ok) throw new Error(`dismissing the onboarding wizard answered ${dismissed.status}`);

		const call = async (method, path, body) => {
			const response = await fetch(`${baseUrl}/api${path}`, {
				method,
				headers: { ...headers, accept: 'application/json', 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const data = await json(response);
			if (!response.ok) throw new Error(`${method} /api${path} answered ${response.status}`);
			return data;
		};
		const fixtures = {};
		const made = [];
		const missing = [];
		const attempt = async (key, make) => {
			try {
				const value = await make();
				if (typeof value === 'string' && value) {
					fixtures[key] = value;
					made.push(key);
					return;
				}
				missing.push(`${key} (no id in the answer)`);
			} catch (error) {
				missing.push(`${key} (${String(error?.message ?? error).split('\n')[0]})`);
			}
		};

		await attempt('organizationId', async () =>
			idOf(await call('POST', '/organizations', { name: 'Egress audit' }))
		);
		if (fixtures.organizationId)
			await attempt('teamId', async () =>
				idOf(
					await call('POST', `/organizations/${fixtures.organizationId}/teams`, { name: 'Egress audit team' })
				)
			);
		// A delivery Goal (one open Definition-of-Done criterion) needs no metrics provider; it stays a draft.
		await attempt('goalId', async () =>
			idOf(
				await call('POST', '/me/goals', {
					title: 'Egress audit goal',
					goalKind: 'delivery',
					dodCriteria: [{ id: 'walked', text: 'The egress audit opened this goal.', status: 'open' }]
				})
			)
		);
		await attempt('ideaId', async () =>
			idOf(
				await call('POST', '/me/work-proposals', {
					title: 'Egress audit idea',
					description: 'An idea recorded by the egress audit.'
				})
			)
		);
		await attempt('taskId', async () => idOf(await call('POST', '/tasks', { title: 'Egress audit task' })));
		await attempt('meetingId', async () =>
			idOf(
				await call('POST', '/meetings', { title: 'Egress audit meeting', startedAt: new Date().toISOString() })
			)
		);
		await attempt('pluginId', async () => firstId(await call('GET', '/plugins')));
		await attempt('workflowId', async () => firstId(await call('GET', '/workflows')));
		await attempt('playbookSlug', async () => {
			const data = await call('GET', '/catalog/playbooks');
			return listOf(data).find((p) => typeof p?.slug === 'string')?.slug;
		});

		log(
			`adapter: onboarding dismissed; fixtures: ${made.join(', ') || 'none'}${missing.length ? `; placeholders for: ${missing.join('; ')}` : ''}`
		);
		return fixtures;
	},

	/**
	 * Off modes only: what the settings page would call, with each route's own method. The
	 * harness's route probe sends GET only, so the POST and PUT routes are checked here: every
	 * one must answer 404 (a refusal here fails the run). Never in the other modes, where these
	 * calls would switch statistics on or send.
	 */
	async openSettings({ baseUrl, mode, fetch, log }) {
		if (!OFF_MODES.has(mode)) return;
		const answers = [];
		for (const [method, path] of STATS_ROUTES) {
			const response = await fetch(`${baseUrl}${path}`, {
				method,
				redirect: 'manual',
				headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
				body: method === 'GET' ? undefined : JSON.stringify(method === 'PUT' ? { enabled: true } : {})
			});
			answers.push({ route: `${method} ${path}`, status: response.status });
		}
		log(`adapter: ${answers.map((a) => `${a.route} ${a.status}`).join('; ')}`);
		const answered = answers.filter((a) => a.status !== 404);
		if (answered.length > 0) {
			throw new Error(
				`with statistics off every statistics route must answer 404: ${answered.map((a) => `${a.route} ${a.status}`).join('; ')}`
			);
		}
	},

	/** Switch statistics off in Settings, as the admin, and check that the module says so. */
	async prepareLoadedOff({ baseUrl, fetch, headers, log }) {
		const toggle = await fetch(`${baseUrl}/api/instance-stats/toggle`, {
			method: 'PUT',
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: false })
		});
		if (toggle.status !== 200) throw new Error(`the statistics switch answered ${toggle.status}`);
		const status = await (await fetch(`${baseUrl}/api/instance-stats/status`, { headers })).json();
		if (status?.operator !== true || status.enabled !== false || status.reason !== 'ui') {
			throw new Error(`statistics are not switched off: ${JSON.stringify(status)}`);
		}
		log('adapter: anonymous usage statistics are switched off in Settings');
	},

	/**
	 * Signs in through the web app's sign-in page, as a person would (e-mail and password), and
	 * ends signed in: a page behind the sign-in must open without landing back on it. In
	 * `positive_stats` the operator's statistics section must also render (Settings → Ever Platform
	 * answers 200 and shows the section, not its "unavailable" notice), so the positive walk is known
	 * to have reached the module's page with the module answering.
	 */
	async uiLogin(page, ctx) {
		// The web app starts next to the API; wait until it answers before the first page is opened.
		const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
		let answer = 'no answer';
		while (Date.now() < deadline) {
			try {
				const response = await ctx.fetch(`${ctx.baseUrl}${SIGN_IN_ROUTE}`, { redirect: 'manual' });
				answer = `HTTP ${response.status}`;
				if (response.status < 500) break;
			} catch (error) {
				answer = String(error?.message ?? error).split('\n')[0];
			}
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
		ctx.log(`adapter: the web app answers ${SIGN_IN_ROUTE} (${answer})`);

		await page.goto(`${ctx.baseUrl}${SIGN_IN_ROUTE}`, { waitUntil: 'load', timeout: 120_000 });
		await page.fill('input[name="email"]', ADMIN.email, { timeout: 30_000 });
		await page.fill('input[name="password"]', ADMIN.password, { timeout: 30_000 });
		await Promise.all([
			page.waitForURL((url) => !SIGNED_OUT_PATH.test(url.pathname), { timeout: 120_000 }),
			page.click('button[type="submit"]', { timeout: 30_000 })
		]);
		await page.waitForLoadState('load');

		const checked = await page.goto(`${ctx.baseUrl}${SIGNED_IN_CHECK_PAGE}`, {
			waitUntil: 'load',
			timeout: 120_000
		});
		const landed = pathOf(page.url());
		if (SIGNED_OUT_PATH.test(landed))
			throw new Error(`the sign-in did not hold: ${SIGNED_IN_CHECK_PAGE} ended on ${landed}`);
		if ((checked?.status() ?? 0) >= 400)
			throw new Error(`the sign-in did not hold: ${SIGNED_IN_CHECK_PAGE} answered ${checked.status()}`);

		if (ctx.mode === 'positive_stats') {
			const stats = await page.goto(`${ctx.baseUrl}${STATS_SETTINGS_PAGE}`, {
				waitUntil: 'load',
				timeout: 120_000
			});
			if (stats?.status() !== 200)
				throw new Error(`with statistics on, ${STATS_SETTINGS_PAGE} answered ${stats?.status() ?? 'nothing'}`);
			// A 200 alone is not enough: the page also answers 200 with its "unavailable" notice when the web
			// app cannot read the module's status. The operator's section renders only from a real answer.
			if ((await page.locator('[data-testid="usage-statistics-unavailable"]').count()) > 0)
				throw new Error(`with statistics on, ${STATS_SETTINGS_PAGE} shows the "unavailable" notice`);
			await page
				.locator('[data-testid="usage-statistics-operator"]')
				.waitFor({ state: 'visible', timeout: 30_000 });
		}
		ctx.log(`adapter: signed in through ${SIGN_IN_ROUTE}; ${SIGNED_IN_CHECK_PAGE} opened signed in`);
	},

	/** The values only a run knows (route-params.json holds the placeholders). */
	async routeParams(ctx) {
		const fixtures = ctx.fixtures ?? {};
		const params = {};
		for (const [key, routes] of Object.entries(FIXTURE_ROUTES)) {
			const value = fixtures[key];
			if (typeof value !== 'string' || !value) continue;
			for (const [route, name] of routes) params[route] = { ...params[route], [name]: value };
		}
		return params;
	}
};
