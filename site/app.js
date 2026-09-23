'use strict';

const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;

const BUCKET_VAR = {
  done: '--c-done',
  progress: '--c-progress',
  stuck: '--c-stuck',
  notstarted: '--c-notstarted',
  cancelled: '--c-cancelled',
};
const BAR_BUCKETS = ['done', 'progress', 'stuck', 'notstarted'];
const HEALTH = {
  1: { v: '--c-done', ico: 'good', sym: '✓' },
  2: { v: '--c-warn', ico: 'warn', sym: '!' },
  3: { v: '--c-stuck', ico: 'bad', sym: '✕' },
  0: { v: '--c-notstarted', ico: 'none', sym: '–' },
};

let data = null;
const ui = { q: '', open: new Set() };

const nf = new Intl.NumberFormat('es-PA');
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

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function pct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  let p = Math.round(v * 100);
  if (p === 100 && v < 1) p = 99;
  if (p === 0 && v > 0) p = 1;
  return `${p}%`;
}
const share = (n, total) => (total ? pct(n / total) : '—');

function ago(iso) {
  if (!iso) return '—';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'hace un momento';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 45) return rtf.format(Math.round(s / 86400), 'day');
  if (a < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), 'month');
  return rtf.format(Math.round(s / (86400 * 365)), 'year');
}

function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return new Intl.DateTimeFormat('es-PA', {
    timeZone: data?.timezone || 'America/Panama',
    day: 'numeric',
    month: 'short',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  }).format(d);
}

function luminance(rgb) {
  const m = String(rgb).match(/\d+(\.\d+)?/g);
  if (!m) return 1;
  const [r, g, b] = m.slice(0, 3).map((x) => {
    const c = Number(x) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function hexLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return luminance(`${n >> 16} ${(n >> 8) & 255} ${n & 255}`);
}
function mixWhite(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * t));
  return `rgb(${ch.join(',')})`;
}

// ---------- barras apiladas ----------
// segs: [{ label, count, color }] donde color es "var(--x)" o un hex de Monday
function stackBar(segs, { size = 'sm', labels = false, focusable = false } = {}) {
  const total = segs.reduce((n, s) => n + s.count, 0);
  const aria = segs
    .filter((s) => s.count)
    .map((s) => `${s.label}: ${s.count} (${share(s.count, total)})`)
    .join(', ');
  const bar = h('div', { class: `stack stack-${size}`, role: 'img', 'aria-label': aria || 'Sin datos' });
  if (!total) {
    bar.classList.add('stack-empty');
    return bar;
  }
  for (const s of segs) {
    if (!s.count) continue;
    const vars = { '--c': s.color };
    const isHex = s.color.startsWith('#');
    const seg = h('span', {
      class: 'seg',
      vars,
      tabindex: focusable ? '0' : null,
      dataset: { tipV: `${nf.format(s.count)} · ${share(s.count, total)}`, tipK: s.label, tipC: s.color },
    });
    if (isHex && hexLum(s.color) < 0.05) {
      seg.classList.add('lift');
      seg.style.setProperty('--c-lift', mixWhite(s.color, 0.45));
      seg.dataset.tipC = mixWhite(s.color, 0.45);
    }
    seg.style.flexGrow = s.count;
    if (labels) seg.append(h('span', { class: 'seg-label' }, share(s.count, total)));
    bar.append(seg);
  }
  if (labels) queueMicrotask(() => fitLabels(bar));
  return bar;
}

function fitLabels(bar) {
  for (const seg of bar.querySelectorAll('.seg')) {
    const lab = seg.querySelector('.seg-label');
    if (!lab) continue;
    lab.classList.remove('is-hidden');
    const fits = lab.scrollWidth + 4 <= seg.clientWidth;
    lab.classList.toggle('is-hidden', !fits);
    // tinta oscura o blanca, la que tenga más contraste con el relleno
    const lum = luminance(getComputedStyle(seg).backgroundColor);
    seg.classList.toggle('ink-dark', lum > 0.187);
    seg.classList.toggle('ink-light', lum <= 0.187);
  }
}
const labeledBars = new ResizeObserver((entries) => entries.forEach((e) => fitLabels(e.target)));

const bucketSegs = (buckets) =>
  BAR_BUCKETS.map((k) => ({
    label: data.buckets.find((b) => b.key === k).label,
    count: buckets?.[k] ?? 0,
    color: `var(${BUCKET_VAR[k]})`,
  }));

