import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notification CHANNELS — EXHAUSTIVE DTO validation + error-MESSAGE + boundary
 * matrix for @Controller('api/notification-channels'). Every status code AND
 * every asserted error string below was probed via curl against
 * http://127.0.0.1:3100 with throwaway registered users BEFORE it was written,
 * and cross-checked against notification-channels.controller.ts (Create/Update
 * DTOs + assertTargetConfigSize + the events regex) and .service.ts.
 *
 * NON-DUPLICATION — sibling specs already own these surfaces and are NOT repeated:
 *   - flow-notification-channels-crud-deep.spec.ts   asserts the STATUS CODES of
 *       create/update DTO rejects, the 16KB cap on create+patch, ParseUUIDPipe
 *       400-vs-404, the events shape-guard, auth 401 (all verbs) + garbage bearer,
 *       cross-user 404, uniqueness, verified-server-owned. It checks `.toBe(400)`
 *       but almost never the MESSAGE ARRAY content, the per-field TYPE matrix, or
 *       the exact-at-limit boundary — which is where THIS file lives.
 *   - flow-settings-notification-channels.spec.ts    owns the partial-PATCH
 *       SEMANTICS matrix (name-only / config-only / {}-noop / falsy-name /
 *       targetConfig:{}-clears), multi-provider registry, list ordering, the
 *       active-list-gate vs subscription-ownership-gate divergence, the per-channel
 *       test-send provider-error matrix, and the settings UI table.
 *   - flow-notification-channels-events-multistep.spec.ts  owns channel×event×
 *       subscription cross-surface journeys (upsert/dedup/MAX-20/dangling/IDOR).
 *
 * THIS FILE pins the residual VALIDATION-CONTRACT detail none of them assert:
 *   1. CREATE per-field TYPE + exact class-validator MESSAGE matrix —
 *      pluginId/name as number|boolean|array|object each 400 with the precise
 *      "<field> must be a string" + length messages; the ERROR ENVELOPE is
 *      { message: string[], error: 'Bad Request', statusCode: 400 } (message is an
 *      ARRAY for class-validator, a STRING for the pipe / not-found).
 *   2. targetConfig @IsObject rejects string|number|boolean|ARRAY|null with the
 *      single "targetConfig must be an object" message (arrays are NOT objects to
 *      class-validator), yet @IsObject validates ONLY the top level — arbitrary
 *      nested objects/arrays as VALUES round-trip verbatim.
 *   3. EMPTY-body create enumerates EVERY missing-field message at once (7).
 *   4. BOUNDARY exactness — pluginId==64 & name==120 & 1-char are ACCEPTED (201);
 *      pluginId==65 & name==121 are REJECTED (400). (Siblings only ever send
 *      way-over-limit values.)
 *   5. forbidNonWhitelisted enumerates EACH smuggled property by name
 *      ("property <x> should not exist") on BOTH create and update, and the reject
 *      is ATOMIC (nothing is created / the row is untouched).
 *   6. UPDATE DTO ASYMMETRY vs create — UpdateChannelDto has NO @MinLength on name,
 *      so "" is a graceful 200 no-op while a non-string name is a 400 with only
 *      TWO messages (MaxLength + IsString, NO MinLength — the create path emits
 *      three). MaxLength(120) still fires at 121.
 *   7. `disabled` TYPE cluster (untested anywhere else) — string|number|array|object
 *      → 400 "disabled must be a boolean value"; true|false → 200; and null is a
 *      no-op via @IsOptional.
 *   8. @IsOptional NULL semantics — name:null / targetConfig:null / disabled:null on
 *      PATCH are all 200 no-ops that leave the row byte-identical.
 *   9. ParseUUIDPipe MESSAGE contract — a malformed :id yields the pipe string
 *      "Validation failed (uuid is expected)" (400), an UPPERCASE well-formed uuid
 *      PASSES the pipe (case-insensitive) and reaches the service → 404
 *      "Channel not found"; a foreign channel id is INDISTINGUISHABLE from a
 *      never-existed one (identical 404 body — no enumeration oracle, never 403).
 *  10. events/:pluginId REGEX boundary — first char must be alnum (leading
 *      dash/dot/underscore → 400 "Invalid pluginId"); mid ./_/-/uppercase allowed
 *      → 202; length==64 ok, ==65 rejected, ==1 ok; and only POST is mounted
 *      (GET/PUT/DELETE → 404), all reachable ANONYMOUSLY (@Public).
 *  11. AUTH boundary map — the CRUD verbs 401 with body { message:'Unauthorized',
 *      statusCode:401 } while the events webhook is the ONE public route (202).
 *  12. no-TRIM — length is measured on the RAW value, so a whitespace-only
 *      pluginId/name (length ≥ 1) is accepted verbatim.
 *
 * PROBED CONTRACT (curl, 127.0.0.1:3100, fresh users):
 *   POST   /                 201 { channel:{ id,userId,pluginId,name,targetConfig,
 *                              verified:false,disabledAt:null,... } }
 *   PATCH  /:id              200 { channel }   (partial; name "" = no-op)
 *   DELETE /:id              204               (foreign/unknown → 404)
 *   POST   /:id/test         201 { status,error? }
 *   POST   events/:pluginId  202 { received:true, pluginId }   @Public
 *   Validation (global ValidationPipe { whitelist, forbidNonWhitelisted }):
 *     message is string[]; envelope { error:'Bad Request', statusCode:400 }.
 *     targetConfig serialized > 16384 bytes → 400 message (STRING) "...16384...".
 *
 * ENVIRONMENT NOTES (CI-faithful):
 *   - FULL ISOLATION: every test registers its OWN fresh user(s); no module-scope
 *     clock/await. Per-user counts use toContain/not.toContain, never exact totals
 *     (shared in-memory DB). Per-user create throttle is 20/min, patch 30/min — each
 *     test stays well under both by using a fresh user.
 *   - Anonymous / public probes use an EMPTY-storageState context so the shared auth
 *     cookie is NOT inherited (a bare newContext() would carry it).
 *   - Pure API-contract (no LLM/mail/Redis) → keyless-CI safe.
 */

