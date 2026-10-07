// ─────────────────────────────────────────────────────────────────
// FASE 2: DELETE /materias/:id con filas contenedoras vacías.
// Reproduce el bug real de "Estadística": una calificación con
// definitiva NULL y 0 notas_items (de abrir el grid sin guardar)
// NO debe bloquear la eliminación de la materia.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')

let srv, api, db, tokenAdmin, estudianteId, docenteId

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  estudianteId = db.prepare('SELECT id FROM estudiantes LIMIT 1').get().id
  docenteId = db.prepare('SELECT id FROM docentes LIMIT 1').get().id
})

after(async () => { db.close(); await srv.cerrar() })

async function crearMateriaPrueba(sufijo) {
  const r = await api.post('/api/admin/materias', { token: tokenAdmin, body: { nombre: 'TEST MATERIA ' + sufijo } })
  assert.equal(r.status, 201, 'crear materia de prueba: ' + JSON.stringify(r.data))
  return r.data.id
}

test('DELETE materia con SOLO filas vacías: 200 y las limpia', async () => {
  const id = await crearMateriaPrueba('VACIA ' + Date.now())

  // Fila contenedora vacía (definitiva NULL, sin items): el caso Estadística
  db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), estudianteId, id, docenteId, new Date().getFullYear())

  const del = await api.delete('/api/admin/materias/' + id, { token: tokenAdmin })
  assert.equal(del.status, 200, 'debe permitir eliminar: ' + JSON.stringify(del.data))

  const cal = db.prepare('SELECT COUNT(*) c FROM calificaciones WHERE materiaid = ?').get(id)
  assert.equal(Number(cal.c), 0, 'la fila vacía debe quedar limpia')
  const mat = db.prepare('SELECT id FROM materias WHERE id = ?').get(id)
  assert.equal(mat, undefined, 'la materia debe eliminarse')
})

test('DELETE materia con notas REALES: sigue bloqueado con 409', async () => {
  const id = await crearMateriaPrueba('CON NOTAS ' + Date.now())

  // Calificación con definitiva cerrada (nota real guardada)
  db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, 1, ?, 3.2, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), estudianteId, id, docenteId, new Date().getFullYear())

  const del = await api.delete('/api/admin/materias/' + id, { token: tokenAdmin })
  assert.equal(del.status, 409, 'materia con nota real NO debe eliminarse')

  // Y además: la misma materia con UNA fila vacía + UNA real también se bloquea
  // (otro estudiante: el UNIQUE es estudiante+materia+periodo+anio)
  const estudiante2 = db.prepare('SELECT id FROM estudiantes WHERE id != ? LIMIT 1').get(estudianteId)
  db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), estudiante2.id, id, docenteId, new Date().getFullYear())

  const del2 = await api.delete('/api/admin/materias/' + id, { token: tokenAdmin })
  assert.equal(del2.status, 409, 'mezcla de real + vacía también se bloquea')

  // Limpieza del fixture (la materia queda porque el DELETE fue rechazado)
  db.prepare('DELETE FROM calificaciones WHERE materiaid = ?').run(id)
  db.prepare('DELETE FROM materias WHERE id = ?').run(id)
})

test('DELETE materia con items pero sin definitiva: también cuenta como real', async () => {
  const id = await crearMateriaPrueba('SOLO ITEMS ' + Date.now())

  const calId = crypto.randomUUID()
  db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP)'
  ).run(calId, estudianteId, id, docenteId, new Date().getFullYear())
  db.prepare(
    'INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), calId, 'ACTIVIDAD', 4.0, 'Tarea test')

  const del = await api.delete('/api/admin/materias/' + id, { token: tokenAdmin })
  assert.equal(del.status, 409, 'items guardados sin definitiva = notas reales')

  db.prepare('DELETE FROM calificaciones WHERE materiaid = ?').run(id)
  db.prepare('DELETE FROM materias WHERE id = ?').run(id)
})
