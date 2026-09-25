// Arma el resumen de diques secos (site/diques.json) a partir de los tableros de los espacios de dique.
// Funciones puras: reciben los tableros con todas sus columnas y valores, no llaman a la red.
import { norm, classifyLabel } from './transform.mjs';

// Rol de cada tablero según su nombre (el orden importa: gana la primera regla que coincide)
const ROLES = [
  ['programa', /programa de diques/],
  ['cronograma', /cronograma/],
  ['centros', /centros? de costo|^cc /],
  ['cambios', /cambio|imprevist/],
  ['compras', /\bpos?\b|compras|ordenes de compra/],
  ['planificacion', /^p\d\b|planificacion/],
  ['trabajos', /plan de trabajos/],
  ['gestion', /gestion de dique|plan de dique|^t1\b|^d1\b/],
];
export const roleOf = (name) => ROLES.find(([, re]) => re.test(norm(name)))?.[0] ?? null;

// ---------- lectura de valores ----------
const cell = (item, col) => (col ? item.column_values?.find((v) => v.id === col.id) : null);
const parse = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
const shown = (cv) => {
  const t = cv?.display_value ?? cv?.text;
  return t == null || t === 'null' ? '' : String(t).trim();
};

// Números: los reflejos traen varios valores separados por coma ("3981.00, 3452.25"); se suman
export function numOf(item, col) {
  const cv = cell(item, col);
  if (!cv) return null;
  let t = shown(cv);
  if (!t) {
    const v = parse(cv.value);
    t = typeof v === 'number' || typeof v === 'string' ? String(v) : '';
  }
  const nums = t
    .split(/,\s+/)
    .map((x) => parseFloat(x.replace(/[^0-9.-]/g, '')))
    .filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

const labelMaps = new WeakMap();
function labelsOf(col) {
  if (labelMaps.has(col)) return labelMaps.get(col);
  const s = parse(col.settings_str) ?? {};
  const map = new Map();
  if (Array.isArray(s.labels)) for (const l of s.labels) map.set(Number(l.id), l.label);
  else if (s.labels) for (const [k, v] of Object.entries(s.labels)) map.set(Number(k), v);
  labelMaps.set(col, map);
  return map;
}
export function statusOf(item, col) {
  const cv = cell(item, col);
  if (!cv) return null;
  const v = parse(cv.value);
  if (v?.index != null) return labelsOf(col).get(Number(v.index))?.trim() || null;
  return shown(cv) || null;
}
const textOf = (item, col) => shown(cell(item, col)) || null;
function dateOf(item, col) {
  const cv = cell(item, col);
  if (!cv) return null;
  const v = parse(cv.value);
  const d = v?.date ?? shown(cv);
  return /^\d{4}-\d{2}-\d{2}/.test(d ?? '') ? d.slice(0, 10) : null;
}
function rangeOf(item, col) {
  const v = parse(cell(item, col)?.value);
  const ok = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d ?? '') ? d.slice(0, 10) : null);
  const from = ok(v?.from);
  const to = ok(v?.to) ?? from;
  return from ? { from, to } : null;
}

// ---------- columnas ----------
const isEur = (c) => /€|\beur\b/i.test(c.title);
function findCol(board, tests, types) {
  const cols = (board.columns ?? []).filter((c) => !types || types.includes(c.type));
  for (const re of [].concat(tests)) {
    const c = cols.find((x) => re.test(norm(x.title)));
    if (c) return c;
  }
  return null;
}
const MONEY = ['numbers', 'formula', 'mirror'];
const usd = (board, tests, types = MONEY) => {
  const cols = { ...board, columns: (board.columns ?? []).filter((c) => !isEur(c)) };
  return findCol(cols, tests, types);
};

const leavesOf = (board) => {
  const parents = new Set((board.items ?? []).map((i) => i.parent_item?.id).filter(Boolean));
  return (board.items ?? []).filter((i) => !parents.has(i.id));
};
const groupTitle = (board, item) => board.groups?.find((g) => g.id === item.group?.id)?.title ?? null;
const sum = (list, f) => list.reduce((n, x) => n + (f(x) ?? 0), 0);
const round = (n) => Math.round(n * 100) / 100;

