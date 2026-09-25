'use strict';

// Dashboard de diques: lee diques.json (lo genera scripts/diques.mjs en cada actualización).
const REFRESH_MS = 60 * 1000;
const STALE_MS = 60 * 60 * 1000;

const BUCKET_COLOR = {
  done: 'var(--c-done)',
  progress: 'var(--c-progress)',
  warn: 'var(--c-warn)',
  stuck: 'var(--c-stuck)',
  deferred: 'var(--c-deferred)',
  cancelled: 'var(--c-cancelled)',
  notstarted: 'var(--c-notstarted)',
  // "Sin estado" rayado para distinguirlo de "No iniciado" cuando van juntos
  empty: 'repeating-linear-gradient(135deg, var(--c-notstarted) 0 2px, transparent 2px 5px)',
};
const BUCKET_ORDER = ['done', 'progress', 'warn', 'stuck', 'deferred', 'cancelled', 'notstarted', 'empty'];
const PHASE_ORDER = ['Planificación', 'Pre-dique', 'Dique', 'Post-dique', 'Cierre'];
const TIPO_COLOR = { especial: 'var(--series-1)', intermedio: 'var(--series-2)' };
const ROLE_NAME = {
  gestion: 'Gestión / plan del dique',
  compras: 'Órdenes de compra',
  cambios: 'Cambios e imprevistos',
  cronograma: 'Cronograma',
  planificacion: 'Planificación de trabajos',
  centros: 'Centros de costo',
  trabajos: 'Plan de trabajos',
};

let data = null;
const ui = { open: new Set() };
const nf = new Intl.NumberFormat('es-PA');
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

// ---------- utilidades ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'vars') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const clean = (s) =>
  String(s ?? '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}\p{Join_Control}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

function money(n, cur = '$') {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a < 1000) return `${s}${cur}${Math.round(a)}`;
  if (a >= 1e6) return `${s}${cur}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  return `${s}${cur}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
}
const moneyFull = (n) => (n == null ? '—' : usd0.format(n));
const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);

const asDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso));
function fmtDate(iso, { year = null, weekday = false } = {}) {
  if (!iso) return '—';
  const d = asDate(iso);
  const showYear = year ?? d.getUTCFullYear() !== asDate(data.today).getUTCFullYear();
  return new Intl.DateTimeFormat('es-PA', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(showYear ? { year: 'numeric' } : {}),
    ...(weekday ? { weekday: 'short' } : {}),
  }).format(d);
}
const fmtRange = (a, b) => (!a ? '—' : a === b || !b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 864e5);
const addDays = (iso, n) => new Date(asDate(iso).getTime() + n * 864e5).toISOString().slice(0, 10);
function inDays(iso) {
  const n = daysBetween(data.today, iso);
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n > 0) return `en ${n} días`;
  return `hace ${-n} días`;
}
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'hace un momento';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

// "Oct-2026" -> mitad de mes, para ubicar fechas escritas como texto en el programa
const MONTHS = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
function monthText(t) {
  const m = String(t ?? '').toLowerCase().match(/([a-z]{3})[a-z]*[\s./-]*(\d{4})/);
  if (!m || !MONTHS[m[1]]) return null;
  return `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}-15`;
}

const ICONS = {
  good: ['var(--c-done)', '✓', '#fff'],
  warn: ['var(--c-warn)', '!', '#0b0b0b'],
  bad: ['var(--c-stuck)', '✕', '#fff'],
  info: ['var(--c-progress)', 'i', '#fff'],
  none: ['var(--c-notstarted)', '–', 'var(--ink)'],
};
const ico = (kind) => {
  const [bg, sym, fg] = ICONS[kind] ?? ICONS.none;
  return h('span', { class: 'ico', 'aria-hidden': 'true', style: `background:${bg};color:${fg}` }, sym);
};

