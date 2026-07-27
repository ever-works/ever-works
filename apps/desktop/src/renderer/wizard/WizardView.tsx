import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
	DatabaseChoice,
	DesktopBridge,
	DesktopMode,
	PrereqCheckResult,
	RemoteConnection,
	RemoteProbeResult,
	RuntimeDescriptor,
	RuntimeLayoutSummary,
	RuntimeSelection,
	ServiceStatus
} from '../../shared/ipc-contract';
import { canAdvance, computeStepList, nextStep, previousStep, type WizardStepId } from './steps';

interface WizardViewProps {
	bridge: DesktopBridge;
	onCompleted(): void;
}

const MODE_CHOICES: Array<{ id: DesktopMode; name: string; description: string }> = [
	{
		id: 'local-stack',
		name: 'Run Ever Works on this machine',
		description:
			'All-in-one install: this app supervises its own API and web services and stores everything locally. Pick your job runtime and database in the next steps.'
	},
	{
		id: 'remote-client',
		name: 'Connect to an existing Ever Works instance',
		description:
			'Client mode: nothing runs locally. Point the app at an instance that is already running — your own self-hosted deployment, your team server, or the hosted platform — and use it as a native desktop client.'
	}
];

export function WizardView({ bridge, onCompleted }: WizardViewProps) {
	const [step, setStep] = useState<WizardStepId>('welcome');
	const [mode, setMode] = useState<DesktopMode | undefined>();
	const [layout, setLayout] = useState<RuntimeLayoutSummary | undefined>();
	const [prereqResults, setPrereqResults] = useState<PrereqCheckResult[] | undefined>();
	const [runtimes, setRuntimes] = useState<RuntimeDescriptor[]>([]);
	const [dockerAvailable, setDockerAvailable] = useState<boolean | undefined>();
	const [selection, setSelection] = useState<RuntimeSelection | undefined>();
	const [envWritten, setEnvWritten] = useState(false);
	const [envError, setEnvError] = useState<string | undefined>();
	const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
	const [bootLog, setBootLog] = useState<string[]>([]);

	// Client-mode state.
	const [remoteWebUrl, setRemoteWebUrl] = useState('');
	const [remoteApiUrl, setRemoteApiUrl] = useState('');
	const [remoteLabel, setRemoteLabel] = useState('');
	const [remoteProbe, setRemoteProbe] = useState<RemoteProbeResult | undefined>();
	const [remoteConnection, setRemoteConnection] = useState<RemoteConnection | undefined>();
	const [remoteBusy, setRemoteBusy] = useState(false);

	const servicesHealthy = statuses.length > 0 && statuses.every((status) => status.healthy);
	const progress = useMemo(
		() => ({
			mode,
			prereqResults,
			selection,
			envWritten,
			servicesHealthy,
			remoteConnection,
			remoteVerified: remoteProbe?.ok === true
		}),
		[mode, prereqResults, selection, envWritten, servicesHealthy, remoteConnection, remoteProbe]
	);
	const steps = computeStepList(progress);
	const localStackUnavailable = layout?.kind === 'unavailable';

	const runPrereqs = useCallback(() => {
		void bridge.checkPrereqs().then(setPrereqResults);
		void bridge.detectDocker().then((result) => setDockerAvailable(result.available));
	}, [bridge]);

	useEffect(() => {
		void bridge.getRuntimeLayout().then(setLayout);
	}, [bridge]);

	useEffect(() => {
		if (step === 'prereq' && !prereqResults) {
			runPrereqs();
		}
		if (step === 'runtime' && runtimes.length === 0) {
			void bridge.listRuntimes().then(setRuntimes);
		}
	}, [step, prereqResults, runtimes.length, bridge, runPrereqs]);

	useEffect(() => {
		if (step !== 'boot') {
			return;
		}
		const offStatus = bridge.onStatus(setStatuses);
		const offLog = bridge.onLog((entry) =>
			setBootLog((lines) => [...lines.slice(-199), `[${entry.serviceId}] ${entry.line}`])
		);
		const poll = setInterval(() => void bridge.getStatus().then(setStatuses), 2000);
		return () => {
			offStatus();
			offLog();
			clearInterval(poll);
		};
	}, [step, bridge]);

	const chooseMode = (next: DesktopMode) => {
		setMode(next);
		void bridge.setMode(next);
	};

	const selectRuntime = (runtime: RuntimeDescriptor) => {
		const values: Record<string, string> = {};
		for (const field of runtime.fields) {
			if (field.defaultValue !== undefined) {
				values[field.key] = field.defaultValue;
			}
		}
		setSelection({
			runtimeId: runtime.id,
			values,
			database: 'embedded-sqlite',
			useDockerInfra: runtime.requiresRedis && dockerAvailable === true
		});
		setEnvWritten(false);
	};

	const applyEnv = async () => {
		if (!selection) {
			return;
		}
		setEnvError(undefined);
		try {
			await bridge.applyRuntime(selection);
			setEnvWritten(true);
		} catch (error) {
			setEnvError((error as Error).message);
		}
	};

	const testRemote = async () => {
		setRemoteBusy(true);
		setRemoteConnection(undefined);
		try {
			const input = { webUrl: remoteWebUrl, apiUrl: remoteApiUrl, label: remoteLabel };
			const probe = await bridge.testRemote(input);
			setRemoteProbe(probe);
			if (probe.ok) {
				setRemoteConnection(await bridge.saveRemote(input));
			}
		} catch (error) {
			setRemoteProbe({ ok: false, message: (error as Error).message });
		} finally {
			setRemoteBusy(false);
		}
	};

	const openApp = async () => {
		await bridge.completeWizard();
		onCompleted();
		await bridge.openWebApp();
	};

	const selectedRuntime = runtimes.find((runtime) => runtime.id === selection?.runtimeId);

	return (
		<div className="shell">
			<h1>Ever Works Desktop</h1>
			<p className="muted">Run the platform on this machine, or use it as a client for an instance you have.</p>

			<div className="steps-nav">
				{steps.map((candidate) => (
					<span
						key={candidate}
						className={`step ${candidate === step ? 'active' : ''} ${
							steps.indexOf(candidate) < steps.indexOf(step) ? 'done' : ''
						}`}
					>
						{candidate}
					</span>
				))}
			</div>

			<div className="panel">
				{step === 'welcome' && (
					<>
						<h2>Welcome</h2>
						<p className="muted">
							This wizard sets up how this machine talks to Ever Works. You can run the whole platform
							locally — this app supervises the API and web services for you — or connect to an instance
							that already runs somewhere else and use this window as a native client.
						</p>
					</>
				)}

				{step === 'mode' && (
					<>
						<h2>How do you want to run Ever Works?</h2>
						{MODE_CHOICES.map((choice) => {
							const disabled = choice.id === 'local-stack' && localStackUnavailable;
							return (
								<div
									key={choice.id}
									className={`runtime-card ${mode === choice.id ? 'selected' : ''}`}
									style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
									onClick={() => {
										if (!disabled) {
											chooseMode(choice.id);
										}
									}}
								>
									<div>
										<strong>{choice.name}</strong>{' '}
										{choice.id === 'local-stack' && layout?.kind === 'bundled' && (
											<span className="badge ok">Bundled runtime</span>
										)}
										{choice.id === 'local-stack' && layout?.kind === 'repo' && (
											<span className="badge warn">From source checkout</span>
										)}
										{disabled && <span className="badge err">Unavailable</span>}
									</div>
									<span className="muted">{choice.description}</span>
								</div>
							);
						})}
						{localStackUnavailable && (
							<p className="muted" style={{ marginTop: 12 }}>
								This build has no bundled platform runtime and no monorepo checkout was found
								{layout?.reason ? ` (${layout.reason})` : ''}. Client mode still works — connect to an
								instance you already run.
							</p>
						)}
						{layout?.kind === 'repo' && (
							<p className="muted" style={{ marginTop: 12 }}>
								Running from the source checkout at {layout.repoRoot} — Node.js and pnpm are required on
								this machine.
							</p>
						)}
						{layout?.kind === 'bundled' && (
							<p className="muted" style={{ marginTop: 12 }}>
								This install ships its own platform runtime (bundle {layout.bundleVersion}) — no source
								checkout, Node.js or pnpm needed.
							</p>
						)}
					</>
				)}

				{step === 'remote' && (
					<>
						<h2>Connect to your Ever Works instance</h2>
						<p className="muted">
							Enter the address of the instance you want this desktop app to use. Nothing is started
							locally; sign-in happens in the instance&apos;s own web UI.
						</p>
						<label className="field">
							<span>Instance URL *</span>
							<input
								type="text"
								value={remoteWebUrl}
								placeholder="https://app.example.com"
								onChange={(event) => {
									setRemoteWebUrl(event.target.value);
									setRemoteProbe(undefined);
									setRemoteConnection(undefined);
								}}
							/>
						</label>
						<label className="field">
							<span>API URL (optional — derived from the instance URL when blank)</span>
							<input
								type="text"
								value={remoteApiUrl}
								placeholder="https://api.example.com"
								onChange={(event) => {
									setRemoteApiUrl(event.target.value);
									setRemoteProbe(undefined);
									setRemoteConnection(undefined);
								}}
							/>
						</label>
						<label className="field">
							<span>Label (optional)</span>
							<input
								type="text"
								value={remoteLabel}
								placeholder="Production"
								onChange={(event) => setRemoteLabel(event.target.value)}
							/>
						</label>
						<div className="actions">
							<button onClick={() => void testRemote()} disabled={remoteBusy || remoteWebUrl === ''}>
								{remoteBusy ? 'Checking…' : 'Test connection'}
							</button>
						</div>
						{remoteProbe && (
							<div className="check-row">
								<span className={`badge ${remoteProbe.ok ? 'ok' : 'err'}`}>
									{remoteProbe.ok ? 'Reachable' : 'Failed'}
								</span>
								<span className="muted">
									{remoteProbe.ok
										? `Instance responded${remoteProbe.version ? ` (version ${remoteProbe.version})` : ''}.`
										: remoteProbe.message}
								</span>
							</div>
						)}
						{remoteConnection && (
							<p className="muted" style={{ marginTop: 12 }}>
								Saved: {remoteConnection.webUrl} (API {remoteConnection.apiUrl})
							</p>
						)}
					</>
				)}

				{step === 'prereq' && (
					<>
						<h2>Prerequisite check</h2>
						{!prereqResults && <p className="muted">Checking…</p>}
						{prereqResults?.map((result) => (
							<div className="check-row" key={result.id}>
								<span className={`badge ${result.ok ? 'ok' : result.required ? 'err' : 'warn'}`}>
									{result.ok ? 'OK' : result.required ? 'Missing' : 'Optional'}
								</span>
								<span>{result.label}</span>
								<span className="muted">{result.version ?? result.message}</span>
							</div>
						))}
						<div className="actions">
							<button className="secondary" onClick={runPrereqs}>
								Re-check
							</button>
						</div>
					</>
				)}

				{step === 'runtime' && (
					<>
						<h2>Choose your job runtime</h2>
						<p className="muted">
							Where AI-agent jobs execute. All options come from the platform&apos;s job-runtime plugin
							family.
						</p>
						{runtimes.map((runtime) => (
							<div
								key={runtime.id}
								className={`runtime-card ${selection?.runtimeId === runtime.id ? 'selected' : ''}`}
								onClick={() => selectRuntime(runtime)}
							>
								<div>
									<strong>{runtime.name}</strong>{' '}
									{runtime.recommended && <span className="badge ok">Recommended</span>}
								</div>
								<span className="muted">{runtime.description}</span>
							</div>
						))}

						{selection && selectedRuntime && (
							<>
								{selectedRuntime.fields.map((field) => (
									<label className="field" key={field.key}>
										<span>
											{field.label} ({field.key}){field.required ? ' *' : ''}
										</span>
										<input
											type={field.secret ? 'password' : 'text'}
											value={selection.values[field.key] ?? ''}
											placeholder={field.placeholder}
											onChange={(event) =>
												setSelection({
													...selection,
													values: { ...selection.values, [field.key]: event.target.value }
												})
											}
										/>
									</label>
								))}

								<label className="field">
									<span>Database</span>
									{(
										[
											['embedded-sqlite', 'Embedded SQLite (zero dependencies)'],
											['docker-postgres', 'Local Postgres via docker-compose infra'],
											['external-postgres', 'External Postgres (connection URL)']
										] as Array<[DatabaseChoice, string]>
									).map(([choice, label]) => (
										<div key={choice}>
											<input
												type="radio"
												id={`db-${choice}`}
												checked={selection.database === choice}
												disabled={choice === 'docker-postgres' && dockerAvailable === false}
												onChange={() =>
													setSelection({
														...selection,
														database: choice,
														useDockerInfra:
															choice === 'docker-postgres' || selection.useDockerInfra
													})
												}
											/>{' '}
											<label htmlFor={`db-${choice}`}>{label}</label>
										</div>
									))}
								</label>

								{selection.database === 'external-postgres' && (
									<label className="field">
										<span>Postgres connection URL *</span>
										<input
											type="text"
											value={selection.externalDatabaseUrl ?? ''}
											placeholder="postgres://user:pass@host:5432/ever_works"
											onChange={(event) =>
												setSelection({ ...selection, externalDatabaseUrl: event.target.value })
											}
										/>
									</label>
								)}

								<label className="field">
									<input
										type="checkbox"
										checked={selection.useDockerInfra}
										disabled={dockerAvailable === false}
										onChange={(event) =>
											setSelection({ ...selection, useDockerInfra: event.target.checked })
										}
									/>{' '}
									Provision Postgres + Redis via docker-compose.infra.yml
									{dockerAvailable === false && <span className="muted"> (Docker not detected)</span>}
								</label>
							</>
						)}
					</>
				)}

				{step === 'env' && (
					<>
						<h2>Write configuration</h2>
						<p className="muted">
							Writes the selected runtime&apos;s environment entries (plus database and service ports) to
							the desktop env file
							{selection?.useDockerInfra ? ' and starts the docker-compose infrastructure' : ''}.
						</p>
						{envError && <p style={{ color: 'var(--err)' }}>{envError}</p>}
						<div className="actions">
							<button onClick={() => void applyEnv()} disabled={envWritten}>
								{envWritten ? 'Configuration written' : 'Write configuration'}
							</button>
						</div>
					</>
				)}

				{step === 'boot' && (
					<>
						<h2>Boot services</h2>
						{statuses.map((status) => (
							<div className="service-row" key={status.id}>
								<span
									className={`badge ${status.healthy ? 'ok' : status.state === 'failed' ? 'err' : 'warn'}`}
								>
									{status.healthy ? 'healthy' : status.state}
								</span>
								<span>{status.id === 'api' ? 'API (:3100)' : 'Web (:3000)'}</span>
								{status.pid && <span className="muted">pid {status.pid}</span>}
							</div>
						))}
						<div className="actions">
							<button onClick={() => void bridge.startServices()}>Start services</button>
							<button className="secondary" onClick={() => void bridge.stopServices()}>
								Stop
							</button>
						</div>
						<div className="log-pane">
							{bootLog.map((line, index) => (
								<div className="log-line" key={index}>
									{line}
								</div>
							))}
						</div>
					</>
				)}

				{step === 'open' && (
					<>
						<h2>Ready</h2>
						<p className="muted">
							{mode === 'remote-client'
								? `Connected to ${remoteConnection?.label ?? remoteConnection?.webUrl ?? 'your instance'}. Continue to sign in and use Ever Works.`
								: 'The local platform is up. Continue into the Ever Works web onboarding to finish setting up your workspace.'}
						</p>
						<div className="actions">
							<button onClick={() => void openApp()}>Open Ever Works</button>
						</div>
					</>
				)}
			</div>

			{step !== 'open' && (
				<div className="actions">
					<button
						className="secondary"
						disabled={previousStep(step, progress) === null}
						onClick={() => {
							const previous = previousStep(step, progress);
							if (previous) {
								setStep(previous);
							}
						}}
					>
						Back
					</button>
					<button
						disabled={!canAdvance(step, progress)}
						onClick={() => {
							const next = nextStep(step, progress);
							if (next) {
								setStep(next);
							}
						}}
					>
						Continue
					</button>
				</div>
			)}
		</div>
	);
}
