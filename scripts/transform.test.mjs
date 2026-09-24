// Pruebas de la lógica de cálculo. Ejecutar: node --test scripts/transform.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDashboard, classifyLabel, pickStatusColumn, pickDueColumn } from './transform.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const s = (index) => JSON.stringify({ index });
const tl = (to) => JSON.stringify({ from: '2026-01-01', to });

test('clasifica las etiquetas de Monday en grupos de avance', () => {
  const cases = [
    ['Listo', 'done'], ['Done', 'done'], ['✅ Done', 'done'], ['Finalizado', 'done'], ['Cerrado', 'done'], ['Mitigado', 'done'],
    ['En Ejecución', 'progress'], ['Working on it', 'progress'], ['En curso', 'progress'], ['🔥 Now', 'progress'], ['50%', 'progress'],
    ['Detenido', 'stuck'], ['Stuck', 'stuck'], ['Bloqueado', 'stuck'], ['On Hold', 'stuck'], ['En espera', 'stuck'],
    ['No iniciado', 'notstarted'], ['Por Iniciar', 'notstarted'], ['Future steps', 'notstarted'], ['⏭️ Next', 'notstarted'], ['Siguientes pasos', 'notstarted'],
    ['Cancelado', 'cancelled'], ['Rechazado/Cancelado', 'cancelled'], ['Archivado', 'cancelled'],
  ];
  for (const [label, want] of cases) assert.equal(classifyLabel(label, '#ffffff', false), want, label);
});

test('elige la columna de estado y de fechas correcta', () => {
  const portfolioCols = [
    { id: 'portfolio_project_rag', title: 'Estado del proyecto (RAG)', type: 'status', settings: { labels: [{ id: 1, label: 'Al día' }] } },
    { id: 'portfolio_project_step', title: 'Fase', type: 'status', settings: { labels: [{ id: 1, label: 'Completado', is_done: true }] } },
    { id: 'color_mm1tt3c2', title: 'TIPO', type: 'status', settings: { labels: [] } },
  ];
  assert.equal(pickStatusColumn(portfolioCols).id, 'portfolio_project_step');
  assert.equal(
    pickStatusColumn([{ id: 'color_mm6kx61n', title: 'Priority', type: 'status' }, { id: 'color_mkv6tatz', title: 'Status', type: 'status' }]).id,
    'color_mkv6tatz',
  );
  assert.equal(
    pickDueColumn([
      { id: 'timeline9', title: 'Cronograma', type: 'timeline' },
      { id: 'timerange_x', title: "Referencia de Cronograma (02 Oct '25)", type: 'timeline' },
    ]).id,
    'timeline9',
  );
  assert.equal(pickDueColumn([{ id: 'r', title: 'Fecha Real', type: 'timeline' }, { id: 'd', title: 'Completion Date', type: 'date' }]), null);
});