function bucketLegend(buckets, { counts = true } = {}) {
  const total = BAR_BUCKETS.reduce((n, k) => n + (buckets[k] ?? 0), 0);
  return h(
    'ul',
    { class: 'legend' },
    BAR_BUCKETS.map((k) => {
      const b = data.buckets.find((x) => x.key === k);
      return h(
        'li',
        null,
        h('span', { class: 'swatch', vars: { '--c': `var(${BUCKET_VAR[k]})` } }),
        b.label,
        ' ',
        h('b', null, share(buckets[k] ?? 0, total)),
        counts ? h('span', { class: 'muted' }, ` (${nf.format(buckets[k] ?? 0)})`) : null,
      );
    }),
  );
}

const phaseColor = (p) =>
  !p
    ? 'var(--c-notstarted)'
    : p.bucket === 'progress' && /planific/i.test(norm(p.label))
      ? 'var(--c-plan)'
      : `var(${BUCKET_VAR[p.bucket] ?? '--c-notstarted'})`;

function healthPill(hl) {
  if (!hl) return null;
  const cfg = HEALTH[hl.severity ?? 0] ?? HEALTH[0];
  const label = hl.severity ? hl.label : 'Sin definir';
  return h('span', { class: 'pill' }, h('span', { class: `ico ${cfg.ico}`, 'aria-hidden': 'true' }, cfg.sym), label);
}

// ---------- secciones ----------
function renderHero() {
  const t = data.totals;
  const tasks = t.tasks;
  const countable = BAR_BUCKETS.reduce((n, k) => n + tasks[k], 0);
  const bar = stackBar(bucketSegs(tasks), { size: 'lg', labels: true, focusable: true });
  labeledBars.observe(bar);

  const tile = (label, value, hint, cls, ico) =>
    h(
      'div',
      { class: `tile ${cls || ''}` },
      h('div', { class: 'label' }, ico, label),
      h('div', { class: 'value' }, value),
      hint ? h('div', { class: 'hint' }, hint) : null,
    );

  return h(
    'section',
    { class: 'card hero', 'aria-label': 'Resumen general' },
    h(
      'div',
      null,
      h('div', { class: 'eyebrow' }, 'Avance de proyectos y mejoras activos'),
      h('div', { class: 'hero-num' }, t.avance == null ? '—' : pct(t.avance).replace('%', ''), t.avance == null ? null : h('small', null, '%')),
      h(
        'div',
        { class: 'hero-sub' },
        `${nf.format(tasks.done)} de ${nf.format(countable)} tareas completadas en ${t.projectsActive} ${t.projectsActive === 1 ? 'proyecto activo' : 'proyectos activos'}`,
      ),
      bar,
      bucketLegend(tasks),
    ),
    h(
      'div',
      { class: 'tiles' },
      tile('Proyectos y mejoras activos', nf.format(t.projectsActive), `${t.projectsDone} completados · ${t.projects} en total`),
      tile(
        'Tareas detenidas',
        nf.format(t.stuck),
        t.stuck ? 'Detenidas, bloqueadas o en espera' : 'Nada detenido',
        t.stuck ? 'is-alert' : '',
        h('span', { class: `ico ${t.stuck ? 'bad' : 'good'}`, 'aria-hidden': 'true' }, t.stuck ? '✕' : '✓'),
      ),
      tile(
        'Tareas vencidas',
        nf.format(t.overdue),
        t.overdue ? 'Fecha pasada y sin completar' : 'Todo en fecha',
        t.overdue ? 'is-warn' : '',
        h('span', { class: `ico ${t.overdue ? 'warn' : 'good'}`, 'aria-hidden': 'true' }, t.overdue ? '!' : '✓'),
      ),
      tile('Actividad últimos 7 días', nf.format(t.updated7d), 'elementos actualizados en Monday', '', h('span', { class: 'ico info', 'aria-hidden': 'true' }, '↻')),
    ),
  );
}

