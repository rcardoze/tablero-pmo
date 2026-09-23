// Convierte los datos crudos de Monday en el resumen que consume el dashboard (site/data.json).
// Funciones puras: no hacen llamadas de red, así se pueden probar con datos de ejemplo.

export const BUCKETS = [
  { key: 'done', label: 'Completado', color: '#00c875' },
  { key: 'progress', label: 'En curso', color: '#fdab3d' },
  { key: 'stuck', label: 'Detenido', color: '#df2f4a' },
  { key: 'notstarted', label: 'Sin iniciar', color: '#c4c4c4' },
  { key: 'cancelled', label: 'Cancelado', color: '#757575' },
];
const BUCKET_ORDER = Object.fromEntries(BUCKETS.map((b, i) => [b.key, i]));
const EMPTY_COLOR = '#c4c4c4';

export function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const nameKey = (s) => norm(s).replace(/[^a-z0-9]+/g, '');
const CODE_RE = /\b(PMO|HSE|MAN|OPR|MNT|ING|OPS)-\d{2,3}-\d{2,3}\b/i;
export const codeOf = (s) => (String(s).match(CODE_RE)?.[0] ?? '').toUpperCase() || null;

function parseJSON(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ---------- Clasificación de etiquetas de estado ----------

const RULES = [
  ['cancelled', /(cancel|rechaz|anulad|descart|archiv|\bn\/a\b|no aplica|declin|inactiv)/],
  ['stuck', /(detenid|stuck|bloque|blocked|\bhold\b|espera|pausa|materializ|atrasad|problema)/],
  ['done', /(\blisto\b|\bdone\b|hecho|complet|finaliz|cerrad|closed|termin|entregad|mitigad|aprobad|culminad|resuelt|finished)/],
  ['notstarted', /(no inici|por inici|sin inici|pendient|future|siguient|proxim|\bnext\b|\blater\b|\bidea\b|solicitad|backlog|to do|nuevo|no contactad)/],
  ['progress', /(\d+\s*%|curso|ejecuci|working|proceso|progres|\bnow\b|revisi|evaluaci|planific|activ|trabajando)/],
];

function hexBucket(hex) {
  const h = String(hex || '').toLowerCase();
  if (['#00c875', '#037f4c', '#9cd326', '#0ca30c'].includes(h)) return 'done';
  if (['#df2f4a', '#e2445c', '#bb3354', '#ff7575', '#d03b3b'].includes(h)) return 'stuck';
  if (['#fdab3d', '#ffcb00', '#cab641', '#ff642e'].includes(h)) return 'progress';
  if (['#c4c4c4', '#808080', ''].includes(h)) return 'notstarted';
  return null;
}

export function classifyLabel(text, hex, isDone) {
  const t = norm(text);
  if (!t || t === '-') return 'notstarted';
  for (const [bucket, re] of RULES) if (re.test(t)) return bucket;
  if (isDone) return 'done';
  return hexBucket(hex) ?? 'progress';
}

const percentWeight = (text) => {
  const m = String(text ?? '').trim().match(/^(\d{1,3})\s*%$/);
  return m ? Math.min(Number(m[1]), 100) / 100 : null;
};

// ---------- Selección de columnas ----------

const STATUS_PENALTY = /(rag|health|salud|priori|tipo|type|probabil|efecto|respuesta|impact|categor|severi|nivel|is active|cambios)/i;

export function pickStatusColumn(columns, overrideId) {
  const status = columns.filter((c) => c.type === 'status');
  if (overrideId) return status.find((c) => c.id === overrideId) ?? null;
  if (!status.length) return null;
  const score = (c) => {
    let s = 0;
    if (c.id === 'project_status') s += 100;
    else if (c.id === 'status') s += 90;
    const t = norm(c.title);
    if (/^(estado|status|estatus)$/.test(t)) s += 80;
    else if (/^(estado|status|estatus|avance|fase|etapa|stage)/.test(t)) s += 60;
    if (STATUS_PENALTY.test(c.title)) s -= 50;
    if (labelsOf(c).some((l) => l.is_done)) s += 5;
    return s;
  };
  return status.reduce((best, c) => (score(c) > score(best) ? c : best), status[0]);
}

export function pickDueColumn(columns) {
  const timelines = columns.filter(
    (c) => c.type === 'timeline' && !/(real|actual|baseline|ejecutad|referencia|l[ií]nea base)/i.test(c.title),
  );
  const preferred = timelines.find(
    (c) => ['project_timeline', 'timeline', 'cronograma'].includes(c.id) || /(cronograma|timeline|plan)/i.test(c.title),
  );
  if (preferred ?? timelines[0]) return preferred ?? timelines[0];
  return (
    columns.find(
      (c) =>
        c.type === 'date' &&
        /(l[ií]mite|deadline|\bdue\b|venc|entrega|finaliz|cierre|\bfin\b)/i.test(c.title) &&
        !/(completion|registro|aprob|informe|creaci|real)/i.test(c.title),
    ) ?? null
  );
}

function labelsOf(col) {
  const settings = parseJSON(col?.settings) ?? {};
  if (Array.isArray(settings.labels)) return settings.labels;
  // formato antiguo: { labels: { "0": "Listo" }, labels_colors: { "0": { color: "#..." } } }
  if (settings.labels && typeof settings.labels === 'object') {
    return Object.entries(settings.labels).map(([id, label]) => ({
      id: Number(id),
      label,
      hex: settings.labels_colors?.[id]?.color,
      is_done: settings.done_colors?.includes(Number(id)) ?? false,
    }));
  }
  return [];
}

function buildLabelMap(col) {
  const map = new Map();
  for (const l of labelsOf(col)) {
    map.set(Number(l.id), {
      label: l.label ?? '',
      color: l.hex ?? EMPTY_COLOR,
      isDone: !!l.is_done,
      deactivated: !!l.is_deactivated,
    });
  }
  return map;
}

// Resuelve el estado de un elemento igual que lo muestra Monday: sin valor => etiqueta por defecto (id 5).
function resolveStatus(item, col, labelMap) {
  const cv = item.column_values?.find((c) => c.id === col.id);
  const v = parseJSON(cv?.value);
  const idx = v?.index ?? v?.id ?? null;
  let lab = idx != null ? labelMap.get(Number(idx)) : null;
  if (!lab && idx == null) lab = labelMap.get(5) ?? null;
  let text = lab?.label?.trim() || '';
  // Etiqueta de relleno que repite el nombre de la columna ("Estado del proyecto" en "Estado del proyecto (RAG)")
  const nt = norm(text);
  const ct = norm(col.title);
  if (nt && (ct === nt || ct.startsWith(nt + ' '))) text = '';
  const label = text || 'Sin estado';
  const color = text ? lab.color : EMPTY_COLOR;
  const bucket = text ? classifyLabel(text, lab.color, lab.isDone) : 'notstarted';
  return { label, color, bucket, weight: percentWeight(text) };
}

function dueOf(item, col) {
  if (!col) return null;
  const v = parseJSON(item.column_values?.find((c) => c.id === col.id)?.value);
  if (!v) return null;
  const d = col.type === 'timeline' ? v.to : v.date;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

// ---------- Secciones ----------

function sectionFor(board, sections) {
  const folderNames = [board.folder?.name, board.folder?.parent?.name].filter(Boolean).join(' / ');
  for (const s of sections) {
    const m = s.match ?? {};
    const keys = Object.keys(m);
    if (!keys.length) return s;
    const hit =
      (m.folder && folderNames && new RegExp(m.folder, 'i').test(norm(folderNames))) ||
      (m.name && new RegExp(m.name, 'i').test(norm(board.name))) ||
      (m.workspace && new RegExp(m.workspace, 'i').test(board.workspace?.name ?? ''));
    if (hit) return s;
  }
  return sections[sections.length - 1];
}

function healthSeverity(label) {
  const t = norm(label);
  if (/(atrasad|off track|critic|rojo)/.test(t)) return 3;
  if (/(riesgo|risk|amber|ambar)/.test(t)) return 2;
  if (/(al dia|on track|verde)/.test(t)) return 1;
  return 0;
}

const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
const addBuckets = (a, b) => {
  for (const k of Object.keys(a)) a[k] += b[k] ?? 0;
  return a;
};

function tipoFromName(name) {
  if (name.includes('🚀')) return 'Mejora';
  if (name.includes('🛠')) return 'Proyecto';
  return null;
}

// ---------- Construcción del dashboard ----------

export function buildDashboard(raw, config, now = new Date()) {
  const tz = config.timezone ?? 'America/Panama';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const weekAgo = now.getTime() - 7 * 864e5;
  const staleMs = (config.staleDays ?? 21) * 864e5;
  const sectionsCfg = config.sections;
  const excludeIds = new Set((config.exclude?.boardIds ?? []).map(String));
  const excludeRe = config.exclude?.namePattern ? new RegExp(config.exclude.namePattern, 'i') : null;

  const attention = { stuck: [], overdue: [], stale: [] };
  const boards = [];
  let totalItems = 0;

  for (const b of raw.boards) {
    if (b.type && b.type !== 'board') continue;
    if (excludeIds.has(String(b.id)) || (excludeRe && excludeRe.test(b.name))) continue;

    const section = sectionFor(b, sectionsCfg);
    const items = raw.itemsByBoard[b.id] ?? [];
    const statusCol = pickStatusColumn(b.columns ?? [], config.statusColumnOverrides?.[b.id]);
    const dueCol = pickDueColumn(b.columns ?? []);
    const labelMap = statusCol ? buildLabelMap(statusCol) : new Map();

    const parentIds = new Set(items.map((i) => i.parent_item?.id).filter(Boolean));
    const leaves = items.filter((i) => !parentIds.has(i.id));
    totalItems += leaves.length;

    const buckets = emptyBuckets();
    const labelCounts = new Map();
    let weighted = 0;
    let overdue = 0;
    let updated7d = 0;
    let lastActivity = null;

    for (const it of leaves) {
      const ts = it.updated_at ? Date.parse(it.updated_at) : NaN;
      if (!Number.isNaN(ts)) {
        if (ts >= weekAgo) updated7d++;
        if (!lastActivity || ts > Date.parse(lastActivity)) lastActivity = it.updated_at;
      }
      if (!statusCol) continue;

      const st = resolveStatus(it, statusCol, labelMap);
      buckets[st.bucket]++;
      if (st.bucket === 'done') weighted += 1;
      else if (st.weight != null && st.bucket === 'progress') weighted += st.weight;

      const key = `${st.label}|${st.color}`;
      const lc = labelCounts.get(key) ?? { label: st.label, color: st.color, bucket: st.bucket, count: 0 };
      lc.count++;
      labelCounts.set(key, lc);

      if (section.mode !== 'progress') continue;
      const due = dueOf(it, dueCol);
      const open = st.bucket !== 'done' && st.bucket !== 'cancelled';
      if (open && due && due < today) {
        overdue++;
        attention.overdue.push({ name: it.name, url: it.url, board: b.name, boardId: String(b.id), due, status: st.label });
      }
      if (st.bucket === 'stuck') {
        attention.stuck.push({ name: it.name, url: it.url, board: b.name, boardId: String(b.id), status: st.label });
      }
    }

    const countable = leaves.length - buckets.cancelled;
    const avance = statusCol && countable > 0 ? weighted / countable : null;
    const labels = [...labelCounts.values()].sort(
      (x, y) => BUCKET_ORDER[x.bucket] - BUCKET_ORDER[y.bucket] || y.count - x.count,
    );

    boards.push({
      id: String(b.id),
      name: b.name,
      url: b.url,
      workspace: b.workspace?.name ?? 'Principal',
      folder: b.folder?.name ?? null,
      section: section.key,
      hierarchy: b.hierarchy_type,
      statusColumn: statusCol?.title ?? null,
      dueColumn: dueCol?.title ?? null,
      total: leaves.length,
      countable,
      avance,
      buckets,
      labels,
      overdue,
      updated7d,
      lastActivity,
      code: codeOf(b.name),
      tipo: tipoFromName(b.name),
      state: !statusCol ? 'nostatus' : countable <= 0 ? 'empty' : avance >= 0.999 ? 'done' : 'active',
    });
  }

  // ---------- Portafolio ----------
  let portfolio = null;
  const pCfg = config.portfolio;
  const pRaw = pCfg && raw.boards.find((b) => String(b.id) === String(pCfg.boardId));
  if (pRaw) {
    const cols = pRaw.columns ?? [];
    const col = (id) => cols.find((c) => c.id === id);
    const phaseCol = col(pCfg.phaseColumn);
    const healthCol = col(pCfg.healthColumn);
    const typeCol = col(pCfg.typeColumn);
    const maps = new Map([phaseCol, healthCol, typeCol].filter(Boolean).map((c) => [c.id, buildLabelMap(c)]));
    const get = (it, c) => (c ? resolveStatus(it, c, maps.get(c.id)) : null);

    const boardByKey = new Map();
    const boardByCode = new Map();
    const rank = (x) => (x.section === 'proyectos' ? 1e6 : 0) + x.total;
    for (const bd of boards) {
      if (String(bd.id) === String(pRaw.id)) continue;
      const k = nameKey(bd.name);
      if (!boardByKey.has(k) || rank(bd) > rank(boardByKey.get(k))) boardByKey.set(k, bd);
      if (bd.code && (!boardByCode.has(bd.code) || rank(bd) > rank(boardByCode.get(bd.code)))) boardByCode.set(bd.code, bd);
    }

    const pItems = (raw.itemsByBoard[pRaw.id] ?? []).filter((i) => !i.parent_item);
    const items = pItems.map((it) => {
      const phase = get(it, phaseCol);
      const health = get(it, healthCol);
      const tipo = get(it, typeCol);
      const code = codeOf(it.name);
      const board = boardByKey.get(nameKey(it.name)) ?? (code ? boardByCode.get(code) : null) ?? null;
      const healthOut = health && { label: health.label, color: health.color, severity: healthSeverity(health.label) };
      const tipoOut = tipo && tipo.label !== 'Sin estado' ? tipo.label : tipoFromName(it.name);
      if (board) {
        board.health = healthOut;
        board.phase = phase && { label: phase.label, color: phase.color, bucket: phase.bucket };
        board.tipo = tipoOut ?? board.tipo;
        board.inPortfolio = true;
        if (phase?.bucket === 'done' && board.state === 'active') board.state = 'done';
      }
      return {
        id: it.id,
        name: it.name,
        url: it.url,
        code,
        tipo: tipoOut,
        phase: phase && { label: phase.label, color: phase.color, bucket: phase.bucket },
        health: healthOut,
        boardId: board?.id ?? null,
        avance: board?.avance ?? null,
        total: board?.total ?? null,
        buckets: board?.buckets ?? null,
      };
    });

    const dist = (key) => {
      const m = new Map();
      for (const it of items) {
        const v = it[key];
        if (!v) continue;
        const k = `${v.label}|${v.color}`;
        const e = m.get(k) ?? { label: v.label, color: v.color, count: 0, bucket: v.bucket, severity: v.severity };
        e.count++;
        m.set(k, e);
      }
      return [...m.values()];
    };
    const phaseOrder = (x) => (x.bucket ? BUCKET_ORDER[x.bucket] : 9);
    portfolio = {
      boardId: String(pRaw.id),
      name: pRaw.name,
      url: pRaw.url,
      total: items.length,
      phase: dist('phase').sort((a, b) => phaseOrder(a) - phaseOrder(b) || b.count - a.count),
      health: dist('health').sort((a, b) => (a.severity || 9) - (b.severity || 9) || b.count - a.count),
      items,
    };
  }

  // Proyectos sin movimiento reciente
  for (const bd of boards) {
    const sec = sectionsCfg.find((s) => s.key === bd.section);
    if (sec?.mode !== 'progress' || bd.state !== 'active' || !bd.lastActivity) continue;
    if (now.getTime() - Date.parse(bd.lastActivity) > staleMs) {
      attention.stale.push({ board: bd.name, boardId: bd.id, url: bd.url, lastActivity: bd.lastActivity });
    }
  }

  // ---------- Secciones y totales ----------
  const sections = sectionsCfg
    .map((s) => {
      const list = boards.filter((b) => b.section === s.key);
      const active = list.filter((b) => b.state === 'active');
      return {
        key: s.key,
        title: s.title,
        mode: s.mode,
        kpi: !!s.kpi,
        collapsed: !!s.collapsed,
        boards: list.map((b) => b.id),
        activeCount: active.length,
        buckets: active.reduce((acc, b) => addBuckets(acc, b.buckets), emptyBuckets()),
      };
    })
    .filter((s) => s.boards.length);
  const order = config.displayOrder ?? [];
  const pos = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  sections.sort((a, b) => pos(a.key) - pos(b.key));

  const kpiBoards = boards.filter((b) => sectionsCfg.find((s) => s.key === b.section)?.kpi);
  const activeKpi = kpiBoards.filter((b) => b.state === 'active');
  const taskBuckets = activeKpi.reduce((acc, b) => addBuckets(acc, b.buckets), emptyBuckets());
  const countable = activeKpi.reduce((n, b) => n + b.countable, 0);
  const weighted = activeKpi.reduce((n, b) => n + (b.avance ?? 0) * b.countable, 0);

  // Las tareas abiertas de proyectos ya cerrados no requieren atención
  const activeIds = new Set(boards.filter((b) => b.state === 'active').map((b) => b.id));
  attention.stuck = attention.stuck.filter((a) => activeIds.has(a.boardId));
  attention.overdue = attention.overdue.filter((a) => activeIds.has(a.boardId));
  attention.overdue.sort((a, b) => a.due.localeCompare(b.due));
  attention.stale.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));

  return {
    generatedAt: now.toISOString(),
    today,
    timezone: tz,
    buckets: BUCKETS,
    totals: {
      boards: boards.length,
      items: totalItems,
      projects: kpiBoards.filter((b) => b.state === 'active' || b.state === 'done').length,
      projectsActive: activeKpi.length,
      projectsDone: kpiBoards.filter((b) => b.state === 'done').length,
      avance: countable ? weighted / countable : null,
      tasks: taskBuckets,
      overdue: attention.overdue.length,
      stuck: attention.stuck.length,
      stale: attention.stale.length,
      updated7d: boards.reduce((n, b) => n + b.updated7d, 0),
    },
    portfolio,
    sections,
    boards,
    attention,
    errors: raw.errors ?? [],
  };
}