test('arma el resumen: hojas en multinivel, portafolio, secciones y totales', () => {
  const remodCols = [
    { id: 'project_status', title: 'Estatus', type: 'status', settings: { labels: [
      { id: 0, label: 'En Ejecución', hex: '#fdab3d' }, { id: 1, label: 'Listo', hex: '#00c875', is_done: true },
      { id: 2, label: 'Cancelado', hex: '#df2f4a' }, { id: 10, label: 'Bloqueado', hex: '#333333' } ] } },
    { id: 'project_timeline', title: 'Cronograma', type: 'timeline' },
  ];
  const item = (id, parent, status, due) => ({
    id, name: `Tarea ${id}`, url: `https://x/pulses/${id}`, updated_at: '2026-09-22T10:00:00Z',
    parent_item: parent ? { id: parent } : null,
    column_values: [{ id: 'project_status', value: status == null ? null : s(status) }, { id: 'project_timeline', value: due ? tl(due) : null }],
  });
  const salaCols = [{ id: 'status', title: 'Estado', type: 'status', settings: { labels: [
    { id: 1, label: 'Listo', hex: '#00c875', is_done: true }, { id: 3, label: 'En ejecución', hex: '#ffcb00' }, { id: 5, label: 'No iniciado', hex: '#c4c4c4' } ] } }];
  const salaItems = [1, 1, 1, null].map((st, i) => ({
    id: `s${i}`, name: `S${i}`, url: 'u', updated_at: '2026-02-01T00:00:00Z', parent_item: null,
    column_values: [{ id: 'status', value: st == null ? null : s(st) }],
  }));
  const ws = { id: '9001198', name: 'PMO: Project Management Office' };
  const pid = config.portfolio.boardId;

  const raw = {
    boards: [
      { id: '100', name: '🚀Remodelación Oficinas TT (1-2)', type: 'board', hierarchy_type: 'multi_level', url: 'b100', workspace: ws, folder: { name: '🚀Mejoras' }, columns: remodCols },
      { id: '200', name: '🚀 Sala de capacitación TT PMO-26-01', type: 'board', hierarchy_type: 'classic', url: 'b200', workspace: ws, folder: { name: '2026 mejoras', parent: { name: 'Mejoras' } }, columns: salaCols },
      { id: '300', name: 'Plantilla Mejora Multinivel', type: 'board', url: 'b300', workspace: ws, folder: { name: '🚀Mejoras' }, columns: [] },
      { id: '400', name: 'Leads', type: 'board', url: 'b400', workspace: { id: '1', name: 'CRM' }, folder: null, columns: [] },
      { id: '500', name: 'Gestión de portafolio 2025', type: 'board', url: 'b500', workspace: ws, folder: { name: 'Portafolio', parent: { name: 'Finalizados' } }, columns: [] },
      { id: '999', name: 'Subelementos de algo', type: 'sub_items_board', url: 'x', workspace: ws, columns: [] },
      { id: pid, name: 'Portafolio 2026', type: 'board', url: 'bp', workspace: ws, folder: { name: '📊Portafolio' }, columns: [
        { id: 'portfolio_project_rag', title: 'Estado del proyecto (RAG)', type: 'status', settings: { labels: [
          { id: 0, label: 'En riesgo', hex: '#fdab3d' }, { id: 1, label: 'Al día', hex: '#00c875' }, { id: 2, label: 'Atrasado', hex: '#df2f4a' }, { id: 5, label: 'Estado del proyecto', hex: '#c4c4c4' } ] } },
        { id: 'portfolio_project_step', title: 'Fase', type: 'status', settings: { labels: [
          { id: 0, label: 'En curso', hex: '#fdab3d' }, { id: 1, label: 'Completado', hex: '#00c875', is_done: true } ] } },
        { id: 'color_mm1tt3c2', title: 'TIPO', type: 'status', settings: { labels: [{ id: 3, label: 'Mejora', hex: '#007eb5' }] } },
      ] },
    ],
    itemsByBoard: {
      100: [
        item('p1', null, null),
        item('c1', 'p1', 1), item('c2', 'p1', 0, '2026-09-01'), item('c3', 'p1', 10),
        item('l1', null, 1), item('l2', null, 5), item('l3', null, 2), item('l4', null, null, '2026-12-01'),
      ],
      200: salaItems,
      [pid]: [
        { id: 'pi1', name: '🚀Remodelación Oficinas TT (1-2)', url: 'u', parent_item: null, column_values: [
          { id: 'portfolio_project_rag', value: null }, { id: 'portfolio_project_step', value: s(0) }, { id: 'color_mm1tt3c2', value: s(3) } ] },
        { id: 'pi2', name: '🚀 Sala de capacitación TT PMO-26-01', url: 'u', parent_item: null, column_values: [
          { id: 'portfolio_project_rag', value: s(1) }, { id: 'portfolio_project_step', value: s(1) } ] },
        { id: 'pi3', name: '🚀 Guardavidas HSE-26-07', url: 'u', parent_item: null, column_values: [
          { id: 'portfolio_project_rag', value: s(2) }, { id: 'portfolio_project_step', value: s(0) } ] },
      ],
    },
    errors: [],
  };

  const d = buildDashboard(raw, config, new Date('2026-09-23T23:00:00Z'));
  const byId = Object.fromEntries(d.boards.map((b) => [b.id, b]));

  assert.equal(d.today, '2026-09-23', 'fecha en hora de Panamá');
  assert.ok(!byId['999'], 'los tableros de subelementos se excluyen');

  // Multinivel: cuentan solo las hojas (c1,c2,c3,l1,l2,l3,l4), el padre p1 no
  const r = byId['100'];
  assert.equal(r.total, 7);
  assert.deepEqual(r.buckets, { done: 2, progress: 1, stuck: 1, notstarted: 2, cancelled: 1 });
  assert.equal(Math.round(r.avance * 100), 33, '2 listas de 6 (sin la cancelada)');
  assert.equal(r.overdue, 1);
  assert.equal(r.section, 'proyectos');
  assert.equal(r.health.label, 'Sin estado', 'la etiqueta de relleno del RAG no cuenta como estado');
  assert.equal(r.phase.label, 'En curso');
  assert.equal(r.tipo, 'Mejora');

  // Clásico: valor vacío => etiqueta por defecto; el portafolio lo marca Completado
  const sala = byId['200'];
  assert.deepEqual(sala.labels.map((l) => [l.label, l.count]), [['Listo', 3], ['No iniciado', 1]]);
  assert.equal(sala.state, 'done');
  assert.equal(sala.code, 'PMO-26-01');

  assert.equal(byId['300'].section, 'plantillas');
  assert.equal(byId['400'].section, 'otros-espacios');
  assert.equal(byId['400'].state, 'nostatus');
  assert.equal(byId['500'].section, 'portafolio', 'carpeta Portafolio dentro de Finalizados');
  assert.equal(byId[pid].section, 'portafolio');
  assert.equal(d.sections[0].key, 'proyectos', 'proyectos se muestra primero');

  assert.equal(d.portfolio.total, 3);
  assert.deepEqual(d.portfolio.health.map((h) => [h.label, h.count]), [['Al día', 1], ['Atrasado', 1], ['Sin estado', 1]]);
  assert.equal(d.portfolio.items[2].boardId, null);

  assert.equal(d.totals.projectsActive, 1);
  assert.equal(d.totals.projectsDone, 1);
  assert.equal(d.totals.stuck, 1);
  assert.equal(d.totals.overdue, 1);
  assert.equal(d.attention.stuck[0].name, 'Tarea c3');
});