// ---------- barras ----------
function sortSegs(list) {
  return [...list].sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) || b.count - a.count);
}
// segs: [{ label, count, amount, bucket }]; by = 'count' | 'amount'
function stackBar(segs, by = 'count', size = 'md') {
  const list = sortSegs(segs).filter((s) => (by === 'amount' ? s.amount : s.count) > 0);
  const total = list.reduce((n, s) => n + (by === 'amount' ? s.amount : s.count), 0);
  const aria = list.map((s) => `${s.label}: ${by === 'amount' ? moneyFull(s.amount) : s.count}`).join(', ');
  const bar = h('div', { class: `stack stack-${size}`, role: 'img', 'aria-label': aria || 'Sin datos' });
  if (!total) {
    bar.classList.add('stack-empty');
    return bar;
  }
  for (const s of list) {
    const v = by === 'amount' ? s.amount : s.count;
    const seg = h('span', {
      class: 'seg',
      tabindex: '0',
      vars: { '--c': BUCKET_COLOR[s.bucket] ?? BUCKET_COLOR.notstarted },
      dataset: {
        tipV: by === 'amount' ? `${moneyFull(s.amount)} · ${plural(s.count, 'registro', 'registros')}` : `${nf.format(s.count)} · ${pct(v / total)}`,
        tipK: s.label,
        tipC: BUCKET_COLOR[s.bucket] ?? BUCKET_COLOR.notstarted,
      },
    });
    seg.style.flexGrow = v;
    bar.append(seg);
  }
  return bar;
}
function legend(segs, by = 'count') {
  return h(
    'ul',
    { class: 'legend' },
    sortSegs(segs).map((s) =>
      h(
        'li',
        null,
        h('span', { class: 'swatch', vars: { '--c': BUCKET_COLOR[s.bucket] ?? BUCKET_COLOR.notstarted } }),
        s.label,
        ' ',
        h('b', null, by === 'amount' ? money(s.amount) : nf.format(s.count)),
        by === 'amount' ? h('span', { class: 'muted' }, ` (${nf.format(s.count)})`) : null,
      ),
    ),
  );
}

// Barras horizontales de un solo color para rankings de montos
function hbars(rows, { value = (r) => r.amount, label = (r) => r.label, fmt = money } = {}) {
  const max = Math.max(...rows.map(value), 0) || 1;
  return h(
    'div',
    { class: 'hbars' },
    rows.map((r) =>
      h(
        'div',
        { class: 'hbar' },
        h('span', { class: 'hb-l', title: label(r) }, label(r)),
        h(
          'span',
          { class: 'hb-t' },
          h('span', {
            class: 'hb-f',
            style: `width:${Math.max(1, (value(r) / max) * 100)}%`,
            tabindex: '0',
            dataset: { tipV: moneyFull(value(r)), tipK: label(r), tipC: 'var(--series-1)' },
          }),
        ),
        h('span', { class: 'hb-v' }, fmt(value(r))),
      ),
    ),
  );
}

