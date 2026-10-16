// ─────────────────────────────────────────────────────────────────
// BOOTSTRAP DEL PORTAL: mi-bootstrap debe devolver, en UNA llamada,
// exactamente lo mismo que los 4 endpoints individuales (mismos
// shapes campo a campo). Es la réplica en suite del patrón de
// verificación usado contra producción con CHAPARRO.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')

let srv, api, db, tokenEstudiante, tokenAdmin, anio

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  anio = new Date().getFullYear()

  // Estudiante de prueba con contraseña conocida (patrón de roles.test.js)
  const est = db.prepare(
    'SELECT u.id, u.documento FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id LIMIT 1'
  ).get()
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Estudiante123', 10), est.id)
  tokenEstudiante = await login(api, est.documento, 'Estudiante123')
})

after(async () => { db.close(); await srv.cerrar() })

test('mi-bootstrap: 200 y el período activo es uno configurado', async () => {
  const r = await api.get('/api/notas/mi-bootstrap?anio=' + anio, { token: tokenEstudiante })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok([1, 2, 3, 4].includes(r.data.periodoActivo), 'período activo válido')
  assert.equal(r.data.anio, anio)
})

test('mi-bootstrap: sus secciones son IDÉNTICAS a los 4 endpoints individuales', async () => {
  const boot = await api.get('/api/notas/mi-bootstrap?anio=' + anio, { token: tokenEstudiante })
  assert.equal(boot.status, 200)

  const periodo = boot.data.periodoActivo
  const notas = await api.get(`/api/notas/mis-notas?periodo=${periodo}&anio=${anio}`, { token: tokenEstudiante })
  const areas = await api.get(`/api/notas/mis-areas?periodo=${periodo}&anio=${anio}`, { token: tokenEstudiante })
  const corte = await api.get(`/api/notas/mi-reporte-corte?periodo=${periodo}&anio=${anio}`, { token: tokenEstudiante })
  const obs = await api.get('/api/notas/mis-observaciones', { token: tokenEstudiante })

  assert.equal(notas.status, 200)
  assert.equal(areas.status, 200)
  assert.equal(corte.status, 200)
  assert.equal(obs.status, 200)

  // Calificaciones: mismo array campo a campo
  assert.deepEqual(boot.data.calificaciones, notas.data.calificaciones, 'calificaciones idénticas a mis-notas')
  assert.equal(boot.data.promedio, notas.data.promedio)
  // Consultas: retiradas de raíz — la migración dejó caer la tabla y ya
  // ninguna respuesta trae el contador. Si el upsert siguiera vivo, el 200
  // de arriba sería un 500 (tabla inexistente).
  const tabla = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consultas_estudiantes'").get()
  assert.equal(tabla, undefined, 'la tabla de consultas ya no existe en la BD')
  assert.equal(boot.data.consultasUsadas, undefined, 'bootstrap ya no trae consultasUsadas')
  assert.equal(notas.data.consultasUsadas, undefined, 'mis-notas ya no trae consultasUsadas')

  // Áreas
  assert.deepEqual(boot.data.areas, areas.data.areas, 'áreas idénticas a mis-areas')

  // Estado del corte
  assert.deepEqual(boot.data.corte, corte.data, 'corte idéntico a mi-reporte-corte')

  // Observaciones
  assert.deepEqual(boot.data.observaciones, obs.data, 'observaciones idénticas a mis-observaciones')
})

test('mi-bootstrap: solo estudiantes (docente/anon 403/401)', async () => {
  const anon = await api.get('/api/notas/mi-bootstrap?anio=' + anio)
  assert.equal(anon.status, 401)
  const r = await api.get('/api/notas/mi-bootstrap?anio=' + anio, { token: tokenAdmin })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /Solo para estudiantes/)
})

test('mis-consultas: el endpoint del contador fue retirado (404)', async () => {
  const r = await api.get('/api/notas/mis-consultas?periodo=1&anio=' + anio, { token: tokenEstudiante })
  assert.equal(r.status, 404, 'la ruta ya no existe')
})