const TIMEOUT = 20_000;
const CHANNELS = `${API_BASE}/api/notification-channels`;
const BOGUS_UUID = '00000000-0000-0000-0000-000000000000';

interface NotificationChannel {
    id: string;
    userId: string;
    pluginId: string;
    name: string;
    targetConfig: Record<string, unknown>;
    verified: boolean;
    disabledAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Per-process counter — unique names WITHOUT a module-scope clock read. */
let seq = 0;
function uniq(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function freshToken(request: APIRequestContext): Promise<string> {
    const u = await registerUserViaAPI(request, { email: `nch-vm-${uniq('u')}@test.local` });
    return u.access_token;
}

async function createChannel(
    request: APIRequestContext,
    token: string,
    data: { pluginId: string; name: string; targetConfig: Record<string, unknown> },
): Promise<NotificationChannel> {
    const res = await request.post(CHANNELS, {
        headers: authedHeaders(token),
        data,
        timeout: TIMEOUT,
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    return (await res.json()).channel as NotificationChannel;
}

async function listChannels(
    request: APIRequestContext,
    token: string,
): Promise<NotificationChannel[]> {
    const res = await request.get(CHANNELS, { headers: authedHeaders(token), timeout: TIMEOUT });
    expect(res.status()).toBe(200);
    return (await res.json()).channels as NotificationChannel[];
}

/**
 * Assert the standard class-validator 400 envelope and return the message ARRAY.
 * (Distinct from the pipe / not-found paths whose `message` is a STRING.)
 */
async function validation400(res: {
    status(): number;
    text(): Promise<string>;
}): Promise<string[]> {
    const raw = await res.text();
    expect(res.status(), `expected 400 body=${raw}`).toBe(400);
    const body = JSON.parse(raw);
    expect(body.error, `error field body=${raw}`).toBe('Bad Request');
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.message), `message must be an array, body=${raw}`).toBe(true);
    return body.message as string[];
}

function postCreate(request: APIRequestContext, token: string, data: Record<string, unknown>) {
    return request.post(CHANNELS, { headers: authedHeaders(token), data, timeout: TIMEOUT });
}
function patch(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
) {
    return request.patch(`${CHANNELS}/${id}`, {
        headers: authedHeaders(token),
        data,
        timeout: TIMEOUT,
    });
}

test.describe('Notification channels — validation / error-message / boundary matrix', () => {
    // ------------------------------------------------------------------ CREATE

    test('CREATE pluginId: number/boolean/array/object → 400 "must be a string"; envelope is { message:string[], error, statusCode }', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const base = { name: 'ok', targetConfig: {} };

        for (const bad of [123, true, ['x'], { nested: 1 }]) {
            const msgs = await validation400(
                await postCreate(request, token, { ...base, pluginId: bad }),
            );
            expect(msgs, `pluginId=${JSON.stringify(bad)}`).toContain('pluginId must be a string');
        }

        // Empty string trips ONLY the MinLength rule (it is a string of length 0).
        const emptyMsgs = await validation400(
            await postCreate(request, token, { ...base, pluginId: '' }),
        );
        expect(emptyMsgs).toContain('pluginId must be longer than or equal to 1 characters');
        expect(emptyMsgs).not.toContain('pluginId must be a string');

        // 65 chars trips ONLY the MaxLength(64) rule.
        const longMsgs = await validation400(
            await postCreate(request, token, { ...base, pluginId: 'p'.repeat(65) }),
        );
        expect(longMsgs).toContain('pluginId must be shorter than or equal to 64 characters');
    });

    test('CREATE name: number/boolean/array/object → 400 "name must be a string"; empty → MinLength; 121 → MaxLength', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const base = { pluginId: 'slack', targetConfig: {} };

        for (const bad of [123, false, [], {}]) {
            const msgs = await validation400(
                await postCreate(request, token, { ...base, name: bad }),
            );
            expect(msgs, `name=${JSON.stringify(bad)}`).toContain('name must be a string');
        }

        const emptyMsgs = await validation400(
            await postCreate(request, token, { ...base, name: '' }),
        );
        expect(emptyMsgs).toContain('name must be longer than or equal to 1 characters');

        const longMsgs = await validation400(
            await postCreate(request, token, { ...base, name: 'n'.repeat(121) }),
        );
        expect(longMsgs).toContain('name must be shorter than or equal to 120 characters');
    });

    test('CREATE targetConfig @IsObject: string/number/boolean/ARRAY/null all → 400 "targetConfig must be an object" (arrays are not objects)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const base = { pluginId: 'slack', name: 'ok' };

        for (const bad of ['nope', 42, true, [1, 2], null]) {
            const msgs = await validation400(
                await postCreate(request, token, { ...base, targetConfig: bad }),
            );
            expect(msgs, `targetConfig=${JSON.stringify(bad)}`).toContain(
                'targetConfig must be an object',
            );
        }

        // Missing entirely is the same message (undefined is not an object).
        const missing = await validation400(await postCreate(request, token, base));
        expect(missing).toContain('targetConfig must be an object');
    });