// Agrupa elementos por una etiqueta y suma un monto opcional
function tally(items, keyOf, amountOf) {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it) || 'Sin estado';
    const e = m.get(k) ?? { label: k, count: 0, amount: 0 };
    e.count++;
    if (amountOf) e.amount += amountOf(it) ?? 0;
    m.set(k, e);
  }
  return [...m.values()].map((e) => ({ ...e, amount: round(e.amount), bucket: bucketOf(e.label) })).sort((a, b) => b.count - a.count);
}

// Grupo de color para etiquetas de dique (diferido/trasladado se muestra aparte de cancelado)
export function bucketOf(label) {
  const t = norm(label);
  if (!t || t === 'sin estado') return 'empty';
  if (t === 'no aplica') return 'notstarted';
  if (/diferid|traslad|pospuest/.test(t)) return 'deferred';
  if (/rechaz|cancelad|descartad/.test(t)) return 'cancelled';
  if (/retrasad|riesgo|past due|vencid/.test(t)) return 'stuck';
  if (/sin registro|indetermin|sin orden/.test(t)) return 'notstarted';
  if (/pagad|incurrid|aprobad|con orden/.test(t) && !/parcial|pendient/.test(t)) return 'done';
  if (/pendient|solicitad|revision|revisado/.test(t)) return 'warn';
  if (/anticipo|parcial|monitoreo|abiert/.test(t)) return 'progress';
  return classifyLabel(label, '', false);
}

// Nombres de fase escritos de distintas formas ("POST- DIQUE", "Post-Dique") quedan iguales
const PHASES = { planificacion: 'Planificación', predique: 'Pre-dique', dique: 'Dique', postdique: 'Post-dique', cierre: 'Cierre' };
export function phaseName(label) {
  const k = norm(label).replace(/^\d+\s*/, '').replace(/[^a-z]/g, '');
  return PHASES[k] ?? null;
}

// ---------- constructores por rol ----------
function buildGestion(board) {
  const L = leavesOf(board);
  const c = {
    presupuesto: usd(board, [/^(presupuesto|aprobado)( usd)?$/, /presupuesto/]),
    proyectado: usd(board, [/^proyectado( usd)?$/]),
    proyectadoEur: (board.columns ?? []).find((x) => isEur(x) && /proyectado/.test(norm(x.title)) && MONEY.includes(x.type)) ?? null,
    incurrido: usd(board, [/incurrido/], ['mirror', 'numbers']),
    estado: findCol(board, [/^status actividad$/, /^estado$/], ['status']),
    fase: findCol(board, [/^fase$/], ['status']),
    area: findCol(board, [/^area$/], ['status']),
    real: findCol(board, [/tiempo real|fecha real/], ['timeline']),
    plan: findCol(board, [/tiempo plan|cronograma/], ['timeline']),
  };
  const ranges = L.map((i) => rangeOf(i, c.real) ?? rangeOf(i, c.plan)).filter(Boolean);
  return {
    lines: L.length,
    presupuesto: c.presupuesto ? round(sum(L, (i) => numOf(i, c.presupuesto))) : null,
    proyectado: c.proyectado ? round(sum(L, (i) => numOf(i, c.proyectado))) : null,
    proyectadoEur: c.proyectadoEur ? round(sum(L, (i) => numOf(i, c.proyectadoEur))) : null,
    incurrido: c.incurrido ? round(sum(L, (i) => numOf(i, c.incurrido))) : null,
    porEstado: c.estado ? tally(L, (i) => statusOf(i, c.estado)) : [],
    porFase: tally(L, (i) => {
      const f = c.fase ? statusOf(i, c.fase) : null;
      return phaseName(f) ?? f ?? phaseName(groupTitle(board, i)) ?? 'Sin fase';
    }),
    porArea: c.area ? tally(L, (i) => statusOf(i, c.area)) : [],
    periodo: ranges.length
      ? { from: ranges.map((r) => r.from).sort()[0], to: ranges.map((r) => r.to).sort().at(-1) }
      : null,
  };
}

