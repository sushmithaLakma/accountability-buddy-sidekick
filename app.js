(function () {
  'use strict';

  var STORAGE_KEY = 'accountability-buddy:v1';
  // A step that has been waiting longer than this gets a gentle nudge.
  var LONG_WAIT_MS = 30 * 60 * 1000;

  // ---------- State ----------

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.days === 'object') return parsed;
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    return { days: {} };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* storage unavailable: keep working in memory */ }
  }

  var state = loadState();
  var currentDay = dayKey(new Date());

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function dayKey(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function parseDayKey(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function shiftDay(key, delta) {
    var d = parseDayKey(key);
    d.setDate(d.getDate() + delta);
    return dayKey(d);
  }

  function getDay(key) {
    if (!state.days[key]) state.days[key] = { goals: [] };
    return state.days[key];
  }

  function findGoal(goalId) {
    return getDay(currentDay).goals.find(function (g) { return g.id === goalId; });
  }

  function findStep(goalId, stepId) {
    var goal = findGoal(goalId);
    return goal && goal.steps.find(function (s) { return s.id === stepId; });
  }

  // ---------- Derived values ----------

  function stepStatus(step) {
    if (step.completedAt) return 'done';
    if (step.startedAt) return 'in-progress';
    return 'not-started';
  }

  function goalStatus(goal) {
    if (goal.steps.length === 0) return goal.completedAt ? 'done' : 'not-started';
    var statuses = goal.steps.map(stepStatus);
    if (statuses.every(function (s) { return s === 'done'; })) return 'done';
    if (statuses.some(function (s) { return s !== 'not-started'; })) return 'in-progress';
    return 'not-started';
  }

  function goalProgress(goal) {
    if (goal.steps.length === 0) return goal.completedAt ? 1 : 0;
    var done = goal.steps.filter(function (s) { return s.completedAt; }).length;
    return done / goal.steps.length;
  }

  function timeToStart(step) {
    return step.startedAt ? step.startedAt - step.createdAt : null;
  }

  function timeSpent(step, now) {
    if (!step.startedAt) return null;
    return (step.completedAt || now) - step.startedAt;
  }

  // The first unfinished step across all goals, in the order they were added.
  function nextStep(day) {
    for (var i = 0; i < day.goals.length; i++) {
      var goal = day.goals[i];
      var active = goal.steps.find(function (s) { return stepStatus(s) === 'in-progress'; });
      if (active) return { goal: goal, step: active };
    }
    for (var j = 0; j < day.goals.length; j++) {
      var g = day.goals[j];
      var waiting = g.steps.find(function (s) { return stepStatus(s) === 'not-started'; });
      if (waiting) return { goal: g, step: waiting };
    }
    return null;
  }

  // ---------- Formatting ----------

  function formatDuration(ms) {
    if (ms == null) return '—';
    var totalMin = Math.max(0, Math.round(ms / 60000));
    if (totalMin < 1) return '<1m';
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h === 0) return m + 'm';
    return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
  }

  function formatClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDayLabel(key) {
    var today = dayKey(new Date());
    if (key === today) return 'Today';
    if (key === shiftDay(today, -1)) return 'Yesterday';
    if (key === shiftDay(today, 1)) return 'Tomorrow';
    return parseDayKey(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  var STATUS_LABEL = { 'not-started': 'Not started', 'in-progress': 'In progress', 'done': 'Done' };

  // ---------- DOM helper ----------

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  // ---------- Parsing input ----------

  // "Write intro | 25" -> { title: "Write intro", estimate: 25 }
  function parseStepLine(line) {
    var parts = line.split('|');
    var title = parts[0].trim();
    var estimate = null;
    if (parts.length > 1) {
      var n = parseInt(parts[1], 10);
      if (n > 0) estimate = n;
    }
    return title ? { title: title, estimate: estimate } : null;
  }

  function makeStep(title, estimate) {
    return { id: uid(), title: title, estimate: estimate || null, createdAt: Date.now(), startedAt: null, completedAt: null };
  }

  // ---------- Actions ----------

  function addGoal(title, stepsText) {
    var steps = stepsText.split('\n').map(parseStepLine).filter(Boolean)
      .map(function (s) { return makeStep(s.title, s.estimate); });
    getDay(currentDay).goals.push({ id: uid(), title: title, createdAt: Date.now(), completedAt: null, steps: steps });
    commit();
  }

  function addStep(goalId, title, estimate) {
    var goal = findGoal(goalId);
    if (!goal) return;
    goal.steps.push(makeStep(title, estimate));
    goal.completedAt = null;
    commit();
  }

  function startStep(goalId, stepId) {
    var step = findStep(goalId, stepId);
    if (!step || step.startedAt) return;
    step.startedAt = Date.now();
    commit();
  }

  function finishStep(goalId, stepId) {
    var step = findStep(goalId, stepId);
    if (!step) return;
    var now = Date.now();
    // Finishing without pressing Start first counts as starting right now.
    if (!step.startedAt) step.startedAt = now;
    step.completedAt = now;
    commit();
  }

  function resetStep(goalId, stepId) {
    var step = findStep(goalId, stepId);
    if (!step) return;
    step.startedAt = null;
    step.completedAt = null;
    commit();
  }

  function deleteStep(goalId, stepId) {
    var goal = findGoal(goalId);
    if (!goal) return;
    goal.steps = goal.steps.filter(function (s) { return s.id !== stepId; });
    commit();
  }

  function toggleGoalDone(goalId) {
    var goal = findGoal(goalId);
    if (!goal) return;
    goal.completedAt = goal.completedAt ? null : Date.now();
    commit();
  }

  function deleteGoal(goalId) {
    var day = getDay(currentDay);
    var goal = findGoal(goalId);
    if (!goal) return;
    if (goal.steps.length && !confirm('Delete "' + goal.title + '" and its ' + goal.steps.length + ' step(s)?')) return;
    day.goals = day.goals.filter(function (g) { return g.id !== goalId; });
    commit();
  }

  function previousDayWithUnfinished() {
    var keys = Object.keys(state.days).filter(function (k) { return k < currentDay; }).sort().reverse();
    for (var i = 0; i < keys.length; i++) {
      var unfinished = state.days[keys[i]].goals.filter(function (g) { return goalStatus(g) !== 'done'; });
      if (unfinished.length) return { key: keys[i], goals: unfinished };
    }
    return null;
  }

  function carryOver() {
    var prev = previousDayWithUnfinished();
    if (!prev) return;
    var now = Date.now();
    var day = getDay(currentDay);
    prev.goals.forEach(function (g) {
      var steps = g.steps.filter(function (s) { return !s.completedAt; }).map(function (s) {
        // Steps restart today, so time-to-start is measured from now.
        return { id: uid(), title: s.title, estimate: s.estimate, createdAt: now, startedAt: null, completedAt: null };
      });
      day.goals.push({ id: uid(), title: g.title, createdAt: now, completedAt: null, steps: steps, carriedFrom: prev.key });
    });
    commit();
  }

  function commit() {
    saveState();
    render();
  }

  // ---------- Rendering ----------

  var els = {
    summary: document.getElementById('summary'),
    nextUp: document.getElementById('next-up'),
    goals: document.getElementById('goals'),
    dayLabel: document.getElementById('today-btn'),
    carryOver: document.getElementById('carry-over')
  };

  function renderSummary(day, now) {
    var steps = [];
    day.goals.forEach(function (g) { steps = steps.concat(g.steps); });
    var doneSteps = steps.filter(function (s) { return s.completedAt; });
    var started = steps.filter(function (s) { return s.startedAt; });
    var avgStart = started.length
      ? started.reduce(function (sum, s) { return sum + timeToStart(s); }, 0) / started.length
      : null;
    var focus = started.reduce(function (sum, s) { return sum + timeSpent(s, now); }, 0);
    var goalsDone = day.goals.filter(function (g) { return goalStatus(g) === 'done'; }).length;

    function stat(value, label) {
      return h('div', { class: 'stat' }, h('div', { class: 'value', text: value }), h('div', { class: 'label', text: label }));
    }

    els.summary.replaceChildren(
      stat(goalsDone + '/' + day.goals.length, 'Goals done'),
      stat(doneSteps.length + '/' + steps.length, 'Steps done'),
      stat(formatDuration(avgStart), 'Avg. time to start'),
      stat(formatDuration(started.length ? focus : null), 'Time on tasks')
    );
  }

  function renderNextUp(day, now) {
    var next = nextStep(day);
    els.nextUp.className = 'next-up';
    if (!next) { els.nextUp.replaceChildren(); return; }

    var step = next.step;
    var inProgress = stepStatus(step) === 'in-progress';
    var meta;
    if (inProgress) {
      meta = 'Working for ' + formatDuration(now - step.startedAt) +
        (step.estimate ? ' of ~' + step.estimate + 'm' : '');
    } else {
      var waited = now - step.createdAt;
      meta = 'Waiting ' + formatDuration(waited) + ' to start' +
        (step.estimate ? ' · ~' + step.estimate + 'm' : '');
      if (waited > LONG_WAIT_MS) els.nextUp.className = 'next-up waiting-long';
    }

    els.nextUp.replaceChildren(
      h('div', null,
        h('div', { class: 'kicker', text: inProgress ? 'Doing now' : 'Next small step' }),
        h('div', { class: 'title', text: step.title }),
        h('div', { class: 'meta', text: next.goal.title + ' · ' + meta })
      ),
      inProgress
        ? h('button', { class: 'btn finish', type: 'button', text: 'Mark done', onclick: function () { finishStep(next.goal.id, step.id); } })
        : h('button', { class: 'btn primary', type: 'button', text: 'Start it now', onclick: function () { startStep(next.goal.id, step.id); } })
    );
  }

  function renderStep(goal, step, now, isNext) {
    var status = stepStatus(step);
    var meta = [];

    if (step.estimate) meta.push(h('span', { text: 'Est. ' + step.estimate + 'm' }));

    if (status === 'not-started') {
      meta.push(h('span', { text: 'Added ' + formatClock(step.createdAt) + ' · waiting ' + formatDuration(now - step.createdAt) }));
    } else {
      meta.push(h('span', { text: 'Took ' + formatDuration(timeToStart(step)) + ' to start' }));
      var spent = timeSpent(step, now);
      var over = step.estimate && spent > step.estimate * 60000;
      if (status === 'in-progress') {
        meta.push(h('span', { class: over ? 'over' : 'live', text: 'In progress ' + formatDuration(spent) }));
      } else {
        meta.push(h('span', { class: over ? 'over' : null, text: 'Done in ' + formatDuration(spent) + ' (at ' + formatClock(step.completedAt) + ')' }));
      }
    }

    var controls = h('div', { class: 'step-controls' },
      h('span', { class: 'badge ' + status, text: STATUS_LABEL[status] }),
      status === 'not-started' && h('button', { class: 'btn small start', type: 'button', text: 'Start', onclick: function () { startStep(goal.id, step.id); } }),
      status === 'in-progress' && h('button', { class: 'btn small finish', type: 'button', text: 'Done', onclick: function () { finishStep(goal.id, step.id); } }),
      status === 'done' && h('button', { class: 'btn small', type: 'button', text: 'Undo', onclick: function () { resetStep(goal.id, step.id); } }),
      h('button', { class: 'x-btn', type: 'button', 'aria-label': 'Delete step ' + step.title, text: '×', onclick: function () { deleteStep(goal.id, step.id); } })
    );

    return h('li', { class: 'step ' + status + (isNext ? ' next' : '') },
      h('div', { class: 'step-title', text: step.title }),
      controls,
      h('div', { class: 'step-meta' }, ...meta)
    );
  }

  function renderGoal(goal, now, next) {
    var status = goalStatus(goal);
    var pct = Math.round(goalProgress(goal) * 100);
    var doneCount = goal.steps.filter(function (s) { return s.completedAt; }).length;
    var estTotal = goal.steps.reduce(function (sum, s) { return sum + (s.estimate || 0); }, 0);
    var estLeft = goal.steps.reduce(function (sum, s) { return sum + (s.completedAt ? 0 : (s.estimate || 0)); }, 0);

    var progressText = goal.steps.length
      ? doneCount + ' of ' + goal.steps.length + ' steps · ' + pct + '%' +
        (estTotal ? ' · ~' + estLeft + 'm left of ' + estTotal + 'm' : '')
      : 'No steps yet. Break it down below, or mark the whole goal done.';
    if (goal.carriedFrom) progressText += ' · carried over from ' + formatDayLabel(goal.carriedFrom);

    var titleInput = h('input', { type: 'text', placeholder: 'Add a smaller step…', maxlength: '140', 'aria-label': 'New step for ' + goal.title });
    var estInput = h('input', { type: 'number', min: '1', max: '600', placeholder: 'min', 'aria-label': 'Estimated minutes' });
    var form = h('form', { class: 'add-step', autocomplete: 'off', onsubmit: function (e) {
      e.preventDefault();
      var title = titleInput.value.trim();
      if (!title) return;
      addStep(goal.id, title, parseInt(estInput.value, 10) || null);
      var refocus = document.querySelector('[data-goal="' + goal.id + '"] .add-step input[type="text"]');
      if (refocus) refocus.focus();
    } }, titleInput, estInput, h('button', { class: 'btn small', type: 'submit', text: 'Add' }));

    return h('article', { class: 'card goal', 'data-goal': goal.id },
      h('div', { class: 'goal-header' },
        h('div', null,
          h('h3', { class: 'goal-title' + (status === 'done' ? ' done' : ''), text: goal.title }),
          h('span', { class: 'badge ' + status, text: STATUS_LABEL[status] })
        ),
        h('div', { class: 'goal-actions' },
          goal.steps.length === 0 && h('button', { class: 'btn small', type: 'button', text: goal.completedAt ? 'Undo' : 'Done', onclick: function () { toggleGoalDone(goal.id); } }),
          h('button', { class: 'x-btn', type: 'button', 'aria-label': 'Delete goal ' + goal.title, text: '×', onclick: function () { deleteGoal(goal.id); } })
        )
      ),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
        h('div', { style: 'width:' + pct + '%' })),
      h('div', { class: 'progress-text', text: progressText }),
      h('ul', { class: 'steps' }, ...goal.steps.map(function (s) {
        return renderStep(goal, s, now, next && next.step.id === s.id);
      })),
      form
    );
  }

  function render() {
    var now = Date.now();
    var day = getDay(currentDay);
    var next = nextStep(day);

    els.dayLabel.textContent = formatDayLabel(currentDay);
    els.carryOver.hidden = !previousDayWithUnfinished();

    renderSummary(day, now);
    renderNextUp(day, now);

    if (day.goals.length === 0) {
      els.goals.replaceChildren(h('p', { class: 'empty', text: 'No goals for this day yet. Add one above and split it into steps small enough to start in under 5 minutes.' }));
    } else {
      els.goals.replaceChildren(...day.goals.map(function (g) { return renderGoal(g, now, next); }));
    }
  }

  // Refresh live timers without wiping what the user is typing.
  function tick() {
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.closest('#goals')) {
      var now = Date.now();
      var day = getDay(currentDay);
      renderSummary(day, now);
      renderNextUp(day, now);
      return;
    }
    render();
  }

  // ---------- Wiring ----------

  document.getElementById('goal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var titleEl = document.getElementById('goal-title');
    var stepsEl = document.getElementById('goal-steps');
    var title = titleEl.value.trim();
    if (!title) return;
    addGoal(title, stepsEl.value);
    titleEl.value = '';
    stepsEl.value = '';
    titleEl.focus();
  });

  document.getElementById('prev-day').addEventListener('click', function () { currentDay = shiftDay(currentDay, -1); render(); });
  document.getElementById('next-day').addEventListener('click', function () { currentDay = shiftDay(currentDay, 1); render(); });
  els.dayLabel.addEventListener('click', function () { currentDay = dayKey(new Date()); render(); });
  els.carryOver.addEventListener('click', carryOver);

  document.getElementById('export-btn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = h('a', { href: URL.createObjectURL(blob), download: 'accountability-buddy-' + dayKey(new Date()) + '.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('import-input').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed.days !== 'object') throw new Error('bad file');
      if (!confirm('Replace your current data with this file?')) return;
      state = parsed;
      commit();
    }).catch(function () {
      alert('That file could not be imported.');
    }).finally(function () { e.target.value = ''; });
  });

  render();
  setInterval(tick, 30 * 1000);
})();
