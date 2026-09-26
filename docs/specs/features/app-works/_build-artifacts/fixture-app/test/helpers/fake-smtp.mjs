/**
 * A tiny SMTP server for the mail tests: it accepts one message and keeps it.
 *
 * Enough of RFC 5321 to prove `src/mail.mjs` sends a real message: the greeting, a multi-line `EHLO`
 * reply advertising `AUTH PLAIN LOGIN`, `AUTH`, `MAIL FROM`, `RCPT TO`, `DATA` with dot-unstuffing, and
 * `QUIT`. It never offers STARTTLS — the fixture's TLS path is exercised by configuration, not here.
 */

import net from 'node:net';

export function createFakeSmtp({ user = '', password = '' } = {}) {
	const messages = [];
	const sessions = [];

	const server = net.createServer((socket) => {
		let buffer = '';
		let inData = false;
		let data = '';
		let authenticated = !user;
		const session = { from: null, to: [], auth: null };
		sessions.push(session);

		const send = (line) => socket.write(`${line}\r\n`);
		send('220 fake-smtp ready');

		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			for (;;) {
				const index = buffer.indexOf('\r\n');
				if (index === -1) break;
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);

				if (inData) {
					if (line === '.') {
						inData = false;
						messages.push({ from: session.from, to: [...session.to], data: data.replace(/\r\n\.\./g, '\r\n.').replace(/\r\n$/, '') });
						data = '';
						send('250 2.0.0 Ok: queued');
						continue;
					}
					data += `${line}\r\n`;
					continue;
				}

				const command = line.split(' ')[0].toUpperCase();
				const argument = line.slice(command.length + 1);
				switch (command) {
					case 'EHLO':
					case 'HELO':
						send('250-fake-smtp');
						send('250-SIZE 10485760');
						send('250 AUTH PLAIN LOGIN');
						break;
					case 'AUTH': {
						const [mechanism, token] = argument.split(' ');
						if (mechanism.toUpperCase() === 'PLAIN') {
							const decoded = Buffer.from(token || '', 'base64').toString('utf8').split('\0');
							session.auth = { mechanism: 'PLAIN', user: decoded[1], password: decoded[2] };
						} else {
							session.auth = { mechanism: 'LOGIN' };
							send('334 VXNlcm5hbWU6');
						}
						if (mechanism.toUpperCase() === 'PLAIN') {
							if (session.auth.user === user && session.auth.password === password) {
								authenticated = true;
								send('235 2.7.0 Authentication successful');
							} else {
								send('535 5.7.8 Authentication credentials invalid');
							}
						}
						break;
					}
					case 'MAIL':
						session.from = argument.replace(/^FROM:</i, '').replace(/[<>]/g, '');
						send('250 2.1.0 Ok');
						break;
					case 'RCPT':
						session.to.push(argument.replace(/^TO:</i, '').replace(/[<>]/g, ''));
						send('250 2.1.5 Ok');
						break;
					case 'DATA':
						if (!authenticated) {
							send('530 5.7.0 Authentication required');
							break;
						}
						inData = true;
						send('354 End data with <CR><LF>.<CR><LF>');
						break;
					case 'QUIT':
						send('221 2.0.0 Bye');
						socket.end();
						break;
					default:
						send('502 5.5.2 Command not implemented');
				}
			}
		});
		socket.on('error', () => socket.destroy());
	});

	return {
		server,
		messages,
		sessions,
		listen(port = 0, host = '127.0.0.1') {
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => {
					server.off('error', reject);
					const address = server.address();
					resolve(typeof address === 'object' && address ? address.port : port);
				});
			});
		},
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
