/**
 * A protocol-level PostgreSQL stub: enough server for the fixture to run with no database installed.
 *
 * **It is not a database.** It speaks the v3 wire protocol (startup, SCRAM-SHA-256 or trust, the simple
 * query protocol, the extended query protocol, `RowDescription`/`DataRow`/`CommandComplete`/
 * `ErrorResponse`/`ReadyForQuery`) and keeps five in-memory tables, so that:
 *
 *   - `npm test` can exercise `src/migrate.mjs`, `src/server.mjs`, `src/worker.mjs` and `src/db.mjs`
 *     end to end without a Postgres, and
 *   - a person can run the fixture locally with `npm run dev:postgres` and curl every route
 *     (see `evidence/proof.txt`).
 *
 * It understands the statements the fixture issues and the columns they select, and **no others**:
 * anything else is acknowledged with a warning, or refused when `strict`. Real PostgreSQL is still the
 * only thing that proves the SQL. **No real-PostgreSQL run is recorded in this repository** — an earlier
 * version of this comment claimed `evidence/proof.txt` held a PostgreSQL 16.2 run, and it never did. The
 * runs in that file are against this stub; the acceptance lanes are what must set
 * `FIXTURE_TEST_DATABASE_URL` and run the same cases against a real server.
 *
 * One connection detail worth knowing: `createStubPostgres` builds ONE `store` and hands it to every
 * connection, so two connections see the same tables. That is why a disagreement between two routes'
 * queries (see `evidence/proof.txt` §3) is a real defect in the fixture rather than an artefact of the stub.
 *
 * Usage: `node tools/dev-postgres.mjs [--port 55432] [--user fixture] [--password secret] [--quiet]`
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INT_COLUMNS = new Set(['ticks', 'beat_count', 'id']);
const BOOL_COLUMNS = new Set(['saw_internal_app', 'saw_public_app']);

/** The tables the fixture's migrations create, with the columns each statement needs. */
function emptyStore() {
	return {
		schema_migrations: { columns: ['version', 'label', 'checksum', 'applied_at'], rows: [], conflictKey: ['version', 'label'] },
		cron_ticks: { columns: ['name', 'ticks', 'last_tick_at'], rows: [], conflictKey: ['name'] },
		worker_heartbeat: { columns: ['name', 'beat_at', 'beat_count'], rows: [], conflictKey: ['name'] },
		bootstrap_checks: { columns: ['id', 'ran_at', 'internal_url', 'public_url', 'saw_internal_app', 'saw_public_app', 'marker'], rows: [], serial: 0, conflictKey: [] },
		app_info: { columns: ['id', 'created_at', 'note'], rows: [], conflictKey: ['id'] }
	};
}

