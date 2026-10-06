import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

let server;
let base;
// Mutable clock so check-in due dates can be tested.
let clock = new Date('2026-10-06T09:00:00Z');

// Runs against in-memory SQLite by default. Set TEST_DATABASE_URL to run the
// same suite against Postgres (its tables are dropped first!).
const pgUrl = process.env.TEST_DATABASE_URL;
let db;

before(async () => {
  if (pgUrl) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: pgUrl });
    await client.connect();
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.end();
  }
  db = await openDatabase({ url: pgUrl });
  const app = createApp(db, { now: () => clock });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
});

/** Minimal cookie-keeping client, one per simulated user. */
function client() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

async function signup(username, timezone = 'UTC') {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { username, password: 'correct horse', timezone });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { c, user: r.body.user };
}

async function pair(a, b) {
  const req = await a.c('POST', '/api/partnerships', { username: b.user.username });
  assert.equal(req.status, 201);
  const acc = await b.c('POST', `/api/partnerships/${req.body.partnership.id}/accept`);
  assert.equal(acc.status, 200);
  return req.body.partnership.id;
}

test('signup, login, logout and validation', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/me')).status, 401);
  assert.equal(
    (await anon('POST', '/api/auth/signup', { username: 'x', password: 'correct horse' })).status,
    400,
  );
  assert.equal(
    (await anon('POST', '/api/auth/signup', { username: 'ok_name', password: 'short' })).status,
    400,
  );
  assert.equal(
    (await anon('POST', '/api/auth/signup', { username: 'ok_name', password: 'long enough', timezone: 'Mars/Base' }))
      .status,
    400,
  );

  const { c } = await signup('alice', 'Asia/Kolkata');
  const me = await c('GET', '/api/me');
  assert.equal(me.body.user.username, 'alice');
  assert.equal(me.body.user.timezone, 'Asia/Kolkata');
  assert.equal(me.body.today, '2026-10-06');

  assert.equal((await client()('POST', '/api/auth/signup', { username: 'ALICE', password: 'whatever123' })).status, 409);

  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'alice', password: 'nope nope' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'alice', password: 'correct horse' })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);
});

test('state-changing requests must be JSON', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=a&password=b',
  });
  assert.equal(res.status, 415);
});

