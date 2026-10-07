// ─────────────────────────────────────────────────────────────────
// Síntoma "fue creada pero no aparece": el botón "+ Agregar nota" de la
// planilla llama POST /columna, que usaba ON CONFLICT DO NOTHING y mentía
// con 200 "agregada" aunque el duplicado se ignorara. Y POST /items aceptaba
// items sin título (invisibles para siempre) y duplicados (500 crudo del
// UNIQUE). Estos tests fijan los tres comportamientos.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente
let base, calificacionId, estudianteId, materiaId, curso

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)

  // Asignación real del docente + estudiante de ese curso + calificación
  const usu = db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(DOCENTE.documento)
  const doc = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(usu.id)
  const asig = db.prepare('SELECT materiaId, curso FROM docente_materias WHERE docenteId = ? LIMIT 1').get(doc.id)
  materiaId = asig.materiaId
  curso = asig.curso
  const est = db.prepare('SELECT id FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
  estudianteId = est.id
  base = { curso, materiaId, periodo: 4, anio: new Date().getFullYear() } // P4: limpio para fixtures
  calificacionId = crypto.randomUUID()
  db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)'
  ).run(calificacionId, estudianteId, materiaId, doc.id, base.periodo, base.anio)
})

after(async () => { db.close(); await srv.cerrar() })

const columna = titulo => api.post('/api/notas/columna', {
  token: tokenDocente,
  body: { ...base, tipo: 'ACTITUDINAL', titulo },
})

test('POST /columna: título nuevo → 200 y aparece en GET /columnas', async () => {
  const r = await columna('Quiz 1')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const cols = await api.get(`/api/notas/columnas?curso=${encodeURIComponent(curso)}&materiaId=${materiaId}&periodo=${base.periodo}&anio=${base.anio}`, { token: tokenDocente })
  assert.ok(cols.data.columnas.ACTITUDINAL.includes('Quiz 1'), 'la columna debe listarse')
})

test('POST /columna: título DUPLICADO → 409 claro (antes: 200 mentiroso y no aparecía)', async () => {
  const r = await columna('Quiz 1')
  assert.equal(r.status, 409, 'el duplicado debe revelarse, no fingir éxito')
  assert.match(r.data.error, /Ya existe una columna con el título/)
  // y sin duplicar filas en la tabla
  const filas = db.prepare('SELECT COUNT(*) c FROM columnas WHERE curso = ? AND materiaId = ? AND periodo = ? AND titulo = ?').get(curso, materiaId, base.periodo, 'Quiz 1')
  assert.equal(Number(filas.c), 1, 'solo una fila por título')
})

test('POST /columna: títulos distintos se acumulan sin límite (no hay tope de 2)', async () => {
  await columna('Quiz 2')
  const r = await columna('Quiz 3')
  assert.equal(r.status, 200)
  const cols = await api.get(`/api/notas/columnas?curso=${encodeURIComponent(curso)}&materiaId=${materiaId}&periodo=${base.periodo}&anio=${base.anio}`, { token: tokenDocente })
  for (const t of ['Quiz 1', 'Quiz 2', 'Quiz 3']) {
    assert.ok(cols.data.columnas.ACTITUDINAL.includes(t), 'debe listar ' + t)
  }
})

test('POST /items: sin descripción → 400 (antes: item invisible que contaba para la definitiva)', async () => {
  const r = await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId, tipo: 'ACTITUDINAL', valor: 3.0 } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /título de la nota es requerido/)
})

test('POST /items: con descripción nueva → 200 y visible en las columnas', async () => {
  const r = await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId, tipo: 'ACTITUDINAL', valor: 3.0, descripcion: 'Quiz 1' } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const cols = await api.get(`/api/notas/columnas?curso=${encodeURIComponent(curso)}&materiaId=${materiaId}&periodo=${base.periodo}&anio=${base.anio}`, { token: tokenDocente })
  assert.ok(cols.data.columnas.ACTITUDINAL.includes('Quiz 1'), 'la nota con título es renderizable')
})

test('POST /items: descripción duplicada → 409 amigable (antes: 500 crudo del UNIQUE)', async () => {
  const r = await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId, tipo: 'ACTITUDINAL', valor: 4.0, descripcion: 'Quiz 1' } })
  assert.equal(r.status, 409, 'no debe ser un 500')
  assert.match(r.data.error, /Ya existe una nota con ese título/)
})

test('PUT /items/:id: cambiar la descripción a una duplicada → 409', async () => {
  const item = db.prepare('SELECT id FROM notas_items WHERE calificacionId = ? AND descripcion = ?').get(calificacionId, 'Quiz 1')
  await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId, tipo: 'ACTITUDINAL', valor: 5.0, descripcion: 'Quiz 2' } })
  const r = await api.put('/api/notas/items/' + item.id, { token: tokenDocente, body: { descripcion: 'Quiz 2' } })
  assert.equal(r.status, 409)
  assert.match(r.data.error, /Ya existe una nota con ese título/)
})

test('PUT /items/:id: descripción vacía → 400 (nunca un item invisible)', async () => {
  const item = db.prepare('SELECT id FROM notas_items WHERE calificacionId = ? AND descripcion = ?').get(calificacionId, 'Quiz 1')
  const r = await api.put('/api/notas/items/' + item.id, { token: tokenDocente, body: { descripcion: '' } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /título de la nota es requerido/)
})

test('POST /items EVALUACION: sin descripción sigue siendo válido (columna fija)', async () => {
  const r = await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId, tipo: 'EVALUACION', valor: 4.3 } })
  assert.equal(r.status, 200, 'Evaluación es la columna fija, no lleva título')
  const segunda = await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId, tipo: 'EVALUACION', valor: 5 } })
  assert.equal(segunda.status, 400, 'solo una evaluación')
})