export function createStubPostgres({ user = 'fixture', password = '', strict = false, log = () => {} } = {}) {
	const store = emptyStore();
	const warnings = [];
	let serial = 0;

	const server = net.createServer((socket) => {
		new StubConnection(socket, { store, user, password, strict, log, warnings, nextSerial: () => (serial += 1) });
	});

	return {
		server,
		store,
		warnings,
		/** @param {number} [port] @param {string} [host] */
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

class StubConnection {
	#socket;
	#buffer = Buffer.alloc(0);
	#phase = 'startup';
	#options;
	#scram = null;
	#statements = new Map();
	#portals = new Map();

	constructor(socket, options) {
		this.#socket = socket;
		this.#options = options;
		socket.on('data', (chunk) => {
			this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
			try {
				this.#pump();
			} catch (error) {
				this.#sendError('XX000', error instanceof Error ? error.message : String(error));
				this.#ready();
			}
		});
		socket.on('error', () => socket.destroy());
	}

	#pump() {
		for (;;) {
			if (this.#phase === 'startup') {
				if (this.#buffer.length < 4) return;
				const length = this.#buffer.readInt32BE(0);
				if (this.#buffer.length < length) return;
				const body = this.#buffer.subarray(4, length);
				this.#buffer = this.#buffer.subarray(length);
				if (body.readInt32BE(0) === 80877103) {
					this.#socket.write(Buffer.from('N')); // no TLS on the stub
					continue;
				}
				this.#startup(body);
				continue;
			}
			if (this.#buffer.length < 5) return;
			const length = this.#buffer.readInt32BE(1);
			if (this.#buffer.length < length + 1) return;
			const type = String.fromCharCode(this.#buffer[0]);
			const body = this.#buffer.subarray(5, length + 1);
			this.#buffer = this.#buffer.subarray(length + 1);
			this.#message(type, body);
		}
	}

	#startup(body) {
		const params = {};
		let offset = 4;
		while (offset < body.length && body[offset] !== 0) {
			const keyEnd = body.indexOf(0, offset);
			const valueEnd = body.indexOf(0, keyEnd + 1);
			params[body.subarray(offset, keyEnd).toString('utf8')] = body.subarray(keyEnd + 1, valueEnd).toString('utf8');
			offset = valueEnd + 1;
		}
		this.#options.log(`stub-postgres: startup user=${params.user} database=${params.database}`);

		if (this.#options.password) {
			const nonce = crypto.randomBytes(18).toString('base64');
			this.#scram = { nonce, clientFirstBare: null, serverFirst: null, saltedPassword: null };
			this.#phase = 'auth'; // the next message is a SASL response, not another startup packet
			this.#send('R', Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\x00\x00', 'utf8')]));
			return;
		}
		this.#authenticated();
	}

	#authenticated() {
		this.#phase = 'ready';
		this.#send('R', int32(0));
		this.#send('S', Buffer.from('server_version\x0016.2\x00', 'utf8'));
		this.#send('S', Buffer.from('client_encoding\x00UTF8\x00', 'utf8'));
		this.#send('K', Buffer.concat([int32(process.pid), int32(crypto.randomInt(1, 100000))]));
		this.#ready();
	}

	#message(type, body) {
		switch (type) {
			case 'Q':
				this.#simpleQuery(cstring(body, 0).value);
				return;
			case 'P':
				this.#parse(body);
				return;
			case 'B':
				this.#bind(body);
				return;
			case 'D':
				this.#describe(body);
				return;
			case 'E':
				this.#execute(body);
				return;
			case 'S':
				this.#ready();
				return;
			case 'X':
				this.#socket.end();
				return;
			case 'p':
				this.#scramResponse(body);
				return;
			default:
				this.#options.log(`stub-postgres: ignoring message ${type}`);
		}
	}

	// ---------------------------------------------------------------- SCRAM-SHA-256 (server side)

	#scramResponse(body) {
		if (!this.#scram) return;
		if (!this.#scram.clientFirstBare) {
			const text = body.toString('utf8');
			const clientFirst = text.slice(text.indexOf('n,,') + 3);
			this.#scram.clientFirstBare = clientFirst;
			const attributes = scramAttributes(clientFirst);
			const salt = crypto.randomBytes(16);
			const iterations = 4096;
			this.#scram.salt = salt;
			this.#scram.iterations = iterations;
			const serverFirst = `r=${attributes.r}${crypto.randomBytes(12).toString('base64')},s=${salt.toString('base64')},i=${iterations}`;
			this.#scram.serverFirst = serverFirst;
			this.#scram.saltedPassword = crypto.pbkdf2Sync(Buffer.from(this.#options.password, 'utf8'), salt, iterations, 32, 'sha256');
			this.#send('R', Buffer.concat([int32(11), Buffer.from(serverFirst, 'utf8')]));
			return;
		}

		const text = body.toString('utf8');
		const attributes = scramAttributes(text);
		const withoutProof = text.slice(0, text.lastIndexOf(',p='));
		const authMessage = `${this.#scram.clientFirstBare},${this.#scram.serverFirst},${withoutProof}`;
		const clientKey = hmac(this.#scram.saltedPassword, 'Client Key');
		const storedKey = crypto.createHash('sha256').update(clientKey).digest();
		const clientSignature = hmac(storedKey, authMessage);
		const expectedProof = xor(clientKey, clientSignature).toString('base64');
		if (attributes.p !== expectedProof) {
			this.#send('E', errorFields('28P01', 'password authentication failed for user "' + this.#options.user + '"'));
			this.#ready();
			return;
		}
		const serverSignature = hmac(hmac(this.#scram.saltedPassword, 'Server Key'), authMessage).toString('base64');
		this.#send('R', Buffer.concat([int32(12), Buffer.from(`v=${serverSignature}`, 'utf8')]));
		this.#authenticated();
	}

	// ---------------------------------------------------------------- queries

	#simpleQuery(sql) {
		let failed = null;
		for (const statement of splitStatements(sql)) {
			try {
				const result = this.#executeStatement(statement, []);
				if (result.fields.length) this.#rowDescription(result.fields);
				for (const row of result.rows) this.#dataRow(result.fields, row);
				this.#send('C', Buffer.from(`${result.command}\0`, 'utf8'));
			} catch (error) {
				failed = error;
				break;
			}
		}
		if (failed) {
			this.#send('E', errorFields(failed.code ?? '42601', failed.message));
		}
		this.#ready();
	}

	#parse(body) {
		const name = cstring(body, 0);
		const query = cstring(body, name.next);
		this.#statements.set(name.value, query.value);
		this.#send('1', Buffer.alloc(0)); // ParseComplete
	}

	#bind(body) {
		const portal = cstring(body, 0);
		const statement = cstring(body, portal.next);
		let offset = statement.next;
		const formatCount = body.readUInt16BE(offset);
		offset += 2 + formatCount * 2;
		const parameterCount = body.readUInt16BE(offset);
		offset += 2;
		const parameters = [];
		for (let i = 0; i < parameterCount; i += 1) {
			const length = body.readInt32BE(offset);
			offset += 4;
			if (length === -1) {
				parameters.push(null);
				continue;
			}
			parameters.push(body.subarray(offset, offset + length).toString('utf8'));
			offset += length;
		}
		this.#portals.set(portal.value, { query: this.#statements.get(statement.value) ?? '', parameters, described: false });
		this.#send('2', Buffer.alloc(0)); // BindComplete
	}

	#describe(body) {
		const kind = String.fromCharCode(body[0]);
		const name = cstring(body, 1).value;
		if (kind === 'S') {
			this.#send('n', Buffer.alloc(0)); // NoData for a statement
			return;
		}
		const portal = this.#portals.get(name);
		if (!portal) {
			this.#send('n', Buffer.alloc(0));
			return;
		}
		try {
			const result = this.#executeStatement(portal.query, portal.parameters, { describeOnly: true });
			if (result.fields.length) {
				this.#rowDescription(result.fields);
				portal.described = true;
			} else {
				this.#send('n', Buffer.alloc(0));
			}
		} catch {
			this.#send('n', Buffer.alloc(0));
		}
	}

	#execute(body) {
		const portalName = cstring(body, 0).value;
		const portal = this.#portals.get(portalName);
		if (!portal) {
			this.#ready();
			return;
		}
		try {
			const result = this.#executeStatement(portal.query, portal.parameters);
			if (!portal.described && result.fields.length) this.#rowDescription(result.fields);
			for (const row of result.rows) this.#dataRow(result.fields, row);
			this.#send('C', Buffer.from(`${result.command}\0`, 'utf8'));
		} catch (error) {
			this.#send('E', errorFields(error.code ?? '42601', error.message));
		}
		this.#ready();
	}

	/** The whole "SQL engine": the statements the fixture issues, and nothing else. */
	#executeStatement(sql, parameters, { describeOnly = false } = {}) {
		const text = String(sql).replace(/--[^\n]*/g, ' ').trim().replace(/;$/, '');
		if (!text) return { command: 'EMPTY', fields: [], rows: [] };

		const upper = text.toUpperCase();

		if (/^(BEGIN|START TRANSACTION)/.test(upper)) return { command: 'BEGIN', fields: [], rows: [] };
		if (/^COMMIT/.test(upper)) return { command: 'COMMIT', fields: [], rows: [] };
		if (/^ROLLBACK/.test(upper)) return { command: 'ROLLBACK', fields: [], rows: [] };

		let match = text.match(/^CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*)\)$/i);
		if (match) {
			const table = this.#table(match[1]);
			for (const line of splitTopLevel(match[2], ',')) {
				const column = line.trim().split(/\s+/)[0];
				if (column && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(column) && !table.columns.includes(column)) {
					table.columns.push(column);
				}
			}
			return { command: 'CREATE TABLE', fields: [], rows: [] };
		}

		match = text.match(/^CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)/i);
		if (match) return { command: 'CREATE INDEX', fields: [], rows: [] };

		match = text.match(/^ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/i);
		if (match) {
			const table = this.#table(match[1]);
			if (!table.columns.includes(match[2])) table.columns.push(match[2]);
			return { command: 'ALTER TABLE', fields: [], rows: [] };
		}

		match = text.match(/^INSERT INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(ON CONFLICT[\s\S]*)?$/i);
		if (match) {
			const table = this.#table(match[1]);
			const columns = splitTopLevel(match[2], ',').map((column) => column.trim());
			const values = splitTopLevel(match[3], ',').map((value) => this.#value(value.trim(), parameters));
			const excluded = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
			const conflict = (match[4] || '').trim();
			const keyColumns = table.conflictKey.length ? table.conflictKey : columns.slice(0, 1);
			const existing = table.rows.find((row) => keyColumns.every((column) => String(row[column]) === String(excluded[column])));
			if (existing) {
				if (/DO NOTHING/i.test(conflict)) return { command: 'INSERT 0 0', fields: [], rows: [] };
				if (/DO UPDATE/i.test(conflict)) {
					const updates = conflict.match(/SET\s+([\s\S]*)$/i);
					if (updates) {
						for (const assignment of splitTopLevel(updates[1], ',')) {
							const [column, expression] = assignment.split('=').map((part) => part.trim());
							const fromExcluded = expression?.match(/^EXCLUDED\.(\w+)$/i);
							if (fromExcluded) existing[column] = excluded[fromExcluded[1]];
							else existing[column] = this.#value(expression, parameters, existing);
						}
					}
					return { command: 'INSERT 0 1', fields: [], rows: [] };
				}
			}
			const row = {};
			columns.forEach((column, index) => {
				row[column] = values[index];
			});
			if (table.columns.includes('id') && row.id === undefined) row.id = this.#options.nextSerial();
			if (table.columns.includes('applied_at') && row.applied_at === undefined) row.applied_at = new Date().toISOString();
			if (table.columns.includes('created_at') && row.created_at === undefined) row.created_at = new Date().toISOString();
			if (table.columns.includes('ran_at') && row.ran_at === undefined) row.ran_at = new Date().toISOString();
			if (describeOnly) return { command: 'INSERT 0 1', fields: [], rows: [] };
			table.rows.push(row);
			return { command: 'INSERT 0 1', fields: [], rows: [] };
		}

		match = text.match(/^UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]*))?$/i);
		if (match) {
			const table = this.#table(match[1]);
			const predicate = match[3] ? this.#predicate(match[3], parameters) : () => true;
			let count = 0;
			for (const row of table.rows) {
				if (!predicate(row)) continue;
				count += 1;
				if (!describeOnly) this.#applySet(row, match[2], parameters);
			}
			return { command: `UPDATE ${count}`, fields: [], rows: [] };
		}

		// `SELECT 1 AS ok` and friends: one row, no table.
		match = text.match(/^SELECT\s+([\s\S]*)$/i);
		if (match && !/\sFROM\s/i.test(text)) {
			const projection = splitTopLevel(match[1], ',').map((expression) => parseProjection(expression.trim()));
			const row = {};
			for (const item of projection) row[item.alias] = item.literal;
			return {
				command: 'SELECT 1',
				fields: projection.map((item) => ({ name: item.alias, dataTypeOid: typeof item.literal === 'number' ? 23 : 25 })),
				rows: [row]
			};
		}

		match = text.match(/^SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)([\s\S]*)$/i);
		if (match) {
			const table = this.#table(match[2]);
			const tail = match[3] || '';
			const where = tail.match(/WHERE\s+([\s\S]*?)(?:\s+ORDER BY|\s+LIMIT|$)/i);
			const order = tail.match(/ORDER BY\s+([\s\S]*?)(?:\s+LIMIT|$)/i);
			const limit = tail.match(/LIMIT\s+(\d+)/i);
			const projection = splitTopLevel(match[1], ',').map((expression) => parseProjection(expression.trim()));

			let rows = table.rows.filter(where ? this.#predicate(where[1], parameters) : () => true);
			if (order) {
				const [column, direction] = order[1].trim().split(/\s+/);
				rows = [...rows].sort((a, b) => {
					const left = a[column];
					const right = b[column];
					const comparison = left === right ? 0 : left > right ? 1 : -1;
					return /DESC/i.test(direction || '') ? -comparison : comparison;
				});
			}
			if (limit) rows = rows.slice(0, Number(limit[1]));

			const fields = projection.map((item) => ({
				name: item.alias,
				dataTypeOid: item.count ? 20 : INT_COLUMNS.has(item.alias) ? 23 : BOOL_COLUMNS.has(item.alias) ? 16 : 25
			}));
			const projected = rows.map((row) => {
				const out = {};
				for (const item of projection) out[item.alias] = item.count ? rows.length : row[item.column] ?? null;
				return out;
			});
			return { command: `SELECT ${projected.length}`, fields, rows: projected };
		}

		// Anything else: the fixture does not issue it, so the stub refuses to pretend it worked.
		const message = `stub-postgres does not implement: ${text.slice(0, 120)}`;
		this.#options.warnings.push(message);
		this.#options.log(`stub-postgres: WARNING ${message}`);
		if (this.#options.strict) throw Object.assign(new Error(message), { code: '0A000' });
		return { command: 'SELECT 0', fields: [], rows: [] };
	}

	#table(name) {
		if (!this.#options.store[name]) {
			this.#options.store[name] = { columns: [], rows: [], conflictKey: [] };
		}
		return this.#options.store[name];
	}

	#applySet(row, assignments, parameters) {
		for (const assignment of splitTopLevel(assignments, ',')) {
			const [column, expression] = assignment.split('=').map((part) => part.trim());
			if (!column || expression === undefined) continue;
			const increment = expression.match(/^(\w+)\s*\+\s*(\d+)$/);
			if (increment) {
				row[column] = Number(row[column] ?? 0) + Number(increment[2]);
				continue;
			}
			row[column] = this.#value(expression, parameters, row);
		}
	}

	#value(expression, parameters, row = null) {
		const text = String(expression).trim();
		const placeholder = text.match(/^\$(\d+)(::[\w\s]+)?$/);
		if (placeholder) return parameters[Number(placeholder[1]) - 1] ?? null;
		if (/^now\(\)$/i.test(text)) return new Date().toISOString();
		if (/^true$/i.test(text)) return true;
		if (/^false$/i.test(text)) return false;
		if (/^null$/i.test(text)) return null;
		if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
		if (/^'.*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
		if (row && Object.hasOwn(row, text)) return row[text];
		return text;
	}

	#predicate(where, parameters) {
		const text = String(where).trim();
		const clauses = text.split(/\s+AND\s+/i).map((clause) => {
			const match = clause.match(/^(\w+)\s*(=|<>|!=)\s*(.+)$/);
			if (!match) return () => true;
			const [, column, operator, rawValue] = match;
			const expected = this.#value(rawValue, parameters);
			return (row) => {
				const value = row[column];
				const equal = typeof expected === 'boolean' || typeof value === 'boolean' ? Boolean(value) === Boolean(expected) : String(value) === String(expected);
				return operator === '=' ? equal : !equal;
			};
		});
		return (row) => clauses.every((clause) => clause(row));
	}

	// ---------------------------------------------------------------- message writing

	#rowDescription(fields) {
		const parts = [uint16(fields.length)];
		for (const field of fields) {
			parts.push(Buffer.from(`${field.name}\0`, 'utf8'), uint32(0), uint16(0), uint32(field.dataTypeOid ?? 25), uint16(-1), int32(-1), uint16(0));
		}
		this.#send('T', Buffer.concat(parts));
	}

	#dataRow(fields, row) {
		const parts = [uint16(fields.length)];
		for (const field of fields) {
			const value = row[field.name];
			if (value === null || value === undefined) {
				parts.push(int32(-1));
				continue;
			}
			const text = typeof value === 'boolean' ? (value ? 't' : 'f') : String(value);
			const buffer = Buffer.from(text, 'utf8');
			parts.push(int32(buffer.length), buffer);
		}
		this.#send('D', Buffer.concat(parts));
	}

	#ready() {
		this.#phase = 'ready';
		this.#send('Z', Buffer.from('I\x00', 'utf8'));
	}

	#sendError(code, message) {
		this.#send('E', errorFields(code, message));
	}

	#send(type, body) {
		const header = Buffer.alloc(5);
		header.write(type, 0, 'latin1');
		header.writeInt32BE(body.length + 4, 1);
		this.#socket.write(Buffer.concat([header, body]));
	}
}

