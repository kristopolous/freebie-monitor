const STORAGE_KEY = 'freebie-monitor-profile-id';

const state = {
  profileId: null,
  answers: {},
  deals: [],
};

const views = {
  onboard: document.getElementById('view-onboard'),
  settings: document.getElementById('view-settings'),
  pipeline: document.getElementById('view-pipeline'),
  deals: document.getElementById('view-deals'),
  brain: document.getElementById('view-brain'),
  calendar: document.getElementById('view-calendar'),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

// ---- question form (shared by onboarding + settings) ----

const QUESTIONS = [
  { field: 'ownsHome', legend: 'Do you own a home?', options: [['true', 'Yes'], ['false', 'No']] },
  {
    field: 'flightsPerYear',
    legend: 'How often do you fly?',
    options: [['none', 'Rarely'], ['a-few', 'A few times a year'], ['frequent', 'Frequently']],
  },
  {
    field: 'idleCashBracket',
    legend: 'How much cash is sitting idle, earning close to nothing?',
    options: [
      ['none', 'None to speak of'],
      ['under-10k', 'Under $10k'],
      ['10k-50k', '$10k–$50k'],
      ['50k-plus', '$50k+'],
    ],
  },
  {
    field: 'bigBoxShopper',
    legend: "Do you shop at big-box stores — Lowe's, Home Depot, and the like?",
    options: [['true', 'Yes'], ['false', 'No']],
  },
  {
    field: 'openToNewAccounts',
    legend: 'Open to opening a new account or card for a bonus?',
    options: [['true', 'Yes'], ['false', 'No, existing accounts only']],
  },
  {
    field: 'primaryGoal',
    legend: 'What are you mainly after?',
    options: [['travel', 'Travel'], ['cashback', 'Cash back'], ['either', 'Either works']],
  },
];
const REQUIRED_FIELDS = QUESTIONS.map((q) => q.field);

// A neutral baseline used to show Drops immediately on first visit, before
// anyone answers anything — the survey is a filter you apply from Settings
// to narrow/reorder results toward your real situation, never a gate that
// blocks seeing anything in the first place.
const DEFAULT_ANSWERS = {
  ownsHome: false,
  flightsPerYear: 'none',
  idleCashBracket: 'none',
  bigBoxShopper: false,
  openToNewAccounts: true,
  primaryGoal: 'either',
};

function parseChipValue(raw) {
  return raw === 'true' ? true : raw === 'false' ? false : raw;
}

/** Renders the question set into `container`, pre-selecting `initial`, and keeps `answersRef` in sync as the person clicks. */
function buildQuestionFields(container, initial, answersRef, onChange) {
  container.innerHTML = QUESTIONS.map(
    (q) => `
    <fieldset class="question">
      <legend>${q.legend}</legend>
      <div class="chip-row" data-field="${q.field}">
        ${q.options.map(([v, l]) => `<button type="button" class="chip" data-value="${v}">${l}</button>`).join('')}
      </div>
    </fieldset>
  `,
  ).join('');

  for (const row of container.querySelectorAll('.chip-row')) {
    const field = row.dataset.field;
    if (field in initial) {
      const btn = row.querySelector(`.chip[data-value="${String(initial[field])}"]`);
      if (btn) btn.classList.add('is-selected');
    }
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      for (const c of row.querySelectorAll('.chip')) c.classList.remove('is-selected');
      btn.classList.add('is-selected');
      answersRef[field] = parseChipValue(btn.dataset.value);
      onChange();
    });
  }
}

// ---- tiers ----

function tierFor(relevanceScore) {
  if (relevanceScore >= 80) return { label: 'LEGENDARY', varName: '--gold' };
  if (relevanceScore >= 60) return { label: 'RARE', varName: '--hot' };
  return { label: 'COMMON', varName: '--common' };
}

// ---- masthead / status ----

async function loadStatus() {
  try {
    const res = await fetch('api/status');
    const s = await res.json();
    document.getElementById('statusbar').innerHTML = [
      ['Cognee', s.cognee],
      ['Bright Data', s.brightData],
      ['Model', s.model],
      ['Docker', s.docker],
    ]
      .map(([label, val]) => `<span>${label}: <b>${val}</b></span>`)
      .join('');
  } catch {
    // status bar is a nice-to-have; a failed fetch shouldn't block anything
  }
}

