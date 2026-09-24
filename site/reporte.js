'use strict';

// Reporte semanal: usa el mismo data.json del tablero. Al generar el PDF en la Action,
// scripts/pdf.mjs inyecta los datos en window.__REPORT_DATA__ y espera window.__reportReady.

const BUCKET_VAR = { done: '--c-done', progress: '--c-progress', stuck: '--c-stuck', notstarted: '--c-notstarted', cancelled: '--c-cancelled' };
const BAR_BUCKETS = ['done', 'progress', 'stuck', 'notstarted'];
const HEALTH = { 1: 'good', 2: 'warn', 3: 'bad', 0: 'none' };

let data = null;
const nf = new Intl.NumberFormat('es-PA');

// ---------- utilidades ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'vars') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Los emojis de los nombres de Monday no se imprimen bien en todos los equipos
const clean = (s) =>
  String(s ?? '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}\p{Join_Control}\p{Me}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const pctNum = (v) => {
  if (v == null || Number.isNaN(v)) return null;
  let p = Math.round(v * 100);
  if (p === 100 && v < 1) p = 99;
  if (p === 0 && v > 0) p = 1;
  return p;
};
const pct = (v) => (pctNum(v) == null ? '—' : `${pctNum(v)}%`);
const share = (n, total) => (total ? pct(n / total) : '—');
const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;

const asDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso));
function fmtDate(iso, opts = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-PA', { timeZone: data.timezone || 'America/Panama', day: 'numeric', month: 'short', ...opts }).format(asDate(iso));
}
const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 864e5);

function weekRange(from, to) {
  const part = (iso, o) => new Intl.DateTimeFormat('es-PA', { timeZone: 'UTC', ...o }).format(asDate(iso));
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  const end = part(to, { day: 'numeric', month: 'long', year: 'numeric' });
  if (fy !== ty) return `${part(from, { day: 'numeric', month: 'long', year: 'numeric' })} al ${end}`;
  if (fm !== tm) return `${part(from, { day: 'numeric', month: 'long' })} al ${end}`;
  return `${part(from, { day: 'numeric' })} al ${end}`;
}

