const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente
let objetivo // { sede, periodo, anio, estudianteId, materiaId }

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)

  // Período abierto de la SEDE de un estudiante real + una materia cualquiera
  // (después del podado solo hay estudiantes en algunas sedes)
  const est = db.prepare('SELECT id, sede, curso FROM estudiantes LIMIT 1').get()
  const p = db.prepare('SELECT sede, periodo, anio FROM periodos_config WHERE abierto = 1 AND sede = ? ORDER BY periodo LIMIT 1').get(est.sede)
  const mat = db.prepare('SELECT id FROM materias LIMIT 1').get()
  objetivo = { sede: p.sede, periodo: p.periodo, anio: p.anio, estudianteId: est.id, materiaId: mat.id }

  // Desde el fix de IDOR, PUT /guardar valida que el docente tenga la
  // materia asignada en el curso del estudiante — se garantiza la asignación
  const usu = db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(DOCENTE.documento)
  const doc = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(usu.id)
  db.prepare('INSERT OR IGNORE INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), doc.id, mat.id, est.curso)
})
after(async () => { db.close(); await srv.cerrar() })

const guardar = () => api.put('/api/notas/guardar', {
  token: tokenDocente,
  body: {
    estudianteId: objetivo.estudianteId,
    materiaId: objetivo.materiaId,
    periodo: objetivo.periodo,
    anio: objetivo.anio,
  },
})

test('GET /api/config/periodos es público y trae los 4 períodos por sede', async () => {
  const r = await api.get(`/api/config/periodos?anio=${objetivo.anio}`)
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
  assert.ok(r.data.length >= 4, 'debe haber al menos 4 períodos')
  for (const c of r.data) {
    assert.ok(c.sede && c.periodo !== undefined && c.abierto !== undefined)
  }
})

test('con el período abierto el docente puede guardar notas', async () => {
  const r = await guardar()
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.mensaje, 'Calificación guardada')
  assert.ok(r.data.calificacionId)
})

test('el admin cierra el período y el estado pasa a CERRADO_MANUAL', async () => {
  const cerrar = await api.post('/api/admin/periodos/cerrar', {
    token: tokenAdmin,
    body: { sede: objetivo.sede, periodo: objetivo.periodo, anio: objetivo.anio },
  })
  assert.equal(cerrar.status, 200)
  assert.match(cerrar.data.mensaje, /cerrado/)

  const lista = await api.get(`/api/admin/periodos?anio=${objetivo.anio}&sede=${encodeURIComponent(objetivo.sede)}`, { token: tokenAdmin })
  const actual = lista.data.find(x => x.periodo === objetivo.periodo)
  assert.equal(actual.abierto, 0)
  assert.equal(actual.estado, 'CERRADO_MANUAL')
})

test('cerrado el período, guardar notas devuelve 403', async () => {
  const r = await guardar()
  assert.equal(r.status, 403)
  assert.match(r.data.error, /cerrado para esta sede/)
})

test('el admin reabre y el docente vuelve a poder guardar', async () => {
  const reabrir = await api.post('/api/admin/periodos/reabrir', {
    token: tokenAdmin,
    body: { sede: objetivo.sede, periodo: objetivo.periodo, anio: objetivo.anio },
  })
  assert.equal(reabrir.status, 200)

  const lista = await api.get(`/api/admin/periodos?anio=${objetivo.anio}&sede=${encodeURIComponent(objetivo.sede)}`, { token: tokenAdmin })
  const actual = lista.data.find(x => x.periodo === objetivo.periodo)
  assert.equal(actual.abierto, 1)
  assert.equal(actual.estado, 'ABIERTO')

  const r = await guardar()
  assert.equal(r.status, 200, JSON.stringify(r.data))
})

test('cerrar/reabrir validan parámetros y rol', async () => {
  const sinDatos = await api.post('/api/admin/periodos/cerrar', { token: tokenAdmin, body: {} })
  assert.equal(sinDatos.status, 400)

  const sedeMala = await api.post('/api/admin/periodos/cerrar', {
    token: tokenAdmin, body: { sede: 'SEDE INEXISTENTE', periodo: 1, anio: objetivo.anio },
  })
  assert.equal(sedeMala.status, 404)

  const sinRol = await api.post('/api/admin/periodos/cerrar', {
    token: tokenDocente,
    body: { sede: objetivo.sede, periodo: objetivo.periodo, anio: objetivo.anio },
  })
  assert.equal(sinRol.status, 403)
})

// ═══════════════════════════════════════════════════════════════
// CACHÉ de GET /api/config/periodos (60 s): SOLO ese endpoint la usa.
// Este test prueba las tres garantías: (1) la caché existe y sirve
// datos de memoria, (2) cerrar desde el admin la invalida al instante,
// (3) el guardado de notas lee la BD directamente — con la caché
// caliente y desactualizada, guardar-grid sigue bloqueado de inmediato.
// ═══════════════════════════════════════════════════════════════
test('caché de periodos: sirve de memoria, se invalida al cerrar, y guardar-grid lee la BD directo', async () => {
  const urlConfig = `/api/config/periodos?anio=${objetivo.anio}&sede=${encodeURIComponent(objetivo.sede)}`

  // 1) Calentar la caché
  const calienta = await api.get(urlConfig)
  assert.equal(calienta.status, 200)

  // 2) Cambio DIRECTO en la BD (sin pasar por el admin → sin invalidación):
  //    la caché caliente debe seguir sirviendo el valor VIEJO (abierto)
  db.prepare('UPDATE periodos_config SET abierto = 0 WHERE sede = ? AND periodo = ? AND anio = ?')
    .run(objetivo.sede, objetivo.periodo, objetivo.anio)
  const servidoDeCache = await api.get(urlConfig)
  const enCache = servidoDeCache.data.find(p => p.periodo === objetivo.periodo)
  assert.equal(enCache.abierto, 1, 'la caché de 60s sirve el valor previo (prueba de que existe)')
  // y mientras tanto, guardar-grid YA está bloqueado (lee la BD directo)
  const bloqueado = await guardar()
  assert.equal(bloqueado.status, 403, 'guardar-grid usa la BD, no la caché: bloqueo inmediato')

  // 3) Cerrar desde el admin → invalida la caché → el endpoint sirve la verdad
  const cerrar = await api.post('/api/admin/periodos/cerrar', {
    token: tokenAdmin, body: { sede: objetivo.sede, periodo: objetivo.periodo, anio: objetivo.anio },
  })
  assert.equal(cerrar.status, 200)
  const trasCerrar = await api.get(urlConfig)
  const cerrado = trasCerrar.data.find(p => p.periodo === objetivo.periodo)
  assert.equal(cerrado.abierto, 0, 'la invalidación refleja el cierre al instante')

  // Limpieza: reabrir desde el admin
  await api.post('/api/admin/periodos/reabrir', {
    token: tokenAdmin, body: { sede: objetivo.sede, periodo: objetivo.periodo, anio: objetivo.anio },
  })
  const trasReabrir = await api.get(urlConfig)
  const abierto = trasReabrir.data.find(p => p.periodo === objetivo.periodo)
  assert.equal(abierto.abierto, 1)
})
