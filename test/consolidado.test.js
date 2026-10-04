const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')
const path = require('node:path')
const Database = require('better-sqlite3')

const RAIZ = path.resolve(__dirname, '..')
const ANIO_PRUEBA = 1999 // año imposible: aisla las pruebas

// La formula aislada (sin servidor): los casos del colegio
const { calcularMinimoRequerido, calcularConsolidado } = require('../src/services/consolidado')

test('formula: 2.5 en P1 -> necesita 3.5 en P2 (el caso de David)', () => {
  const r = calcularMinimoRequerido([2.5])
  assert.equal(r.minimo, 3.5)
  assert.equal(r.estado, 'ALCANZABLE')
})

test('formula: ceil a 1 decimal (3.46 se muestra 3.5)', () => {
  // 3.0x2 - 2.55 = 3.45 -> ceil -> 3.5
  const r = calcularMinimoRequerido([2.55])
  assert.equal(r.minimo, 3.5)
})

test('formula: dos periodos con nota', () => {
  const r = calcularMinimoRequerido([2.5, 2.0])
  assert.equal(r.minimo, 4.5) // 3.0x3 - 4.5
  assert.equal(r.estado, 'ALCANZABLE')
})

test('formula: ya pasa -> ASEGURADO con 0', () => {
  // 3.0x2 - 4.0 = 2.0: todavia necesita 2.0 en el siguiente (alcanzable)
  assert.deepEqual(calcularMinimoRequerido([4.0]), { minimo: 2, estado: 'ALCANZABLE' })
  // 3 notas (n=4): 3.0x4 - 12.0 = 0 -> asegurado (ya pasa con cualquier nota)
  assert.deepEqual(calcularMinimoRequerido([4.0, 4.0, 4.0]), { minimo: 0, estado: 'ASEGURADO' })
})

test('formula: no alcanzable (necesitaria mas de 5)', () => {
  // 3.0x3 - 3.5 = 5.5 -> RIESGO_CRITICO
  const r = calcularMinimoRequerido([2.0, 1.5])
  assert.equal(r.minimo, null)
  assert.equal(r.estado, 'RIESGO_CRITICO')
})

test('formula: sin notas anteriores -> el minimo es 3.0', () => {
  assert.deepEqual(calcularMinimoRequerido([]), { minimo: 3.0, estado: 'ALCANZABLE' })
  assert.deepEqual(calcularMinimoRequerido([null, null]), { minimo: 3.0, estado: 'ALCANZABLE' })
})

// El endpoint con servidor real
let srv, api, db, tokenAdmin, tokenDocente, curso, materiaId

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  const docRow = db.prepare(
    "SELECT dm.materiaId, dm.curso FROM docentes d JOIN usuarios u ON u.id = d.usuarioId JOIN docente_materias dm ON dm.docenteId = d.id WHERE u.documento = ? LIMIT 1"
  ).get(DOCENTE.documento)
  curso = docRow.curso
  materiaId = docRow.materiaId
})

after(async () => { db.close(); await srv.cerrar() })

test('endpoint consolidado: definitivas por estudiante + nota necesaria', async () => {
  const estudiantes = db.prepare('SELECT id FROM estudiantes WHERE curso = ? LIMIT 2').all(curso)
  assert.ok(estudiantes.length >= 2)
  // P1: est[0] -> 2.5 (el caso David). docenteId es NOT NULL y FK: uso el
  // docente real de la asignacion de esa materia
  const asigDoc = db.prepare('SELECT docenteId FROM docente_materias WHERE materiaId = ? AND curso = ?').get(materiaId, curso)
  db.prepare(
    "INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, 1, ?, 2.5, datetime('now'))"
  ).run('test-cons-1', estudiantes[0].id, materiaId, asigDoc.docenteId, ANIO_PRUEBA)
  // P2: est[0] -> 3.5 (completa los 2 primeros)

  const r = await api.get('/api/notas/consolidado?curso=' + encodeURIComponent(curso) + '&materiaId=' + materiaId + '&anio=' + ANIO_PRUEBA + '&periodo=2', { token: tokenDocente })
  assert.equal(r.status, 200)
  const david = r.data.estudiantes.find(e => e.estudianteId === estudiantes[0].id)
  assert.ok(david, 'el estudiante debe aparecer')
  assert.equal(david.definitivas[0], 2.5)
  assert.equal(david.definitivas[1], null)
  assert.equal(david.periodoSiguiente, 2, 'con periodo=2 y P2 sin calificar, el siguiente es P2')
  assert.equal(david.notaNecesaria, 3.5, '2.5 en P1 -> necesita 3.5 en P2')
  assert.equal(david.completo, false)

  // El "siguiente" NUNCA es un periodo ya pasado: con periodo=4, la nota
  // necesaria es para P4 (los periodos P2/P3 sin nota no penalizan)
  const r4 = await api.get('/api/notas/consolidado?curso=' + encodeURIComponent(curso) + '&materiaId=' + materiaId + '&anio=' + ANIO_PRUEBA + '&periodo=4', { token: tokenDocente })
  const david4 = r4.data.estudiantes.find(e => e.estudianteId === estudiantes[0].id)
  assert.equal(david4.periodoSiguiente, 4, 'con periodo=4, el siguiente es P4 (nunca P1)')
  assert.equal(david4.notaNecesaria, 3.5, '2.5 en P1 -> necesita 3.5 (n=2) en P4')

  // El caso del colegio: P4 actual SIN notas en P1-P3 -> necesita 3.0 en P4
  const otro4 = r4.data.estudiantes.find(e => e.estudianteId === estudiantes[1].id)
  assert.equal(otro4.periodoSiguiente, 4)
  assert.equal(otro4.notaNecesaria, 3.0, 'sin notas -> el minimo es 3.0 en P4')
})

test('endpoint consolidado: no-docente de la materia -> 403, sin params -> 400', async () => {
  const noAsignada = await api.get('/api/notas/consolidado?curso=' + encodeURIComponent(curso) + '&materiaId=zzz&anio=1999', { token: tokenDocente })
  assert.equal(noAsignada.status, 403)

  const sinParams = await api.get('/api/notas/consolidado?curso=' + encodeURIComponent(curso), { token: tokenDocente })
  assert.equal(sinParams.status, 400)

  // El admin SÍ puede ver cualquier curso/materia (el mismo servicio)
  const admin = await api.get('/api/admin/consolidado?curso=' + encodeURIComponent(curso) + '&materiaId=' + materiaId + '&anio=' + ANIO_PRUEBA, { token: tokenAdmin })
  assert.equal(admin.status, 200)
  assert.ok(admin.data.estudiantes.length >= 2)
})
