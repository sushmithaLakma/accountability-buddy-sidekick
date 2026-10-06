import express from 'express';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';
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

export function createApp(db, { secureCookies = false, now = () => new Date() } = {}) {
  const app = express();
  const limiter = createLoginLimiter();

  // ---------- prepared statements ----------
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (username, display_name, password_hash, timezone) VALUES (?, ?, ?, ?)',
    ),
    updateUser: db.prepare('UPDATE users SET display_name = ?, timezone = ? WHERE id = ?'),

    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    partnershipById: db.prepare('SELECT * FROM partnerships WHERE id = ?'),
    partnershipsForUser: db.prepare(
      `SELECT * FROM partnerships
       WHERE (requester_id = ? OR addressee_id = ?) AND status IN ('pending', 'active')
       ORDER BY status = 'active' DESC, created_at DESC`,
    ),
    openPartnershipBetween: db.prepare(
      `SELECT * FROM partnerships
       WHERE status IN ('pending', 'active')
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    ),
    insertPartnership: db.prepare('INSERT INTO partnerships (requester_id, addressee_id) VALUES (?, ?)'),
    setPartnershipStatus: db.prepare('UPDATE partnerships SET status = ? WHERE id = ?'),
    acceptPartnership: db.prepare(
      "UPDATE partnerships SET status = 'active', accepted_at = ? WHERE id = ?",
    ),
    deletePartnership: db.prepare('DELETE FROM partnerships WHERE id = ?'),
    setInterval: db.prepare('UPDATE partnerships SET checkin_interval_days = ? WHERE id = ?'),

    goalById: db.prepare('SELECT * FROM goals WHERE id = ?'),
    currentGoals: db.prepare(
      `SELECT * FROM goals
       WHERE user_id = ?
         AND ((horizon = 'week' AND period_start >= ?) OR (horizon = 'month' AND period_start >= ?))
       ORDER BY period_start, horizon DESC, status = 'active' DESC, id`,
    ),
    pastGoals: db.prepare(
      `SELECT * FROM goals
       WHERE user_id = ?
         AND ((horizon = 'week' AND period_start < ?) OR (horizon = 'month' AND period_start < ?))
       ORDER BY period_start DESC, id DESC LIMIT 100`,
    ),
    insertGoal: db.prepare(
      'INSERT INTO goals (user_id, title, details, horizon, period_start) VALUES (?, ?, ?, ?, ?)',
    ),
    updateGoal: db.prepare(
      `UPDATE goals SET title = ?, details = ?, status = ?, progress = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ),
    deleteGoal: db.prepare('DELETE FROM goals WHERE id = ?'),

    taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    tasksForDay: db.prepare('SELECT * FROM tasks WHERE user_id = ? AND day = ? ORDER BY done, id'),
    insertTask: db.prepare('INSERT INTO tasks (user_id, day, title, kind, goal_id) VALUES (?, ?, ?, ?, ?)'),
    updateTask: db.prepare('UPDATE tasks SET title = ?, done = ?, done_at = ? WHERE id = ?'),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    openTasksForDay: db.prepare('SELECT * FROM tasks WHERE user_id = ? AND day = ? AND done = 0 ORDER BY id'),
    taskExists: db.prepare('SELECT 1 FROM tasks WHERE user_id = ? AND day = ? AND title = ?'),
    lastDayWithOpenTasks: db.prepare(
      'SELECT MAX(day) AS day FROM tasks WHERE user_id = ? AND day < ? AND done = 0',
    ),

    lastCheckin: db.prepare(
      'SELECT MAX(created_at) AS at FROM checkins WHERE partnership_id = ? AND user_id = ?',
    ),
    checkins: db.prepare(
      'SELECT * FROM checkins WHERE partnership_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ),
    insertCheckin: db.prepare(
      `INSERT INTO checkins (partnership_id, user_id, mood, wins, struggles, next_focus, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    checkinById: db.prepare('SELECT * FROM checkins WHERE id = ?'),

    messagesAfter: db.prepare(
      'SELECT * FROM messages WHERE partnership_id = ? AND id > ? ORDER BY id LIMIT 200',
    ),
    latestMessages: db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE partnership_id = ? ORDER BY id DESC LIMIT 100)
       ORDER BY id`,
    ),
    insertMessage: db.prepare(
      'INSERT INTO messages (partnership_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
    ),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  };

  // ---------- domain helpers ----------

  const nowIso = () => now().toISOString();
  const userToday = (user) => todayIn(user.timezone, now());

  function checkinStatus(p, userId) {
    const last = q.lastCheckin.get(p.id, userId)?.at ?? null;
    const dueAt = last
      ? new Date(new Date(last).getTime() + p.checkin_interval_days * DAY_MS).toISOString()
      : null;
    return { lastAt: last, dueAt, isDue: !last || new Date(dueAt) <= now() };
  }

  function partnershipOut(p, me) {
    const partnerId = p.requester_id === me.id ? p.addressee_id : p.requester_id;
    const out = {
      id: p.id,
      status: p.status,
      direction: p.requester_id === me.id ? 'outgoing' : 'incoming',
      partner: publicUser(q.userById.get(partnerId)),
      checkinIntervalDays: p.checkin_interval_days,
      createdAt: p.created_at,
      acceptedAt: p.accepted_at,
    };
    if (p.status === 'active') {
      out.checkins = { me: checkinStatus(p, me.id), partner: checkinStatus(p, partnerId) };
    }
    return out;
  }

  /** Loads a partnership the current user belongs to, or 404s. */
  function loadPartnership(req, { active = true } = {}) {
    const p = q.partnershipById.get(idParam(req));
    const me = req.user.id;
    if (!p || (p.requester_id !== me && p.addressee_id !== me)) fail(404, 'Partnership not found');
    if (active && p.status !== 'active') fail(409, 'This partnership is not active');
    const partner = q.userById.get(p.requester_id === me ? p.addressee_id : p.requester_id);
    return { p, partner };
  }

  function ownGoal(req) {
    const g = q.goalById.get(idParam(req));
    if (!g || g.user_id !== req.user.id) fail(404, 'Goal not found');
    return g;
  }

  function ownTask(req) {
    const t = q.taskById.get(idParam(req));
    if (!t || t.user_id !== req.user.id) fail(404, 'Task not found');
    return t;
  }

  function goalsFor(user, scope) {
    const today = userToday(user);
    const args = [user.id, weekStart(today), monthStart(today)];
    const rows = scope === 'past' ? q.pastGoals.all(...args) : q.currentGoals.all(...args);
    return rows.map(goalOut);
  }

  function tasksFor(user, dayParam) {
    const today = userToday(user);
    const day = dayParam === undefined ? today : dayParam;
    if (!isValidDay(day)) fail(400, 'day must be a date in YYYY-MM-DD format');
    return { day, today, tasks: q.tasksForDay.all(user.id, day).map(taskOut) };
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
  app.use('/api', express.json({ limit: '32kb' }));

  // Requiring a JSON body on every state-changing request means a cross-site
  // HTML form can't forge one (browsers preflight JSON), on top of SameSite.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Requests must send Content-Type: application/json'));
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.sessionTokenHash = token ? hashToken(token) : null;
    req.user = token ? (q.sessionUser.get(req.sessionTokenHash, nowIso()) ?? null) : null;
    next();
  });

  const requireUser = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    next();
  };

  function startSession(res, userId) {
    q.purgeSessions.run(nowIso());
    const token = newSessionToken();
    const expires = new Date(now().getTime() + SESSION_TTL_DAYS * DAY_MS);
    q.insertSession.run(hashToken(token), userId, expires.toISOString());
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
    if (q.userByName.get(username)) fail(409, 'That username is taken');

    const hash = await hashPassword(password);
    let id;
    try {
      id = Number(q.insertUser.run(username, displayName, hash, timezone).lastInsertRowid);
    } catch (err) {
      // Lost a race with a concurrent signup for the same name.
      if (String(err.message).includes('UNIQUE')) fail(409, 'That username is taken');
      throw err;
    }
    startSession(res, id);
    res.status(201).json({ user: publicUser(q.userById.get(id)) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const username = text(req.body, 'username', { required: true, max: 30 });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (limiter.isBlocked(req.ip, username)) fail(429, 'Too many failed attempts. Try again later.');
    const user = q.userByName.get(username);
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!ok) {
      limiter.fail(req.ip, username);
      fail(401, 'Wrong username or password');
    }
    limiter.reset(req.ip, username);
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionTokenHash) q.deleteSession.run(req.sessionTokenHash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: publicUser(req.user), today: userToday(req.user) });
  });

  app.patch('/api/me', requireUser, (req, res) => {
    const displayName = text(req.body, 'displayName', { max: 60 }) || req.user.display_name;
    const timezone = text(req.body, 'timezone', { max: 64 }) || req.user.timezone;
    if (!isValidTimezone(timezone)) fail(400, 'timezone is not a recognised IANA timezone');
    q.updateUser.run(displayName, timezone, req.user.id);
    const user = q.userById.get(req.user.id);
    res.json({ user: publicUser(user), today: userToday(user) });
  });

  // ---------- partnerships ----------

  app.get('/api/partnerships', requireUser, (req, res) => {
    const rows = q.partnershipsForUser.all(req.user.id, req.user.id);
    res.json({ partnerships: rows.map((p) => partnershipOut(p, req.user)) });
  });

  app.post('/api/partnerships', requireUser, (req, res) => {
    const username = text(req.body, 'username', { required: true, max: 30 });
    const other = q.userByName.get(username);
    if (!other) fail(404, `No user called "${username}"`);
    if (other.id === req.user.id) fail(400, "You can't partner with yourself");

    const existing = q.openPartnershipBetween.get(req.user.id, other.id, other.id, req.user.id);
    if (existing) {
      // They already asked us: treat our request as accepting theirs.
      if (existing.status === 'pending' && existing.addressee_id === req.user.id) {
        q.acceptPartnership.run(nowIso(), existing.id);
        return res.json({ partnership: partnershipOut(q.partnershipById.get(existing.id), req.user) });
      }
      fail(409, existing.status === 'active' ? "You're already partners" : 'Request already sent');
    }
    const id = q.insertPartnership.run(req.user.id, other.id).lastInsertRowid;
    res.status(201).json({ partnership: partnershipOut(q.partnershipById.get(id), req.user) });
  });

  app.post('/api/partnerships/:id/accept', requireUser, (req, res) => {
    const { p } = loadPartnership(req, { active: false });
    if (p.status !== 'pending' || p.addressee_id !== req.user.id) fail(409, 'Nothing to accept');
    q.acceptPartnership.run(nowIso(), p.id);
    res.json({ partnership: partnershipOut(q.partnershipById.get(p.id), req.user) });
  });

  // Cancels an outgoing request, declines an incoming one, or ends an active partnership.
  app.delete('/api/partnerships/:id', requireUser, (req, res) => {
    const { p } = loadPartnership(req, { active: false });
    if (p.status === 'pending' && p.requester_id === req.user.id) q.deletePartnership.run(p.id);
    else if (p.status === 'pending') q.setPartnershipStatus.run('declined', p.id);
    else if (p.status === 'active') q.setPartnershipStatus.run('ended', p.id);
    else fail(409, 'This partnership is already closed');
    res.json({ ok: true });
  });

  app.patch('/api/partnerships/:id', requireUser, (req, res) => {
    const { p } = loadPartnership(req);
    const days = int(req.body?.checkinIntervalDays, 'checkinIntervalDays', 1, 30);
    q.setInterval.run(days, p.id);
    res.json({ partnership: partnershipOut(q.partnershipById.get(p.id), req.user) });
  });

  app.get('/api/partnerships/:id', requireUser, (req, res) => {
    const { p } = loadPartnership(req, { active: false });
    res.json({ partnership: partnershipOut(p, req.user) });
  });

  // A partner's goals and daily plan are visible only while the partnership is active.
  app.get('/api/partnerships/:id/goals', requireUser, (req, res) => {
    const { partner } = loadPartnership(req);
    const scope = req.query.scope === 'past' ? 'past' : 'current';
    res.json({ goals: goalsFor(partner, scope) });
  });

  app.get('/api/partnerships/:id/tasks', requireUser, (req, res) => {
    const { partner } = loadPartnership(req);
    res.json(tasksFor(partner, req.query.day));
  });

  // ---------- check-ins ----------

  app.get('/api/partnerships/:id/checkins', requireUser, (req, res) => {
    const { p } = loadPartnership(req);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
    res.json({ checkins: q.checkins.all(p.id, limit).map(checkinOut) });
  });

  app.post('/api/partnerships/:id/checkins', requireUser, (req, res) => {
    const { p } = loadPartnership(req);
    const mood = int(req.body?.mood, 'mood', 1, 5);
    const wins = text(req.body, 'wins', { max: 2000 });
    const struggles = text(req.body, 'struggles', { max: 2000 });
    const nextFocus = text(req.body, 'nextFocus', { max: 2000 });
    if (!wins && !struggles && !nextFocus) fail(400, 'Write at least a line about how it went');
    const id = q.insertCheckin.run(p.id, req.user.id, mood, wins, struggles, nextFocus, nowIso())
      .lastInsertRowid;
    res.status(201).json({ checkin: checkinOut(q.checkinById.get(id)) });
  });

  // ---------- messages ----------

  app.get('/api/partnerships/:id/messages', requireUser, (req, res) => {
    const { p } = loadPartnership(req);
    const after = Number.parseInt(req.query.after, 10);
    const rows = Number.isInteger(after) && after >= 0 ? q.messagesAfter.all(p.id, after) : q.latestMessages.all(p.id);
    res.json({ messages: rows.map(messageOut) });
  });

  app.post('/api/partnerships/:id/messages', requireUser, (req, res) => {
    const { p } = loadPartnership(req);
    const body = text(req.body, 'body', { required: true, max: 2000 });
    const id = q.insertMessage.run(p.id, req.user.id, body, nowIso()).lastInsertRowid;
    res.status(201).json({ message: messageOut(q.messageById.get(id)) });
  });

  // ---------- goals ----------

  app.get('/api/goals', requireUser, (req, res) => {
    const scope = req.query.scope === 'past' ? 'past' : 'current';
    res.json({ goals: goalsFor(req.user, scope) });
  });

  app.post('/api/goals', requireUser, (req, res) => {
    const title = text(req.body, 'title', { required: true, max: 200 });
    const details = text(req.body, 'details', { max: 2000 });
    const horizon = oneOf(req.body?.horizon, 'horizon', ['week', 'month']);
    const when = oneOf(req.body?.when ?? 'this', 'when', ['this', 'next']);
    const today = userToday(req.user);
    let start = periodStart(horizon, today);
    if (when === 'next') start = horizon === 'week' ? addDays(start, 7) : addMonths(start, 1);
    const id = q.insertGoal.run(req.user.id, title, details, horizon, start).lastInsertRowid;
    res.status(201).json({ goal: goalOut(q.goalById.get(id)) });
  });

  app.patch('/api/goals/:id', requireUser, (req, res) => {
    const g = ownGoal(req);
    const b = req.body ?? {};
    const title = b.title === undefined ? g.title : text(b, 'title', { required: true, max: 200 });
    const details = b.details === undefined ? g.details : text(b, 'details', { max: 2000 });
    const status = b.status === undefined ? g.status : oneOf(b.status, 'status', ['active', 'done', 'dropped']);
    let progress = b.progress === undefined ? g.progress : int(b.progress, 'progress', 0, 100);
    if (b.status === 'done' && b.progress === undefined) progress = 100;
    q.updateGoal.run(title, details, status, progress, g.id);
    res.json({ goal: goalOut(q.goalById.get(g.id)) });
  });

  app.delete('/api/goals/:id', requireUser, (req, res) => {
    q.deleteGoal.run(ownGoal(req).id);
    res.json({ ok: true });
  });

  // ---------- daily tasks & decisions ----------

  app.get('/api/tasks', requireUser, (req, res) => {
    res.json(tasksFor(req.user, req.query.day));
  });

  app.post('/api/tasks', requireUser, (req, res) => {
    const title = text(req.body, 'title', { required: true, max: 300 });
    const kind = oneOf(req.body?.kind ?? 'task', 'kind', ['task', 'decision']);
    const day = req.body?.day ?? userToday(req.user);
    if (!isValidDay(day)) fail(400, 'day must be a date in YYYY-MM-DD format');
    let goalId = req.body?.goalId ?? null;
    if (goalId !== null) {
      const g = Number.isInteger(goalId) ? q.goalById.get(goalId) : null;
      if (!g || g.user_id !== req.user.id) fail(400, 'goalId is not one of your goals');
    }
    const id = q.insertTask.run(req.user.id, day, title, kind, goalId).lastInsertRowid;
    res.status(201).json({ task: taskOut(q.taskById.get(id)) });
  });

  app.patch('/api/tasks/:id', requireUser, (req, res) => {
    const t = ownTask(req);
    const b = req.body ?? {};
    const title = b.title === undefined ? t.title : text(b, 'title', { required: true, max: 300 });
    let done = t.done;
    let doneAt = t.done_at;
    if (b.done !== undefined) {
      if (typeof b.done !== 'boolean') fail(400, 'done must be true or false');
      done = b.done ? 1 : 0;
      doneAt = b.done ? (t.done ? t.done_at : nowIso()) : null;
    }
    q.updateTask.run(title, done, doneAt, t.id);
    res.json({ task: taskOut(q.taskById.get(t.id)) });
  });

  app.delete('/api/tasks/:id', requireUser, (req, res) => {
    q.deleteTask.run(ownTask(req).id);
    res.json({ ok: true });
  });

  // Copies unfinished items from the most recent earlier day onto today, so
  // yesterday's record still shows what was missed.
  app.post('/api/tasks/carry-over', requireUser, (req, res) => {
    const today = userToday(req.user);
    const from = q.lastDayWithOpenTasks.get(req.user.id, today)?.day;
    if (!from) return res.json({ from: null, copied: 0, ...tasksFor(req.user) });
    const copied = transaction(db, () => {
      let n = 0;
      for (const t of q.openTasksForDay.all(req.user.id, from)) {
        if (q.taskExists.get(req.user.id, today, t.title)) continue;
        q.insertTask.run(req.user.id, today, t.title, t.kind, t.goal_id);
        n += 1;
      }
      return n;
    });
    res.json({ from, copied, ...tasksFor(req.user) });
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