const PAGO_PENDIENTE = /pendient|past due|vencid/;
function buildCompras(board) {
  const L = leavesOf(board);
  const c = {
    total: usd(board, [/po total/]),
    incurrido: usd(board, [/^incurrido( usd)?$/, /incurrido/], ['numbers', 'formula']),
    saldo: usd(board, [/saldo/]),
    pago: findCol(board, [/estatus de pago/], ['status']),
    estadoPO: findCol(board, [/estatus po/], ['status', 'dropdown']),
    proveedor: findCol(board, [/proveedor/], ['text', 'dropdown']),
    fecha: findCol(board, [/^fecha/], ['date']),
    cc: findCol(board, [/^cc$/, /centro de costo/], ['mirror', 'dropdown', 'status']),
  };
  const amount = (i) => numOf(i, c.incurrido) ?? 0;
  const pendientes = L.filter((i) => PAGO_PENDIENTE.test(norm(statusOf(i, c.pago) ?? '')))
    .map((i) => ({
      name: i.name,
      proveedor: textOf(i, c.proveedor),
      monto: round(amount(i) || numOf(i, c.total) || 0),
      estado: statusOf(i, c.pago),
      fecha: dateOf(i, c.fecha),
    }))
    .sort((a, b) => b.monto - a.monto);
  const porCentro = c.cc
    ? tally(L, (i) => (c.cc.type === 'status' ? statusOf(i, c.cc) : textOf(i, c.cc)), amount)
        .filter((x) => x.label !== 'Sin estado' || x.amount)
        .sort((a, b) => b.amount - a.amount)
    : [];
  return {
    count: L.length,
    incurrido: round(sum(L, amount)),
    poTotal: c.total ? round(sum(L, (i) => numOf(i, c.total))) : null,
    porPago: c.pago ? tally(L, (i) => statusOf(i, c.pago), amount) : [],
    porEstadoPO: c.estadoPO ? tally(L, (i) => statusOf(i, c.estadoPO), amount) : [],
    porCentro: porCentro.map((x) => ({ ...x, label: x.label === 'Sin estado' ? 'Sin centro de costo' : x.label })),
    pendientes: pendientes.slice(0, 10),
    pendientesCount: pendientes.length,
    pendientesMonto: round(sum(pendientes, (p) => p.monto)),
  };
}

function buildCambios(board) {
  const L = leavesOf(board);
  const c = {
    costo: usd(board, [/^costo( usd)?$/, /impacto usd/, /^impacto$/, /costo/]),
    dias: findCol(board, [/dias/], ['numbers']),
    estado: findCol(board, [/^estado$/], ['status']),
    tipo: findCol(board, [/tipo de impacto/], ['dropdown', 'status']),
    cc: findCol(board, [/centro de costo/], ['dropdown', 'status', 'mirror']),
    registro: findCol(board, [/registro/], ['creation_log', 'date']),
  };
  const costo = (i) => numOf(i, c.costo);
  const items = L.map((i) => ({
    name: i.name,
    url: i.url ?? null,
    costo: round(costo(i) ?? 0),
    dias: numOf(i, c.dias),
    estado: statusOf(i, c.estado) ?? 'Sin estado',
    bucket: bucketOf(statusOf(i, c.estado)),
    tipo: textOf(i, c.tipo),
    cc: c.cc?.type === 'status' ? statusOf(i, c.cc) : textOf(i, c.cc),
    grupo: groupTitle(board, i),
    fecha: (c.registro?.type === 'date' ? dateOf(i, c.registro) : null) ?? i.created_at?.slice(0, 10) ?? null,
  })).sort((a, b) => b.costo - a.costo);
  const porDecidir = items.filter((x) => /solicitad|pendient/.test(norm(x.estado)));
  return {
    count: L.length,
    costo: round(sum(items, (x) => x.costo)),
    dias: round(sum(items, (x) => x.dias)),
    porEstado: tally(L, (i) => statusOf(i, c.estado), costo),
    porDecidir: { count: porDecidir.length, costo: round(sum(porDecidir, (x) => x.costo)) },
    items: items.slice(0, 12),
  };
}