test('agrupa entregables por persona y hereda el responsable del padre', () => {
  const owner = (...ids) => JSON.stringify({ personsAndTeams: ids.map((id) => ({ id, kind: 'person' })) });
  const cols = [
    { id: 'project_status', title: 'Estatus', type: 'status', settings: { labels: [
      { id: 0, label: 'En Ejecución' }, { id: 1, label: 'Listo', is_done: true }, { id: 10, label: 'Bloqueado' } ] } },
    { id: 'project_timeline', title: 'Cronograma', type: 'timeline' },
    { id: 'reportado', title: 'Reportado por', type: 'people' },
    { id: 'project_owner', title: 'Responsable', type: 'people' },
  ];
  const it = (id, parent, status, own, due) => ({
    id, name: `T ${id}`, url: `u/${id}`, updated_at: '2026-09-20T00:00:00Z', parent_item: parent ? { id: parent } : null,
    column_values: [
      { id: 'project_status', value: status == null ? null : s(status) },
      { id: 'project_timeline', value: due ? tl(due) : null },
      { id: 'project_owner', value: own ?? null },
      { id: 'reportado', value: owner(3) },
    ],
  });
  const raw = {
    users: [{ id: '1', name: 'Esteban Millaa' }, { id: '2', name: 'rcardoze@melonesterminal.com' }, { id: '3', name: 'Otro' }],
    boards: [{ id: '10', name: 'Proyecto X', type: 'board', hierarchy_type: 'multi_level', url: 'b', workspace: { name: 'PMO' }, folder: { name: '🛠️Proyectos' }, columns: cols }],
    itemsByBoard: {
      10: [
        it('p', null, null, owner(1)),              // padre con responsable 1
        it('c1', 'p', 1), it('c2', 'p', 0, null, '2026-09-01'), // heredan de 1
        it('x1', null, 10, owner(2)),               // bloqueada, de 2
        it('x2', null, 0, owner(1, 2)),             // compartida
        it('x3', null, 0),                          // sin responsable
      ],
    },
  };
  const d = buildDashboard(raw, config, new Date('2026-09-23T23:00:00Z'));
  const p = Object.fromEntries(d.people.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(p).sort(), ['Esteban Millaa', 'Rcardoze'], '"Reportado por" no cuenta como responsable');
  assert.equal(p['Esteban Millaa'].total, 3);
  assert.equal(p['Esteban Millaa'].openCount, 2);
  assert.equal(p['Esteban Millaa'].overdue, 1);
  assert.equal(p['Esteban Millaa'].open[0].name, 'T c2', 'las vencidas van primero');
  assert.equal(p['Rcardoze'].stuck, 1);
  assert.equal(d.people[0].name, 'Esteban Millaa');
  assert.equal(d.unassigned.open, 1);
  assert.deepEqual(d.attention.stuck[0].owners, ['Rcardoze']);
});

test('manda plantillas y tableros de prueba fuera de los indicadores', () => {
  const ws = { name: 'PMO: Project Management Office' };
  const stage = { id: 'portfolio_project_step', title: 'Stage', type: 'status', settings: { labels: [] } };
  const raw = {
    boards: [
      { id: '1', name: 'Proyecto Alfa', type: 'board', url: 'x', workspace: ws, folder: { name: 'Proyectos múltiples' }, columns: [] },
      { id: '2', name: 'Mejoras Rev. 3 09/26', type: 'board', url: 'x', workspace: ws, folder: { name: '🚀Mejoras' }, columns: [stage] },
      { id: '3', name: '🛠️ PMO-25-11 Remodelación MOTI  - TT', type: 'board', url: 'x', workspace: ws, folder: { name: '2025 Proyectos' }, columns: [stage] },
      { id: config.portfolio.boardId, name: 'Portafolio 2026', type: 'board', url: 'x', workspace: ws, folder: { name: '📊Portafolio' }, columns: [stage] },
      { id: '5', name: '🛠️ Laboratorio PMO-25-04', type: 'board', url: 'x', workspace: ws, folder: { name: '🛠️Proyectos' }, columns: [] },
    ],
    itemsByBoard: {},
  };
  const d = buildDashboard(raw, config, new Date('2026-09-23T23:00:00Z'));
  const sec = Object.fromEntries(d.boards.map((b) => [b.id, b.section]));
  assert.equal(sec['1'], 'plantillas');
  assert.equal(sec['2'], 'plantillas');
  assert.equal(sec['3'], 'plantillas');
  assert.equal(sec[config.portfolio.boardId], 'portafolio', 'el portafolio real no es plantilla');
  assert.equal(sec['5'], 'proyectos');
});
