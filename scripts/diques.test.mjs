// Pruebas del resumen de diques. Ejecutar: node --test scripts/diques.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiques, roleOf, bucketOf, phaseName, numOf } from './diques.mjs';

const cfg = { timezone: 'America/Panama', diques: { testFolders: 'migraci|prueba' } };
const now = new Date('2026-09-25T16:00:00Z');

const status = (id, title, labels) => ({ id, title, type: 'status', settings_str: JSON.stringify({ labels: labels.map((label, i) => ({ id: i, label })) }) });
const col = (id, title, type) => ({ id, title, type, settings_str: '{}' });
const st = (i) => JSON.stringify({ index: i, changed_at: '2026-07-01T00:00:00Z' });
const item = (id, name, group, values, parent) => ({
  id, name, group: { id: group }, parent_item: parent ? { id: parent } : null, updated_at: '2026-09-20T00:00:00Z',
  column_values: Object.entries(values).map(([cid, v]) => (typeof v === 'object' ? { id: cid, ...v } : { id: cid, text: String(v), value: JSON.stringify(String(v)) })),
});
const board = (id, name, folder, columns, groups, items) => ({ id, name, url: `b/${id}`, workspace: 'DIQUE SECO', folder, columns, groups: groups.map((g) => ({ id: g, title: g })), items });

const programa = board('p', 'PROGRAMA DE DIQUES', null,
  [col('mand', 'Mandatorio', 'date'), col('real', 'Fecha Real', 'text'), status('tipo', 'Tipo de dique', ['Especial', 'Intermedio']), col('est', '$ estimado próximo dique', 'numbers')],
  ['2027', '2028'],
  [
    item('p1', 'Roxana Trader', '2027', { mand: { text: '2027-11-27', value: JSON.stringify({ date: '2027-11-27' }) }, real: 'Definir', tipo: { value: st(0) }, est: 600000 }),
    item('p2', 'Kelly Trader', '2027', { mand: { text: '2027-03-23', value: JSON.stringify({ date: '2027-03-23' }) }, real: 'Oct-2026', tipo: { value: st(0) }, est: 800000 }),
    item('p3', 'Isthmus Trader', '2028', { mand: { text: '2028-01-19', value: JSON.stringify({ date: '2028-01-19' }) }, tipo: { value: st(1) }, est: 475000 }),
  ]);

// Plan multinivel: el padre no se suma, solo sus hijas
const gestion = board('g', 'T1. Gestión de Dique ROXANA', 'Roxana Trader',
  [col('apr', '$ Aprobado', 'numbers'), col('dup', 'Dup. of $ Aprobado', 'numbers'), col('proy', '$ Proyectado', 'numbers'), col('inc', '$ Incurrido Reflejo', 'mirror'),
    status('act', 'Status Actividad', ['En curso', 'Listo', 'Detenido/Cancelado', 'Diferido']), status('fase', 'Fase', ['Planificación', 'Pre-Dique', 'Dique']),
    col('real', 'Tiempo Real', 'timeline')],
  ['DIQUE', 'POST- DIQUE'],
  [
    item('g1', 'Casco', 'DIQUE', { apr: 999, inc: { display_value: '999' } }),
    item('g1a', 'Pintura', 'DIQUE', { apr: 1000, proy: 1200, inc: { display_value: '700.50, 299.50' }, act: { value: st(1) }, fase: { value: st(2) }, real: { value: JSON.stringify({ from: '2026-05-01', to: '2026-05-20' }) } }, 'g1'),
    item('g1b', 'Ánodos', 'DIQUE', { apr: 500, act: { value: st(3) }, real: { value: JSON.stringify({ from: '2026-05-02', to: '2026-06-10' }) } }, 'g1'),
    item('g2', 'Informe', 'POST- DIQUE', { apr: 0, act: { value: st(0) } }),
  ]);