// Íconos de estado en SVG (no dependen de las fuentes instaladas); siempre van con texto al lado
const ICONS = {
  good: '<circle cx="6" cy="6" r="6" fill="var(--c-done)"/><path d="M3.4 6.2 5.2 8l3.4-3.8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  bad: '<circle cx="6" cy="6" r="6" fill="var(--c-stuck)"/><path d="m4 4 4 4m0-4-4 4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  warn: '<circle cx="6" cy="6" r="6" fill="var(--c-warn)"/><path d="M6 3.2v3.3" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="8.7" r=".9" fill="#0b0b0b"/>',
  none: '<circle cx="6" cy="6" r="6" fill="var(--c-notstarted)"/><path d="M3.8 6h4.4" stroke="#52514e" stroke-width="1.6" stroke-linecap="round"/>',
  up: '<path d="M6 2.5 10.5 9h-9z" fill="var(--c-done)"/>',
  down: '<path d="M6 9.5 1.5 3h9z" fill="var(--c-stuck)"/>',
  flat: '<path d="M2 6h8" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/>',
};
function ico(kind) {
  const s = h('span', { class: 'ico', 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12">${ICONS[kind]}</svg>`;
  return s;
}

function stackBar(segs, size = '') {
  const total = segs.reduce((n, s) => n + s.count, 0);
  const aria = segs.filter((s) => s.count).map((s) => `${s.label}: ${s.count} (${share(s.count, total)})`).join(', ');
  const bar = h('div', { class: `stack ${size ? `stack-${size}` : ''}`, role: 'img', 'aria-label': aria || 'Sin datos' });
  if (!total) bar.classList.add('stack-empty');
  for (const s of segs) {
    if (!s.count) continue;
    const seg = h('span', { class: 'seg', vars: { '--c': s.color } });
    seg.style.flexGrow = s.count;
    bar.append(seg);
  }
  return bar;
}
const bucketLabel = (k) => data.buckets.find((b) => b.key === k)?.label ?? k;
const bucketSegs = (b) => BAR_BUCKETS.map((k) => ({ label: bucketLabel(k), count: b?.[k] ?? 0, color: `var(${BUCKET_VAR[k]})` }));

function bucketLegend(buckets) {
  const total = BAR_BUCKETS.reduce((n, k) => n + (buckets[k] ?? 0), 0);
  return h(
    'ul',
    { class: 'legend' },
    BAR_BUCKETS.map((k) =>
      h('li', null, h('span', { class: 'swatch', vars: { '--c': `var(${BUCKET_VAR[k]})` } }), bucketLabel(k), ' ', h('b', null, share(buckets[k] ?? 0, total)), h('span', { class: 'muted' }, ` (${nf.format(buckets[k] ?? 0)})`)),
    ),
  );
}

const phaseColor = (p) =>
  !p ? 'var(--c-notstarted)' : p.bucket === 'progress' && /planific/i.test(p.label) ? 'var(--c-plan)' : `var(${BUCKET_VAR[p.bucket] ?? '--c-notstarted'})`;

function deltaPts(now, prev) {
  const a = pctNum(now);
  const b = pctNum(prev);
  if (a == null || b == null) return null;
  return a - b;
}
function deltaEl(d, suffix = '') {
  if (d == null) return h('span', { class: 'muted' }, '—');
  if (d === 0) return h('span', { class: 'delta' }, ico('flat'), `Sin cambio${suffix}`);
  return h('span', { class: 'delta' }, ico(d > 0 ? 'up' : 'down'), `${d > 0 ? '+' : '−'}${Math.abs(d)} pts${suffix}`);
}

const owners = (x) => (x.owners?.length ? x.owners.join(', ') : h('span', { class: 'muted' }, 'Sin responsable'));
const taskLink = (x) => h('a', { href: x.url }, clean(x.name));

function table(cols, rows) {
  return h(
    'table',
    null,
    h('colgroup', null, cols.map((c) => h('col', { style: c.w ? `width:${c.w}` : null }))),
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.cls }, c.t)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((cell, i) => h('td', { class: cols[i].cls }, cell))))),
  );
}

