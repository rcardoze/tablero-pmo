// Lee todos los tableros de Monday y genera site/data.json para el dashboard.
// Uso: MONDAY_API_TOKEN=xxxx node scripts/fetch-monday.mjs
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, pickStatusColumn, pickDueColumn, pickPeopleColumn } from './transform.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.env.OUT_FILE ?? 'site/data.json');
const TOKEN = process.env.MONDAY_API_TOKEN;
const API_VERSION = process.env.MONDAY_API_VERSION || '';
const CONCURRENCY = 3;

if (!TOKEN) {
  console.error('Falta la variable MONDAY_API_TOKEN.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}) {
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
    id name type hierarchy_type items_count updated_at url
    workspace { id name }
    folder { id name parent { id name } }
    columns(types: [status, timeline, date, people]) { id title type settings }
  }
}`;

const ITEM_FIELDS = `cursor items {
  id name url updated_at
  parent_item { id }
  column_values(ids: $cols, capabilities: [CALCULATED]) { id value }
}`;

const FIRST_PAGE = `query ($id: [ID!], $cols: [String!]) {
  boards(ids: $id) { items_page(limit: 500, hierarchy_scope_config: "allItems") { ${ITEM_FIELDS} } }
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

async function fetchItems(board, cols) {
  const items = [];
  const first = await gql(FIRST_PAGE, { id: [board.id], cols });
  let page = first.boards[0]?.items_page;
  while (page) {
    items.push(...page.items);
    if (!page.cursor) break;
    page = (await gql(NEXT_PAGE, { cursor: page.cursor, cols })).next_items_page;
  }
  return items;
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

  const boards = (await fetchAllBoards()).filter((b) => !b.type || b.type === 'board');
  console.log(`Tableros encontrados: ${boards.length}`);
  const users = await fetchUsers();

  const itemsByBoard = {};
  const errors = [];
  await mapLimit(boards, CONCURRENCY, async (b) => {
    const status = pickStatusColumn(b.columns ?? [], config.statusColumnOverrides?.[b.id]);
    const due = pickDueColumn(b.columns ?? []);
    const people = pickPeopleColumn(b.columns ?? [], config.peopleColumnOverrides?.[b.id]);
    const cols = [status?.id, due?.id, people?.id].filter(Boolean);
    if (String(b.id) === String(config.portfolio?.boardId)) {
      const p = config.portfolio;
      cols.push(p.phaseColumn, p.healthColumn, p.typeColumn);
    }
    try {
      itemsByBoard[b.id] = await fetchItems(b, [...new Set(cols)]);
    } catch (e) {
      errors.push({ boardId: String(b.id), board: b.name, message: e.message });
      console.warn(`No se pudo leer "${b.name}": ${e.message}`);
    }
  });

  const data = buildDashboard({ boards, itemsByBoard, users, errors }, config, new Date());
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));

  const t = data.totals;
  const summary = [
    `### Dashboard PMO actualizado`,
    `- Tableros: ${t.boards} · elementos: ${t.items}`,
    `- Proyectos activos: ${t.projectsActive} · completados: ${t.projectsDone}`,
    `- Avance proyectos activos: ${t.avance == null ? '—' : Math.round(t.avance * 100) + '%'}`,
    `- Detenidas: ${t.stuck} · vencidas: ${t.overdue}`,
    `- Personas con entregables: ${data.people.length} · sin responsable: ${data.unassigned.open}`,
    `- Errores: ${errors.length}${errors.map((e) => `\n  - ${e.board}: ${e.message}`).join('')}`,
    `- Duración: ${Math.round((Date.now() - started) / 1000)} s`,
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