function renderPortfolio() {
  const p = data.portfolio;
  if (!p) return null;

  const phaseSegs = p.phase.map((x) => ({ label: x.label, count: x.count, color: phaseColor(x) }));
  const healthSegs = p.health.map((x) => ({
    label: x.severity ? x.label : 'Sin definir',
    count: x.count,
    color: `var(${(HEALTH[x.severity ?? 0] ?? HEALTH[0]).v})`,
  }));
  const distLegend = (segs) =>
    h(
      'ul',
      { class: 'legend' },
      segs.map((s) =>
        h('li', null, h('span', { class: 'swatch', vars: { '--c': s.color } }), s.label, ' ', h('b', null, nf.format(s.count)), h('span', { class: 'muted' }, ` (${share(s.count, p.total)})`)),
      ),
    );

  const order = { progress: 0, stuck: 0, notstarted: 1, done: 2, cancelled: 3 };
  const items = [...p.items].sort(
    (a, b) =>
      (order[a.phase?.bucket] ?? 1) - (order[b.phase?.bucket] ?? 1) ||
      (b.health?.severity ?? 0) - (a.health?.severity ?? 0) ||
      a.name.localeCompare(b.name),
  );
  const boardsById = Object.fromEntries(data.boards.map((b) => [b.id, b]));

  return h(
    'section',
    { class: 'card', 'aria-label': 'Portafolio' },
    h('div', { class: 'card-head' }, h('h2', null, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.name)), h('span', { class: 'meta' }, `${p.total} proyectos y mejoras`)),
    h('div', { class: 'dist-row' }, h('span', { class: 'dist-label' }, 'Fase'), h('div', null, stackBar(phaseSegs, { size: 'md', focusable: true }), distLegend(phaseSegs))),
    h('div', { class: 'dist-row' }, h('span', { class: 'dist-label' }, 'Salud'), h('div', null, stackBar(healthSegs, { size: 'md', focusable: true }), distLegend(healthSegs))),
    h(
      'ul',
      { class: 'plist' },
      items.map((it) => {
        const b = it.boardId ? boardsById[it.boardId] : null;
        return h(
          'li',
          null,
          healthPill(it.health) ?? h('span'),
          h(
            'div',
            { class: 'pname' },
            h('a', { href: b?.url ?? it.url, target: '_blank', rel: 'noopener', title: it.name }, it.name),
            h(
              'div',
              { class: 's' },
              it.phase ? h('span', { class: 'pill' }, h('span', { class: 'dotc', vars: { '--c': phaseColor(it.phase) } }), it.phase.label) : null,
              it.tipo ? h('span', { class: 'chip' }, it.tipo) : null,
              !b ? h('span', null, 'sin tablero') : null,
            ),
          ),
          h('div', { class: 'pbar' }, b ? stackBar(bucketSegs(b.buckets)) : null),
          h('div', { class: 'pct' }, b ? pct(b.avance) : '—'),
        );
      }),
    ),
  );
}

function renderAttention() {
  const a = data.attention;
  const group = (title, ico, list, render) => {
    const LIMIT = 5;
    const ul = h('ul', { class: 'att-list' });
    const draw = (all) => {
      ul.replaceChildren(...(all ? list : list.slice(0, LIMIT)).map(render));
    };
    draw(false);
    const more =
      list.length > LIMIT
        ? h('button', {
            class: 'link-btn',
            type: 'button',
            onclick: (e) => {
              const open = e.currentTarget.dataset.open !== '1';
              e.currentTarget.dataset.open = open ? '1' : '0';
              e.currentTarget.textContent = open ? 'Ver menos' : `Ver todas (${list.length})`;
              draw(open);
            },
          }, `Ver todas (${list.length})`)
        : null;
    return h(
      'div',
      { class: 'att-group' },
      h('div', { class: 'att-head' }, ico, title, h('span', { class: 'n' }, list.length)),
      list.length ? ul : h('div', { class: 'att-empty' }, 'Nada por ahora.'),
      more,
    );
  };
  const itemRow = (x, when) =>
    h(
      'li',
      null,
      h('div', { style: 'min-width:0' }, h('a', { class: 'nm', href: x.url, target: '_blank', rel: 'noopener', title: x.name }, x.name), h('div', { class: 'bd', title: x.board }, x.board)),
      when ? h('span', { class: 'when' }, when) : null,
    );

  return h(
    'section',
    { class: 'card', 'aria-label': 'Requiere atención' },
    h('div', { class: 'card-head' }, h('h2', null, 'Requiere atención'), h('span', { class: 'meta' }, 'Proyectos activos')),
    group('Detenidas', h('span', { class: 'ico bad', 'aria-hidden': 'true' }, '✕'), a.stuck, (x) => itemRow(x, x.status)),
    group('Vencidas', h('span', { class: 'ico warn', 'aria-hidden': 'true' }, '!'), a.overdue, (x) => itemRow(x, `venció ${fmtDate(x.due)}`)),
    group('Sin movimiento reciente', h('span', { class: 'ico none', 'aria-hidden': 'true' }, '–'), a.stale, (x) =>
      itemRow({ name: x.board, url: x.url, board: `Última actividad ${ago(x.lastActivity)}` }, fmtDate(x.lastActivity)),
    ),
  );
}