const compras = board('c', 'T4. POs', 'Roxana Trader',
  [col('tot', '$ PO Total', 'numbers'), col('inc', '$ Incurrido', 'numbers'), status('pago', 'Estatus de Pago', ['Pagado', 'Pendiente de Pago', 'Sin registro JL']),
    col('prov', 'Proveedor', 'text'), col('cc', 'CC', 'mirror')],
  ['PO'],
  [
    item('c1', 'PO-1', 'PO', { tot: 1000, inc: 1000, pago: { value: st(0) }, prov: 'Astillero', cc: { display_value: '2.2.1 Cuenta astillero' } }),
    item('c2', 'PO-2', 'PO', { tot: 300, inc: 250, pago: { value: st(1) }, prov: 'Hotel', cc: { display_value: '2.1.4 Estadía' } }),
    item('c3', 'PO-3', 'PO', { tot: 0, inc: 100, pago: { value: st(2) }, prov: 'Varios' }),
  ]);

// Copia de migración de las compras: no debe sumarse porque existe el tablero operativo
const comprasMigracion = board('m', 'D3. Compras y Costos - Roxana', 'MIGRACIÓN - Estándar Dique v1',
  [col('inc', 'Incurrido USD', 'numbers')], ['PO'], [item('m1', 'PO-1', 'PO', { inc: 99999 })]);

const cambios = board('x', 'T2. Control de Cambios/Imprevistos', 'Roxana Trader',
  [col('costo', 'Costo', 'numbers'), status('estado', 'Estado', ['Solicitado', 'Aprobado', 'Rechazado'])],
  ['DIQUE ROXANA'],
  [
    item('x1', 'Tanque de lastre', 'DIQUE ROXANA', { costo: 2000, estado: { value: st(0) } }),
    item('x2', 'Cambio de aceite', 'DIQUE ROXANA', { costo: 500, estado: { value: st(1) } }),
  ]);

// Kelly: cronograma con una fase que ya debió empezar y planificación por áreas
const crono = board('k', 'Cronograma', 'KELLY TRADER',
  [status('estado', 'Estado', ['En curso', 'Listo', 'Retrasado', 'No Iniciado']), col('real', 'Fecha Real', 'timeline'), col('base', 'Linea Base', 'timeline'), col('dif', 'Diferencia', 'formula')],
  ['Plan', 'Dique'],
  [
    item('k1', 'PLANIFICACIÓN', 'Plan', { estado: { value: st(3) }, real: { value: JSON.stringify({ from: '2026-09-22', to: '2026-10-02' }) } }),
    item('k2', 'Entrada al astillero', 'Dique', { estado: { value: st(3) }, real: { value: JSON.stringify({ from: '2026-10-13', to: '2026-10-13' }) }, base: { value: JSON.stringify({ from: '2026-10-16', to: '2026-10-16' }) }, dif: { display_value: '-3' } }),
    item('k3', 'DIQUE (Ejecución)', 'Dique', { estado: { value: st(3) }, real: { value: JSON.stringify({ from: '2026-10-17', to: '2026-10-31' }) } }),
  ]);
const p2 = board('pp', 'P2. Cubierta', 'KELLY TRADER',
  [col('sol', '$ Solicitado (Equipo)', 'numbers'), status('ap', 'Estado Aprobación', ['Revisado Gerencia', 'Aprobado Dirección', 'Descartado', 'Pendiente']), status('area', 'Área', ['Ingeniería', 'Técnico', 'Cubierta'])],
  ['Cubierta'],
  [item('pp1', 'Limpieza tanques', 'Cubierta', { sol: 12500, ap: { value: st(3) }, area: { value: st(2) } }), item('pp2', 'Pintura', 'Cubierta', { area: { value: st(2) } })]);

const d = buildDiques([programa, gestion, compras, comprasMigracion, cambios, crono, p2], cfg, now);
const by = Object.fromEntries(d.buques.map((b) => [b.name, b]));