test('partner requests: send, accept, decline, mutual and privacy', async () => {
  const bob = await signup('bob', 'America/New_York');
  const cara = await signup('cara', 'Europe/Berlin');
  const dan = await signup('dan', 'Australia/Sydney');

  assert.equal((await bob.c('POST', '/api/partnerships', { username: 'bob' })).status, 400);
  assert.equal((await bob.c('POST', '/api/partnerships', { username: 'nobody' })).status, 404);

  const sent = await bob.c('POST', '/api/partnerships', { username: 'cara' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.partnership.direction, 'outgoing');
  assert.equal((await bob.c('POST', '/api/partnerships', { username: 'cara' })).status, 409);

  const caraList = await cara.c('GET', '/api/partnerships');
  assert.equal(caraList.body.partnerships[0].direction, 'incoming');
  assert.equal(caraList.body.partnerships[0].partner.username, 'bob');

  // Pending partner data is private.
  const pid = sent.body.partnership.id;
  assert.equal((await bob.c('GET', `/api/partnerships/${pid}/goals`)).status, 409);
  // Only the addressee may accept.
  assert.equal((await bob.c('POST', `/api/partnerships/${pid}/accept`)).status, 409);
  // Outsiders can't see it at all.
  assert.equal((await dan.c('GET', `/api/partnerships/${pid}`)).status, 404);

  // Requesting someone who already requested you accepts their request.
  const mutual = await cara.c('POST', '/api/partnerships', { username: 'bob' });
  assert.equal(mutual.status, 200);
  assert.equal(mutual.body.partnership.status, 'active');

  // Declining
  const toDan = await bob.c('POST', '/api/partnerships', { username: 'dan' });
  assert.equal((await dan.c('DELETE', `/api/partnerships/${toDan.body.partnership.id}`)).status, 200);
  assert.equal((await bob.c('GET', '/api/partnerships')).body.partnerships.length, 1);

  // Ending an active partnership hides the partner's data again.
  assert.equal((await bob.c('DELETE', `/api/partnerships/${pid}`)).status, 200);
  assert.equal((await cara.c('GET', `/api/partnerships/${pid}/tasks`)).status, 409);
});

test('goals for this/next week and month, visible to partner', async () => {
  const erin = await signup('erin', 'Pacific/Auckland');
  const finn = await signup('finn', 'America/Los_Angeles');
  const pid = await pair(erin, finn);

  // 2026-10-06T09:00Z is Tuesday 6 Oct evening in Auckland.
  const g1 = await erin.c('POST', '/api/goals', { title: 'Run 3 times', horizon: 'week' });
  assert.equal(g1.status, 201);
  assert.equal(g1.body.goal.periodStart, '2026-10-05');
  assert.equal(g1.body.goal.periodEnd, '2026-10-11');

  const g2 = await erin.c('POST', '/api/goals', { title: 'Ship v1', horizon: 'month', when: 'next' });
  assert.equal(g2.body.goal.periodStart, '2026-11-01');
  assert.equal(g2.body.goal.periodEnd, '2026-11-30');

  assert.equal((await erin.c('POST', '/api/goals', { title: 'x', horizon: 'year' })).status, 400);

  const done = await erin.c('PATCH', `/api/goals/${g1.body.goal.id}`, { status: 'done' });
  assert.equal(done.body.goal.progress, 100);

  // Finn can see Erin's goals, but can't edit them.
  const seen = await finn.c('GET', `/api/partnerships/${pid}/goals`);
  assert.deepEqual(seen.body.goals.map((g) => g.title).sort(), ['Run 3 times', 'Ship v1']);
  assert.equal((await finn.c('PATCH', `/api/goals/${g1.body.goal.id}`, { title: 'hacked' })).status, 404);
  assert.equal((await finn.c('DELETE', `/api/goals/${g1.body.goal.id}`)).status, 404);
});

test('daily tasks use each user’s own calendar day', async () => {
  const gus = await signup('gus', 'Pacific/Kiritimati'); // UTC+14
  const hal = await signup('hal', 'Pacific/Pago_Pago'); // UTC-11
  const pid = await pair(gus, hal);

  clock = new Date('2026-10-06T12:00:00Z');
  const t = await gus.c('POST', '/api/tasks', { title: 'Write 500 words' });
  assert.equal(t.body.task.day, '2026-10-07');
  await gus.c('POST', '/api/tasks', { title: 'Pick a gym', kind: 'decision' });
  await hal.c('POST', '/api/tasks', { title: 'Call mum' });

  const halView = await hal.c('GET', `/api/partnerships/${pid}/tasks`);
  assert.equal(halView.body.today, '2026-10-07');
  assert.equal(halView.body.tasks.length, 2);
  assert.equal((await hal.c('GET', '/api/tasks')).body.today, '2026-10-06');

  const toggled = await gus.c('PATCH', `/api/tasks/${t.body.task.id}`, { done: true });
  assert.equal(toggled.body.task.done, true);
  assert.ok(toggled.body.task.doneAt);
  assert.equal((await hal.c('PATCH', `/api/tasks/${t.body.task.id}`, { done: false })).status, 404);

  // Next day: carry over the unfinished decision only.
  clock = new Date('2026-10-07T12:00:00Z');
  const carried = await gus.c('POST', '/api/tasks/carry-over');
  assert.equal(carried.body.from, '2026-10-07');
  assert.equal(carried.body.copied, 1);
  assert.deepEqual(carried.body.tasks.map((x) => x.title), ['Pick a gym']);
  // Running it again doesn't duplicate.
  assert.equal((await gus.c('POST', '/api/tasks/carry-over')).body.copied, 0);

  assert.equal((await gus.c('GET', '/api/tasks?day=2026-02-30')).status, 400);
  clock = new Date('2026-10-06T09:00:00Z');
});

test('check-ins come due on the agreed interval; messages are shared', async () => {
  const ivy = await signup('ivy');
  const jo = await signup('joey');
  const pid = await pair(ivy, jo);

  let p = (await ivy.c('GET', `/api/partnerships/${pid}`)).body.partnership;
  assert.equal(p.checkins.me.isDue, true);

  assert.equal((await ivy.c('PATCH', `/api/partnerships/${pid}`, { checkinIntervalDays: 0 })).status, 400);
  p = (await ivy.c('PATCH', `/api/partnerships/${pid}`, { checkinIntervalDays: 3 })).body.partnership;
  assert.equal(p.checkinIntervalDays, 3);

  assert.equal((await ivy.c('POST', `/api/partnerships/${pid}/checkins`, { mood: 4 })).status, 400);
  const ci = await ivy.c('POST', `/api/partnerships/${pid}/checkins`, {
    mood: 4,
    wins: 'Ran twice',
    struggles: 'Slept late',
    nextFocus: 'Bed by 11',
  });
  assert.equal(ci.status, 201);

  p = (await jo.c('GET', `/api/partnerships/${pid}`)).body.partnership;
  assert.equal(p.checkins.partner.isDue, false);
  assert.equal(p.checkins.partner.dueAt, '2026-10-09T09:00:00.000Z');
  assert.equal(p.checkins.me.isDue, true);

  clock = new Date('2026-10-09T09:00:01Z');
  p = (await jo.c('GET', `/api/partnerships/${pid}`)).body.partnership;
  assert.equal(p.checkins.partner.isDue, true);
  clock = new Date('2026-10-06T09:00:00Z');

  const list = await jo.c('GET', `/api/partnerships/${pid}/checkins`);
  assert.equal(list.body.checkins[0].wins, 'Ran twice');

  const m1 = await jo.c('POST', `/api/partnerships/${pid}/messages`, { body: 'Proud of you!' });
  assert.equal(m1.status, 201);
  await ivy.c('POST', `/api/partnerships/${pid}/messages`, { body: 'Thanks <3' });
  const all = await ivy.c('GET', `/api/partnerships/${pid}/messages`);
  assert.deepEqual(all.body.messages.map((m) => m.body), ['Proud of you!', 'Thanks <3']);
  const newer = await ivy.c('GET', `/api/partnerships/${pid}/messages?after=${m1.body.message.id}`);
  assert.equal(newer.body.messages.length, 1);

  const outsider = await signup('kim');
  assert.equal((await outsider.c('GET', `/api/partnerships/${pid}/messages`)).status, 404);
  assert.equal((await outsider.c('POST', `/api/partnerships/${pid}/checkins`, { mood: 3, wins: 'x' })).status, 404);
});