function boardRow(b, mode) {
  const progress = mode === 'progress';
  const key = `b-${b.id}`;
  const sub = [
    progress ? healthPill(b.health) : null,
    b.tipo && progress ? h('span', { class: 'chip' }, b.tipo) : null,
    h('span', null, [b.folder ?? b.workspace, progress && b.lastActivity ? `act. ${ago(b.lastActivity)}` : null].filter(Boolean).join(' · ')),
  ];

  let num;
  let bar;
  if (progress) {
    num = h('div', { class: 'bnum' }, pct(b.avance));
    bar = h('div', { class: 'bbar' }, stackBar(bucketSegs(b.buckets)));
  } else {
    const segs = b.labels.map((l) => ({ label: l.label, count: l.count, color: l.color }));
    num = h('div', { class: 'bnum small' }, nf.format(b.total));
    const top = [...b.labels].sort((x, y) => y.count - x.count).slice(0, 4);
    bar = h(
      'div',
      { class: 'bbar' },
      stackBar(segs),
      h(
        'div',
        { class: 'inline-legend' },
        top.map((l) => h('span', null, h('span', { class: 'dotc', vars: { '--c': hexLum(l.color) < 0.05 ? mixWhite(l.color, 0.45) : l.color } }), `${l.label} ${share(l.count, b.total)}`)),
        b.labels.length > 4 ? h('span', { class: 'muted' }, `+${b.labels.length - 4}`) : null,
      ),
    );
  }

  const meta = [];
  if (progress) {
    meta.push(`${nf.format(b.total)} ${b.hierarchy === 'multi_level' ? 'tareas' : 'elementos'}`);
    if (b.buckets.stuck) meta.push(h('span', { class: 'warn' }, `${b.buckets.stuck} detenida${b.buckets.stuck > 1 ? 's' : ''}`));
    if (b.overdue && b.state === 'active') meta.push(h('span', { class: 'warn' }, `${b.overdue} vencida${b.overdue > 1 ? 's' : ''}`));
  } else {
    meta.push(`act. ${ago(b.lastActivity)}`);
  }

  const labelTotal = b.labels.reduce((n, l) => n + l.count, 0);
  const bucketName = (k) => data.buckets.find((x) => x.key === k)?.label ?? k;
  const details = h(
    'details',
    {
      class: `brow ${b.state === 'done' ? 'row-done' : ''}`,
      dataset: { key, search: norm([b.name, b.folder, b.workspace, b.code].join(' ')) },
      open: ui.open.has(key),
      ontoggle: (e) => (e.currentTarget.open ? ui.open.add(key) : ui.open.delete(key)),
    },
    h(
      'summary',
      null,
      h('div', { class: 'bname' }, h('span', { class: 't', title: b.name }, b.name), h('span', { class: 's' }, sub)),
      num,
      bar,
      h('div', { class: 'bmeta' }, meta.flatMap((m, i) => (i ? [' · ', m] : [m]))),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'),
    ),
    h(
      'div',
      { class: 'bdetail' },
      b.labels.length
        ? h(
            'table',
            { class: 'btable' },
            h('thead', null, h('tr', null, h('th', null, 'Estado en Monday'), h('th', null, 'Cuenta como'), h('th', { class: 'n' }, 'Cant.'), h('th', { class: 'n' }, '%'))),
            h(
              'tbody',
              null,
              b.labels.map((l) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('span', { class: 'pill' }, h('span', { class: 'swatch', vars: { '--c': hexLum(l.color) < 0.05 ? mixWhite(l.color, 0.45) : l.color } }), l.label)),
                  h('td', { class: 'muted' }, bucketName(l.bucket)),
                  h('td', { class: 'n' }, nf.format(l.count)),
                  h('td', { class: 'n' }, share(l.count, labelTotal)),
                ),
              ),
            ),
          )
        : h('div', { class: 'muted' }, 'Este tablero no tiene columna de estado.'),
      h(
        'div',
        { class: 'side' },
        b.statusColumn ? h('span', null, `Columna de estado: ${b.statusColumn}`) : null,
        progress && b.dueColumn ? h('span', null, `Fechas: ${b.dueColumn}`) : null,
        b.buckets.cancelled ? h('span', null, `${b.buckets.cancelled} cancelado(s), no cuentan en el avance`) : null,
        b.lastActivity ? h('span', null, `Última actividad: ${fmtDate(b.lastActivity, true)}`) : null,
        h('a', { href: b.url, target: '_blank', rel: 'noopener' }, 'Abrir en Monday ↗'),
      ),
    ),
  );
  return details;
}

