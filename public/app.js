// Accountability Buddy — single-page frontend. No build step, no dependencies.

const state = { user: null, today: null, partnerships: [] };
const timers = new Set();

// ---------- tiny DOM helper (always uses text nodes, so user content is never parsed as HTML) ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $app = () => document.getElementById('app');

// ---------- API ----------

class ApiError extends Error {}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    state.user = null;
    renderAuth();
    throw new ApiError('Please log in again');
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`);
  return data;
}

/** Wraps a form submit handler: disables the button, shows errors under the form. */
function onSubmit(handler) {
  return async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = form.querySelector('.error');
    if (error) error.textContent = '';
    if (button) button.disabled = true;
    try {
      await handler(form);
    } catch (err) {
      if (error) error.textContent = err.message;
      else alert(err.message);
    } finally {
      if (button) button.disabled = false;
    }
  };
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ApiError && !state.user)) alert(err.message);
  }
}

// ---------- formatting ----------

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function localTime(tz) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
}

function fmtDay(day, opts = { weekday: 'long', month: 'short', day: 'numeric' }) {
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts }).format(new Date(`${day}T00:00:00Z`));
}

function fmtDateTime(iso) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relative(iso) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

const MOODS = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' };

// ---------- routing ----------

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

function clearTimers() {
  for (const t of timers) clearInterval(t);
  timers.clear();
}

function every(ms, fn) {
  const t = setInterval(() => {
    if (!document.hidden) fn().catch(() => {});
  }, ms);
  timers.add(t);
}

async function route() {
  clearTimers();
  if (!state.user) return renderAuth();
  const { parts, params } = parseHash();
  const page = parts[0] || 'today';
  const main = renderShell(page);
  try {
    if (page === 'today') await viewToday(main, params.get('day'));
    else if (page === 'goals') await viewGoals(main);
    else if (page === 'partners') await viewPartners(main);
    else if (page === 'partner') await viewPartner(main, Number(parts[1]));
    else if (page === 'settings') viewSettings(main);
    else location.hash = '#/today';
  } catch (err) {
    if (state.user) main.replaceChildren(h('div', { class: 'notice' }, err.message));
  }
}

async function refreshPartnerships() {
  state.partnerships = (await api('GET', '/api/partnerships')).partnerships;
  updateBadge();
}

function attentionCount() {
  return state.partnerships.filter(
    (p) => (p.status === 'pending' && p.direction === 'incoming') || (p.status === 'active' && p.checkins.me.isDue),
  ).length;
}

function updateBadge() {
  const badge = document.getElementById('partners-badge');
  if (!badge) return;
  const n = attentionCount();
  badge.textContent = n ? String(n) : '';
  badge.hidden = !n;
}

// ---------- shell ----------

function renderShell(page) {
  const link = (href, label, key, extra) =>
    h('a', { href, class: page === key ? 'active' : null }, label, extra);
  const main = h('main', {}, h('p', { class: 'loading' }, 'Loading…'));
  $app().replaceChildren(
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, 'Accountability ', h('span', {}, 'Buddy')),
      h(
        'nav',
        { class: 'nav' },
        link('#/today', 'Today', 'today'),
        link('#/goals', 'Goals', 'goals'),
        link(
          '#/partners',
          'Partners',
          page === 'partner' ? 'partner' : 'partners',
          h('span', { class: 'badge', id: 'partners-badge', hidden: true }),
        ),
      ),
      h(
        'div',
        { class: 'userbox' },
        h('span', { class: 'localtime', title: state.user.timezone }, localTime(state.user.timezone)),
        h('a', { href: '#/settings' }, state.user.displayName),
        h('button', { class: 'link', onclick: logout }, 'Log out'),
      ),
    ),
    main,
  );
  if (page === 'partner') main.previousSibling.querySelector('a[href="#/partners"]').classList.add('active');
  refreshPartnerships().catch(() => {});
  every(60_000, refreshPartnerships);
  return main;
}

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  clearTimers();
  location.hash = '';
  renderAuth();
}

// ---------- auth ----------

function renderAuth(mode = 'login') {
  clearTimers();
  const isSignup = mode === 'signup';
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: onSubmit(async (f) => {
        const body = {
          username: f.username.value,
          password: f.password.value,
        };
        if (isSignup) {
          body.displayName = f.displayName.value;
          body.timezone = browserTimezone();
        }
        const data = await api('POST', isSignup ? '/api/auth/signup' : '/api/auth/login', body);
        state.user = data.user;
        await loadMe();
        if (!location.hash || location.hash === '#') location.hash = isSignup ? '#/partners' : '#/today';
        else route();
      }),
    },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'username' }, 'Username'),
      h('input', { id: 'username', name: 'username', autocomplete: 'username', required: true, maxlength: 30 }),
    ),
    isSignup &&
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'displayName' }, 'Your name (what your partner sees)'),
        h('input', { id: 'displayName', name: 'displayName', maxlength: 60 }),
      ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'password' }, isSignup ? 'Password (8+ characters)' : 'Password'),
      h('input', {
        id: 'password',
        name: 'password',
        type: 'password',
        required: true,
        minlength: isSignup ? 8 : null,
        autocomplete: isSignup ? 'new-password' : 'current-password',
      }),
    ),
    isSignup && h('p', { class: 'muted small' }, `Timezone: ${browserTimezone()} (you can change it later).`),
    h('button', { type: 'submit', class: 'primary' }, isSignup ? 'Create account' : 'Log in'),
    h('p', { class: 'error', role: 'alert' }),
  );

  $app().replaceChildren(
    h(
      'div',
      { class: 'auth' },
      h('h1', {}, 'Accountability ', h('span', {}, 'Buddy')),
      h(
        'p',
        { class: 'muted' },
        'Pair up with someone anywhere in the world. Share your goals for the week and month, plan your day, and check in on each other.',
      ),
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        h('button', { class: !isSignup ? 'active' : null, onclick: () => renderAuth('login') }, 'Log in'),
        h('button', { class: isSignup ? 'active' : null, onclick: () => renderAuth('signup') }, 'Sign up'),
      ),
      form,
    ),
  );
  form.username.focus();
}

async function loadMe() {
  const data = await api('GET', '/api/me');
  state.user = data.user;
  state.today = data.today;
}

// ---------- shared renderers ----------

function taskList(tasks, { editable, reload }) {
  if (!tasks.length) return h('p', { class: 'empty' }, editable ? 'Nothing planned yet.' : 'Nothing planned for this day yet.');
  return h(
    'ul',
    { class: 'items' },
    tasks.map((t) =>
      h(
        'li',
        { class: t.done ? 'done' : null },
        h('input', {
          type: 'checkbox',
          checked: t.done,
          disabled: !editable,
          'aria-label': `Mark "${t.title}" ${t.done ? 'not done' : 'done'}`,
          onchange: editable
            ? (e) => act(async () => {
                await api('PATCH', `/api/tasks/${t.id}`, { done: e.target.checked });
                await reload();
              })
            : null,
        }),
        h(
          'span',
          { class: 'grow' },
          h('span', { class: 'title' }, t.title),
          ' ',
          t.kind === 'decision' && h('span', { class: 'tag decision' }, 'decision'),
        ),
        editable &&
          h(
            'button',
            {
              class: 'link danger',
              title: 'Delete',
              'aria-label': `Delete "${t.title}"`,
              onclick: () => act(async () => {
                await api('DELETE', `/api/tasks/${t.id}`);
                await reload();
              }),
            },
            '✕',
          ),
      ),
    ),
  );
}

function periodLabel(horizon, start, today) {
  const end = new Date(`${start}T00:00:00Z`);
  if (horizon === 'week') {
    end.setUTCDate(end.getUTCDate() + 6);
    const range = `${fmtDay(start, { month: 'short', day: 'numeric' })} – ${fmtDay(end.toISOString().slice(0, 10), { month: 'short', day: 'numeric' })}`;
    const thisWeek = weekStartOf(today);
    const name = start === thisWeek ? 'This week' : start === addDays(thisWeek, 7) ? 'Next week' : 'Week';
    return `${name} · ${range}`;
  }
  const thisMonth = `${today.slice(0, 7)}-01`;
  const month = fmtDay(start, { month: 'long', year: 'numeric' });
  const next = new Date(`${thisMonth}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const name = start === thisMonth ? 'This month' : start === next.toISOString().slice(0, 10) ? 'Next month' : 'Month';
  return `${name} · ${month}`;
}

function weekStartOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

function goalGroups(goals, { editable, today, reload, nested = false }) {
  if (!goals.length) return [h('p', { class: 'empty' }, editable ? 'No goals yet — add one above.' : 'No goals shared yet.')];
  const groups = new Map();
  for (const g of goals) {
    const key = `${g.horizon}|${g.periodStart}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [horizon, start] = key.split('|');
    const done = list.filter((g) => g.status === 'done').length;
    return h(
      'section',
      { class: nested ? 'goal-group' : 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, periodLabel(horizon, start, today)), h('span', { class: 'muted small' }, `${done}/${list.length} done`)),
      list.map((g) => goalItem(g, { editable, reload })),
    );
  });
}

function goalItem(g, { editable, reload }) {
  const patch = (body) => act(async () => {
    await api('PATCH', `/api/goals/${g.id}`, body);
    await reload();
  });
  const statusTag =
    g.status === 'done' ? h('span', { class: 'tag done' }, 'done') : g.status === 'dropped' ? h('span', { class: 'tag' }, 'dropped') : null;
  return h(
    'div',
    { class: `goal ${g.status}` },
    h('div', { class: 'row' }, h('span', { class: 'title' }, g.title), statusTag),
    g.details && h('p', {}, g.details),
    h(
      'div',
      { class: 'row' },
      editable && g.status === 'active'
        ? h('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 10,
            value: g.progress,
            'aria-label': `Progress on "${g.title}"`,
            oninput: (e) => {
              e.target.nextSibling.textContent = `${e.target.value}%`;
            },
            onchange: (e) => patch({ progress: Number(e.target.value) }),
          })
        : h('div', { class: 'progress', role: 'img', 'aria-label': `${g.progress}% complete` }, h('div', { 'data-w': g.progress })),
      h('span', { class: 'muted small' }, `${g.progress}%`),
      editable && g.status === 'active' && h('button', { class: 'link', onclick: () => patch({ status: 'done' }) }, '✓ Done'),
      editable && g.status === 'active' && h('button', { class: 'link', onclick: () => patch({ status: 'dropped' }) }, 'Drop'),
      editable && g.status !== 'active' && h('button', { class: 'link', onclick: () => patch({ status: 'active' }) }, 'Reopen'),
      editable &&
        h(
          'button',
          {
            class: 'link danger',
            onclick: () => {
              if (confirm(`Delete goal "${g.title}"?`)) act(async () => {
                await api('DELETE', `/api/goals/${g.id}`);
                await reload();
              });
            },
          },
          'Delete',
        ),
    ),
  );
}

// The CSP forbids inline styles set via attributes, so progress widths are applied through the CSSOM.
function applyWidths(root) {
  for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
}

// ---------- Today ----------

async function viewToday(main, dayParam) {
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : state.today;

  async function render() {
    const [{ tasks, today }, { goals }] = await Promise.all([
      api('GET', `/api/tasks?day=${day}`),
      api('GET', '/api/goals'),
    ]);
    state.today = today;
    const activeGoals = goals.filter((g) => g.status === 'active');
    const doneCount = tasks.filter((t) => t.done).length;
    const isToday = day === today;
    const go = (d) => {
      location.hash = d === today ? '#/today' : `#/today?day=${d}`;
    };

    const due = state.partnerships.filter((p) => p.status === 'active' && p.checkins.me.isDue);

    main.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        due.length > 0 &&
          h(
            'div',
            { class: 'notice' },
            'Check-in due with ',
            due.map((p, i) => [i ? ', ' : '', h('a', { href: `#/partner/${p.id}` }, p.partner.displayName)]),
            '.',
          ),
        h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'card-head' },
            h(
              'div',
              { class: 'daynav' },
              h('button', { class: 'link', 'aria-label': 'Previous day', onclick: () => go(addDays(day, -1)) }, '‹'),
              h('h2', {}, isToday ? `Today · ${fmtDay(day)}` : fmtDay(day)),
              h('button', { class: 'link', 'aria-label': 'Next day', onclick: () => go(addDays(day, 1)) }, '›'),
              !isToday && h('button', { onclick: () => go(today) }, 'Back to today'),
            ),
            h('span', { class: 'muted small' }, `${doneCount}/${tasks.length} done`),
          ),
          h('p', { class: 'muted small' }, 'Your partner can see this list. Add the things you will do and the decisions you need to make.'),
          h(
            'form',
            {
              class: 'inline',
              onsubmit: onSubmit(async (f) => {
                await api('POST', '/api/tasks', {
                  title: f.title.value,
                  kind: f.kind.value,
                  day,
                  goalId: f.goal.value ? Number(f.goal.value) : null,
                });
                await render();
                main.querySelector('input[name="title"]')?.focus();
              }),
            },
            h('input', { name: 'title', placeholder: 'What will you do?', required: true, maxlength: 300, 'aria-label': 'New item' }),
            h(
              'select',
              { name: 'kind', 'aria-label': 'Type' },
              h('option', { value: 'task' }, 'To-do'),
              h('option', { value: 'decision' }, 'Decision'),
            ),
            activeGoals.length > 0 &&
              h(
                'select',
                { name: 'goal', 'aria-label': 'Related goal' },
                h('option', { value: '' }, 'No goal'),
                activeGoals.map((g) => h('option', { value: g.id }, g.title)),
              ),
            activeGoals.length === 0 && h('input', { type: 'hidden', name: 'goal', value: '' }),
            h('button', { type: 'submit', class: 'primary' }, 'Add'),
            h('p', { class: 'error', role: 'alert' }),
          ),
          taskList(tasks, { editable: true, reload: render }),
          isToday &&
            h(
              'p',
              {},
              h(
                'button',
                {
                  class: 'link',
                  onclick: () => act(async () => {
                    const r = await api('POST', '/api/tasks/carry-over');
                    await render();
                    if (!r.from) alert('No unfinished items from earlier days.');
                  }),
                },
                '↻ Bring over unfinished items from my last planned day',
              ),
            ),
        ),
        activeGoals.length > 0 &&
          h(
            'section',
            { class: 'card' },
            h('h3', {}, 'Keep in mind — your active goals'),
            h('ul', { class: 'items' }, activeGoals.map((g) => h('li', {}, h('span', { class: 'grow' }, g.title), h('span', { class: 'muted small' }, `${g.progress}%`)))),
          ),
      ),
    );
  }

  await refreshPartnerships().catch(() => {});
  await render();
}