async function refreshScoreTotal() {
  if (!state.profileId) return;
  try {
    const res = await fetch(`api/commitments?profileId=${state.profileId}`);
    const { commitments } = await res.json();
    // Only what's actually been earned (every ticket complete) counts —
    // "tracking" is intent, not money in hand yet.
    const total = commitments.filter((c) => c.status === 'fulfilled').reduce((sum, c) => sum + c.personalValueUsd, 0);
    document.getElementById('scoreTotal').textContent = `$${total.toLocaleString()}`;
  } catch {
    // non-critical
  }
}

// ---- onboarding ----

const startBtn = document.getElementById('startBtn');

function checkOnboardComplete() {
  startBtn.disabled = !REQUIRED_FIELDS.every((f) => f in state.answers);
}

document.getElementById('onboardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showView('pipeline');
  animatePipeline(['scout', 'matcher']);
  document.getElementById('pipelineStatus').textContent = 'Booting up your monitor…';

  const res = await fetch('api/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.answers),
  });
  const { profile } = await res.json();
  state.profileId = profile.id;
  localStorage.setItem(STORAGE_KEY, profile.id);

  document.getElementById('mainNav').hidden = false;
  await fetchDeals();
  await refreshScoreTotal();
});

// ---- settings ----

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`api/profile/${state.profileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.answers),
  });
  const { profile } = await res.json();
  state.answers = profile.answers;

  showView('pipeline');
  animatePipeline(['scout', 'matcher']);
  document.getElementById('pipelineStatus').textContent = 'Re-scanning with your changes…';
  await fetchDeals();
  setActiveNav('deals');
  syncViewToUrl('deals');
});

function openSettings() {
  buildQuestionFields(document.getElementById('settingsFields'), state.answers, state.answers, () => {});
  showView('settings');
}

// ---- pipeline animation ----

function animatePipeline(order) {
  const nodes = document.querySelectorAll('.pipeline__node');
  for (const n of nodes) n.classList.remove('is-active', 'is-done');
  order.forEach((name, i) => {
    setTimeout(() => {
      const node = document.querySelector(`[data-node="${name}"]`);
      node.classList.add('is-active');
      if (i > 0) {
        const prev = document.querySelector(`[data-node="${order[i - 1]}"]`);
        prev.classList.remove('is-active');
        prev.classList.add('is-done');
      }
    }, i * 650);
  });
}

// ---- deals / drops ----

async function fetchDeals() {
  document.getElementById('pipelineStatus').textContent = 'Scanning for free money…';
  const res = await fetch(`api/deals?profileId=${state.profileId}`);
  const { deals } = await res.json();
  state.deals = deals;
  renderDeals();
  showView('deals');
  setActiveNav('deals');
}

function renderDeals() {
  const grid = document.getElementById('dealsGrid');
  const summary = document.getElementById('dealsSummary');

  if (state.deals.length === 0) {
    summary.textContent = "Nothing worth chasing — you said you're not open to new accounts, so there's nothing here to grab.";
    grid.innerHTML = '';
    return;
  }

  const worthIt = state.deals.filter((d) => d.relevanceScore >= 50);
  summary.textContent = `${state.deals.length} drops found this week. ${worthIt.length} are actually worth grabbing.`;

  grid.innerHTML = state.deals
    .map((d) => {
      const tier = tierFor(d.relevanceScore);
      return `
    <article class="deal-card" style="--tier-color: var(${tier.varName})">
      <span class="deal-card__tier">${tier.label}</span>
      <span class="deal-card__institution">${escapeHtml(d.institution)}</span>
      <h3 class="deal-card__title">${escapeHtml(d.title)}</h3>
      <div class="deal-card__value">$${d.personalValueUsd.toLocaleString()}</div>
      <p class="deal-card__reasoning">${escapeHtml(d.reasoning)}</p>
      <div class="deal-card__rule">
        <span class="deal-card__rule-label">The rule</span>
        <p class="deal-card__rule-text">${escapeHtml(d.requirement)}</p>
      </div>
      <button class="btn btn--secondary" data-track="${d.id}">I'm doing this</button>
    </article>
  `;
    })
    .join('');

  grid.querySelectorAll('[data-track]').forEach((btn) => {
    btn.addEventListener('click', () => trackDeal(btn.dataset.track));
  });
}

async function trackDeal(dealId) {
  const deal = state.deals.find((d) => d.id === dealId);
  if (!deal) return;

  showView('pipeline');
  document.getElementById('pipelineStatus').textContent = `Building your tickets for ${deal.title}…`;
  animatePipeline(['strategist', 'actor']);

  const res = await fetch('api/deals/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: state.profileId, deal }),
  });
  const { commitment } = await res.json();

  showView('deals');
  openTrackedDetail(deal, commitment);
  refreshScoreTotal();
}

function fireScorePop(value) {
  const layer = document.getElementById('scorePopLayer');
  const pop = document.getElementById('scorePop');
  pop.textContent = `+$${value.toLocaleString()} LOCKED IN`;
  layer.hidden = false;
  pop.classList.remove('is-popping');
  void pop.offsetWidth; // restart animation
  pop.classList.add('is-popping');
  setTimeout(() => (layer.hidden = true), 1600);
}

function openTrackedDetail(deal, commitment) {
  const plan = commitment.plan;
  const days = Math.max(0, Math.round((new Date(plan.deadline) - new Date()) / 86400000));

  document.getElementById('claimDialogContent').innerHTML = `
    <div class="claim-detail">
      <h3>${escapeHtml(deal.title)}</h3>
      <p class="claim-detail__sub">${escapeHtml(deal.institution)} · due in ${days} days · your agent is tracking it now</p>
      <ol class="claim-detail__steps">
        ${plan.tickets.map((t) => `<li>${escapeHtml(t.title)}</li>`).join('')}
      </ol>
      <p class="claim-detail__hint">Go do these yourself, then check them off under <b>To-Do</b> as you go.</p>
      <div class="claim-detail__artifact">${escapeHtml(plan.artifact.content)}</div>
      <details class="claim-detail__log-toggle">
        <summary>Technical proof (Docker sandbox log)</summary>
        <div class="claim-detail__log">${escapeHtml(plan.sandboxLog || '(no log)')}</div>
      </details>
    </div>
  `;
  document.getElementById('claimDialog').showModal();
}

document.getElementById('closeDialog').addEventListener('click', () => {
  document.getElementById('claimDialog').close();
});

// Closing the confirmation (via the button, Esc, or a backdrop click) should
// land you on the tickets you just committed to, not back on the deal shelf.
document.getElementById('claimDialog').addEventListener('close', () => {
  navigateTo('brain');
});

// ---- docket ("your brain") ----

const STATUS_LABEL = { tracking: 'IN PROGRESS', fulfilled: 'SCORED', missed: 'MISSED', cancelled: 'CANCELLED' };

function isTicketComplete(t) {
  if (t.kind === 'target') return (t.currentAmount ?? 0) >= (t.targetAmount ?? Infinity);
  if (t.kind === 'action') return Boolean(t.done);
  return true;
}

async function fetchDocket() {
  const res = await fetch(`api/commitments?profileId=${state.profileId}`);
  const { commitments } = await res.json();
  renderDocket(commitments);
}

function renderTicket(ticket, index, daysLeft, complete, overdue, locked) {
  const dateLabel = new Date(ticket.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dateSub = locked ? 'backed out' : complete ? 'done' : overdue ? `${dateLabel} · overdue` : `${dateLabel} · ${daysLeft}d left`;

  let body;
  if (ticket.kind === 'action') {
    body = locked
      ? `<span class="ticket-done">${escapeHtml(ticket.title)}</span>`
      : `
      <label class="ticket__check">
        <input type="checkbox" data-toggle="${index}" ${ticket.done ? 'checked' : ''} />
        <span class="${ticket.done ? 'ticket-done' : ''}">${escapeHtml(ticket.title)}</span>
      </label>`;
  } else if (ticket.kind === 'target') {
    const target = ticket.targetAmount ?? 0;
    const current = ticket.currentAmount ?? 0;
    const remaining = Math.max(0, target - current);
    const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    const unit = ticket.unit ?? '$';
    body = `
      <div class="ticket__target">
        <span class="${complete ? 'ticket-done' : ''}">${escapeHtml(ticket.title)}</span>
        <div class="ticket__progress-bar"><div class="ticket__progress-fill" style="width:${pct}%"></div></div>
        <div class="ticket__progress-text">
          ${unit}${current.toLocaleString()} / ${unit}${target.toLocaleString()}${complete ? '' : ` — ${unit}${remaining.toLocaleString()} more`}
        </div>
        ${
          complete || locked
            ? ''
            : `<form class="ticket__report" data-report="${index}">
                 <input type="number" min="0" step="1" placeholder="e.g. ${current || 400}" />
                 <button type="submit" class="btn btn--ghost">I've put in</button>
               </form>`
        }
      </div>`;
  } else {
    body = `<span class="ticket__deadline-label">${escapeHtml(ticket.title)}</span>`;
  }

  return `
    <li class="ticket ticket--${ticket.kind} ${complete ? 'is-complete' : ''} ${overdue ? 'is-overdue' : ''} ${locked ? 'is-locked' : ''}">
      <span class="ticket__dot"></span>
      <div class="ticket__body">
        <div class="ticket__date">${dateSub}</div>
        ${body}
      </div>
    </li>`;
}

function renderDocket(commitments) {
  const list = document.getElementById('docketList');
  if (commitments.length === 0) {
    list.innerHTML = `<p class="docket-empty">Nothing yet. Say you're doing one and it'll show up here.</p>`;
    return;
  }

  const now = Date.now();
  // Active commitments are what you're actually meant to act on — those
  // belong above anything already fulfilled, backed out of, or missed,
  // regardless of deadline order within each group.
  const STATUS_PRIORITY = { tracking: 0, fulfilled: 1, missed: 2, cancelled: 3 };
  const sorted = [...commitments].sort((a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9));

  list.innerHTML = sorted
    .map((c) => {
      const days = Math.round((new Date(c.deadline) - now) / 86400000);
      const deadlineText = days <= 0 ? 'due now' : `${days} day${days === 1 ? '' : 's'} left`;
      const actionable = c.plan.tickets.filter((t) => t.kind !== 'deadline');
      const doneCount = actionable.filter(isTicketComplete).length;

      const locked = c.status === 'cancelled';
      const withIndex = c.plan.tickets.map((t, i) => ({ t, i }));
      withIndex.sort((a, b) => new Date(a.t.deadline) - new Date(b.t.deadline));
      const ticketsHtml = withIndex
        .map(({ t, i }) => {
          const complete = isTicketComplete(t);
          const daysLeft = Math.round((new Date(t.deadline).getTime() - now) / 86400000);
          const overdue = !complete && daysLeft < 0 && t.kind !== 'deadline';
          return renderTicket(t, i, daysLeft, complete, overdue, locked);
        })
        .join('');

      return `
      <div class="docket-item" data-commitment="${c.id}">
        <div class="docket-row">
          <div>
            <div class="docket-row__title">${escapeHtml(c.dealTitle)}</div>
            <div class="docket-row__institution">${escapeHtml(c.institution)} · ${doneCount}/${actionable.length} done</div>
          </div>
          <div class="docket-row__value">$${c.personalValueUsd.toLocaleString()}</div>
          <div class="docket-row__deadline">${deadlineText}</div>
          <div class="docket-row__status docket-row__status--${c.status}">${STATUS_LABEL[c.status] ?? c.status}</div>
          ${c.status === 'tracking' ? `<button type="button" class="btn btn--danger btn--small" data-cancel>Back out</button>` : ''}
          ${c.status === 'cancelled' ? `<button type="button" class="btn btn--ghost btn--small" data-undo>Undo</button>` : ''}
        </div>
        ${c.nag ? `<p class="docket-nag">⚠ ${escapeHtml(c.nag)}</p>` : ''}
        <ul class="ticket-timeline">${ticketsHtml}</ul>
      </div>
    `;
    })
    .join('');

  list.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.docket-item');
      openCancelConfirm(item.dataset.commitment, item.querySelector('.docket-row__title').textContent);
    });
  });

  list.querySelectorAll('[data-undo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.docket-item');
      reactivateCommitment(item.dataset.commitment);
    });
  });

  list.querySelectorAll('[data-toggle]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const item = e.target.closest('.docket-item');
      toggleTicket(item.dataset.commitment, Number(e.target.dataset.toggle), e.target.checked);
    });
  });

  list.querySelectorAll('[data-report]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const item = e.target.closest('.docket-item');
      const input = e.target.querySelector('input[type="number"]');
      const amount = Number(input.value);
      if (Number.isFinite(amount) && amount >= 0) {
        reportProgress(item.dataset.commitment, Number(e.target.dataset.report), amount);
      }
    });
  });
}

async function toggleTicket(commitmentId, ticketIndex, done) {
  const res = await fetch(`api/commitments/${commitmentId}/tickets/${ticketIndex}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done }),
  });
  const { commitment } = await res.json();
  if (commitment.status === 'fulfilled' && done) fireScorePop(commitment.personalValueUsd);
  await fetchDocket();
  await refreshScoreTotal();
}