function renderSection(sec, boardsById) {
  const list = sec.boards.map((id) => boardsById[id]).filter(Boolean);
  const progress = sec.mode === 'progress';
  const withStatus = list.filter((b) => b.state === 'active' || b.state === 'done');
  const empty = list.filter((b) => b.state === 'empty' || b.state === 'nostatus');
  const byActivity = (a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');
  const attentionScore = (b) =>
    ((b.health?.severity ?? 0) >= 2 ? b.health.severity * 100 : 0) + (b.buckets.stuck ? 50 : 0) + (b.overdue ? 25 : 0);

  let main;
  let done = [];
  if (progress) {
    main = list.filter((b) => b.state === 'active').sort((a, b) => attentionScore(b) - attentionScore(a) || byActivity(a, b));
    done = list.filter((b) => b.state === 'done').sort(byActivity);
  } else {
    main = withStatus.sort(byActivity);
  }

  const agg = progress ? sec.buckets : null;
  const metaParts = progress
    ? [`${main.length} activos`, done.length ? `${done.length} completados` : null, empty.length ? `${empty.length} sin datos` : null]
    : [`${list.length} tableros`, `${nf.format(list.reduce((n, b) => n + b.total, 0))} elementos`];

  const head = h(
    'div',
    { class: 'section-head' },
    h('div', null, h('h2', null, sec.title), h('div', { class: 'meta' }, metaParts.filter(Boolean).join(' · '))),
    agg && main.length
      ? h('div', { title: 'Tareas de los tableros activos de esta sección' }, stackBar(bucketSegs(agg), { size: 'md', focusable: true }))
      : sec.collapsed
        ? h('div', { class: 'fold-hint' }, 'Mostrar')
        : h('div'),
  );
  const cols = h(
    'div',
    { class: 'cols', 'aria-hidden': 'true' },
    h('span', null, 'Tablero'),
    h('span', { class: 'r' }, progress ? 'Avance' : 'Elementos'),
    h('span', null, progress ? 'Estado de las tareas' : 'Distribución por estado'),
    h('span', null, progress ? 'Detalle' : 'Actividad'),
    h('span'),
  );

  const groupKey = (k) => `g-${sec.key}-${k}`;
  const group = (k, title, rows) =>
    rows.length
      ? h(
          'details',
          {
            class: 'group',
            dataset: { key: groupKey(k) },
            open: ui.open.has(groupKey(k)),
            ontoggle: (e) => (e.currentTarget.open ? ui.open.add(groupKey(k)) : ui.open.delete(groupKey(k))),
          },
          h('summary', null, `${title} (${rows.length})`),
          rows.map((b) => boardRow(b, sec.mode)),
        )
      : null;

  const body = [
    cols,
    main.map((b) => boardRow(b, sec.mode)),
    !main.length && !done.length ? h('div', { class: 'att-empty', style: 'padding:10px 8px' }, 'No hay tableros activos en esta sección.') : null,
    group('done', 'Completados', done),
    group('empty', 'Sin datos de estado', empty),
  ];

  if (sec.collapsed) {
    const key = `s-${sec.key}`;
    return h(
      'details',
      {
        class: 'card section-fold',
        dataset: { section: sec.key, key },
        open: ui.open.has(key),
        ontoggle: (e) => (e.currentTarget.open ? ui.open.add(key) : ui.open.delete(key)),
      },
      h('summary', null, head),
      body,
    );
  }
  return h('section', { class: 'card', dataset: { section: sec.key } }, head, body);
}

// ---------- búsqueda ----------
function applySearch() {
  const q = norm(ui.q.trim());
  for (const row of document.querySelectorAll('details.brow')) {
    row.classList.toggle('hidden-by-search', !!q && !row.dataset.search.includes(q));
  }
  for (const g of document.querySelectorAll('details.group, details.section-fold')) {
    if (q && g.querySelector('details.brow:not(.hidden-by-search)')) g.open = true;
  }
  for (const s of document.querySelectorAll('[data-section]')) {
    const any = s.querySelector('details.brow:not(.hidden-by-search)');
    s.classList.toggle('hidden-by-search', !!q && !any);
  }
}

// ---------- render principal ----------
function render() {
  const app = document.getElementById('app');
  const boardsById = Object.fromEntries(data.boards.map((b) => [b.id, b]));
  const workspaces = new Set(data.boards.map((b) => b.workspace)).size;

  document.getElementById('coverage').textContent =
    `${nf.format(data.totals.boards)} tableros · ${nf.format(data.totals.items)} elementos · ${workspaces} espacios de trabajo de Monday`;

  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Buscar tablero, proyecto o código…',
    'aria-label': 'Buscar tablero',
    value: ui.q,
    oninput: (e) => {
      ui.q = e.currentTarget.value;
      applySearch();
    },
  });

  const portfolio = renderPortfolio();
  app.replaceChildren(
    renderHero(),
    h('div', { class: 'grid-2' }, portfolio, renderAttention()),
    h('div', { class: 'filters' }, search, h('span', { class: 'count' }, 'Toca un tablero para ver el detalle de sus estados.')),
    ...data.sections.map((s) => renderSection(s, boardsById)),
  );
  if (!portfolio) app.querySelector('.grid-2').style.gridTemplateColumns = '1fr';
  app.setAttribute('aria-busy', 'false');
  applySearch();
  renderFooter();
  renderUpdated();
}