function buildCronograma(board, today) {
  const c = {
    estado: findCol(board, [/^estado$/], ['status']),
    real: findCol(board, [/fecha real/], ['timeline']),
    base: findCol(board, [/base/], ['timeline']),
    diferencia: findCol(board, [/diferencia/], ['formula', 'numbers']),
    avance: findCol(board, [/avance/], ['numbers', 'formula']),
  };
  const phases = leavesOf(board).map((i) => {
    const real = rangeOf(i, c.real);
    const base = rangeOf(i, c.base);
    const cur = real ?? base;
    const estado = statusOf(i, c.estado) ?? 'Sin estado';
    const bucket = bucketOf(estado);
    const alerta =
      cur && bucket !== 'done'
        ? cur.to < today
          ? 'atrasada'
          : cur.from <= today && bucket === 'notstarted'
            ? 'sin iniciar'
            : null
        : null;
    return {
      name: i.name,
      grupo: groupTitle(board, i),
      estado,
      bucket,
      from: cur?.from ?? null,
      to: cur?.to ?? null,
      baseFrom: base?.from ?? null,
      baseTo: base?.to ?? null,
      diferencia: numOf(i, c.diferencia),
      avance: numOf(i, c.avance),
      hito: !!cur && cur.from === cur.to,
      alerta,
    };
  });
  const dated = phases.filter((p) => p.from);
  const periodo = dated.length ? { from: dated.map((p) => p.from).sort()[0], to: dated.map((p) => p.to).sort().at(-1) } : null;
  // Fase en curso según fechas: la que cubre hoy y empezó más tarde
  const actual = dated
    .filter((p) => !p.hito && p.from <= today && p.to >= today)
    .sort((a, b) => a.from.localeCompare(b.from))
    .at(-1);
  const label = actual ? phaseName(actual.name) ?? phaseName(actual.grupo) ?? actual.name.replace(/^\d+\s*[·.-]\s*/, '') : null;
  return { phases, periodo, faseActual: label };
}

function buildPlanificacion(boards) {
  const lines = [];
  for (const board of boards) {
    const c = {
      area: findCol(board, [/^area$/], ['status']),
      fase: findCol(board, [/^fase$/], ['status']),
      aprobacion: findCol(board, [/estado aprobacion/, /^aprobacion$/], ['status']),
      solicitado: usd(board, [/solicitado/, /presupuesto/], ['numbers']),
      revisado: usd(board, [/revisado gerencia/], ['numbers']),
      aprobado: usd(board, [/aprobado direccion/], ['numbers']),
      estatus: findCol(board, [/^estatus$/], ['status']),
    };
    const nameArea = board.name.replace(/^p\d+\.\s*/i, '').replace(/\s*-\s*\w+$/, '').replace(/^planificaci[oó]n\s+/i, '');
    for (const i of leavesOf(board)) {
      lines.push({
        area: statusOf(i, c.area) ?? nameArea,
        fase: phaseName(statusOf(i, c.fase)) ?? statusOf(i, c.fase) ?? 'Sin fase',
        aprobacion: statusOf(i, c.aprobacion) ?? 'Sin estado',
        estatus: c.estatus ? statusOf(i, c.estatus) : null,
        solicitado: numOf(i, c.solicitado) ?? 0,
        revisado: numOf(i, c.revisado) ?? 0,
        aprobado: numOf(i, c.aprobado) ?? 0,
      });
    }
  }
  const areas = new Map();
  for (const l of lines) {
    const a = areas.get(l.area) ?? { area: l.area, lines: 0, solicitado: 0, revisado: 0, aprobado: 0, conMonto: 0 };
    a.lines++;
    a.solicitado += l.solicitado;
    a.revisado += l.revisado;
    a.aprobado += l.aprobado;
    if (l.solicitado) a.conMonto++;
    areas.set(l.area, a);
  }
  return {
    lines: lines.length,
    solicitado: round(sum(lines, (l) => l.solicitado)),
    revisado: round(sum(lines, (l) => l.revisado)),
    aprobado: round(sum(lines, (l) => l.aprobado)),
    porArea: [...areas.values()].map((a) => ({ ...a, solicitado: round(a.solicitado), revisado: round(a.revisado), aprobado: round(a.aprobado) })),
    porAprobacion: tally(lines, (l) => l.aprobacion),
    porFase: tally(lines, (l) => l.fase),
    porEstatus: lines.some((l) => l.estatus) ? tally(lines, (l) => l.estatus) : [],
  };
}

function buildCentros(board) {
  const L = leavesOf(board);
  const c = {
    estado: findCol(board, [/estado aprobacion/, /^estado$/], ['status']),
    revisado: usd(board, [/^revisado$/, /revisado/], ['formula', 'numbers', 'mirror']),
    aprobado: usd(board, [/^aprobado$/, /aprobado/], ['formula', 'numbers', 'mirror']),
  };
  return {
    count: L.length,
    revisado: round(sum(L, (i) => numOf(i, c.revisado))),
    aprobado: round(sum(L, (i) => numOf(i, c.aprobado))),
    porEstado: tally(L, (i) => statusOf(i, c.estado)),
  };
}