async function reportProgress(commitmentId, ticketIndex, currentAmount) {
  const res = await fetch(`api/commitments/${commitmentId}/tickets/${ticketIndex}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentAmount }),
  });
  const { commitment } = await res.json();
  if (commitment.status === 'fulfilled') fireScorePop(commitment.personalValueUsd);
  await fetchDocket();
  await refreshScoreTotal();
}

let pendingCancelId = null;

function openCancelConfirm(commitmentId, dealTitle) {
  pendingCancelId = commitmentId;
  document.getElementById('cancelDialogText').textContent =
    `"${dealTitle}" drops off your active list. You can undo this later if you change your mind again.`;
  document.getElementById('cancelDialog').showModal();
}

document.getElementById('cancelDialogNo').addEventListener('click', () => {
  document.getElementById('cancelDialog').close();
});

document.getElementById('cancelDialogYes').addEventListener('click', async () => {
  document.getElementById('cancelDialog').close();
  if (pendingCancelId) await cancelCommitment(pendingCancelId);
  pendingCancelId = null;
});

document.getElementById('closeCancelDialog').addEventListener('click', () => {
  document.getElementById('cancelDialog').close();
});

async function cancelCommitment(commitmentId) {
  await fetch(`api/commitments/${commitmentId}/cancel`, { method: 'POST' });
  await fetchDocket();
}

async function reactivateCommitment(commitmentId) {
  await fetch(`api/commitments/${commitmentId}/reactivate`, { method: 'POST' });
  await fetchDocket();
}

// ---- calendar ----

const calState = { year: new Date().getFullYear(), month: new Date().getMonth(), commitments: [] };

async function openCalendar() {
  const res = await fetch(`api/commitments?profileId=${state.profileId}`);
  const { commitments } = await res.json();
  calState.commitments = commitments;
  renderCalendar();
  showView('calendar');
}

function renderCalendar() {
  const { year, month, commitments } = calState;
  document.getElementById('calMonthLabel').textContent = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const byDate = {};
  for (const c of commitments) {
    for (const t of c.plan.tickets) {
      const key = new Date(t.deadline).toISOString().slice(0, 10);
      const complete = isTicketComplete(t);
      const overdue = !complete && new Date(t.deadline).getTime() < Date.now() && t.kind !== 'deadline';
      const tierVar = complete ? '--money' : overdue ? '--hot' : t.kind === 'deadline' ? '--gold' : '--common';
      (byDate[key] ||= []).push({ label: `${c.institution}: ${t.title}`, tierVar });
    }
  }

  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const todayKey = new Date().toISOString().slice(0, 10);

  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ day: daysInPrevMonth - i, otherMonth: true, key: null });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, otherMonth: false, key: `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
  }
  let trailing = 1;
  while (cells.length % 7 !== 0) cells.push({ day: trailing++, otherMonth: true, key: null });

  document.getElementById('calGrid').innerHTML = cells
    .map((cell) => {
      const items = cell.key ? byDate[cell.key] || [] : [];
      const shown = items.slice(0, 3);
      const overflow = items.length - shown.length;
      return `
      <div class="calendar__day ${cell.otherMonth ? 'calendar__day--other-month' : ''} ${cell.key === todayKey ? 'calendar__day--today' : ''}">
        <div class="calendar__day-number">${cell.day}</div>
        ${shown.map((it) => `<div class="calendar__pill" style="--tier-color: var(${it.tierVar})" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>`).join('')}
        ${overflow > 0 ? `<div class="calendar__pill" style="--tier-color: var(--common)">+${overflow} more</div>` : ''}
      </div>
    `;
    })
    .join('');
}