// ---------- tarjetas de indicadores ----------
function renderKpis() {
  const t = data.totals;
  const p = data.proximo;
  const tile = (label, value, hint, cls, icon) =>
    h('div', { class: `tile ${cls || ''}` }, h('div', { class: 'label' }, icon, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
  const years = data.programaPorAnio.filter((y) => y.anio >= data.today.slice(0, 4));
  const span = years.length ? `${years[0].anio}–${years.at(-1).anio}` : '';
  return h(
    'section',
    { class: 'kpi-row', 'aria-label': 'Resumen' },
    tile('Próximo dique', p ? p.buque : '—', p ? `${p.hito} · ${fmtDate(p.fecha)} (${inDays(p.fecha)})` : 'Sin fechas programadas', 'is-accent', ico('info')),
    tile('Incurrido en diques', money(t.incurrido), `Órdenes de compra de ${plural(data.buques.filter((b) => b.compras).length, 'buque', 'buques')}`),
    tile(
      'Imprevistos por decidir',
      nf.format(t.cambiosPorDecidir),
      t.cambiosPorDecidir ? `${money(t.cambiosPorDecidirMonto)} solicitados sin aprobar` : 'Todo decidido',
      t.cambiosPorDecidir ? 'is-warn' : '',
      ico(t.cambiosPorDecidir ? 'warn' : 'good'),
    ),
    tile(
      'Pagos pendientes',
      nf.format(t.pagosPendientes),
      t.pagosPendientes ? `${money(t.pagosPendientesMonto)} por pagar a proveedores` : 'Sin pagos pendientes',
      t.pagosPendientes ? 'is-warn' : '',
      ico(t.pagosPendientes ? 'warn' : 'good'),
    ),
    tile('Programa de diques', plural(t.programaCount, 'dique', 'diques'), `${money(t.programaEstimado)} estimado${span ? ` · ${span}` : ''}`),
  );
}

// ---------- cronograma (Gantt) ----------
function renderGantt(v) {
  const c = v.cronograma;
  const dated = c.phases.filter((p) => p.from);
  if (!dated.length) return h('div', { class: 'empty' }, 'El cronograma todavía no tiene fechas.');
  const allDates = dated.flatMap((p) => [p.from, p.to, p.baseFrom, p.baseTo]).filter(Boolean).sort();
  let min = allDates[0];
  let max = allDates.at(-1);
  if (data.today < min && daysBetween(data.today, min) < 21) min = data.today;
  if (data.today > max && daysBetween(max, data.today) < 21) max = data.today;
  min = addDays(min, -1);
  max = addDays(max, 2);
  const span = daysBetween(min, max);
  const x = (iso) => (daysBetween(min, iso) / span) * 100;

  // Marcas del eje: semanales en diques cortos, mensuales en los largos
  const ticks = [];
  if (span <= 80) {
    const start = asDate(min);
    const offset = (8 - start.getUTCDay()) % 7; // lunes
    for (let d = addDays(min, offset); d <= max; d = addDays(d, 7)) ticks.push(d);
  } else {
    let [y, m] = min.split('-').map(Number);
    for (;;) {
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
      const d = `${y}-${String(m).padStart(2, '0')}-01`;
      if (d > max) break;
      ticks.push(d);
    }
  }
  const showToday = data.today >= min && data.today <= max;
  const todayLine = () => (showToday ? h('span', { class: 'g-today', style: `left:${x(data.today)}%` }) : null);

  const rows = [];
  let lastGroup = null;
  for (const p of c.phases) {
    if (!p.from) continue;
    const group = clean(p.grupo);
    if (group && group !== lastGroup && c.phases.some((q) => clean(q.grupo) !== group)) {
      rows.push(h('div', { class: 'g-group' }, group));
      lastGroup = group;
    }
    const color = BUCKET_COLOR[p.bucket] ?? BUCKET_COLOR.notstarted;
    const tip = {
      tipV: `${fmtRange(p.from, p.to)}${p.baseFrom && (p.baseFrom !== p.from || p.baseTo !== p.to) ? ` · línea base ${fmtRange(p.baseFrom, p.baseTo)}` : ''}`,
      tipK: `${clean(p.name)} · ${p.estado}`,
      tipC: color,
    };
    const mark = p.hito
      ? h('span', { class: 'g-mile', tabindex: '0', style: `left:${x(p.from)}%`, vars: { '--c': color }, dataset: tip })
      : h('span', {
          class: 'g-bar',
          tabindex: '0',
          style: `left:${x(p.from)}%;width:${Math.max(0.8, x(addDays(p.to, 1)) - x(p.from))}%`,
          vars: { '--c': color },
          dataset: tip,
        });
    const base =
      p.baseFrom && (p.baseFrom !== p.from || p.baseTo !== p.to)
        ? h('span', { class: 'g-base', style: `left:${x(p.baseFrom)}%;width:${Math.max(0.6, x(addDays(p.baseTo, 1)) - x(p.baseFrom))}%` })
        : null;
    const diff = p.diferencia ? `${p.diferencia > 0 ? '+' : '−'}${Math.abs(p.diferencia)} d vs línea base` : null;
    rows.push(
      h(
        'div',
        { class: `g-row ${p.alerta ? 'has-alert' : ''}` },
        h('div', { class: 'g-label' }, h('span', { class: 'g-name', title: clean(p.name) }, clean(p.name)), h('span', { class: 'g-dates' }, [fmtRange(p.from, p.to), diff].filter(Boolean).join(' · '))),
        h('div', { class: 'g-track' }, todayLine(), base, mark),
        h(
          'div',
          { class: 'g-state' },
          p.alerta
            ? h('span', { class: 'pill' }, ico(p.alerta === 'atrasada' ? 'bad' : 'warn'), p.alerta === 'atrasada' ? 'Atrasada' : 'Debió iniciar')
            : h('span', { class: 'pill' }, h('span', { class: 'dotc', vars: { '--c': color } }), p.estado),
        ),
      ),
    );
  }
  const undated = c.phases.filter((p) => !p.from);
  return h(
    'div',
    { class: 'gantt' },
    h(
      'div',
      { class: 'g-row g-axis', 'aria-hidden': 'true' },
      h('div'),
      h(
        'div',
        { class: 'g-track' },
        ticks.map((t) =>
          h('span', { class: 'g-tick', style: `left:${x(t)}%` }, new Intl.DateTimeFormat('es-PA', { timeZone: 'UTC', day: span <= 80 ? 'numeric' : undefined, month: 'short' }).format(asDate(t))),
        ),
        showToday ? h('span', { class: 'g-today-label', style: `left:${x(data.today)}%` }, 'Hoy') : null,
      ),
      h('div'),
    ),
    rows,
    h(
      'ul',
      { class: 'legend g-legend' },
      h('li', null, h('span', { class: 'g-key-bar' }), 'Fechas (color según estado)'),
      c.phases.some((p) => p.baseFrom && (p.baseFrom !== p.from || p.baseTo !== p.to)) ? h('li', null, h('span', { class: 'g-key-base' }), 'Línea base') : null,
      c.phases.some((p) => p.hito) ? h('li', null, h('span', { class: 'g-key-mile' }), 'Hito') : null,
      showToday ? h('li', null, h('span', { class: 'g-key-today' }), 'Hoy') : null,
    ),
    undated.length ? h('div', { class: 'muted small' }, `Sin fecha todavía: ${undated.map((p) => clean(p.name)).join(', ')}.`) : null,
  );
}

// ---------- paneles del buque ----------
const panel = (title, meta, ...body) =>
  h('section', { class: `panel ${body.length === 1 && body[0]?.classList?.contains('empty') ? 'is-empty' : ''}` }, h('div', { class: 'panel-head' }, h('h3', null, title), meta ? h('span', { class: 'meta' }, meta) : null), body);

function renderCostos(v) {
  const g = v.gestion;
  const presupuesto = g?.presupuesto || null;
  const proyectado = g?.proyectado || null;
  const eur = g?.proyectadoEur || null;
  const incurrido = v.compras?.incurrido ?? g?.incurrido ?? null;
  if (presupuesto == null && incurrido == null && proyectado == null) return null;

  // Proyectado solo se compara si está todo en dólares
  const proyComparable = proyectado && !eur;
  const max = Math.max(presupuesto ?? 0, incurrido ?? 0, proyComparable ? proyectado : 0) * 1.05 || 1;
  const pos = (n) => `${(n / max) * 100}%`;
  const bullet = h(
    'div',
    { class: 'bullet', role: 'img', 'aria-label': `Incurrido ${moneyFull(incurrido)}, presupuesto ${moneyFull(presupuesto)}${proyComparable ? `, proyectado ${moneyFull(proyectado)}` : ''}` },
    incurrido != null
      ? h('span', { class: 'b-fill', tabindex: '0', style: `width:${pos(incurrido)}`, dataset: { tipV: moneyFull(incurrido), tipK: 'Incurrido', tipC: 'var(--series-1)' } })
      : null,
    presupuesto ? h('span', { class: 'b-mark', tabindex: '0', style: `left:${pos(presupuesto)}`, dataset: { tipV: moneyFull(presupuesto), tipK: 'Presupuesto', tipC: 'var(--ink)' } }) : null,
    proyComparable
      ? h('span', { class: 'b-mark is-proj', tabindex: '0', style: `left:${pos(proyectado)}`, dataset: { tipV: moneyFull(proyectado), tipK: 'Proyectado', tipC: 'var(--ink-2)' } })
      : null,
  );

  let verdict = null;
  if (presupuesto && incurrido != null) {
    const ratio = incurrido / presupuesto;
    const diff = incurrido - presupuesto;
    verdict = h(
      'div',
      { class: 'verdict' },
      ico(ratio > 1.0005 ? (ratio > 1.1 ? 'bad' : 'warn') : 'good'),
      `Incurrido = ${pct(ratio)} del presupuesto (${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))})`,
    );
  }
  const stat = (k, val, sub) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('b', null, val), sub ? h('span', { class: 'muted small' }, sub) : null);
  return panel(
    'Costos',
    'USD',
    h(
      'div',
      { class: 'stats' },
      stat('Presupuesto', money(presupuesto)),
      stat('Proyectado', proyectado || eur ? [proyectado ? money(proyectado) : null, eur ? ` + ${money(eur, '€')}` : null].filter(Boolean).join('') : '—', eur ? 'parte en euros' : null),
      stat('Incurrido', money(incurrido), v.compras ? 'según órdenes de compra' : null),
    ),
    bullet,
    h(
      'ul',
      { class: 'legend' },
      h('li', null, h('span', { class: 'swatch', vars: { '--c': 'var(--series-1)' } }), 'Incurrido'),
      presupuesto ? h('li', null, h('span', { class: 'b-key' }), 'Presupuesto') : null,
      proyComparable ? h('li', null, h('span', { class: 'b-key is-proj' }), 'Proyectado') : null,
    ),
    verdict,
  );
}

function renderCompras(v) {
  const c = v.compras;
  const board = v.boards.find((b) => b.role === 'compras');
  if (!c) return board ? panel('Órdenes de compra', null, h('div', { class: 'empty' }, 'Todavía no hay órdenes de compra registradas.')) : null;
  const centros = c.porCentro.filter((x) => x.label !== 'Sin centro de costo');
  return panel(
    'Órdenes de compra',
    `${plural(c.count, 'orden', 'órdenes')} · ${money(c.incurrido)}`,
    h('div', { class: 'sub-label' }, 'Estado de pago (por monto)'),
    stackBar(c.porPago, 'amount'),
    legend(c.porPago, 'amount'),
    c.pendientes.length
      ? [
          h('div', { class: 'sub-label' }, `Pendientes de pago · ${money(c.pendientesMonto)}`),
          h(
            'ul',
            { class: 'rows' },
            c.pendientes.slice(0, 5).map((p) =>
              h('li', null, h('span', { class: 'r-name', title: clean(p.proveedor ?? p.name) }, clean(p.proveedor ?? p.name)), h('span', { class: 'r-meta' }, [p.estado, p.fecha ? fmtDate(p.fecha) : null].filter(Boolean).join(' · ')), h('b', null, money(p.monto))),
            ),
          ),
        ]
      : null,
    centros.length > 1 ? [h('div', { class: 'sub-label' }, 'Mayores centros de costo'), hbars(centros.slice(0, 6), { label: (r) => clean(r.label) })] : null,
  );
}

function renderCambios(v) {
  const c = v.cambios;
  const board = v.boards.find((b) => b.role === 'cambios');
  if (!c) return board ? panel('Cambios e imprevistos', null, h('div', { class: 'empty' }, 'Sin cambios ni imprevistos registrados.')) : null;
  return panel(
    'Cambios e imprevistos',
    `${plural(c.count, 'registro', 'registros')} · ${money(c.costo)}${c.dias ? ` · ${plural(c.dias, 'día', 'días')} de impacto` : ''}`,
    h('div', { class: 'sub-label' }, 'Por estado (por monto)'),
    stackBar(c.porEstado, 'amount'),
    legend(c.porEstado, 'amount'),
    c.porDecidir.count ? h('div', { class: 'verdict' }, ico('warn'), `${plural(c.porDecidir.count, 'solicitud', 'solicitudes')} por decidir · ${money(c.porDecidir.costo)}`) : null,
    h('div', { class: 'sub-label' }, 'Los de mayor costo'),
    h(
      'ul',
      { class: 'rows' },
      c.items.slice(0, 5).map((x) =>
        h(
          'li',
          null,
          h('span', { class: 'r-name', title: clean(x.name) }, clean(x.name)),
          h('span', { class: 'r-meta' }, h('span', { class: 'dotc', vars: { '--c': BUCKET_COLOR[x.bucket] ?? BUCKET_COLOR.notstarted } }), ' ', x.estado),
          h('b', null, money(x.costo)),
        ),
      ),
    ),
  );
}

function renderActividades(v) {
  const g = v.gestion;
  if (!g || !g.porEstado.length) return null;
  const fases = [...g.porFase].sort((a, b) => {
    const ia = PHASE_ORDER.indexOf(a.label);
    const ib = PHASE_ORDER.indexOf(b.label);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const done = g.porEstado.filter((x) => x.bucket === 'done').reduce((n, x) => n + x.count, 0);
  return panel(
    'Actividades del plan',
    `${plural(g.lines, 'actividad', 'actividades')} · ${pct(done / g.lines)} listas`,
    stackBar(g.porEstado),
    legend(g.porEstado),
    h('div', { class: 'sub-label' }, 'Por fase'),
    hbars(fases, { value: (r) => r.count, fmt: (n) => nf.format(n) }),
  );
}

function renderPlanificacion(v) {
  const p = v.planificacion;
  if (!p) return null;
  const fromTest = v.boards.some((b) => b.role === 'planificacion' && b.test);
  const areas = [...p.porArea].sort((a, b) => b.lines - a.lines);
  return panel(
    'Planificación de trabajos',
    `${plural(p.lines, 'línea', 'líneas')}${p.solicitado ? ` · ${money(p.solicitado)} solicitados` : ''}`,
    h(
      'table',
      { class: 'mini' },
      h('thead', null, h('tr', null, h('th', null, 'Área'), h('th', { class: 'n' }, 'Líneas'), h('th', { class: 'n' }, 'Con monto'), h('th', { class: 'n' }, 'Solicitado'), h('th', { class: 'n' }, 'Revisado'), h('th', { class: 'n' }, 'Aprobado'))),
      h(
        'tbody',
        null,
        areas.map((a) =>
          h('tr', null, h('td', null, a.area), h('td', { class: 'n' }, nf.format(a.lines)), h('td', { class: 'n' }, nf.format(a.conMonto)), h('td', { class: 'n' }, a.solicitado ? money(a.solicitado) : '—'), h('td', { class: 'n' }, a.revisado ? money(a.revisado) : '—'), h('td', { class: 'n' }, a.aprobado ? money(a.aprobado) : '—')),
        ),
      ),
    ),
    h('div', { class: 'sub-label' }, 'Estado de aprobación'),
    stackBar(p.porAprobacion),
    legend(p.porAprobacion),
    p.porEstatus.length ? [h('div', { class: 'sub-label' }, 'Avance de ejecución'), stackBar(p.porEstatus), legend(p.porEstatus)] : null,
    fromTest ? h('div', { class: 'muted small' }, 'Fuente: tableros de migración al Estándar Dique v1 (prueba).') : null,
  );
}

function renderCentros(v) {
  const c = v.centros;
  if (!c) return null;
  return panel(
    'Centros de costo',
    `${plural(c.count, 'centro', 'centros')}`,
    h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Revisado gerencia'), h('b', null, money(c.revisado))), h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Aprobado dirección'), h('b', null, money(c.aprobado)))),
    stackBar(c.porEstado),
    legend(c.porEstado),
  );
}