function buildTrabajos(board) {
  const L = leavesOf(board);
  const c = {
    estado: findCol(board, [/^status actividad$/, /^estatus$/], ['status']),
    aprobacion: findCol(board, [/^status$/], ['status']),
    preliminar: usd(board, [/preliminar/], ['numbers']),
    proyectado: usd(board, [/proyectado/], ['numbers']),
  };
  return {
    name: board.name,
    url: board.url ?? null,
    lines: L.length,
    preliminar: c.preliminar ? round(sum(L, (i) => numOf(i, c.preliminar))) : null,
    proyectado: c.proyectado ? round(sum(L, (i) => numOf(i, c.proyectado))) : null,
    porEstado: c.estado ? tally(L, (i) => statusOf(i, c.estado)) : [],
    porAprobacion: c.aprobacion ? tally(L, (i) => statusOf(i, c.aprobacion)) : [],
  };
}

function buildPrograma(board) {
  const c = {
    estado: findCol(board, [/^estado$/], ['status']),
    mandatorio: findCol(board, [/mandatorio/], ['date']),
    realFecha: findCol(board, [/fecha real/], ['date']),
    realTexto: findCol(board, [/fecha real/], ['text']),
    lugar: findCol(board, [/lugar/], ['status', 'dropdown', 'text']),
    tipo: findCol(board, [/tipo/], ['status', 'dropdown']),
    anterior: usd(board, [/anterior/], ['numbers']),
    estimado: usd(board, [/estimado/], ['numbers']),
    obs: findCol(board, [/observ/], ['long_text', 'text']),
  };
  return leavesOf(board)
    .map((i) => ({
      buque: i.name.trim(),
      anio: groupTitle(board, i),
      estado: statusOf(i, c.estado),
      mandatorio: dateOf(i, c.mandatorio),
      fechaReal: dateOf(i, c.realFecha),
      fechaTexto: textOf(i, c.realTexto),
      lugar: c.lugar?.type === 'status' ? statusOf(i, c.lugar) : textOf(i, c.lugar),
      tipo: c.tipo?.type === 'status' ? statusOf(i, c.tipo) : textOf(i, c.tipo),
      anterior: numOf(i, c.anterior),
      estimado: numOf(i, c.estimado),
      obs: textOf(i, c.obs),
    }))
    .sort((a, b) => (a.mandatorio ?? '9').localeCompare(b.mandatorio ?? '9'));
}

// ---------- buques ----------
const firstWord = (name) => norm(name).split(' ')[0];
function vesselOf(board, vesselNames) {
  const hay = ` ${norm([board.folder, board.parentFolder, board.name].filter(Boolean).join(' '))} `;
  const hit = vesselNames.find((v) => new RegExp(`\\b${firstWord(v)}\\b`).test(hay));
  if (hit) return hit;
  const f = board.folder && /trader/i.test(board.folder) ? board.folder : null;
  return f ? f.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) : null;
}