function renderFooter() {
  const f = document.getElementById('footer');
  const errs = data.errors ?? [];
  f.replaceChildren(
    ...[
      h('div', null, 'Fuente: Monday.com. El tablero se actualiza solo (cada 10 min en horario laboral, cada hora el resto del tiempo) y esta página recarga los datos cada 5 min.'),
      h('div', null, 'Avance = tareas completadas ÷ tareas totales, sin contar canceladas. En tableros multinivel se cuentan las subtareas (no los elementos padre).'),
      errs.length ? h('div', null, `No se pudieron leer ${errs.length} tablero(s): ${errs.map((e) => e.board).join(', ')}.`) : null,
    ].filter(Boolean),
  );
}

function renderUpdated() {
  if (!data) return;
  const el = document.getElementById('updated');
  const age = Date.now() - Date.parse(data.generatedAt);
  const stale = age > STALE_MS;
  el.classList.toggle('is-stale', stale);
  el.title = `Datos generados el ${fmtDate(data.generatedAt, true)}`;
  el.lastElementChild.textContent = `Actualizado ${ago(data.generatedAt)}`;
  const banner = document.getElementById('banner');
  banner.hidden = !stale;
  if (stale) banner.textContent = `Los datos no se actualizan desde ${fmtDate(data.generatedAt, true)}. Revisa la acción "Actualizar dashboard" en GitHub.`;
}

// ---------- tooltip ----------
function setupTooltip() {
  const tip = document.getElementById('tip');
  const show = (seg, x, y) => {
    tip.replaceChildren(
      h('div', { class: 'v' }, seg.dataset.tipV),
      h('div', { class: 'k' }, h('i', { vars: { '--c': seg.dataset.tipC } }), seg.dataset.tipK),
    );
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => (tip.hidden = true);
  document.addEventListener('pointermove', (e) => {
    const seg = e.target.closest?.('.seg[data-tip-v]');
    if (seg) show(seg, e.clientX, e.clientY);
    else if (!tip.hidden) hide();
  });
  document.addEventListener('focusin', (e) => {
    const seg = e.target.closest?.('.seg[data-tip-v]');
    if (!seg) return hide();
    const r = seg.getBoundingClientRect();
    show(seg, r.left + r.width / 2, r.top);
  });
  document.addEventListener('scroll', hide, { passive: true });
}

// ---------- tema ----------
function setupTheme() {
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('pmo-theme', next);
    } catch {}
    document.querySelectorAll('.stack-lg').forEach(fitLabels);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
    document.querySelectorAll('.stack-lg').forEach(fitLabels),
  );
}

// ---------- carga ----------
async function load(initial = false) {
  const app = document.getElementById('app');
  try {
    if (!initial) app.classList.add('is-refreshing');
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!data || next.generatedAt !== data.generatedAt) {
      data = next;
      render();
    }
  } catch (e) {
    if (initial) {
      app.replaceChildren(h('p', { class: 'loading' }, 'No se pudieron cargar los datos. Intenta recargar la página en unos minutos.'));
    }
    console.error(e);
  } finally {
    app.classList.remove('is-refreshing');
    renderUpdated();
  }
}

setupTooltip();
setupTheme();
load(true);
setInterval(load, REFRESH_MS);
setInterval(renderUpdated, 30 * 1000);