function renderTrabajos(v) {
  if (!v.trabajos?.length) return null;
  return panel(
    'Planes de trabajo',
    plural(v.trabajos.reduce((n, t) => n + t.lines, 0), 'línea', 'líneas'),
    v.trabajos.map((t) =>
      h(
        'div',
        { class: 'trabajo' },
        h('div', { class: 'sub-label' }, clean(t.name).replace(/^T\d+\.\s*/, ''), h('span', { class: 'muted' }, ` · ${plural(t.lines, 'línea', 'líneas')}${t.preliminar ? ` · ${money(t.preliminar)} preliminar` : ''}${t.proyectado ? ` · ${money(t.proyectado)} proyectado` : ''}`)),
        stackBar(t.porEstado.length ? t.porEstado : t.porAprobacion),
        legend(t.porEstado.length ? t.porEstado : t.porAprobacion),
      ),
    ),
  );
}

function etapaPill(v) {
  if (v.etapa === 'En curso') return h('span', { class: 'etapa is-live' }, h('span', { class: 'live-dot' }), `En curso${v.faseActual ? ` · ${v.faseActual}` : ''}`);
  if (v.etapa === 'Próximo') return h('span', { class: 'etapa' }, ico('info'), 'Próximo');
  if (v.etapa === 'Realizado') return h('span', { class: 'etapa' }, ico('good'), 'Realizado');
  return h('span', { class: 'etapa' }, ico('none'), v.etapa);
}