document.getElementById('calPrev').addEventListener('click', () => {
  calState.month -= 1;
  if (calState.month < 0) {
    calState.month = 11;
    calState.year -= 1;
  }
  renderCalendar();
});
document.getElementById('calNext').addEventListener('click', () => {
  calState.month += 1;
  if (calState.month > 11) {
    calState.month = 0;
    calState.year += 1;
  }
  renderCalendar();
});

// ---- nav ----

function setActiveNav(name) {
  document.querySelectorAll('.nav-link').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === name);
  });
}

// Kept in the URL so refreshing (Ctrl+R) lands back on the same view instead
// of always resetting to Drops.
function syncViewToUrl(name) {
  const url = new URL(location.href);
  url.searchParams.set('view', name);
  history.replaceState(null, '', url);
}

async function navigateTo(target) {
  setActiveNav(target);
  syncViewToUrl(target);
  if (target === 'brain') {
    await fetchDocket();
    showView('brain');
  } else if (target === 'settings') {
    openSettings();
  } else if (target === 'calendar') {
    await openCalendar();
  } else {
    await fetchDeals();
  }
}

document.querySelectorAll('[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.nav));
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- init: restore from localStorage, or auto-start on defaults ----

// Drops should never be gated behind the survey — this loads a profile into
// state and jumps straight to whichever tab was last active (or Drops by
// default), used whether that profile was just restored or just auto-created.
async function enterApp(profile, { greeting } = {}) {
  state.profileId = profile.id;
  state.answers = profile.answers;
  document.getElementById('mainNav').hidden = false;

  const targetView = new URL(location.href).searchParams.get('view');
  if (targetView === 'brain') {
    await fetchDocket();
    showView('brain');
    setActiveNav('brain');
  } else if (targetView === 'calendar') {
    await openCalendar();
    setActiveNav('calendar');
  } else if (targetView === 'settings') {
    openSettings();
    setActiveNav('settings');
  } else {
    showView('pipeline');
    document.getElementById('pipelineStatus').textContent = greeting ?? 'Welcome back — scanning for free money…';
    animatePipeline(['scout', 'matcher']);
    await fetchDeals();
  }
  await refreshScoreTotal();
}

async function init() {
  loadStatus();

  const savedId = localStorage.getItem(STORAGE_KEY);
  if (savedId) {
    try {
      const res = await fetch(`api/profile/${savedId}`);
      if (res.ok) {
        const { profile } = await res.json();
        await enterApp(profile);
        return;
      }
      // A definitive "this profile doesn't exist" (404) means the saved id is
      // genuinely stale. Anything else (500/502/503 from a mid-restart proxy
      // hiccup, a flaky response) is transient — fall through to the default
      // profile below for just this load, without wiping the saved id, so a
      // later successful load still recovers it.
      if (res.status === 404) localStorage.removeItem(STORAGE_KEY);
    } catch {
      // network/proxy hiccup — leave the saved id alone, fall through below
    }
  }

  // No usable saved profile — auto-create a neutral default one and show
  // Drops right away instead of blocking on the survey. Settings (using the
  // exact same answers/questions) is where someone narrows results toward
  // their real situation, whenever they want to, never a precondition.
  const res = await fetch('api/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DEFAULT_ANSWERS),
  });
  const { profile } = await res.json();
  localStorage.setItem(STORAGE_KEY, profile.id);
  await enterApp(profile, { greeting: 'Finding free money…' });
}

init();