// ---------- Goals ----------

async function viewGoals(main) {
  let showPast = false;

  async function render() {
    const [{ goals }, past] = await Promise.all([
      api('GET', '/api/goals'),
      showPast ? api('GET', '/api/goals?scope=past') : Promise.resolve(null),
    ]);
    main.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Set a goal'),
          h('p', { class: 'muted small' }, 'Goals are shared with your partners so they can cheer you on and ask how it’s going.'),
          h(
            'form',
            {
              onsubmit: onSubmit(async (f) => {
                await api('POST', '/api/goals', {
                  title: f.title.value,
                  details: f.details.value,
                  horizon: f.horizon.value,
                  when: f.when.value,
                });
                await render();
              }),
            },
            h('div', { class: 'field' }, h('label', { for: 'g-title' }, 'Goal'), h('input', { id: 'g-title', name: 'title', required: true, maxlength: 200, placeholder: 'e.g. Run 3 times' })),
            h('div', { class: 'field' }, h('label', { for: 'g-details' }, 'Details (optional) — why it matters, what “done” looks like'), h('textarea', { id: 'g-details', name: 'details', maxlength: 2000 })),
            h(
              'div',
              { class: 'grid' },
              h(
                'div',
                { class: 'field' },
                h('label', { for: 'g-horizon' }, 'Timeframe'),
                h('select', { id: 'g-horizon', name: 'horizon' }, h('option', { value: 'week' }, 'Week'), h('option', { value: 'month' }, 'Month')),
              ),
              h(
                'div',
                { class: 'field' },
                h('label', { for: 'g-when' }, 'Which one'),
                h('select', { id: 'g-when', name: 'when' }, h('option', { value: 'this' }, 'This one'), h('option', { value: 'next' }, 'The next one')),
              ),
            ),
            h('button', { type: 'submit', class: 'primary' }, 'Add goal'),
            h('p', { class: 'error', role: 'alert' }),
          ),
        ),
        goalGroups(goals, { editable: true, today: state.today, reload: render }),
        h(
          'p',
          {},
          h('button', { class: 'link', onclick: () => { showPast = !showPast; act(render); } }, showPast ? 'Hide past goals' : 'Show past goals'),
        ),
        past && (past.goals.length ? goalGroups(past.goals, { editable: true, today: state.today, reload: render }) : h('p', { class: 'empty' }, 'No past goals.')),
      ),
    );
    applyWidths(main);
  }

  await render();
}

