const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
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

  // Período abierto + estudiante de esa sede + una materia cualquiera
  const p = db.prepare('SELECT sede, periodo, anio FROM periodos_config WHERE abierto = 1 ORDER BY periodo LIMIT 1').get()
  const est = db.prepare('SELECT id FROM estudiantes WHERE sede = ? LIMIT 1').get(p.sede)
  const mat = db.prepare('SELECT id FROM materias LIMIT 1').get()
  objetivo = { sede: p.sede, periodo: p.periodo, anio: p.anio, estudianteId: est.id, materiaId: mat.id }
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
