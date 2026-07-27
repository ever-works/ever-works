import { useEffect, useState } from 'react';
import type { DesktopBridge, DesktopConfig, LogEntry, ServiceId, ServiceStatus } from '../shared/ipc-contract';

interface StatusScreenProps {
	bridge: DesktopBridge;
	config: DesktopConfig;
}

/** Service status + log panes shown when the wizard is already complete. */
export function StatusScreen({ bridge, config }: StatusScreenProps) {
	const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
	const [activeService, setActiveService] = useState<ServiceId>('api');
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const isRemote = config.mode === 'remote-client';

	useEffect(() => {
		if (isRemote) {
			return;
		}
		void bridge.getStatus().then(setStatuses);
		const offStatus = bridge.onStatus(setStatuses);
		const poll = setInterval(() => void bridge.getStatus().then(setStatuses), 3000);
		return () => {
			offStatus();
			clearInterval(poll);
		};
	}, [bridge, isRemote]);

	useEffect(() => {
		if (isRemote) {
			return;
		}
		void bridge.getLogs(activeService).then(setLogs);
		const offLog = bridge.onLog((entry) => {
			if (entry.serviceId === activeService) {
				setLogs((existing) => [...existing.slice(-499), entry]);
			}
		});
		return offLog;
	}, [bridge, activeService, isRemote]);

	if (isRemote) {
		return (
			<div className="shell">
				<h1>Ever Works Desktop</h1>
				<p className="muted">Client mode — connected to a remote instance</p>

				<div className="panel">
					<div className="check-row">
						<span className="badge ok">Remote</span>
						<span>{config.remote?.label ?? config.remote?.webUrl ?? 'Not configured'}</span>
					</div>
					{config.remote && (
						<div className="check-row">
							<span className="badge">API</span>
							<span className="muted">{config.remote.apiUrl}</span>
						</div>
					)}
					<p className="muted" style={{ marginTop: 12 }}>
						No services run on this machine in client mode. The platform runs on the instance above.
					</p>
					<div className="actions">
						<button onClick={() => void bridge.openWebApp()}>Open Ever Works</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="shell">
			<h1>Ever Works Desktop</h1>
			<p className="muted">Local services</p>

			{statuses.map((status) => (
				<div className="service-row" key={status.id}>
					<span className={`badge ${status.healthy ? 'ok' : status.state === 'failed' ? 'err' : 'warn'}`}>
						{status.healthy ? 'healthy' : status.state}
					</span>
					<span>{status.id === 'api' ? 'API (:3100)' : 'Web (:3000)'}</span>
					{status.pid && <span className="muted">pid {status.pid}</span>}
					{status.restarts > 0 && <span className="muted">restarts: {status.restarts}</span>}
					<button className="secondary" onClick={() => void bridge.restartService(status.id)}>
						Restart
					</button>
				</div>
			))}

			<div className="actions">
				<button onClick={() => void bridge.startServices()}>Start all</button>
				<button className="secondary" onClick={() => void bridge.stopServices()}>
					Stop all
				</button>
				<button onClick={() => void bridge.openWebApp()}>Open app</button>
			</div>

			<div className="panel">
				<div className="actions" style={{ marginTop: 0 }}>
					{(['api', 'web'] as ServiceId[]).map((id) => (
						<button
							key={id}
							className={id === activeService ? '' : 'secondary'}
							onClick={() => setActiveService(id)}
						>
							{id} logs
						</button>
					))}
				</div>
				<div className="log-pane">
					{logs.map((entry, index) => (
						<div className={`log-line ${entry.stream}`} key={index}>
							{entry.line}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