// ---------- bloques ----------
function renderHead() {
  const w = data.week;
  const mark = h('span', { class: 'r-mark', 'aria-hidden': 'true' });
  mark.innerHTML =
    '<svg viewBox="0 0 32 32" width="34" height="34"><rect x="3" y="18" width="6" height="11" rx="2" fill="#0ca30c"/><rect x="13" y="10" width="6" height="19" rx="2" fill="#2a78d6"/><rect x="23" y="4" width="6" height="25" rx="2" fill="#d03b3b"/></svg>';
  const generated = new Intl.DateTimeFormat('es-PA', {
    timeZone: data.timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(data.generatedAt));
  return h(
    'header',
    { class: 'r-head' },
    h(
      'div',
      null,
      h('div', { class: 'r-eyebrow' }, 'PMO · Reporte semanal'),
      h('h1', null, `Semana del ${weekRange(w.fromDate, w.toDate)}`),
      h('p', { class: 'r-sub' }, `Datos de Monday al ${generated} (hora de Panamá) · ${nf.format(data.totals.boards)} tableros · ${nf.format(data.totals.items)} elementos`),
    ),
    mark,
  );
}

function renderKpis() {
  const t = data.totals;
  const w = data.week;
  const d = deltaPts(t.avance, t.avancePrev);
  const kpi = (k, v, sub, cls, icon) =>
    h('div', { class: `kpi ${cls || ''}` }, h('div', { class: 'k' }, icon, k), h('div', { class: 'v' }, v), sub);

  const countable = BAR_BUCKETS.reduce((n, k) => n + t.tasks[k], 0);
  return [
    h(
      'div',
      { class: 'kpis' },
      kpi(
        'Avance de proyectos activos',
        [pctNum(t.avance) ?? '—', t.avance == null ? null : h('small', null, '%')],
        [h('div', null, deltaEl(d, ' en la semana')), t.avancePrev != null ? h('div', { class: 's' }, `${pct(t.avancePrev)} hace 7 días`) : null],
      ),
      kpi('Completadas en la semana', nf.format(w.completedCount), h('div', { class: 's' }, 'tareas cerradas en 7 días'), '', ico('good')),
      kpi('Nuevas en la semana', nf.format(w.created), h('div', { class: 's' }, 'tareas creadas en 7 días')),
      kpi('Vencidas', nf.format(t.overdue), h('div', { class: 's' }, 'fecha pasada, sin completar'), t.overdue ? 'is-warn' : '', ico(t.overdue ? 'warn' : 'good')),
      kpi('Detenidas', nf.format(t.stuck), h('div', { class: 's' }, 'bloqueadas o en espera'), t.stuck ? 'is-alert' : '', ico(t.stuck ? 'bad' : 'good')),
    ),
    h(
      'div',
      { class: 'overview' },
      h('span', { class: 't' }, 'Estado de las tareas'),
      stackBar(bucketSegs(t.tasks), 'md'),
      bucketLegend(t.tasks),
    ),
    h('div', { class: 'muted', style: 'font-size:10.5px;margin-top:2px' }, `${nf.format(t.tasks.done)} de ${nf.format(countable)} tareas completadas en ${plural(t.projectsActive, 'proyecto o mejora activo', 'proyectos y mejoras activos')} · ${plural(t.projectsDone, 'completado', 'completados')} en total`),
  ];
}

function renderProjects() {
  const kpiSections = new Set(data.sections.filter((s) => s.kpi).map((s) => s.key));
  const score = (b) => ((b.health?.severity ?? 0) >= 2 ? b.health.severity * 100 : 0) + (b.buckets.stuck ? 50 : 0) + (b.overdue ? 25 : 0);
  const list = data.boards
    .filter((b) => kpiSections.has(b.section) && b.state === 'active')
    .sort((a, b) => score(b) - score(a) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  const finished = data.boards.filter((b) => kpiSections.has(b.section) && b.state === 'done' && (b.doneWeek ?? 0) > 0);

  const rows = list.map((b) => {
    const alerts = [
      b.overdue ? h('span', { class: 'pill' }, ico('warn'), plural(b.overdue, 'vencida', 'vencidas')) : null,
      b.buckets.stuck ? h('span', { class: 'pill' }, ico('bad'), plural(b.buckets.stuck, 'detenida', 'detenidas')) : null,
    ].filter(Boolean);
    const sev = b.health?.severity ?? 0;
    return [
      [h('a', { href: b.url }, h('b', null, clean(b.name))), h('span', { class: 'sub' }, [b.tipo, plural(b.total, 'tarea', 'tareas')].filter(Boolean).join(' · '))],
      b.phase ? h('span', { class: 'pill' }, h('span', { class: 'dotc', vars: { '--c': phaseColor(b.phase) } }), b.phase.label) : h('span', { class: 'muted' }, '—'),
      b.health ? h('span', { class: 'pill' }, ico(HEALTH[sev] ?? 'none'), sev ? b.health.label : 'Sin definir') : h('span', { class: 'muted' }, '—'),
      h('div', { class: 'barcell' }, stackBar(bucketSegs(b.buckets)), h('span', { class: 'p' }, pct(b.avance))),
      [deltaEl(deltaPts(b.avance, b.avancePrev)), b.doneWeek ? h('span', { class: 'sub' }, plural(b.doneWeek, 'completada', 'completadas')) : null],
      alerts.length ? h('div', { class: 'alerts' }, alerts) : h('span', { class: 'pill' }, ico('good'), 'Al día'),
    ];
  });

  return h(
    'section',
    { class: 'r-sec' },
    h('h2', null, 'Proyectos y mejoras activos', h('span', { class: 'n' }, list.length)),
    list.length
      ? table(
          [
            { t: 'Proyecto', w: '30%' },
            { t: 'Fase', w: '13%' },
            { t: 'Salud', w: '12%' },
            { t: 'Avance', w: '18%' },
            { t: 'En la semana', w: '13%' },
            { t: 'Alertas', w: '14%' },
          ],
          rows,
        )
      : h('div', { class: 'empty' }, 'No hay proyectos activos.'),
    finished.length
      ? h('div', { class: 'more' }, `También cerraron tareas esta semana proyectos ya completados: ${finished.map((b) => clean(b.name)).join(', ')}.`)
      : null,
  );
}

function renderCompleted() {
  const w = data.week;
  return h(
    'section',
    { class: 'r-sec' },
    h('h2', null, 'Completadas en la semana', h('span', { class: 'n' }, w.completedCount)),
    w.completed.length
      ? table(
          [
            { t: 'Tarea', w: '38%' },
            { t: 'Tablero', w: '30%' },
            { t: 'Responsable', w: '20%' },
            { t: 'Fecha', w: '12%', cls: 'nowrap' },
          ],
          w.completed.map((x) => [taskLink(x), clean(x.board), owners(x), fmtDate(x.date)]),
        )
      : h('div', { class: 'empty' }, 'No se completaron tareas en los últimos 7 días.'),
    w.completedCount > w.completed.length ? h('div', { class: 'more' }, `y ${nf.format(w.completedCount - w.completed.length)} más en el tablero.`) : null,
  );
}

function renderAttention() {
  const a = data.attention;
  return h(
    'section',
    { class: 'r-sec' },
    h('h2', null, 'Requiere atención'),
    h('h3', null, ico('warn'), 'Vencidas', h('span', { class: 'n' }, a.overdue.length)),
    a.overdue.length
      ? table(
          [
            { t: 'Tarea', w: '34%' },
            { t: 'Tablero', w: '26%' },
            { t: 'Responsable', w: '18%' },
            { t: 'Venció', w: '10%', cls: 'nowrap' },
            { t: 'Atraso', w: '12%', cls: 'n nowrap' },
          ],
          a.overdue.map((x) => [taskLink(x), clean(x.board), owners(x), fmtDate(x.due), plural(daysBetween(x.due, data.today), 'día', 'días')]),
        )
      : h('div', { class: 'empty' }, 'Nada vencido.'),
    h('h3', null, ico('bad'), 'Detenidas', h('span', { class: 'n' }, a.stuck.length)),
    a.stuck.length
      ? table(
          [
            { t: 'Tarea', w: '34%' },
            { t: 'Tablero', w: '26%' },
            { t: 'Responsable', w: '18%' },
            { t: 'Estado', w: '22%' },
          ],
          a.stuck.map((x) => [taskLink(x), clean(x.board), owners(x), x.status]),
        )
      : h('div', { class: 'empty' }, 'Nada detenido.'),
    h('h3', null, ico('none'), 'Sin movimiento reciente', h('span', { class: 'n' }, a.stale.length)),
    a.stale.length
      ? table(
          [
            { t: 'Tablero', w: '60%' },
            { t: 'Última actividad', w: '40%' },
          ],
          a.stale.map((x) => [h('a', { href: x.url }, clean(x.board)), `${fmtDate(x.lastActivity, { year: 'numeric' })} · hace ${plural(daysBetween(x.lastActivity.slice(0, 10), data.today), 'día', 'días')}`]),
        )
      : h('div', { class: 'empty' }, 'Todos los proyectos activos tuvieron movimiento en las últimas semanas.'),
  );
}

function renderNext() {
  const w = data.week;
  return h(
    'section',
    { class: 'r-sec' },
    h('h2', null, 'Vencen en los próximos 7 días', h('span', { class: 'n' }, w.dueNextCount)),
    w.dueNext.length
      ? table(
          [
            { t: 'Vence', w: '10%', cls: 'nowrap' },
            { t: 'Tarea', w: '34%' },
            { t: 'Tablero', w: '24%' },
            { t: 'Responsable', w: '18%' },
            { t: 'Estado', w: '14%' },
          ],
          w.dueNext.map((x) => [fmtDate(x.due, { weekday: 'short' }), taskLink(x), clean(x.board), owners(x), x.status]),
        )
      : h('div', { class: 'empty' }, `Nada vence entre hoy y el ${fmtDate(w.nextWeekDate, { month: 'long' })}.`),
    w.dueNextCount > w.dueNext.length ? h('div', { class: 'more' }, `y ${nf.format(w.dueNextCount - w.dueNext.length)} más en el tablero.`) : null,
  );
}

function renderPeople() {
  const people = data.people ?? [];
  const un = data.unassigned;
  if (!people.length && !un?.open) return null;
  const rows = people.map((p) => [
    h('b', null, p.name),
    nf.format(p.doneWeek ?? 0),
    nf.format(p.openCount),
    p.overdue ? h('span', { class: 'pill' }, ico('warn'), nf.format(p.overdue)) : '0',
    p.stuck ? h('span', { class: 'pill' }, ico('bad'), nf.format(p.stuck)) : '0',
    h('div', { class: 'barcell' }, stackBar(bucketSegs(p.buckets)), h('span', { class: 'p' }, pct(p.avance))),
    p.nextDue ? [clean(p.nextDue.name), h('span', { class: 'sub' }, `${fmtDate(p.nextDue.due)} · ${clean(p.nextDue.board)}`)] : h('span', { class: 'muted' }, '—'),
  ]);
  if (un?.open) {
    rows.push([
      h('span', { class: 'muted' }, 'Sin responsable'),
      '—',
      nf.format(un.open),
      un.overdue ? h('span', { class: 'pill' }, ico('warn'), nf.format(un.overdue)) : '0',
      un.stuck ? h('span', { class: 'pill' }, ico('bad'), nf.format(un.stuck)) : '0',
      h('span', { class: 'muted' }, '—'),
      h('span', { class: 'muted' }, 'Asignar responsable en Monday'),
    ]);
  }
  return h(
    'section',
    { class: 'r-sec' },
    h('h2', null, 'Entregables por persona', h('span', { class: 'n' }, people.length)),
    table(
      [
        { t: 'Persona', w: '19%' },
        { t: 'Completadas 7 días', w: '11%', cls: 'n' },
        { t: 'Abiertas', w: '8%', cls: 'n' },
        { t: 'Vencidas', w: '9%', cls: 'n' },
        { t: 'Detenidas', w: '9%', cls: 'n' },
        { t: 'Avance', w: '17%' },
        { t: 'Próximo entregable', w: '27%' },
      ],
      rows,
    ),
  );
}

function renderNotes() {
  const site = window.__REPORT_SITE__ || new URL('./', location.href).href;
  const isWeb = /^https?:/.test(site);
  return h(
    'footer',
    { class: 'notes' },
    h('div', null, 'Avance = tareas completadas ÷ tareas totales, sin contar canceladas, de los proyectos y mejoras activos. En tableros multinivel se cuentan las subtareas.'),
    h('div', null, 'Las tareas completadas en la semana y el avance de hace 7 días se calculan con la fecha del último cambio de estado que guarda Monday; el avance anterior es una estimación.'),
    isWeb ? h('div', null, 'Tablero en vivo: ', h('a', { href: site }, site)) : null,
  );
}

// ---------- carga ----------
async function main() {
  const root = document.getElementById('report');
  try {
    data = window.__REPORT_DATA__ ?? (await (await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' })).json());
    if (!data.week) throw new Error('Los datos todavía no incluyen el resumen semanal.');
    root.replaceChildren(
      ...[renderHead(), ...renderKpis(), renderProjects(), renderCompleted(), renderAttention(), renderNext(), renderPeople(), renderNotes()].filter(Boolean),
    );
    document.title = `Reporte semanal PMO ${data.today}`;
    const pdf = document.getElementById('pdf-link');
    if (pdf && !window.__REPORT_DATA__) {
      fetch('reporte-semanal.pdf', { method: 'HEAD', cache: 'no-store' })
        .then((r) => {
          if (!r.ok) return;
          pdf.href = `reporte-semanal.pdf?v=${encodeURIComponent(data.generatedAt)}`;
          pdf.setAttribute('download', `Reporte semanal PMO ${data.today}.pdf`);
          pdf.hidden = false;
        })
        .catch(() => {});
    }
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('p', { class: 'loading' }, `No se pudo armar el reporte: ${e.message}`));
  } finally {
    root.setAttribute('aria-busy', 'false');
    await document.fonts?.ready;
    window.__reportReady = true;
  }
}

document.getElementById('print-btn').addEventListener('click', () => window.print());
main();