// ---------- Partners ----------

function checkinSummary(p) {
  const me = p.checkins.me;
  const them = p.checkins.partner;
  const name = p.partner.displayName;
  return {
    mine: me.isDue
      ? me.lastAt
        ? 'Your check-in is due'
        : 'Post your first check-in'
      : `Your next check-in is due ${relative(me.dueAt)}`,
    theirs: !them.lastAt
      ? `${name} hasn't checked in yet`
      : them.isDue
        ? `${name}'s check-in was due ${relative(them.dueAt)}`
        : `${name} checked in ${relative(them.lastAt)}`,
  };
}

async function viewPartners(main) {
  async function render() {
    await refreshPartnerships();
    const incoming = state.partnerships.filter((p) => p.status === 'pending' && p.direction === 'incoming');
    const outgoing = state.partnerships.filter((p) => p.status === 'pending' && p.direction === 'outgoing');
    const active = state.partnerships.filter((p) => p.status === 'active');
    const remove = (p, verb) => act(async () => {
      if (verb && !confirm(`${verb}?`)) return;
      await api('DELETE', `/api/partnerships/${p.id}`);
      await render();
    });

    main.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        incoming.length > 0 &&
          h(
            'section',
            { class: 'card' },
            h('h2', {}, 'Partner requests'),
            h(
              'ul',
              { class: 'items' },
              incoming.map((p) =>
                h(
                  'li',
                  {},
                  h('span', { class: 'grow' }, h('strong', {}, p.partner.displayName), ` @${p.partner.username} · ${p.partner.timezone}`),
                  h('button', { class: 'primary', onclick: () => act(async () => { await api('POST', `/api/partnerships/${p.id}/accept`); await render(); }) }, 'Accept'),
                  h('button', { onclick: () => remove(p) }, 'Decline'),
                ),
              ),
            ),
          ),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Your accountability partners'),
          active.length === 0
            ? h('p', { class: 'empty' }, 'No partners yet. Invite someone below — they just need an account.')
            : h(
                'ul',
                { class: 'items' },
                active.map((p) => {
                  const s = checkinSummary(p);
                  return h(
                    'li',
                    {},
                    h(
                      'a',
                      { class: 'partner-card grow', href: `#/partner/${p.id}` },
                      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(p.partner.displayName)),
                      h(
                        'span',
                        {},
                        h('span', { class: 'name' }, h('strong', {}, p.partner.displayName), ` @${p.partner.username}`),
                        h('br'),
                        h('span', { class: 'muted small' }, `${localTime(p.partner.timezone)} their time · ${s.theirs}`),
                      ),
                    ),
                    p.checkins.me.isDue && h('span', { class: 'tag decision' }, 'check-in due'),
                  );
                }),
              ),
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Invite a partner'),
          h('p', { class: 'muted small' }, 'Ask your partner for their username. Yours is ', h('strong', {}, `@${state.user.username}`), ' — share it so they can find you.'),
          h(
            'form',
            {
              class: 'inline',
              onsubmit: onSubmit(async (f) => {
                const r = await api('POST', '/api/partnerships', { username: f.username.value.replace(/^@/, '') });
                f.reset();
                await render();
                if (r.partnership.status === 'active') location.hash = `#/partner/${r.partnership.id}`;
              }),
            },
            h('input', { name: 'username', required: true, maxlength: 31, placeholder: 'their username', 'aria-label': 'Partner username', autocomplete: 'off' }),
            h('button', { type: 'submit', class: 'primary' }, 'Send request'),
            h('p', { class: 'error', role: 'alert' }),
          ),
          outgoing.length > 0 &&
            h(
              'ul',
              { class: 'items' },
              outgoing.map((p) =>
                h(
                  'li',
                  {},
                  h('span', { class: 'grow muted' }, `Waiting for @${p.partner.username} to accept`),
                  h('button', { class: 'link danger', onclick: () => remove(p) }, 'Cancel'),
                ),
              ),
            ),
        ),
      ),
    );
  }

  await render();
}

