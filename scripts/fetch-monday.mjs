// Lee todos los tableros de Monday y genera site/data.json para el dashboard.
// Uso: MONDAY_API_TOKEN=xxxx node scripts/fetch-monday.mjs
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, pickStatusColumn, pickDueColumn, pickPeopleColumn } from './transform.mjs';
import { buildDiques } from './diques.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.env.OUT_FILE ?? 'site/data.json');
const OUT_DIQUES = resolve(dirname(OUT), 'diques.json');
const TOKEN = process.env.MONDAY_API_TOKEN;
const API_VERSION = process.env.MONDAY_API_VERSION || '';
const CONCURRENCY = 2;
const BATCH_SIZE = 10; // tableros por consulta, para gastar pocas llamadas del límite diario de Monday
const BATCH_MAX_ITEMS = 400;

if (!TOKEN) {
  console.error('Falta la variable MONDAY_API_TOKEN.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let countCall = () => {};

async function gql(query, variables = {}) {
  countCall();
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: TOKEN,
        ...(API_VERSION ? { 'API-Version': API_VERSION } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    const errors = body.errors ?? (body.error_message ? [{ message: body.error_message }] : []);
    const retryIn = Number(errors[0]?.extensions?.retry_in_seconds ?? body.retry_in_seconds ?? 0);
    const msg = errors.map((e) => e.message).join('; ');

    if (res.status === 401 || res.status === 403) throw new Error(`Token de Monday inválido o sin permisos (${res.status}).`);
    if (res.status === 429 || res.status >= 500 || /complexity|rate limit|try again|too many/i.test(msg)) {
      lastError = new Error(msg || `HTTP ${res.status}`);
      await sleep(Math.max(retryIn * 1000, 2000 * 2 ** attempt));
      continue;
    }
    if (errors.length) throw new Error(msg);
    return body.data;
  }
  throw lastError;
}

const BOARDS_QUERY = `query ($page: Int!) {
  boards(limit: 50, page: $page, state: active) {
    id name type board_kind hierarchy_type items_count updated_at url
    workspace { id name }
    folder { id name parent { id name } }
    columns(types: [status, timeline, date, people]) { id title type settings }
  }
}`;

const ITEM_FIELDS = `cursor items {
  id name url created_at updated_at
  parent_item { id }
  column_values(ids: $cols, capabilities: [CALCULATED]) { id value }
}`;

const FIRST_PAGE = `query ($ids: [ID!], $cols: [String!]) {
  boards(ids: $ids) { id items_page(limit: 500, hierarchy_scope_config: "allItems") { ${ITEM_FIELDS} } }
}`;

const NEXT_PAGE = `query ($cursor: String!, $cols: [String!]) {
  next_items_page(limit: 500, cursor: $cursor) { ${ITEM_FIELDS} }
}`;

async function fetchAllBoards() {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await gql(BOARDS_QUERY, { page });
    all.push(...data.boards);
    if (data.boards.length < 50) break;
  }
  return all;
}

const USERS_QUERY = `query ($page: Int!) { users(limit: 100, page: $page) { id name } }`;

async function fetchUsers() {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await gql(USERS_QUERY, { page });
    all.push(...data.users);
    if (data.users.length < 100) break;
  }
  return all;
}

// Lee los elementos de varios tableros en una sola consulta; pagina aparte los que tengan más de 500.
async function fetchItemsBatch(batch) {
  const cols = [...new Set(batch.flatMap((x) => x.cols))];
  const first = await gql(FIRST_PAGE, { ids: batch.map((x) => x.board.id), cols });
  const out = {};
  for (const b of first.boards ?? []) {
    const items = [];
    let page = b.items_page;
    while (page) {
      items.push(...page.items);
      if (!page.cursor) break;
      page = (await gql(NEXT_PAGE, { cursor: page.cursor, cols })).next_items_page;
    }
    out[b.id] = items;
  }
  return out;
}