function parseProjection(expression) {
	const alias = expression.match(/\s+AS\s+(\w+)$/i);
	const source = alias ? expression.slice(0, alias.index).trim() : expression;
	if (/^count\(\*\)$/i.test(source)) return { alias: alias ? alias[1] : 'count', column: null, count: true };
	if (/^to_char\(/i.test(source)) {
		const column = source.replace(/^to_char\(/i, '').match(/^\s*(\w+)/);
		return { alias: alias ? alias[1] : column?.[1] ?? 'value', column: column?.[1] ?? null, count: false };
	}
	if (/^-?\d+(\.\d+)?$/.test(source)) return { alias: alias ? alias[1] : source, column: null, count: false, literal: Number(source) };
	if (/^'.*'$/.test(source)) return { alias: alias ? alias[1] : 'text', column: null, count: false, literal: source.slice(1, -1) };
	if (/^now\(\)$/i.test(source)) return { alias: alias ? alias[1] : 'now', column: null, count: false, literal: new Date().toISOString() };
	return { alias: alias ? alias[1] : source, column: source.split('.').pop(), count: false };
}

/** Split on a separator at bracket depth zero, ignoring separators inside quotes or `--` comments. */
export function splitTopLevel(text, separator) {
	const parts = [];
	let depth = 0;
	let quoted = false;
	let comment = false;
	let current = '';
	const characters = [...String(text)];
	for (let index = 0; index < characters.length; index += 1) {
		const character = characters[index];
		if (comment) {
			if (character === '\n') comment = false;
			current += character;
			continue;
		}
		if (!quoted && character === '-' && characters[index + 1] === '-') {
			comment = true;
			current += character;
			continue;
		}
		if (character === "'") quoted = !quoted;
		if (!quoted) {
			if (character === '(') depth += 1;
			if (character === ')') depth -= 1;
			if (character === separator && depth === 0) {
				parts.push(current);
				current = '';
				continue;
			}
		}
		current += character;
	}
	parts.push(current);
	return parts.filter((part) => part.trim().length);
}

/** Split a simple-query string into statements, ignoring semicolons in strings and `--` comments. */
export function splitStatements(sql) {
	const statements = [];
	let quoted = false;
	let comment = false;
	let current = '';
	const characters = [...String(sql)];
	for (let index = 0; index < characters.length; index += 1) {
		const character = characters[index];
		if (comment) {
			if (character === '\n') comment = false;
			current += character;
			continue;
		}
		if (!quoted && character === '-' && characters[index + 1] === '-') {
			comment = true;
			current += character;
			continue;
		}
		if (character === "'") quoted = !quoted;
		if (character === ';' && !quoted) {
			if (current.trim()) statements.push(current.trim());
			current = '';
			continue;
		}
		current += character;
	}
	if (current.trim()) statements.push(current.trim());
	return statements;
}

function scramAttributes(message) {
	const attributes = {};
	for (const part of String(message).split(',')) {
		const index = part.indexOf('=');
		if (index > 0) attributes[part.slice(0, index)] = part.slice(index + 1);
	}
	return attributes;
}

const cstring = (buf, offset) => {
	const end = buf.indexOf(0, offset);
	return { value: buf.subarray(offset, end === -1 ? buf.length : end).toString('utf8'), next: end === -1 ? buf.length : end + 1 };
};

const uint16 = (value) => {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16BE(value & 0xffff, 0);
	return buffer;
};

const uint32 = (value) => {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value >>> 0, 0);
	return buffer;
};

const int32 = (value) => {
	const buffer = Buffer.alloc(4);
	buffer.writeInt32BE(value | 0, 0);
	return buffer;
};

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const xor = (a, b) => Buffer.from(a.map((byte, index) => byte ^ b[index]));

function errorFields(code, message) {
	return Buffer.concat([
		Buffer.from('S', 'utf8'),
		Buffer.from('ERROR\0', 'utf8'),
		Buffer.from('V', 'utf8'),
		Buffer.from('ERROR\0', 'utf8'),
		Buffer.from('C', 'utf8'),
		Buffer.from(`${code}\0`, 'utf8'),
		Buffer.from('M', 'utf8'),
		Buffer.from(`${message}\0`, 'utf8'),
		Buffer.from([0])
	]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = Number(valueOf('--port') ?? 55432);
	const user = valueOf('--user') ?? 'fixture';
	const password = valueOf('--password') ?? '';
	const quiet = process.argv.includes('--quiet');
	const stub = createStubPostgres({ user, password, log: quiet ? () => {} : (line) => process.stdout.write(`${line}\n`) });
	const actual = await stub.listen(port);
	process.stdout.write(
		`stub-postgres: listening on 127.0.0.1:${actual} as ${user}\n` +
			`stub-postgres: DATABASE_URL=postgres://${user}${password ? `:${password}` : ''}@127.0.0.1:${actual}/app_fixture?sslmode=disable\n` +
			'stub-postgres: this is a protocol stub for local runs, not a database\n'
	);
	const stop = async () => {
		await stub.close();
		process.exit(0);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
}

function valueOf(name, argv = process.argv.slice(2)) {
	const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
	if (withEquals) return withEquals.slice(name.length + 1);
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : null;
}