// ---------- Partner page ----------

async function viewPartner(main, id) {
  let { partnership: p } = await api('GET', `/api/partnerships/${id}`);
  if (p.status !== 'active') {
    main.replaceChildren(
      h('div', { class: 'notice' }, p.status === 'pending' ? 'This request hasn’t been accepted yet.' : 'This partnership has ended.', ' ', h('a', { href: '#/partners' }, 'Back to partners')),
    );
    return;
  }
  const partner = p.partner;
  const base = `/api/partnerships/${id}`;
  let lastMessageId = 0;

  const statusBox = h('div', { class: 'grid' });
  const goalsBox = h('div', {});
  const tasksBox = h('div', {});
  const tasksHead = h('h2', {}, 'Their plan for today');
  const historyBox = h('div', {});
  const chatLog = h('div', { class: 'log', 'aria-live': 'polite' });
  const theirTime = h('span', {}, localTime(partner.timezone));

  function renderStatus() {
    const s = checkinSummary(p);
    statusBox.replaceChildren(
      h('div', { class: `notice ${p.checkins.me.isDue ? '' : 'ok'}` }, s.mine),
      h('div', { class: `notice ${p.checkins.partner.isDue ? '' : 'ok'}` }, s.theirs),
    );
  }

  async function loadStatus() {
    p = (await api('GET', base)).partnership;
    renderStatus();
  }

  async function loadGoals() {
    const { goals } = await api('GET', `${base}/goals`);
    goalsBox.replaceChildren(...goalGroups(goals, { editable: false, today: weekRefToday(), reload: loadGoals, nested: true }));
    applyWidths(goalsBox);
  }

  let partnerToday = null;
  const weekRefToday = () => partnerToday ?? state.today;

  async function loadTasks() {
    const data = await api('GET', `${base}/tasks`);
    partnerToday = data.today;
    const done = data.tasks.filter((t) => t.done).length;
    tasksHead.textContent = `Their plan for today · ${fmtDay(data.today, { weekday: 'short', month: 'short', day: 'numeric' })}`;
    tasksBox.replaceChildren(
      data.tasks.length ? h('p', { class: 'muted small' }, `${done}/${data.tasks.length} done`) : '',
      taskList(data.tasks, { editable: false }),
    );
  }

  async function loadHistory() {
    const { checkins } = await api('GET', `${base}/checkins`);
    historyBox.replaceChildren(
      ...(checkins.length === 0
        ? [h('p', { class: 'empty' }, 'No check-ins yet.')]
        : checkins.map((c) =>
            h(
              'div',
              { class: 'checkin' },
              h(
                'div',
                { class: 'card-head' },
                h('strong', {}, `${MOODS[c.mood]} ${c.userId === state.user.id ? 'You' : partner.displayName}`),
                h('span', { class: 'muted small', title: fmtDateTime(c.createdAt) }, relative(c.createdAt)),
              ),
              h(
                'dl',
                {},
                c.wins && [h('dt', {}, 'Wins'), h('dd', {}, c.wins)],
                c.struggles && [h('dt', {}, 'Struggles'), h('dd', {}, c.struggles)],
                c.nextFocus && [h('dt', {}, 'Next'), h('dd', {}, c.nextFocus)],
              ),
            ),
          )),
    );
  }

  async function loadMessages() {
    const { messages } = await api('GET', lastMessageId ? `${base}/messages?after=${lastMessageId}` : `${base}/messages`);
    if (!lastMessageId) chatLog.replaceChildren();
    if (!messages.length && !lastMessageId) chatLog.append(h('p', { class: 'empty' }, `Say hi to ${partner.displayName}!`));
    if (messages.length) chatLog.querySelector('.empty')?.remove();
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    for (const m of messages) {
      chatLog.append(
        h('div', { class: `bubble ${m.userId === state.user.id ? 'mine' : ''}` }, m.body, h('time', { datetime: m.createdAt, title: fmtDateTime(m.createdAt) }, relative(m.createdAt))),
      );
      lastMessageId = Math.max(lastMessageId, m.id);
    }
    if (messages.length && (atBottom || messages.some((m) => m.userId === state.user.id))) chatLog.scrollTop = chatLog.scrollHeight;
  }

  const checkinForm = h(
    'form',
    {
      onsubmit: onSubmit(async (f) => {
        const mood = f.querySelector('input[name="mood"]:checked');
        if (!mood) throw new Error('Pick how you’re feeling');
        await api('POST', `${base}/checkins`, {
          mood: Number(mood.value),
          wins: f.wins.value,
          struggles: f.struggles.value,
          nextFocus: f.nextFocus.value,
        });
        f.reset();
        await Promise.all([loadHistory(), loadStatus(), refreshPartnerships()]);
      }),
    },
    h(
      'fieldset',
      { class: 'field' },
      h('legend', { class: 'muted small' }, 'How are you doing?'),
      h(
        'div',
        { class: 'moods' },
        Object.entries(MOODS).map(([value, emoji]) =>
          h('label', { title: `${value} of 5` }, h('input', { type: 'radio', name: 'mood', value }), h('span', {}, emoji)),
        ),
      ),
    ),
    h('div', { class: 'field' }, h('label', { for: 'ci-wins' }, 'What went well / what did you get done?'), h('textarea', { id: 'ci-wins', name: 'wins', maxlength: 2000 })),
    h('div', { class: 'field' }, h('label', { for: 'ci-struggles' }, 'What got in the way?'), h('textarea', { id: 'ci-struggles', name: 'struggles', maxlength: 2000 })),
    h('div', { class: 'field' }, h('label', { for: 'ci-next' }, 'What will you focus on until the next check-in?'), h('textarea', { id: 'ci-next', name: 'nextFocus', maxlength: 2000 })),
    h('button', { type: 'submit', class: 'primary' }, 'Post check-in'),
    h('p', { class: 'error', role: 'alert' }),
  );

  const chatForm = h(
    'form',
    {
      class: 'inline',
      onsubmit: onSubmit(async (f) => {
        await api('POST', `${base}/messages`, { body: f.body.value });
        f.reset();
        await loadMessages();
        f.body.focus();
      }),
    },
    h('input', { name: 'body', required: true, maxlength: 2000, placeholder: 'Encourage, ask, nudge…', 'aria-label': 'Message', autocomplete: 'off' }),
    h('button', { type: 'submit', class: 'primary' }, 'Send'),
    h('p', { class: 'error', role: 'alert' }),
  );

  const intervalSelect = h(
    'select',
    {
      'aria-label': 'Check-in frequency',
      onchange: (e) => act(async () => {
        p = (await api('PATCH', base, { checkinIntervalDays: Number(e.target.value) })).partnership;
        renderStatus();
        await refreshPartnerships();
      }),
    },
    [1, 2, 3, 7, 14].map((d) =>
      h('option', { value: d, selected: p.checkinIntervalDays === d }, d === 1 ? 'every day' : d === 7 ? 'every week' : d === 14 ? 'every 2 weeks' : `every ${d} days`),
    ),
  );
  if (![1, 2, 3, 7, 14].includes(p.checkinIntervalDays)) {
    intervalSelect.append(h('option', { value: p.checkinIntervalDays, selected: true }, `every ${p.checkinIntervalDays} days`));
  }

  main.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'partner-head' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(partner.displayName)),
        h(
          'div',
          { class: 'grow' },
          h('h1', {}, partner.displayName),
          h('span', { class: 'muted small' }, `@${partner.username} · `, theirTime, ` their time (${partner.timezone})`),
        ),
        h('label', { class: 'small' }, 'Check in ', intervalSelect),
        h(
          'button',
          {
            class: 'link danger',
            onclick: () => {
              if (!confirm(`End your partnership with ${partner.displayName}? They will no longer see your goals and plans.`)) return;
              act(async () => {
                await api('DELETE', base);
                location.hash = '#/partners';
              });
            },
          },
          'End partnership',
        ),
      ),
      statusBox,
      h(
        'div',
        { class: 'grid' },
        h('section', { class: 'card' }, tasksHead, tasksBox),
        h('section', { class: 'card' }, h('h2', {}, `${partner.displayName}'s goals`), goalsBox),
      ),
      h(
        'div',
        { class: 'grid' },
        h('section', { class: 'card' }, h('h2', {}, 'Check in'), checkinForm, h('h3', {}, 'History'), historyBox),
        h('section', { class: 'card chat' }, h('h2', {}, 'Catch up'), chatLog, chatForm),
      ),
    ),
  );

  renderStatus();
  await Promise.all([loadTasks(), loadMessages(), loadHistory()]);
  await loadGoals();

  every(15_000, async () => {
    theirTime.textContent = localTime(partner.timezone);
    await Promise.all([loadMessages(), loadTasks(), loadHistory(), loadStatus(), loadGoals()]);
  });
}