function makeBatches(jobs) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const job of jobs) {
    const n = job.board.items_count ?? 0;
    if (cur.length && (cur.length >= BATCH_SIZE || size + n > BATCH_MAX_ITEMS)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(job);
    size += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// Tableros de dique: se leen con todas sus columnas (montos, fechas, reflejos y fórmulas)
const FULL_ITEMS = `cursor items {
  id name url created_at updated_at group { id } parent_item { id }
  column_values(capabilities: [CALCULATED]) { id type text value
    ... on FormulaValue { display_value }
    ... on MirrorValue { display_value } }
}`;
const FULL_FIRST = `query ($ids: [ID!]) {
  boards(ids: $ids) { id url columns { id title type settings_str } groups { id title }
    items_page(limit: 500, hierarchy_scope_config: "allItems") { ${FULL_ITEMS} } }
}`;
const FULL_NEXT = `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { ${FULL_ITEMS} } }`;

async function fetchFullBoards(list) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const b of list) {
    if (cur.length && (cur.length >= 5 || size + (b.items_count ?? 0) > 300)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += b.items_count ?? 0;
  }
  if (cur.length) batches.push(cur);

  const out = [];
  for (const batch of batches) {
    const data = await gql(FULL_FIRST, { ids: batch.map((b) => b.id) });
    for (const full of data.boards ?? []) {
      const meta = batch.find((b) => String(b.id) === String(full.id));
      const items = [];
      let page = full.items_page;
      while (page) {
        items.push(...page.items);
        if (!page.cursor) break;
        page = (await gql(FULL_NEXT, { cursor: page.cursor })).next_items_page;
      }
      out.push({
        id: full.id,
        name: meta.name,
        url: full.url,
        workspace: meta.workspace?.name,
        folder: meta.folder?.name,
        parentFolder: meta.folder?.parent?.name,
        columns: full.columns,
        groups: full.groups,
        items,
      });
    }
  }
  return out;
}

async function mapLimit(list, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (i < list.length) {
        const idx = i++;
        out[idx] = await fn(list[idx]);
      }
    }),
  );
  return out;
}

async function main() {
  const config = JSON.parse(await readFile(resolve(ROOT, 'config.json'), 'utf8'));
  const started = Date.now();
  let calls = 0;
  countCall = () => calls++;

  // Los tableros privados nunca se leen ni se publican (config.exclude.privateBoards)
  const boards = (await fetchAllBoards()).filter(
    (b) => (!b.type || b.type === 'board') && !(config.exclude?.privateBoards && b.board_kind === 'private'),
  );
  console.log(`Tableros encontrados: ${boards.length}`);
  const users = await fetchUsers();

  const itemsByBoard = {};
  const errors = [];
  const jobs = boards.map((b) => {
    const status = pickStatusColumn(b.columns ?? [], config.statusColumnOverrides?.[b.id]);
    const due = pickDueColumn(b.columns ?? []);
    const people = pickPeopleColumn(b.columns ?? [], config.peopleColumnOverrides?.[b.id]);
    const cols = [status?.id, due?.id, people?.id].filter(Boolean);
    if (String(b.id) === String(config.portfolio?.boardId)) {
      const p = config.portfolio;
      cols.push(p.phaseColumn, p.healthColumn, p.typeColumn);
    }
    return { board: b, cols };
  });
  await mapLimit(makeBatches(jobs), CONCURRENCY, async (batch) => {
    try {
      Object.assign(itemsByBoard, await fetchItemsBatch(batch));
    } catch (e) {
      // Si falla el grupo, se reintenta tablero por tablero para aislar el problema
      for (const job of batch) {
        try {
          Object.assign(itemsByBoard, await fetchItemsBatch([job]));
        } catch (err) {
          errors.push({ boardId: String(job.board.id), board: job.board.name, message: err.message });
          console.warn(`No se pudo leer "${job.board.name}": ${err.message}`);
        }
      }
    }
  });

  const now = new Date();
  const data = buildDashboard({ boards, itemsByBoard, users, errors }, config, now);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));

  // Dashboard de diques: si falla, el tablero PMO se publica igual y la página de diques avisa
  let diquesLine = '- Diques: no configurado';
  if (config.diques?.workspaces) {
    const re = new RegExp(config.diques.workspaces, 'i');
    const list = boards.filter((b) => re.test(b.workspace?.name ?? ''));
    try {
      const diques = buildDiques(await fetchFullBoards(list), config, now);
      await writeFile(OUT_DIQUES, JSON.stringify(diques));
      diquesLine = `- Diques: ${diques.buques.length} buques · ${list.length} tableros${diques.sinBuque.length ? ` · sin buque: ${diques.sinBuque.join(', ')}` : ''}`;
    } catch (e) {
      console.warn(`No se pudieron leer los tableros de dique: ${e.message}`);
      await writeFile(OUT_DIQUES, JSON.stringify({ generatedAt: now.toISOString(), error: e.message }));
      diquesLine = `- Diques: error (${e.message})`;
    }
  }

  const t = data.totals;
  const summary = [
    `### Dashboard PMO actualizado`,
    `- Tableros: ${t.boards} · elementos: ${t.items}`,
    `- Proyectos activos: ${t.projectsActive} · completados: ${t.projectsDone}`,
    `- Avance proyectos activos: ${t.avance == null ? '—' : Math.round(t.avance * 100) + '%'}`,
    `- Detenidas: ${t.stuck} · vencidas: ${t.overdue}`,
    `- Personas con entregables: ${data.people.length} · sin responsable: ${data.unassigned.open}`,
    diquesLine,
    `- Errores: ${errors.length}${errors.map((e) => `\n  - ${e.board}: ${e.message}`).join('')}`,
    `- Consultas a Monday: ${calls} · duración: ${Math.round((Date.now() - started) / 1000)} s`,
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

  // Si no se pudo leer nada, fallar para no publicar un dashboard vacío
  if (boards.length && errors.length === boards.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