export function buildDiques(rawBoards, config = {}, now = new Date()) {
  const tz = config.timezone ?? 'America/Panama';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const testRe = config.diques?.testFolders ? new RegExp(config.diques.testFolders, 'i') : null;

  const boards = rawBoards.map((b) => ({
    ...b,
    role: roleOf(b.name),
    test: !!testRe && testRe.test(norm([b.folder, b.parentFolder].filter(Boolean).join(' '))),
  }));
  const programBoard = boards.find((b) => b.role === 'programa');
  const programa = programBoard ? buildPrograma(programBoard) : [];
  const vesselNames = [...new Set(programa.map((p) => p.buque))];

  const byVessel = new Map();
  const sinBuque = [];
  for (const b of boards) {
    if (!b.role || b.role === 'programa') continue;
    const v = vesselOf(b, vesselNames);
    if (!v) {
      sinBuque.push(b.name);
      continue;
    }
    const e = byVessel.get(v) ?? { name: v, boards: [] };
    e.boards.push(b);
    byVessel.set(v, e);
  }

  const buques = [...byVessel.values()].map((v) => {
    // Por cada tipo de tablero se usan los operativos; los de migración o prueba solo si no hay otro
    const pick = (role) => {
      const all = v.boards.filter((b) => b.role === role);
      const real = all.filter((b) => !b.test);
      return real.length ? real : all;
    };
    const used = [];
    const one = (role) => {
      const b = pick(role)[0];
      if (b) used.push(b);
      return b ?? null;
    };
    const many = (role) => {
      const l = pick(role);
      used.push(...l);
      return l;
    };
    const gestionB = one('gestion');
    const comprasB = one('compras');
    const cambiosB = one('cambios');
    const cronoB = one('cronograma');
    const centrosB = one('centros');
    const planB = many('planificacion');
    const trabajosB = many('trabajos');

    const gestion = gestionB ? buildGestion(gestionB) : null;
    const compras = comprasB && leavesOf(comprasB).length ? buildCompras(comprasB) : null;
    const cambios = cambiosB && leavesOf(cambiosB).length ? buildCambios(cambiosB) : null;
    const cronograma = cronoB ? buildCronograma(cronoB, today) : null;
    const planificacion = planB.length ? buildPlanificacion(planB) : null;
    const centros = centrosB && leavesOf(centrosB).length ? buildCentros(centrosB) : null;
    const trabajos = trabajosB.map(buildTrabajos);

    const periodo = cronograma?.periodo ?? gestion?.periodo ?? null;
    const etapa = !periodo ? 'Sin fechas' : today < periodo.from ? 'Próximo' : today > periodo.to ? 'Realizado' : 'En curso';
    const lastActivity = v.boards
      .flatMap((b) => (b.items ?? []).map((i) => i.updated_at))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    const prog = programa.filter((p) => p.buque === v.name);

    return {
      name: v.name,
      etapa,
      faseActual: etapa === 'En curso' ? cronograma?.faseActual ?? null : null,
      periodo,
      lastActivity,
      programa: prog,
      boards: used.map((b) => ({ id: String(b.id), name: b.name, url: b.url ?? null, role: b.role, test: b.test })),
      gestion,
      compras,
      cambios,
      cronograma,
      planificacion,
      centros,
      trabajos,
    };
  });

  const order = { 'En curso': 0, Próximo: 1, Realizado: 2, 'Sin fechas': 3 };
  buques.sort((a, b) => order[a.etapa] - order[b.etapa] || (b.periodo?.from ?? '').localeCompare(a.periodo?.from ?? ''));

  // Próximo hito de entrada a dique entre los cronogramas, si no el mandatorio más cercano del programa
  const entradas = buques
    .flatMap((v) => (v.cronograma?.phases ?? []).filter((p) => p.from && p.from >= today && /entrada|varada/i.test(p.name)).map((p) => ({ buque: v.name, fecha: p.from, hito: p.name })))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  const nextProg = programa.find((p) => (p.fechaReal ?? p.mandatorio ?? '') >= today);
  const proximo = entradas[0] ?? (nextProg ? { buque: nextProg.buque, fecha: nextProg.fechaReal ?? nextProg.mandatorio, hito: nextProg.fechaReal ? 'Fecha programada' : 'Fecha mandatoria' } : null);

  const years = new Map();
  for (const p of programa) {
    const y = p.anio ?? p.mandatorio?.slice(0, 4) ?? '—';
    const e = years.get(y) ?? { anio: y, count: 0, estimado: 0 };
    e.count++;
    e.estimado += p.estimado ?? 0;
    years.set(y, e);
  }

  return {
    generatedAt: now.toISOString(),
    today,
    timezone: tz,
    programaUrl: programBoard?.url ?? null,
    proximo,
    totals: {
      buques: buques.length,
      incurrido: round(sum(buques, (v) => v.compras?.incurrido)),
      cambiosPorDecidir: sum(buques, (v) => v.cambios?.porDecidir.count),
      cambiosPorDecidirMonto: round(sum(buques, (v) => v.cambios?.porDecidir.costo)),
      programaCount: programa.length,
      programaEstimado: round(sum(programa, (p) => p.estimado)),
      pagosPendientes: sum(buques, (v) => v.compras?.pendientesCount),
      pagosPendientesMonto: round(sum(buques, (v) => v.compras?.pendientesMonto)),
    },
    programa,
    programaPorAnio: [...years.values()].sort((a, b) => a.anio.localeCompare(b.anio)),
    buques,
    sinBuque,
  };
}
