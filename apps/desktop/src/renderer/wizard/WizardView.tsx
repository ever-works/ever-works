import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
	DatabaseChoice,
	DesktopBridge,
	PrereqCheckResult,
	RuntimeDescriptor,
	RuntimeSelection,
	ServiceStatus
} from '../../shared/ipc-contract';
import { canAdvance, computeStepList, nextStep, previousStep, type WizardStepId } from './steps';

interface WizardViewProps {
	bridge: DesktopBridge;
	onCompleted(): void;
}

export function WizardView({ bridge, onCompleted }: WizardViewProps) {
	const [step, setStep] = useState<WizardStepId>('welcome');
	const [prereqResults, setPrereqResults] = useState<PrereqCheckResult[] | undefined>();
	const [runtimes, setRuntimes] = useState<RuntimeDescriptor[]>([]);
	const [dockerAvailable, setDockerAvailable] = useState<boolean | undefined>();
	const [selection, setSelection] = useState<RuntimeSelection | undefined>();
	const [envWritten, setEnvWritten] = useState(false);
	const [envError, setEnvError] = useState<string | undefined>();
	const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
	const [bootLog, setBootLog] = useState<string[]>([]);

	const servicesHealthy = statuses.length > 0 && statuses.every((status) => status.healthy);
	const progress = useMemo(
		() => ({ prereqResults, selection, envWritten, servicesHealthy }),
		[prereqResults, selection, envWritten, servicesHealthy]
	);
	const steps = computeStepList(progress);

	const runPrereqs = useCallback(() => {
		void bridge.checkPrereqs().then(setPrereqResults);
		void bridge.detectDocker().then((result) => setDockerAvailable(result.available));
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

	const openApp = async () => {
		await bridge.completeWizard();
		onCompleted();
		await bridge.openWebApp();
	};

	const selectedRuntime = runtimes.find((runtime) => runtime.id === selection?.runtimeId);

	return (
		<div className="shell">
			<h1>Ever Works Desktop</h1>
			<p className="muted">All-in-one install: run the full platform on this machine.</p>

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
							This wizard checks prerequisites, lets you pick the AI-agent job runtime, writes the local
							configuration, then boots the platform (API on :3100, web on :3000) and opens the existing
							web onboarding.
						</p>
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
							The local platform is up. Continue into the Ever Works web onboarding to finish setting up
							your workspace.
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
