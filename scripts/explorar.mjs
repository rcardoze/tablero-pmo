// Temporal: guarda la estructura completa (columnas, grupos y valores) de los tableros de ciertos
// espacios de trabajo en explore/, para diseñar vistas nuevas. No imprime datos en el registro.
// Uso: MONDAY_API_TOKEN=xxxx WORKSPACES="dique" node scripts/explorar.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const TOKEN = process.env.MONDAY_API_TOKEN;
const WS = new RegExp(process.env.WORKSPACES || 'dique', 'i');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    const msg = (body.errors ?? []).map((e) => e.message).join('; ') || body.error_message || '';
    if (res.status === 429 || res.status >= 500 || /complexity|rate limit|try again/i.test(msg)) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (msg) throw new Error(msg);
    return body.data;
  }
  throw new Error('Monday no respondió');
}

const CV = `column_values { id type text value
  ... on FormulaValue { display_value }
  ... on MirrorValue { display_value }
  ... on BoardRelationValue { display_value linked_item_ids } }`;
const ITEMS = `cursor items { id name created_at updated_at group { id } parent_item { id } subitems { id } ${CV} }`;

const boards = [];
for (let page = 1; ; page++) {
  const d = await gql(`query ($p: Int!) { boards(limit: 50, page: $p, state: active) { id name type board_kind workspace { name } folder { name parent { name } } } }`, { p: page });
  boards.push(...d.boards);
  if (d.boards.length < 50) break;
}
const target = boards.filter((b) => b.type === 'board' && b.board_kind !== 'private' && WS.test(b.workspace?.name ?? ''));

const out = [];
for (const b of target) {
  const d = await gql(
    `query ($id: [ID!]) { boards(ids: $id) { id name description hierarchy_type
      columns { id title type settings_str description }
      groups { id title position }
      items_page(limit: 500, hierarchy_scope_config: "allItems") { ${ITEMS} } } }`,
    { id: [b.id] },
  );
  const full = d.boards[0];
  let page = full.items_page;
  const items = [...page.items];
  let truncated = false;
  try {
    while (page.cursor) {
      page = (await gql(`query ($c: String!) { next_items_page(limit: 500, cursor: $c) { ${ITEMS} } }`, { c: page.cursor })).next_items_page;
      items.push(...page.items);
    }
  } catch (e) {
    truncated = e.message;
    console.log(`Tablero ${b.id}: paginación cortada (${items.length} elementos)`);
  }
  delete full.items_page;
  out.push({ ...full, workspace: b.workspace?.name, folder: b.folder?.name, parentFolder: b.folder?.parent?.name, truncated, items });
}

await mkdir('explore', { recursive: true });
await writeFile('explore/tableros.json', JSON.stringify(out));
console.log(`Tableros guardados: ${out.length} · elementos: ${out.reduce((n, b) => n + b.items.length, 0)}`);
