// Ever Works' adapter for the Ever Platform egress audit (see README.md).
//
// The audit's driver runs it inside the sealed audit network, so it reaches the API by its compose
// service name. It only does what an operator would do in a fresh installation: create the
// platform admin and, for `loaded_off`, switch anonymous usage statistics off in Settings.

/** The installation's first person, made platform admin by the bootstrap list below. Test-only. */
const ADMIN = {
	username: 'egressaudit',
	email: 'egress-audit-admin@example.test',
	password: 'egress-audit-only-1!'
};

export default {
	// Extra environment per mode (the harness adds it to the API container).
	//
	// `CI=true` lets the statistics module honour the modes' short send interval (it is raised to
	// one hour otherwise): in `off` and `off_env_file` a module that were loaded by mistake would
	// then try to send within the watched window, and be seen doing it.
	env: {
		off: { CI: 'true' },
		off_env_file: { CI: 'true' },
		// Loaded, switched off in Settings. The first send is due a minute after first boot, well
		// after the switch is off (the driver acts as soon as the API answers); an installation
		// whose switch did not hold would then try the default endpoint and be seen doing it.
		loaded_off: {
			CI: 'true',
			EVER_STATS_SEND_INTERVAL_S: '60',
			EVER_WORKS_BOOTSTRAP_PLATFORM_ADMIN_EMAILS: ADMIN.email
		},
		positive_stats: { CI: 'true' }
	},

	/** `loaded_off` only: register the admin and answer the session header later hooks send. */
	async login({ baseUrl, mode, fetch, log }) {
		if (mode !== 'loaded_off') return {};
		const response = await fetch(`${baseUrl}/api/auth/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(ADMIN)
		});
		const body = await response.json().catch(() => null);
		if (response.status !== 200 && response.status !== 201) {
			throw new Error(`registering the admin answered ${response.status}`);
		}
		const token = body?.access_token;
		if (typeof token !== 'string' || token.length === 0)
			throw new Error('registering the admin answered no session');
		log('adapter: the platform admin is signed in');
		return { authorization: `Bearer ${token}` };
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
	}
};
