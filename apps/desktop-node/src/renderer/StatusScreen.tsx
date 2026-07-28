import { useEffect, useState } from 'react';
import type { ConnectionStatusView, DesktopNodeBridge, LogEntry, NodeIdentityView } from '../shared/ipc-contract';
import { describeStatus, formatSince, isLive, statusTone } from '../shared/status-label';

interface StatusScreenProps {
	bridge: DesktopNodeBridge;
	identity: NodeIdentityView;
	onUnenrolled(): void;
}

/** Node status, capabilities and a live log pane, shown once enrolled. */
export function StatusScreen({ bridge, identity, onUnenrolled }: StatusScreenProps) {
	const [status, setStatus] = useState<ConnectionStatusView | undefined>();
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		void bridge.getStatus().then(setStatus);
		const offStatus = bridge.onStatus(setStatus);
		// Re-render the "last heartbeat" age between events.
		const ticker = setInterval(() => setNow(Date.now()), 1000);
		return () => {
			offStatus();
			clearInterval(ticker);
		};
	}, [bridge]);

	useEffect(() => {
		void bridge.getLogs().then(setLogs);
		return bridge.onLog((entry) => setLogs((existing) => [...existing.slice(-499), entry]));
	}, [bridge]);

	const live = isLive(status);
	// A18 — driven off the worker loop's real state, not a local UI flag, so
	// the button always agrees with what the node is actually doing.
	const worker = status?.worker;
	const paused = worker?.paused === true;

	return (
		<div className="shell">
			<h1>Ever Works Desktop Node</h1>

			<div className="service-row">
				<span className={`badge ${status ? statusTone(status) : 'warn'}`}>
					{status ? describeStatus(status) : 'Not connected'}
				</span>
				<span className="muted">{identity.name ?? identity.nodeId}</span>
				{status?.platformStatus && <span className="muted">platform: {status.platformStatus}</span>}
				{worker?.enabled && (
					<span className={`badge ${paused ? 'warn' : 'ok'}`}>
						{paused ? 'work paused' : `work ${worker.state}`}
					</span>
				)}
			</div>

			<div className="panel">
				<dl className="kv">
					<dt>Node id</dt>
					<dd>{identity.nodeId}</dd>
					<dt>API host</dt>
					<dd>{identity.apiUrl}</dd>
					<dt>Last heartbeat</dt>
					<dd>{formatSince(status?.lastHeartbeatAt ?? null, now)}</dd>
					<dt>Heartbeat every</dt>
					<dd>{(identity.heartbeatIntervalMs ?? 60_000) / 1000}s</dd>
					<dt>Enrolled at</dt>
					<dd>{identity.enrolledAt}</dd>
					<dt>Capabilities</dt>
					<dd>
						<div className="tags">
							{identity.capabilities.map((tag) => (
								<span className="badge" key={tag}>
									{tag}
								</span>
							))}
						</div>
					</dd>
					<dt>Resource limits</dt>
					<dd>
						{identity.limits.maxConcurrentJobs} job(s) at once
						{identity.limits.maxCpuPercent === null
							? ', no CPU ceiling'
							: `, CPU below ${identity.limits.maxCpuPercent}%`}
						{identity.limits.maxMemoryMb === null
							? ', no memory ceiling'
							: `, memory in use below ${identity.limits.maxMemoryMb}MB`}
					</dd>
					{worker?.enabled && (
						<>
							<dt>Work</dt>
							<dd>
								{worker.activeJobCount} running · {worker.completed} completed · {worker.failed} failed
							</dd>
						</>
					)}
				</dl>

				{worker?.throttleReason && <p className="muted">Not leasing new work: {worker.throttleReason}.</p>}
				{status?.lastError && <div className="error-note">{status.lastError}</div>}
			</div>

			<div className="actions">
				<button disabled={live} onClick={() => void bridge.connect()}>
					Connect
				</button>
				<button className="secondary" disabled={!live} onClick={() => void bridge.disconnect()}>
					Disconnect
				</button>
				{paused ? (
					<button onClick={() => void bridge.resume()}>Resume work</button>
				) : (
					<button className="secondary" onClick={() => void bridge.pause()}>
						Pause work
					</button>
				)}
				<button
					className="secondary"
					onClick={() => {
						void bridge.unenroll().then(onUnenrolled);
					}}
				>
					Un-enroll
				</button>
			</div>
			<p className="muted">
				Pausing stops this machine leasing NEW work — the node stays online and jobs already running still
				finish and report. Un-enrolling only forgets the local credential; the node stays in the Fleet page
				until it is revoked there.
			</p>

			<div className="panel">
				<h2>Log</h2>
				<div className="log-pane">
					{logs.map((entry, index) => (
						<div className={`log-line ${entry.level}`} key={index}>
							{entry.message}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
