const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenDocente, tokenAdmin, estudiante, materiaId, anio

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)

  // La asignación PROPIA del docente de prueba, directo de la BD (el endpoint
  // de asignaciones no devuelve materiaId, solo el nombre)
  const docRow = db.prepare(
    "SELECT dm.materiaId, dm.curso FROM docentes d JOIN usuarios u ON u.id = d.usuarioId JOIN docente_materias dm ON dm.docenteId = d.id WHERE u.documento = ? LIMIT 1"
  ).get(DOCENTE.documento)
  assert.ok(docRow, 'hace falta una asignación para el docente de prueba')

  // Un estudiante del curso de esa asignación
  materiaId = docRow.materiaId
  anio = new Date().getFullYear() + 50 // año imposible: aísla la prueba
  const est = db.prepare('SELECT id FROM estudiantes WHERE curso = ? LIMIT 1').get(docRow.curso)
  assert.ok(est, 'hace falta un estudiante en el curso de la asignación')
  estudiante = est.id
})

after(async () => { db.close(); await srv.cerrar() })

function itemCon(valor) {
  return { estudianteId: estudiante, materiaId, periodo: 1, anio, tipo: 'ACTIVIDAD', titulo: 'Test Rango', valor }
}

test('guardar-grid rechaza notas fuera de 0 a 5 con el mensaje exacto', async () => {
  const seis = await api.post('/api/notas/guardar-grid', { token: tokenDocente, body: { items: [itemCon(6)] } })
  assert.equal(seis.status, 400)
  assert.match(seis.data.error, /de 0 a 5/)

  const negativo = await api.post('/api/notas/guardar-grid', { token: tokenDocente, body: { items: [itemCon(-1)] } })
  assert.equal(negativo.status, 400)
  assert.match(negativo.data.error, /de 0 a 5/)

  const decima = await api.post('/api/notas/guardar-grid', { token: tokenDocente, body: { items: [itemCon(5.1)] } })
  assert.equal(decima.status, 400)

  // El 0 y el 5 SÍ son válidos (extremos del rango) — verificando el
  // guardado REAL (actualizados > 0), no solo el status
  const cero = await api.post('/api/notas/guardar-grid', { token: tokenDocente, body: { items: [itemCon(0)] } })
  assert.equal(cero.status, 200)
  assert.ok((cero.data.actualizados || 0) >= 1, 'el 0 debe guardarse de verdad (el viejo valor < 1 lo ignoraba)')

  const cinco = await api.post('/api/notas/guardar-grid', { token: tokenDocente, body: { items: [itemCon(5)] } })
  assert.equal(cinco.status, 200)
  assert.ok((cinco.data.actualizados || 0) >= 1, 'el 5 debe guardarse de verdad')

  // Limpieza del item de prueba
  const limpiar = await api.post('/api/notas/guardar-grid', { token: tokenDocente, body: { items: [{ estudianteId: estudiante, materiaId, periodo: 1, anio, tipo: 'ACTIVIDAD', titulo: 'Test Rango', valor: null, _delete: true }] } })
  assert.equal(limpiar.status, 200)
})