// Línea del programa de la flota para el buque: el dique actual si coincide en fechas, si no el próximo
function programaText(v) {
  const list = v.programa ?? [];
  const planOf = (p) => p.fechaReal ?? monthText(p.fechaTexto);
  const near = (d) => d && v.periodo && d >= addDays(v.periodo.from, -45) && d <= addDays(v.periodo.to, 45);
  const actual = list.find((p) => near(planOf(p)));
  const p = actual ?? list.find((q) => (q.mandatorio ?? '') >= data.today) ?? list[0];
  if (!p) return null;
  const when = p.fechaReal ? fmtDate(p.fechaReal, { year: true }) : p.fechaTexto && !/definir/i.test(p.fechaTexto) ? p.fechaTexto : null;
  return [
    actual ? 'En el programa de la flota' : 'Próximo dique',
    when ? `programado ${when}` : null,
    p.mandatorio ? `mandatorio ${fmtDate(p.mandatorio, { year: true })}` : null,
    p.lugar,
    p.tipo,
    p.estimado ? `estimado ${money(p.estimado)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderVessel(v) {
  const key = `v-${v.name}`;
  const alerts = (v.cronograma?.phases ?? []).filter((p) => p.alerta);
  const boardsList = h(
    'details',
    { class: 'boards', dataset: { key: `${key}-b` }, open: ui.open.has(`${key}-b`), ontoggle: (e) => (e.currentTarget.open ? ui.open.add(`${key}-b`) : ui.open.delete(`${key}-b`)) },
    h('summary', null, `Tableros en Monday (${v.boards.length})`),
    h(
      'ul',
      null,
      v.boards.map((b) =>
        h('li', null, h('a', { href: b.url, target: '_blank', rel: 'noopener' }, clean(b.name)), h('span', { class: 'muted' }, ` · ${ROLE_NAME[b.role] ?? b.role}${b.test ? ' · migración (prueba)' : ''}`)),
      ),
    ),
  );
  // Los paneles sin datos van al final
  const panels = [renderCostos(v), renderCompras(v), renderCambios(v), renderActividades(v), renderPlanificacion(v), renderCentros(v), renderTrabajos(v)]
    .filter(Boolean)
    .sort((a, b) => a.classList.contains('is-empty') - b.classList.contains('is-empty'));
  return h(
    'section',
    { class: 'card vessel', 'aria-label': v.name },
    h(
      'div',
      { class: 'v-head' },
      h(
        'div',
        null,
        h('h2', null, v.name),
        h('div', { class: 'v-meta' }, etapaPill(v), v.periodo ? h('span', null, fmtRange(v.periodo.from, v.periodo.to)) : null, v.lastActivity ? h('span', { class: 'muted' }, `act. ${ago(v.lastActivity)}`) : null),
        programaText(v) ? h('div', { class: 'v-prog' }, programaText(v)) : null,
      ),
      boardsList,
    ),
    alerts.length
      ? h(
          'div',
          { class: 'v-alerts' },
          alerts.map((p) => h('span', { class: 'pill' }, ico(p.alerta === 'atrasada' ? 'bad' : 'warn'), `${clean(p.name)}: ${p.alerta === 'atrasada' ? `debió terminar el ${fmtDate(p.to)}` : `debió iniciar el ${fmtDate(p.from)}`} (${p.estado})`)),
        )
      : null,
    v.cronograma
      ? h(
          'section',
          { class: 'panel panel-wide' },
          h('div', { class: 'panel-head' }, h('h3', null, 'Cronograma'), v.boards.some((b) => b.role === 'cronograma' && b.test) ? h('span', { class: 'meta' }, 'tablero de migración (prueba)') : null),
          renderGantt(v),
        )
      : null,
    panels.length ? h('div', { class: 'panels' }, panels) : h('div', { class: 'empty' }, 'Sin datos para mostrar todavía.'),
  );
}

// ---------- programa de la flota ----------
function renderPrograma() {
  const list = data.programa;
  if (!list.length) return null;
  const pts = list.flatMap((p) => [p.mandatorio, p.fechaReal ?? monthText(p.fechaTexto)]).filter(Boolean);
  const y0 = Math.min(Number(data.today.slice(0, 4)), ...pts.map((d) => Number(d.slice(0, 4))));
  const y1 = Math.max(...pts.map((d) => Number(d.slice(0, 4))));
  const min = `${y0}-01-01`;
  const max = `${y1 + 1}-01-01`;
  const span = daysBetween(min, max);
  const x = (iso) => (daysBetween(min, iso) / span) * 100;
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const quarters = years.flatMap((y) => [`${y}-04-01`, `${y}-07-01`, `${y}-10-01`]);
  const tipoColor = (t) => TIPO_COLOR[String(t ?? '').toLowerCase()] ?? 'var(--c-cancelled)';
  const grid = () => [
    years.slice(1).map((y) => h('span', { class: 't-year', style: `left:${x(`${y}-01-01`)}%` })),
    quarters.map((q) => h('span', { class: 't-q', style: `left:${x(q)}%` })),
    h('span', { class: 'g-today', style: `left:${x(data.today)}%` }),
  ];

  const rows = list.map((p) => {
    const plan = p.fechaReal ?? monthText(p.fechaTexto);
    const color = tipoColor(p.tipo);
    const planLabel = p.fechaReal ? fmtDate(p.fechaReal, { year: true }) : p.fechaTexto;
    const marks = [];
    if (plan && p.mandatorio && plan !== p.mandatorio) {
      const a = Math.min(x(plan), x(p.mandatorio));
      const b = Math.max(x(plan), x(p.mandatorio));
      marks.push(h('span', { class: 't-link', style: `left:${a}%;width:${b - a}%`, vars: { '--c': color } }));
    }
    if (p.mandatorio) {
      marks.push(h('span', { class: 't-mand', tabindex: '0', style: `left:${x(p.mandatorio)}%`, vars: { '--c': color }, dataset: { tipV: fmtDate(p.mandatorio, { year: true }), tipK: `${p.buque} · fecha mandatoria`, tipC: color } }));
    }
    if (plan && plan !== p.mandatorio) {
      marks.push(h('span', { class: 't-plan', tabindex: '0', style: `left:${x(plan)}%`, vars: { '--c': color }, dataset: { tipV: planLabel, tipK: `${p.buque} · fecha programada`, tipC: color } }));
    }
    return h(
      'div',
      { class: 't-row' },
      h('div', { class: 't-label' }, h('b', null, p.buque), h('span', { class: 'muted' }, [p.tipo, p.lugar].filter(Boolean).join(' · '))),
      h('div', { class: 't-track' }, grid(), marks),
      h('div', { class: 't-when' }, h('span', null, p.mandatorio ? fmtDate(p.mandatorio, { year: true }) : '—'), h('span', { class: 'muted' }, planLabel && !/definir/i.test(planLabel) ? `prog. ${planLabel}` : 'por definir')),
      h('div', { class: 't-cost' }, h('b', null, money(p.estimado)), p.anterior ? h('span', { class: 'muted' }, `anterior ${money(p.anterior)}`) : null),
    );
  });

  const tipos = [...new Set(list.map((p) => p.tipo).filter(Boolean))];
  return h(
    'section',
    { class: 'card', 'aria-label': 'Programa de diques' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', null, data.programaUrl ? h('a', { href: data.programaUrl, target: '_blank', rel: 'noopener' }, 'Programa de diques de la flota') : 'Programa de diques de la flota'),
      h('span', { class: 'meta' }, `${plural(list.length, 'dique', 'diques')} · ${money(data.totals.programaEstimado)} estimado`),
    ),
    h(
      'div',
      { class: 'years' },
      data.programaPorAnio.map((y) => h('div', { class: 'year' }, h('span', { class: 'k' }, y.anio), h('b', null, money(y.estimado)), h('span', { class: 'muted' }, plural(y.count, 'dique', 'diques')))),
    ),
    h(
      'div',
      { class: 'timeline' },
      h(
        'div',
        { class: 't-row t-axis', 'aria-hidden': 'true' },
        h('div'),
        h('div', { class: 't-track' }, years.map((y) => h('span', { class: 't-ylabel', style: `left:${x(`${y}-07-01`)}%` }, String(y)))),
        h('div', { class: 'muted small' }, 'Mandatorio'),
        h('div', { class: 'muted small' }, 'Estimado'),
      ),
      rows,
    ),
    h(
      'ul',
      { class: 'legend' },
      tipos.map((t) => h('li', null, h('span', { class: 'swatch', vars: { '--c': tipoColor(t) } }), `Dique ${t.toLowerCase()}`)),
      h('li', null, h('span', { class: 't-key-mand' }), 'Fecha mandatoria'),
      h('li', null, h('span', { class: 't-key-plan' }), 'Fecha programada'),
      h('li', null, h('span', { class: 'g-key-today' }), 'Hoy'),
    ),
  );
}

// ---------- render principal ----------
function render() {
  const app = document.getElementById('app');
  if (data.error) {
    app.replaceChildren(h('p', { class: 'loading' }, `No se pudieron leer los tableros de dique en la última actualización (${data.error}).`));
    return;
  }
  document.getElementById('coverage').textContent = `${plural(data.buques.length, 'buque', 'buques')} con tableros de dique · programa de ${plural(data.totals.programaCount, 'dique', 'diques')}`;
  app.replaceChildren(...[renderKpis(), ...data.buques.map(renderVessel), renderPrograma()].filter(Boolean));
  app.setAttribute('aria-busy', 'false');
  renderFooter();
  renderUpdated();
}

function renderFooter() {
  document.getElementById('footer').replaceChildren(
    h('div', null, 'Fuente: espacios de trabajo DIQUE SECO y GESTIÓN DE DIQUES en Monday.com. Se actualiza junto con el tablero PMO y esta página recarga sola cada minuto.'),
    h('div', null, 'Incurrido = suma de las órdenes de compra del buque. Presupuesto y proyectado vienen del tablero de gestión o plan del dique. Los montos en euros se muestran aparte, sin convertir.'),
    h('div', null, 'Cuando un buque tiene tableros operativos y copias de migración al Estándar Dique v1, se usan los operativos; las copias solo se usan si no hay otro tablero de ese tipo.'),
  );
}

function renderUpdated() {
  if (!data) return;
  const el = document.getElementById('updated');
  const age = Date.now() - Date.parse(data.generatedAt);
  const stale = age > STALE_MS;
  el.classList.toggle('is-stale', stale);
  el.title = `Datos generados ${new Date(data.generatedAt).toLocaleString('es-PA', { timeZone: data.timezone || 'America/Panama' })}`;
  el.lastElementChild.textContent = `Actualizado ${ago(data.generatedAt)}`;
  const banner = document.getElementById('banner');
  banner.hidden = !stale;
  if (stale) banner.textContent = `Los datos no se actualizan desde ${new Date(data.generatedAt).toLocaleString('es-PA', { timeZone: data.timezone || 'America/Panama' })}. Revisa la acción "Actualizar dashboard" en GitHub.`;
}

// ---------- tooltip ----------
function setupTooltip() {
  const tip = document.getElementById('tip');
  const show = (el, x, y) => {
    tip.replaceChildren(h('div', { class: 'v' }, el.dataset.tipV), h('div', { class: 'k' }, h('i', { vars: { '--c': el.dataset.tipC } }), el.dataset.tipK));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8)}px`;
    tip.style.top = `${y - r.height - 12 < 8 ? y + 16 : y - r.height - 12}px`;
  };
  const hide = () => (tip.hidden = true);
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('[data-tip-v]');
    if (el) show(el, e.clientX, e.clientY);
    else if (!tip.hidden) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip-v]');
    if (!el) return hide();
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('scroll', hide, { passive: true });
}

function setupTheme() {
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('pmo-theme', next);
    } catch {}
  });
}

async function load(initial = false) {
  const app = document.getElementById('app');
  try {
    const res = await fetch(`diques.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!data || next.generatedAt !== data.generatedAt) {
      data = next;
      render();
    }
  } catch (e) {
    if (initial) app.replaceChildren(h('p', { class: 'loading' }, 'Todavía no hay datos de diques. Se generan en la próxima actualización del tablero.'));
    console.error(e);
  } finally {
    renderUpdated();
  }
}

setupTooltip();
setupTheme();
load(true);
setInterval(load, REFRESH_MS);
setInterval(renderUpdated, 30 * 1000);