// ---------- Settings ----------

function viewSettings(main) {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers: fall back to a free-text field.
  }
  if (zones.length && !zones.includes(state.user.timezone)) zones = [state.user.timezone, ...zones];
  const tzField = zones.length
    ? h('select', { id: 's-tz', name: 'timezone' }, zones.map((z) => h('option', { value: z, selected: z === state.user.timezone }, z)))
    : h('input', { id: 's-tz', name: 'timezone', value: state.user.timezone });

  main.replaceChildren(
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Settings'),
      h(
        'form',
        {
          onsubmit: onSubmit(async (f) => {
            const data = await api('PATCH', '/api/me', { displayName: f.displayName.value, timezone: f.timezone.value });
            state.user = data.user;
            state.today = data.today;
            f.querySelector('.error').textContent = '';
            route();
          }),
        },
        h('p', { class: 'muted small' }, `Username: @${state.user.username}`),
        h('div', { class: 'field' }, h('label', { for: 's-name' }, 'Display name'), h('input', { id: 's-name', name: 'displayName', value: state.user.displayName, maxlength: 60, required: true })),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 's-tz' }, 'Timezone — decides when your “today” starts'),
          tzField,
          browserTimezone() !== state.user.timezone && h('p', { class: 'muted small' }, `Your device says ${browserTimezone()}.`),
        ),
        h('button', { type: 'submit', class: 'primary' }, 'Save'),
        h('p', { class: 'error', role: 'alert' }),
      ),
    ),
  );
}

// ---------- boot ----------

window.addEventListener('hashchange', route);

(async () => {
  try {
    await loadMe();
  } catch {
    state.user = null;
  }
  route();
})();