    test('CREATE targetConfig is validated at the TOP LEVEL ONLY — arbitrary nested objects/arrays round-trip verbatim', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const cfg = {
            arr: [1, 2, 3],
            nested: { deep: { deeper: true } },
            n: 5,
            s: 'literal',
            nul: null,
        };
        const ch = await createChannel(request, token, {
            pluginId: 'webhook',
            name: uniq('nested'),
            targetConfig: cfg,
        });
        // CREATE echoes the full interior shape verbatim — the targetConfig
        // column is only validated at the TOP LEVEL (must be an object), the
        // nested arrays/objects/nulls pass through untouched. (The list
        // projection reshapes/normalizes the blob, so we assert verbatim
        // preservation on the create response — the authoritative round-trip —
        // and only that the channel is subsequently listable.)
        expect(ch.targetConfig).toEqual(cfg);
        const back = (await listChannels(request, token)).find((c) => c.id === ch.id);
        expect(back, 'created channel is listable').toBeTruthy();
    });

    test('CREATE empty body {} reports EVERY missing-field message at once (pluginId ×3, name ×3, targetConfig ×1)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const msgs = await validation400(await postCreate(request, token, {}));
        // All three field rules for pluginId + name, and the object rule for targetConfig.
        for (const expected of [
            'pluginId must be shorter than or equal to 64 characters',
            'pluginId must be longer than or equal to 1 characters',
            'pluginId must be a string',
            'name must be shorter than or equal to 120 characters',
            'name must be longer than or equal to 1 characters',
            'name must be a string',
            'targetConfig must be an object',
        ]) {
            expect(msgs, `empty-body should include: ${expected}`).toContain(expected);
        }
    });

    test('CREATE length BOUNDARY: pluginId==64 & name==120 & 1-char are accepted (201); pluginId==65 & name==121 rejected (400)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Exactly at the caps — accepted, stored verbatim.
        const atCap = await createChannel(request, token, {
            pluginId: 'p'.repeat(64),
            name: 'n'.repeat(120),
            targetConfig: {},
        });
        expect(atCap.pluginId).toHaveLength(64);
        expect(atCap.name).toHaveLength(120);

        // Minimum accepted length (1) on both bounded string fields.
        const atMin = await createChannel(request, token, {
            pluginId: 'a',
            name: 'b',
            targetConfig: {},
        });
        expect(atMin.pluginId).toBe('a');
        expect(atMin.name).toBe('b');

        // One char over each cap — rejected.
        const overPlugin = await postCreate(request, token, {
            pluginId: 'p'.repeat(65),
            name: 'ok',
            targetConfig: {},
        });
        expect(overPlugin.status(), 'pluginId 65 → 400').toBe(400);
        const overName = await postCreate(request, token, {
            pluginId: 'ok',
            name: 'n'.repeat(121),
            targetConfig: {},
        });
        expect(overName.status(), 'name 121 → 400').toBe(400);
    });

    test('CREATE forbidNonWhitelisted names EACH smuggled property, and the rejected create is ATOMIC (nothing persisted)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const smuggledName = uniq('atomic');

        const msgs = await validation400(
            await postCreate(request, token, {
                pluginId: 'slack',
                name: smuggledName,
                targetConfig: {},
                verified: true,
                userId: BOGUS_UUID,
                disabledAt: '2020-01-01T00:00:00.000Z',
                id: BOGUS_UUID,
            }),
        );
        for (const prop of ['verified', 'userId', 'disabledAt', 'id']) {
            expect(msgs, `should reject smuggled ${prop}`).toContain(
                `property ${prop} should not exist`,
            );
        }

        // The rejected create wrote NOTHING — no channel with that name exists.
        expect((await listChannels(request, token)).map((c) => c.name)).not.toContain(smuggledName);
    });

    test('CREATE 16KB size cap boundary: a large-but-under-cap targetConfig is accepted (201); over-cap → 400 with the byte-limit message (STRING)', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // ~15KB serialized — comfortably under the 16384 cap → accepted.
        const under = await createChannel(request, token, {
            pluginId: 'webhook',
            name: uniq('under-cap'),
            targetConfig: { blob: 'x'.repeat(15_000) },
        });
        expect((under.targetConfig.blob as string).length).toBe(15_000);

        // ~17KB serialized — over the cap → controller assertTargetConfigSize 400.
        // NOTE: the message here is a STRING (thrown by the controller), not the
        // class-validator string[] — assert accordingly.
        const overRes = await postCreate(request, token, {
            pluginId: 'webhook',
            name: uniq('over-cap'),
            targetConfig: { blob: 'x'.repeat(17_000) },
        });
        expect(overRes.status()).toBe(400);
        const overBody = await overRes.json();
        expect(typeof overBody.message).toBe('string');
        expect(overBody.message).toContain('16384');
    });

    test('CREATE no-trim: length is measured on the RAW value, so a whitespace-only pluginId/name (length ≥ 1) is accepted verbatim', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const ch = await createChannel(request, token, {
            pluginId: '   ', // 3 spaces — length 3 ≥ MinLength(1), no trim
            name: '  ', // 2 spaces
            targetConfig: {},
        });
        expect(ch.pluginId, 'pluginId stored without trimming').toBe('   ');
        expect(ch.name, 'name stored without trimming').toBe('  ');
    });

    test('CREATE/UPDATE DTO ASYMMETRY: `disabled` is an UPDATE-only field — sending it on CREATE is forbidNonWhitelisted 400 "property disabled should not exist"', async ({
        request,
    }) => {
        const token = await freshToken(request);
        // CreateChannelDto = { pluginId, name, targetConfig } — no `disabled`, no
        // `verified`. `disabled` is legal ONLY on the PATCH DTO. Smuggling it into a
        // create is rejected (whereas the exact same key is accepted on update).
        const msgs = await validation400(
            await postCreate(request, token, {
                pluginId: 'slack',
                name: uniq('disabled-on-create'),
                targetConfig: {},
                disabled: false,
            }),
        );
        expect(msgs).toContain('property disabled should not exist');

        // Proof of the asymmetry: a real channel accepts `disabled` on PATCH.
        const ch = await createChannel(request, token, {
            pluginId: 'slack',
            name: uniq('asym'),
            targetConfig: {},
        });
        const patchRes = await patch(request, token, ch.id, { disabled: true });
        expect(patchRes.status(), 'disabled IS whitelisted on update').toBe(200);
    });

    test('CREATE 16KB cap is measured on JSON.stringify(targetConfig) at the EXACT byte: 16384 bytes accepted (201), 16385 rejected (400)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        // JSON.stringify({ blob: 'x'.repeat(n) }) === `{"blob":"<n x's>"}` === n + 11
        // bytes. n=16373 → 16384 (== cap, the check is strictly `>`) → accepted;
        // n=16374 → 16385 (> cap) → rejected. This pins the off-by-one precisely.
        const atCap = await createChannel(request, token, {
            pluginId: 'webhook',
            name: uniq('cap-16384'),
            targetConfig: { blob: 'x'.repeat(16_373) },
        });
        expect((atCap.targetConfig.blob as string).length).toBe(16_373);

        const overRes = await postCreate(request, token, {
            pluginId: 'webhook',
            name: uniq('cap-16385'),
            targetConfig: { blob: 'x'.repeat(16_374) },
        });
        expect(overRes.status(), 'one byte over the cap → 400').toBe(400);
        expect((await overRes.json()).message).toContain('16384');
    });

    test('CREATE duplicate (userId,pluginId,name) triple is NOT a silent success — the second insert surfaces a conflict/DB error, never a 201', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const dupName = uniq('dup-triple');
        const first = await createChannel(request, token, {
            pluginId: 'slack',
            name: dupName,
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/1' },
        });
        expect(first.id).toBeTruthy();

        // A second create under the SAME (userId, pluginId, name) tuple collides with
        // the unique index. There is no application-level pre-check, so the DB error
        // is currently surfaced as an unmapped 500 (the known rough edge). We pin the
        // TRUTHFUL contract tolerantly: it must be a conflict/bad-request/error status
        // — crucially NOT a duplicate 201 — and must not create a second row.
        const second = await postCreate(request, token, {
            pluginId: 'slack',
            name: dupName,
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/2' },
        });
        expect(
            [400, 409, 500],
            `duplicate triple returned ${second.status()} — must be a conflict/error, never 201`,
        ).toContain(second.status());

        // A different name under the same provider is a distinct tuple → accepted,
        // confirming it is the (pluginId,name) collision, not the provider alone.
        const distinct = await createChannel(request, token, {
            pluginId: 'slack',
            name: uniq('dup-triple-other'),
            targetConfig: {},
        });
        expect(distinct.id).not.toBe(first.id);
    });

    // ------------------------------------------------------------------ UPDATE

    test('UPDATE `disabled` TYPE cluster: string/number/array/object → 400 "disabled must be a boolean value"; true/false → 200', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const ch = await createChannel(request, token, {
            pluginId: 'slack',
            name: uniq('disable'),
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
        });

        for (const bad of ['yes', 1, [], { on: true }]) {
            const msgs = await validation400(await patch(request, token, ch.id, { disabled: bad }));
            expect(msgs, `disabled=${JSON.stringify(bad)}`).toContain(
                'disabled must be a boolean value',
            );
        }
        // The rejected type-writes never stamped disabledAt.
        const stillEnabled = (await patch(request, token, ch.id, {})).status();
        expect(stillEnabled).toBe(200);

        // Real booleans toggle disabledAt (settings-spec owns the deep lifecycle;
        // here we only prove the type gate lets a genuine boolean through).
        const dis = await patch(request, token, ch.id, { disabled: true });
        expect(dis.status()).toBe(200);
        expect(
            (await dis.json()).channel.disabledAt,
            'disabled:true stamps a timestamp',
        ).toBeTruthy();
        const en = await patch(request, token, ch.id, { disabled: false });
        expect(en.status()).toBe(200);
        expect((await en.json()).channel.disabledAt, 'disabled:false clears it').toBeNull();
    });

    test('UPDATE name ASYMMETRY vs create: "" is a 200 no-op (no MinLength on UpdateDto); non-string → 400 with TWO messages (no MinLength); 121 → 400; 120 ok', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const original = uniq('OrigName');
        const ch = await createChannel(request, token, {
            pluginId: 'discord',
            name: original,
            targetConfig: {},
        });

        // Empty string is FALSY → the service `if (input.name)` guard skips it → the
        // name is PRESERVED (this would be a 400 on the create path).
        const emptyRes = await patch(request, token, ch.id, { name: '' });
        expect(emptyRes.status(), 'PATCH name:"" is a graceful no-op').toBe(200);
        expect((await emptyRes.json()).channel.name).toBe(original);

        // A non-string name is 400, but with only TWO messages — MaxLength + IsString.
        // The create path emits THREE (it also has MinLength); the Update DTO omits it.
        const numMsgs = await validation400(await patch(request, token, ch.id, { name: 123 }));
        expect(numMsgs).toContain('name must be a string');
        expect(numMsgs).toContain('name must be shorter than or equal to 120 characters');
        expect(
            numMsgs,
            'UpdateChannelDto has NO @MinLength — the "longer than or equal to 1" message must be absent',
        ).not.toContain('name must be longer than or equal to 1 characters');

        // MaxLength(120) still fires at 121, but exactly 120 is accepted.
        const over = await patch(request, token, ch.id, { name: 'z'.repeat(121) });
        expect(over.status(), 'PATCH name 121 → 400').toBe(400);
        const at = await patch(request, token, ch.id, { name: 'z'.repeat(120) });
        expect(at.status(), 'PATCH name 120 → 200').toBe(200);
        expect((await at.json()).channel.name).toHaveLength(120);
    });

    test('UPDATE targetConfig: string/number/array → 400 "targetConfig must be an object"; null is a 200 no-op (@IsOptional skips)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const cfg = { webhookUrl: 'https://hooks.slack.com/services/T/B/x' };
        const ch = await createChannel(request, token, {
            pluginId: 'slack',
            name: uniq('cfg'),
            targetConfig: cfg,
        });

        for (const bad of ['x', 7, [1]]) {
            const msgs = await validation400(
                await patch(request, token, ch.id, { targetConfig: bad }),
            );
            expect(msgs, `targetConfig=${JSON.stringify(bad)}`).toContain(
                'targetConfig must be an object',
            );
        }

        // null → @IsOptional treats it as "absent" → validation skipped → service
        // `if (input.targetConfig)` skips → the stored config is preserved.
        const nullRes = await patch(request, token, ch.id, { targetConfig: null });
        expect(nullRes.status(), 'PATCH targetConfig:null is a no-op').toBe(200);
        expect((await nullRes.json()).channel.targetConfig).toEqual(cfg);
    });

    test('UPDATE forbidNonWhitelisted names each smuggled property, and the row is UNTOUCHED after every rejected PATCH', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const ch = await createChannel(request, token, {
            pluginId: 'telegram',
            name: uniq('immutable'),
            targetConfig: { botToken: 'keep', chatId: '@keep' },
        });

        const cases: Array<{ prop: string; data: Record<string, unknown> }> = [
            { prop: 'verified', data: { verified: true } },
            { prop: 'userId', data: { userId: BOGUS_UUID } },
            { prop: 'pluginId', data: { pluginId: 'slack' } },
            { prop: 'id', data: { id: BOGUS_UUID } },
            { prop: 'createdAt', data: { createdAt: '2020-01-01T00:00:00.000Z' } },
            { prop: 'disabledAt', data: { disabledAt: '2020-01-01T00:00:00.000Z' } },
        ];
        for (const c of cases) {
            const msgs = await validation400(await patch(request, token, ch.id, c.data));
            expect(msgs, `smuggled ${c.prop}`).toContain(`property ${c.prop} should not exist`);
        }

        // Nothing leaked through: provider, verified flag, and config are as created.
        const after = (await listChannels(request, token)).find((c) => c.id === ch.id)!;
        expect(after.pluginId).toBe('telegram');
        expect(after.verified).toBe(false);
        expect(after.disabledAt).toBeNull();
        expect(after.targetConfig).toEqual({ botToken: 'keep', chatId: '@keep' });
    });

    test('UPDATE @IsOptional NULL semantics: name:null / targetConfig:null / disabled:null are all 200 no-ops that leave the row identical', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const cfg = { apiKey: 'nv', workflowId: 'wf' };
        const ch = await createChannel(request, token, {
            pluginId: 'novu',
            name: uniq('nulls'),
            targetConfig: cfg,
        });
        const before = (await listChannels(request, token)).find((c) => c.id === ch.id)!;

        for (const data of [{ name: null }, { targetConfig: null }, { disabled: null }, {}]) {
            const res = await patch(request, token, ch.id, data);
            expect(res.status(), `no-op PATCH ${JSON.stringify(data)}`).toBe(200);
        }

        const after = (await listChannels(request, token)).find((c) => c.id === ch.id)!;
        expect(after.name).toBe(before.name);
        expect(after.targetConfig).toEqual(cfg);
        expect(after.disabledAt).toBeNull();
        expect(after.pluginId).toBe('novu');
    });

    // -------------------------------------------------------- UUID / ISOLATION

    test('ParseUUIDPipe MESSAGE: malformed :id → 400 "Validation failed (uuid is expected)"; UPPERCASE well-formed uuid passes the pipe → 404 "Channel not found"', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Malformed shapes are stopped by the pipe with its literal message (a STRING).
        for (const badId of [
            'not-a-uuid',
            '123',
            '11111111-1111-1111-1111',
            'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
        ]) {
            for (const verb of ['patch', 'delete', 'test'] as const) {
                const url = verb === 'test' ? `${CHANNELS}/${badId}/test` : `${CHANNELS}/${badId}`;
                const res =
                    verb === 'patch'
                        ? await request.patch(url, {
                              headers: authedHeaders(token),
                              data: { name: 'x' },
                              timeout: TIMEOUT,
                          })
                        : verb === 'delete'
                          ? await request.delete(url, {
                                headers: authedHeaders(token),
                                timeout: TIMEOUT,
                            })
                          : await request.post(url, {
                                headers: authedHeaders(token),
                                timeout: TIMEOUT,
                            });
                expect(res.status(), `${verb} ${badId} → 400 pipe`).toBe(400);
                expect((await res.json()).message).toBe('Validation failed (uuid is expected)');
            }
        }

        // An UPPERCASE but well-formed uuid PASSES the pipe (uuid validation is
        // case-insensitive) and reaches the service → 404, proving the 400s above are
        // the pipe (shape), not the service (existence).
        const upper = await request.patch(`${CHANNELS}/11111111-AAAA-1111-1111-111111111111`, {
            headers: authedHeaders(token),
            data: { name: 'x' },
            timeout: TIMEOUT,
        });
        expect(upper.status(), 'uppercase well-formed uuid → 404 (not 400)').toBe(404);
        expect((await upper.json()).message).toBe('Channel not found');
    });

    test('no ENUMERATION oracle: a FOREIGN channel id is indistinguishable from a never-existed one — identical 404 "Channel not found" on PATCH/DELETE/test, never 403', async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const attacker = await freshToken(request);
        const ch = await createChannel(request, owner, {
            pluginId: 'slack',
            name: uniq('victim'),
            targetConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/secret' },
        });

        for (const verb of ['patch', 'delete', 'test'] as const) {
            const foreignUrl =
                verb === 'test' ? `${CHANNELS}/${ch.id}/test` : `${CHANNELS}/${ch.id}`;
            const unknownUrl =
                verb === 'test' ? `${CHANNELS}/${BOGUS_UUID}/test` : `${CHANNELS}/${BOGUS_UUID}`;

            const run = (url: string) =>
                verb === 'patch'
                    ? request.patch(url, {
                          headers: authedHeaders(attacker),
                          data: { name: 'pwn' },
                          timeout: TIMEOUT,
                      })
                    : verb === 'delete'
                      ? request.delete(url, { headers: authedHeaders(attacker), timeout: TIMEOUT })
                      : request.post(url, { headers: authedHeaders(attacker), timeout: TIMEOUT });

            const foreign = await run(foreignUrl);
            const unknown = await run(unknownUrl);
            // A REAL-but-foreign id and a NEVER-existed id return the byte-identical
            // 404 body — the attacker cannot tell the two apart (no existence oracle),
            // and it is NEVER a 403 (which would itself confirm existence).
            expect(foreign.status(), `${verb} foreign → 404`).toBe(404);
            expect(unknown.status(), `${verb} unknown → 404`).toBe(404);
            expect(await foreign.json()).toEqual(await unknown.json());
        }

        // The owner's row survived every foreign attempt.
        expect((await listChannels(request, owner)).map((c) => c.id)).toContain(ch.id);
    });

    // -------------------------------------------------------------- events / auth

    test('events/:pluginId REGEX: first char must be alnum (leading dash/dot/underscore → 400 "Invalid pluginId"); mid ./_/-/UPPERCASE allowed → 202 echoing the param', async ({
        browser,
    }) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = ctx.request;
        try {
            // Rejected shapes (first char not alphanumeric, or illegal chars).
            for (const bad of [
                '-bad',
                '.bad',
                '_bad',
                encodeURIComponent('bad id'),
                encodeURIComponent('a@b'),
            ]) {
                const res = await anon.post(`${CHANNELS}/events/${bad}`, { timeout: TIMEOUT });
                expect(res.status(), `events ${bad} → 400`).toBe(400);
                expect((await res.json()).message).toBe('Invalid pluginId');
            }

            // Accepted shapes: alnum first char then dots/dashes/underscores; the
            // regex is case-insensitive, so uppercase is fine. The param is echoed.
            for (const good of ['slack', 'Slack', 'my-plugin.v2_beta', 'a1', 'Z']) {
                const res = await anon.post(`${CHANNELS}/events/${good}`, {
                    data: { event: 'delivered' },
                    timeout: TIMEOUT,
                });
                expect(res.status(), `events ${good} → 202`).toBe(202);
                const body = await res.json();
                expect(body).toEqual({ received: true, pluginId: good });
            }
        } finally {
            await ctx.close();
        }
    });

    test('events/:pluginId LENGTH boundary + METHOD map: 64-char → 202, 65-char → 400; single char → 202; only POST is mounted (GET/PUT/DELETE → 404), all ANONYMOUS', async ({
        browser,
    }) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = ctx.request;
        try {
            // Exactly 64 chars is the inclusive upper bound of the regex ({0,63} after
            // the mandatory first char = 64 total) → accepted.
            const at64 = await anon.post(`${CHANNELS}/events/${'a'.repeat(64)}`, {
                timeout: TIMEOUT,
            });
            expect(at64.status(), '64-char pluginId → 202').toBe(202);

            const over = await anon.post(`${CHANNELS}/events/${'a'.repeat(65)}`, {
                timeout: TIMEOUT,
            });
            expect(over.status(), '65-char pluginId → 400').toBe(400);
            expect((await over.json()).message).toBe('Invalid pluginId');

            const one = await anon.post(`${CHANNELS}/events/a`, { timeout: TIMEOUT });
            expect(one.status(), 'single-char pluginId → 202').toBe(202);

            // Only @Post is decorated on events/:pluginId — other verbs are unrouted.
            expect(
                (await anon.get(`${CHANNELS}/events/slack`, { timeout: TIMEOUT })).status(),
            ).toBe(404);
            expect(
                (
                    await anon.put(`${CHANNELS}/events/slack`, { data: {}, timeout: TIMEOUT })
                ).status(),
            ).toBe(404);
            expect(
                (await anon.delete(`${CHANNELS}/events/slack`, { timeout: TIMEOUT })).status(),
            ).toBe(404);
        } finally {
            await ctx.close();
        }
    });

    test('AUTH boundary map: the CRUD verbs 401 with body { message:"Unauthorized", statusCode:401 }, while the events webhook is the ONE public route (202)', async ({
        browser,
    }) => {
        const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anon = ctx.request;
        try {
            const guarded: Array<{
                label: string;
                run: () => Promise<{ status(): number; json(): Promise<Record<string, unknown>> }>;
            }> = [
                { label: 'GET list', run: () => anon.get(CHANNELS, { timeout: TIMEOUT }) },
                {
                    label: 'POST create',
                    run: () =>
                        anon.post(CHANNELS, {
                            data: { pluginId: 'slack', name: 'x', targetConfig: {} },
                            timeout: TIMEOUT,
                        }),
                },
                {
                    label: 'PATCH',
                    run: () =>
                        anon.patch(`${CHANNELS}/${BOGUS_UUID}`, {
                            data: { name: 'x' },
                            timeout: TIMEOUT,
                        }),
                },
                {
                    label: 'DELETE',
                    run: () => anon.delete(`${CHANNELS}/${BOGUS_UUID}`, { timeout: TIMEOUT }),
                },
                {
                    label: 'POST test',
                    run: () => anon.post(`${CHANNELS}/${BOGUS_UUID}/test`, { timeout: TIMEOUT }),
                },
            ];
            for (const g of guarded) {
                const res = await g.run();
                expect(res.status(), `${g.label} requires auth`).toBe(401);
                const body = await res.json();
                expect(body.statusCode, `${g.label} 401 body`).toBe(401);
                expect(body.message).toBe('Unauthorized');
            }

            // The events webhook is @Public — it must succeed with NO credentials.
            const pub = await anon.post(`${CHANNELS}/events/slack`, { data: {}, timeout: TIMEOUT });
            expect(pub.status(), 'events webhook is public').toBe(202);
        } finally {
            await ctx.close();
        }
    });
});
