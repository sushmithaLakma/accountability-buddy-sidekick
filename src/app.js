import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  parseCookies,
} from './auth.js';
import {
  isValidTimezone,
  isValidDay,
  todayIn,
  addDays,
  addMonths,
  periodStart,
  periodEnd,
  weekStart,
  monthStart,
} from './dates.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

// ---------- input validation ----------

function text(body, field, { required = false, max = 500, fallback = '' } = {}) {
  const value = body?.[field];
  if (value === undefined || value === null) {
    if (required) fail(400, `${field} is required`);
    return fallback;
  }
  if (typeof value !== 'string') fail(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) fail(400, `${field} is required`);
  if (trimmed.length > max) fail(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

function int(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(400, `${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function oneOf(value, field, options) {
  if (!options.includes(value)) fail(400, `${field} must be one of: ${options.join(', ')}`);
  return value;
}

function idParam(req, name = 'id') {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) fail(404, 'Not found');
  return id;
}

// ---------- serializers ----------

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  timezone: u.timezone,
});

const goalOut = (g) => ({
  id: g.id,
  userId: g.user_id,
  title: g.title,
  details: g.details,
  horizon: g.horizon,
  periodStart: g.period_start,
  periodEnd: periodEnd(g.horizon, g.period_start),
  status: g.status,
  progress: g.progress,
  createdAt: g.created_at,
  updatedAt: g.updated_at,
});

const taskOut = (t) => ({
  id: t.id,
  userId: t.user_id,
  day: t.day,
  title: t.title,
  kind: t.kind,
  goalId: t.goal_id,
  done: Boolean(t.done),
  createdAt: t.created_at,
  doneAt: t.done_at,
});

const checkinOut = (c) => ({
  id: c.id,
  userId: c.user_id,
  mood: c.mood,
  wins: c.wins,
  struggles: c.struggles,
  nextFocus: c.next_focus,
  createdAt: c.created_at,
});

const messageOut = (m) => ({
  id: m.id,
  userId: m.user_id,
  body: m.body,
  createdAt: m.created_at,
});

/**
 * In-memory limiter for failed logins, keyed by IP + username. Good enough for
 * a single-process deployment; use a shared store if you run several.
 */
function createLoginLimiter({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const key = (ip, username) => `${ip}|${String(username).toLowerCase()}`;
  return {
    isBlocked(ip, username) {
      const entry = failures.get(key(ip, username));
      if (!entry) return false;
      if (Date.now() - entry.first > windowMs) {
        failures.delete(key(ip, username));
        return false;
      }
      return entry.count >= maxFailures;
    },
    fail(ip, username) {
      const k = key(ip, username);
      const entry = failures.get(k);
      if (!entry || Date.now() - entry.first > windowMs) failures.set(k, { first: Date.now(), count: 1 });
      else entry.count += 1;
    },
    reset(ip, username) {
      failures.delete(key(ip, username));
    },
  };
}


// All SQL lives here, written in the dialect shared by SQLite and Postgres.
const SQL = {
  userById: 'SELECT * FROM users WHERE id = ?',
  userByName: 'SELECT * FROM users WHERE lower(username) = lower(?)',
  insertUser: `INSERT INTO users (username, display_name, password_hash, timezone, created_at)
               VALUES (?, ?, ?, ?, ?) RETURNING id`,
  updateUser: 'UPDATE users SET display_name = ?, timezone = ? WHERE id = ?',

  insertSession: 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  sessionUser: `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ?`,
  deleteSession: 'DELETE FROM sessions WHERE token_hash = ?',
  purgeSessions: 'DELETE FROM sessions WHERE expires_at <= ?',

  partnershipById: 'SELECT * FROM partnerships WHERE id = ?',
  partnershipsForUser: `SELECT * FROM partnerships
                        WHERE (requester_id = ? OR addressee_id = ?) AND status IN ('pending', 'active')
                        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
  openPartnershipBetween: `SELECT * FROM partnerships
                           WHERE status IN ('pending', 'active')
                             AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
  insertPartnership: `INSERT INTO partnerships (requester_id, addressee_id, created_at)
                      VALUES (?, ?, ?) RETURNING id`,
  setPartnershipStatus: 'UPDATE partnerships SET status = ? WHERE id = ?',
  acceptPartnership: "UPDATE partnerships SET status = 'active', accepted_at = ? WHERE id = ?",
  deletePartnership: 'DELETE FROM partnerships WHERE id = ?',
  setInterval: 'UPDATE partnerships SET checkin_interval_days = ? WHERE id = ?',

  goalById: 'SELECT * FROM goals WHERE id = ?',
  currentGoals: `SELECT * FROM goals
                 WHERE user_id = ?
                   AND ((horizon = 'week' AND period_start >= ?) OR (horizon = 'month' AND period_start >= ?))
                 ORDER BY period_start, horizon DESC, CASE status WHEN 'active' THEN 0 ELSE 1 END, id`,
  pastGoals: `SELECT * FROM goals
              WHERE user_id = ?
                AND ((horizon = 'week' AND period_start < ?) OR (horizon = 'month' AND period_start < ?))
              ORDER BY period_start DESC, id DESC LIMIT 100`,
  insertGoal: `INSERT INTO goals (user_id, title, details, horizon, period_start, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  updateGoal: 'UPDATE goals SET title = ?, details = ?, status = ?, progress = ?, updated_at = ? WHERE id = ?',
  deleteGoal: 'DELETE FROM goals WHERE id = ?',

  taskById: 'SELECT * FROM tasks WHERE id = ?',
  tasksForDay: 'SELECT * FROM tasks WHERE user_id = ? AND day = ? ORDER BY done, id',
  insertTask: `INSERT INTO tasks (user_id, day, title, kind, goal_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  updateTask: 'UPDATE tasks SET title = ?, done = ?, done_at = ? WHERE id = ?',
  deleteTask: 'DELETE FROM tasks WHERE id = ?',
  openTasksForDay: 'SELECT * FROM tasks WHERE user_id = ? AND day = ? AND done = 0 ORDER BY id',
  taskExists: 'SELECT 1 AS found FROM tasks WHERE user_id = ? AND day = ? AND title = ?',
  lastDayWithOpenTasks: 'SELECT MAX(day) AS day FROM tasks WHERE user_id = ? AND day < ? AND done = 0',

  lastCheckin: 'SELECT MAX(created_at) AS at FROM checkins WHERE partnership_id = ? AND user_id = ?',
  checkins: 'SELECT * FROM checkins WHERE partnership_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  insertCheckin: `INSERT INTO checkins (partnership_id, user_id, mood, wins, struggles, next_focus, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  checkinById: 'SELECT * FROM checkins WHERE id = ?',

  messagesAfter: 'SELECT * FROM messages WHERE partnership_id = ? AND id > ? ORDER BY id LIMIT 200',
  latestMessages: `SELECT * FROM (SELECT * FROM messages WHERE partnership_id = ? ORDER BY id DESC LIMIT 100) AS recent
                   ORDER BY id`,
  insertMessage: 'INSERT INTO messages (partnership_id, user_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  messageById: 'SELECT * FROM messages WHERE id = ?',
};

const isUniqueViolation = (err) => err?.code === '23505' || /UNIQUE constraint failed/.test(err?.message ?? '');

export function createApp(db, { secureCookies = false, now = () => new Date() } = {}) {
  const app = express();
  const limiter = createLoginLimiter();

  // ---------- domain helpers ----------

  const nowIso = () => now().toISOString();
  const userToday = (user) => todayIn(user.timezone, now());
  const insertId = async (sql, params) => Number((await db.get(sql, params)).id);

  async function checkinStatus(p, userId) {
    const last = (await db.get(SQL.lastCheckin, [p.id, userId]))?.at ?? null;
    const dueAt = last
      ? new Date(new Date(last).getTime() + p.checkin_interval_days * DAY_MS).toISOString()
      : null;
    return { lastAt: last, dueAt, isDue: !last || new Date(dueAt) <= now() };
  }

  async function partnershipOut(p, me) {
    const partnerId = p.requester_id === me.id ? p.addressee_id : p.requester_id;
    const out = {
      id: p.id,
      status: p.status,
      direction: p.requester_id === me.id ? 'outgoing' : 'incoming',
      partner: publicUser(await db.get(SQL.userById, [partnerId])),
      checkinIntervalDays: p.checkin_interval_days,
      createdAt: p.created_at,
      acceptedAt: p.accepted_at,
    };
    if (p.status === 'active') {
      out.checkins = { me: await checkinStatus(p, me.id), partner: await checkinStatus(p, partnerId) };
    }
    return out;
  }

  const partnershipById = async (id, me) => partnershipOut(await db.get(SQL.partnershipById, [id]), me);

  /** Loads a partnership the current user belongs to, or 404s. */
  async function loadPartnership(req, { active = true } = {}) {
    const p = await db.get(SQL.partnershipById, [idParam(req)]);
    const me = req.user.id;
    if (!p || (p.requester_id !== me && p.addressee_id !== me)) fail(404, 'Partnership not found');
    if (active && p.status !== 'active') fail(409, 'This partnership is not active');
    const partner = await db.get(SQL.userById, [p.requester_id === me ? p.addressee_id : p.requester_id]);
    return { p, partner };
  }

  async function ownGoal(req) {
    const g = await db.get(SQL.goalById, [idParam(req)]);
    if (!g || g.user_id !== req.user.id) fail(404, 'Goal not found');
    return g;
  }

  async function ownTask(req) {
    const t = await db.get(SQL.taskById, [idParam(req)]);
    if (!t || t.user_id !== req.user.id) fail(404, 'Task not found');
    return t;
  }

  async function goalsFor(user, scope) {
    const today = userToday(user);
    const args = [user.id, weekStart(today), monthStart(today)];
    const rows = await db.all(scope === 'past' ? SQL.pastGoals : SQL.currentGoals, args);
    return rows.map(goalOut);
  }

  async function tasksFor(user, dayParam) {
    const today = userToday(user);
    const day = dayParam === undefined ? today : dayParam;
    if (!isValidDay(day)) fail(400, 'day must be a date in YYYY-MM-DD format');
    return { day, today, tasks: (await db.all(SQL.tasksForDay, [user.id, day])).map(taskOut) };
  }

  // ---------- middleware ----------

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });
  app.use(express.static(PUBLIC_DIR));

  // For hosting platforms' health checks.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '32kb' }));

  // Requiring a JSON body on every state-changing request means a cross-site
  // HTML form can't forge one (browsers preflight JSON), on top of SameSite.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Requests must send Content-Type: application/json'));
    }
    next();
  });

  app.use('/api', async (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.sessionTokenHash = token ? hashToken(token) : null;
    req.user = token ? ((await db.get(SQL.sessionUser, [req.sessionTokenHash, nowIso()])) ?? null) : null;
    next();
  });

  const requireUser = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    next();
  };

  async function startSession(res, userId) {
    await db.run(SQL.purgeSessions, [nowIso()]);
    const token = newSessionToken();
    const expires = new Date(now().getTime() + SESSION_TTL_DAYS * DAY_MS);
    await db.run(SQL.insertSession, [hashToken(token), userId, expires.toISOString()]);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
      expires,
    });
  }

  // ---------- auth ----------

  app.post('/api/auth/signup', async (req, res) => {
    const username = text(req.body, 'username', { required: true, max: 30 });
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
      fail(400, 'username must be 3–30 characters: letters, numbers, dot, dash or underscore');
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      fail(400, 'password must be 8–200 characters');
    }
    const displayName = text(req.body, 'displayName', { max: 60 }) || username;
    const timezone = text(req.body, 'timezone', { max: 64 }) || 'UTC';
    if (!isValidTimezone(timezone)) fail(400, 'timezone is not a recognised IANA timezone');
    if (await db.get(SQL.userByName, [username])) fail(409, 'That username is taken');

    const hash = await hashPassword(password);
    let id;
    try {
      id = await insertId(SQL.insertUser, [username, displayName, hash, timezone, nowIso()]);
    } catch (err) {
      // Lost a race with a concurrent signup for the same name.
      if (isUniqueViolation(err)) fail(409, 'That username is taken');
      throw err;
    }
    await startSession(res, id);
    res.status(201).json({ user: publicUser(await db.get(SQL.userById, [id])) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const username = text(req.body, 'username', { required: true, max: 30 });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (limiter.isBlocked(req.ip, username)) fail(429, 'Too many failed attempts. Try again later.');
    const user = await db.get(SQL.userByName, [username]);
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!ok) {
      limiter.fail(req.ip, username);
      fail(401, 'Wrong username or password');
    }
    limiter.reset(req.ip, username);
    await startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.sessionTokenHash) await db.run(SQL.deleteSession, [req.sessionTokenHash]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: publicUser(req.user), today: userToday(req.user) });
  });

  app.patch('/api/me', requireUser, async (req, res) => {
    const displayName = text(req.body, 'displayName', { max: 60 }) || req.user.display_name;
    const timezone = text(req.body, 'timezone', { max: 64 }) || req.user.timezone;
    if (!isValidTimezone(timezone)) fail(400, 'timezone is not a recognised IANA timezone');
    await db.run(SQL.updateUser, [displayName, timezone, req.user.id]);
    const user = await db.get(SQL.userById, [req.user.id]);
    res.json({ user: publicUser(user), today: userToday(user) });
  });

  // ---------- partnerships ----------

  app.get('/api/partnerships', requireUser, async (req, res) => {
    const rows = await db.all(SQL.partnershipsForUser, [req.user.id, req.user.id]);
    const partnerships = [];
    for (const p of rows) partnerships.push(await partnershipOut(p, req.user));
    res.json({ partnerships });
  });

  app.post('/api/partnerships', requireUser, async (req, res) => {
    const username = text(req.body, 'username', { required: true, max: 30 });
    const other = await db.get(SQL.userByName, [username]);
    if (!other) fail(404, `No user called "${username}"`);
    if (other.id === req.user.id) fail(400, "You can't partner with yourself");

    const existing = await db.get(SQL.openPartnershipBetween, [req.user.id, other.id, other.id, req.user.id]);
    if (existing) {
      // They already asked us: treat our request as accepting theirs.
      if (existing.status === 'pending' && existing.addressee_id === req.user.id) {
        await db.run(SQL.acceptPartnership, [nowIso(), existing.id]);
        return res.json({ partnership: await partnershipById(existing.id, req.user) });
      }
      fail(409, existing.status === 'active' ? "You're already partners" : 'Request already sent');
    }
    const id = await insertId(SQL.insertPartnership, [req.user.id, other.id, nowIso()]);
    res.status(201).json({ partnership: await partnershipById(id, req.user) });
  });

  app.post('/api/partnerships/:id/accept', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req, { active: false });
    if (p.status !== 'pending' || p.addressee_id !== req.user.id) fail(409, 'Nothing to accept');
    await db.run(SQL.acceptPartnership, [nowIso(), p.id]);
    res.json({ partnership: await partnershipById(p.id, req.user) });
  });

  // Cancels an outgoing request, declines an incoming one, or ends an active partnership.
  app.delete('/api/partnerships/:id', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req, { active: false });
    if (p.status === 'pending' && p.requester_id === req.user.id) await db.run(SQL.deletePartnership, [p.id]);
    else if (p.status === 'pending') await db.run(SQL.setPartnershipStatus, ['declined', p.id]);
    else if (p.status === 'active') await db.run(SQL.setPartnershipStatus, ['ended', p.id]);
    else fail(409, 'This partnership is already closed');
    res.json({ ok: true });
  });

  app.patch('/api/partnerships/:id', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req);
    const days = int(req.body?.checkinIntervalDays, 'checkinIntervalDays', 1, 30);
    await db.run(SQL.setInterval, [days, p.id]);
    res.json({ partnership: await partnershipById(p.id, req.user) });
  });

  app.get('/api/partnerships/:id', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req, { active: false });
    res.json({ partnership: await partnershipOut(p, req.user) });
  });

  // A partner's goals and daily plan are visible only while the partnership is active.
  app.get('/api/partnerships/:id/goals', requireUser, async (req, res) => {
    const { partner } = await loadPartnership(req);
    const scope = req.query.scope === 'past' ? 'past' : 'current';
    res.json({ goals: await goalsFor(partner, scope) });
  });

  app.get('/api/partnerships/:id/tasks', requireUser, async (req, res) => {
    const { partner } = await loadPartnership(req);
    res.json(await tasksFor(partner, req.query.day));
  });

  // ---------- check-ins ----------

  app.get('/api/partnerships/:id/checkins', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
    res.json({ checkins: (await db.all(SQL.checkins, [p.id, limit])).map(checkinOut) });
  });

  app.post('/api/partnerships/:id/checkins', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req);
    const mood = int(req.body?.mood, 'mood', 1, 5);
    const wins = text(req.body, 'wins', { max: 2000 });
    const struggles = text(req.body, 'struggles', { max: 2000 });
    const nextFocus = text(req.body, 'nextFocus', { max: 2000 });
    if (!wins && !struggles && !nextFocus) fail(400, 'Write at least a line about how it went');
    const id = await insertId(SQL.insertCheckin, [p.id, req.user.id, mood, wins, struggles, nextFocus, nowIso()]);
    res.status(201).json({ checkin: checkinOut(await db.get(SQL.checkinById, [id])) });
  });

  // ---------- messages ----------

  app.get('/api/partnerships/:id/messages', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req);
    const after = Number.parseInt(req.query.after, 10);
    const rows =
      Number.isInteger(after) && after >= 0
        ? await db.all(SQL.messagesAfter, [p.id, after])
        : await db.all(SQL.latestMessages, [p.id]);
    res.json({ messages: rows.map(messageOut) });
  });

  app.post('/api/partnerships/:id/messages', requireUser, async (req, res) => {
    const { p } = await loadPartnership(req);
    const body = text(req.body, 'body', { required: true, max: 2000 });
    const id = await insertId(SQL.insertMessage, [p.id, req.user.id, body, nowIso()]);
    res.status(201).json({ message: messageOut(await db.get(SQL.messageById, [id])) });
  });

  // ---------- goals ----------

  app.get('/api/goals', requireUser, async (req, res) => {
    const scope = req.query.scope === 'past' ? 'past' : 'current';
    res.json({ goals: await goalsFor(req.user, scope) });
  });

  app.post('/api/goals', requireUser, async (req, res) => {
    const title = text(req.body, 'title', { required: true, max: 200 });
    const details = text(req.body, 'details', { max: 2000 });
    const horizon = oneOf(req.body?.horizon, 'horizon', ['week', 'month']);
    const when = oneOf(req.body?.when ?? 'this', 'when', ['this', 'next']);
    const today = userToday(req.user);
    let start = periodStart(horizon, today);
    if (when === 'next') start = horizon === 'week' ? addDays(start, 7) : addMonths(start, 1);
    const stamp = nowIso();
    const id = await insertId(SQL.insertGoal, [req.user.id, title, details, horizon, start, stamp, stamp]);
    res.status(201).json({ goal: goalOut(await db.get(SQL.goalById, [id])) });
  });

  app.patch('/api/goals/:id', requireUser, async (req, res) => {
    const g = await ownGoal(req);
    const b = req.body ?? {};
    const title = b.title === undefined ? g.title : text(b, 'title', { required: true, max: 200 });
    const details = b.details === undefined ? g.details : text(b, 'details', { max: 2000 });
    const status = b.status === undefined ? g.status : oneOf(b.status, 'status', ['active', 'done', 'dropped']);
    let progress = b.progress === undefined ? g.progress : int(b.progress, 'progress', 0, 100);
    if (b.status === 'done' && b.progress === undefined) progress = 100;
    await db.run(SQL.updateGoal, [title, details, status, progress, nowIso(), g.id]);
    res.json({ goal: goalOut(await db.get(SQL.goalById, [g.id])) });
  });

  app.delete('/api/goals/:id', requireUser, async (req, res) => {
    await db.run(SQL.deleteGoal, [(await ownGoal(req)).id]);
    res.json({ ok: true });
  });

  // ---------- daily tasks & decisions ----------

  app.get('/api/tasks', requireUser, async (req, res) => {
    res.json(await tasksFor(req.user, req.query.day));
  });

  app.post('/api/tasks', requireUser, async (req, res) => {
    const title = text(req.body, 'title', { required: true, max: 300 });
    const kind = oneOf(req.body?.kind ?? 'task', 'kind', ['task', 'decision']);
    const day = req.body?.day ?? userToday(req.user);
    if (!isValidDay(day)) fail(400, 'day must be a date in YYYY-MM-DD format');
    const goalId = req.body?.goalId ?? null;
    if (goalId !== null) {
      const g = Number.isInteger(goalId) ? await db.get(SQL.goalById, [goalId]) : null;
      if (!g || g.user_id !== req.user.id) fail(400, 'goalId is not one of your goals');
    }
    const id = await insertId(SQL.insertTask, [req.user.id, day, title, kind, goalId, nowIso()]);
    res.status(201).json({ task: taskOut(await db.get(SQL.taskById, [id])) });
  });

  app.patch('/api/tasks/:id', requireUser, async (req, res) => {
    const t = await ownTask(req);
    const b = req.body ?? {};
    const title = b.title === undefined ? t.title : text(b, 'title', { required: true, max: 300 });
    let done = t.done;
    let doneAt = t.done_at;
    if (b.done !== undefined) {
      if (typeof b.done !== 'boolean') fail(400, 'done must be true or false');
      done = b.done ? 1 : 0;
      doneAt = b.done ? (t.done ? t.done_at : nowIso()) : null;
    }
    await db.run(SQL.updateTask, [title, done, doneAt, t.id]);
    res.json({ task: taskOut(await db.get(SQL.taskById, [t.id])) });
  });

  app.delete('/api/tasks/:id', requireUser, async (req, res) => {
    await db.run(SQL.deleteTask, [(await ownTask(req)).id]);
    res.json({ ok: true });
  });

  // Copies unfinished items from the most recent earlier day onto today, so
  // yesterday's record still shows what was missed.
  app.post('/api/tasks/carry-over', requireUser, async (req, res) => {
    const today = userToday(req.user);
    const result = await db.transaction(async (tx) => {
      const from = (await tx.get(SQL.lastDayWithOpenTasks, [req.user.id, today]))?.day ?? null;
      let copied = 0;
      if (!from) return { from, copied };
      for (const t of await tx.all(SQL.openTasksForDay, [req.user.id, from])) {
        if (await tx.get(SQL.taskExists, [req.user.id, today, t.title])) continue;
        await tx.get(SQL.insertTask, [req.user.id, today, t.title, t.kind, t.goal_id, nowIso()]);
        copied += 1;
      }
      return { from, copied };
    });
    res.json({ ...result, ...(await tasksFor(req.user)) });
  });

  // ---------- errors ----------

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