test('reconoce el tipo de cada tablero por su nombre', () => {
  assert.equal(roleOf('T1. Gestión de Dique Kingston'), 'gestion');
  assert.equal(roleOf('D1. Plan de Dique - Kingston'), 'gestion');
  assert.equal(roleOf('T4. POs KT'), 'compras');
  assert.equal(roleOf('D3. Compras y Costos - Kingston'), 'compras');
  assert.equal(roleOf('T2. Control de Cambios/Imprevisto Kingston Trader'), 'cambios');
  assert.equal(roleOf('CC. Centros de Costo - Kelly Trader'), 'centros');
  assert.equal(roleOf('P1. Planificación Ingeniería - Kingston'), 'planificacion');
  assert.equal(roleOf('T5. Plan de Trabajos de Ingenieria'), 'trabajos');
  assert.equal(roleOf('D0. Cronograma - Kingston'), 'cronograma');
  assert.equal(roleOf('PROGRAMA DE DIQUES'), 'programa');
  assert.equal(phaseName('POST- DIQUE'), 'Post-dique');
  assert.equal(phaseName('3 · DIQUE'), 'Dique');
  assert.equal(bucketOf('Pendiente de Pago'), 'warn');
  assert.equal(bucketOf('Sin registro JL'), 'notstarted');
  assert.equal(bucketOf('Diferido'), 'deferred');
  assert.equal(numOf({ column_values: [{ id: 'm', display_value: '3,981.00, 452.25' }] }, { id: 'm' }), 4433.25, 'reflejo con varios valores');
});

test('suma costos del buque sin contar padres ni copias de migración', () => {
  const r = by['Roxana Trader'];
  assert.ok(r, 'el buque sale de la carpeta');
  assert.equal(r.gestion.presupuesto, 1500, 'solo las hijas del elemento Casco');
  assert.equal(r.gestion.proyectado, 1200);
  assert.equal(r.gestion.incurrido, 1000, 'reflejo con varios montos');
  assert.deepEqual(r.gestion.porFase.map((f) => [f.label, f.count]), [['Dique', 2], ['Post-dique', 1]]);
  assert.equal(r.compras.incurrido, 1350, 'la copia de migración no se suma');
  assert.ok(!r.boards.some((b) => b.test), 'no usa tableros de migración si hay operativos');
  assert.equal(r.compras.pendientesCount, 1);
  assert.equal(r.compras.pendientes[0].proveedor, 'Hotel');
  assert.equal(r.compras.porCentro[0].label, '2.2.1 Cuenta astillero');
  assert.equal(r.cambios.porDecidir.count, 1);
  assert.equal(r.cambios.porDecidir.costo, 2000);
  assert.equal(r.etapa, 'Realizado');
  assert.equal(r.programa[0].mandatorio, '2027-11-27');
});

test('arma el cronograma del dique en curso y el próximo hito', () => {
  const k = by['Kelly Trader'];
  assert.equal(k.etapa, 'En curso');
  assert.equal(k.faseActual, 'Planificación');
  const plan = k.cronograma.phases.find((p) => p.name === 'PLANIFICACIÓN');
  assert.equal(plan.alerta, 'sin iniciar', 'debió empezar el 22-sep');
  const entrada = k.cronograma.phases.find((p) => p.hito);
  assert.equal(entrada.diferencia, -3);
  assert.equal(entrada.baseFrom, '2026-10-16');
  assert.deepEqual(d.proximo, { buque: 'Kelly Trader', fecha: '2026-10-13', hito: 'Entrada al astillero' });
  assert.equal(k.planificacion.solicitado, 12500);
  assert.deepEqual(k.planificacion.porAprobacion.map((x) => [x.label, x.count]), [['Pendiente', 1], ['Sin estado', 1]]);
  assert.equal(k.planificacion.porArea[0].area, 'Cubierta');
});

test('resume el programa por año', () => {
  assert.deepEqual(d.programaPorAnio, [{ anio: '2027', count: 2, estimado: 1400000 }, { anio: '2028', count: 1, estimado: 475000 }]);
  assert.equal(d.totals.programaEstimado, 1875000);
  assert.equal(d.totals.incurrido, 1350);
  assert.equal(d.programa[0].buque, 'Kelly Trader', 'ordenado por fecha mandatoria');
});
