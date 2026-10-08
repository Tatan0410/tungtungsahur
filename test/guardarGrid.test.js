// ─────────────────────────────────────────────────────────────────
// FASE 4: guardar-grid con resultado por item y transacción corta por
// calificación. Caso clave: un item falla (SQL) → rollback SOLO de su
// grupo; los demás grupos quedan guardados y el response reporta
// { guardados, fallidos } con la misma forma en ambos motores.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, asig, estudiante, anio

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)

  const usu = db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(DOCENTE.documento)
  const doc = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(usu.id)
  asig = db.prepare('SELECT materiaId, curso FROM docente_materias WHERE docenteId = ? LIMIT 1').get(doc.id)
  estudiante = db.prepare('SELECT id FROM estudiantes WHERE curso = ? LIMIT 1').get(asig.curso)
  anio = new Date().getFullYear() + 40 // año aislado de datos reales
})

after(async () => { db.close(); await srv.cerrar() })

const item = (extra = {}) => ({
  estudianteId: estudiante.id,
  materiaId: asig.materiaId,
  periodo: 1,
  anio,
  tipo: 'ACTIVIDAD',
  titulo: 'Test Grid',
  valor: 4.0,
  ...extra,
})

test('2 items válidos + 1 IDOR ajeno → guardados:2, fallidos:1 con el error claro', async () => {
  const r = await api.post('/api/notas/guardar-grid', {
    token: tokenDocente,
    body: { items: [
      item({ titulo: 'Tarea A', valor: 3.0 }),
      item({ titulo: 'Tarea B', valor: 4.5 }),
      item({ estudianteId: 'estudiante-falso-999', titulo: 'Tarea Ajena', valor: 5 }),
    ] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.guardados.length, 2, JSON.stringify(r.data))
  assert.equal(r.data.fallidos.length, 1)
  assert.match(r.data.fallidos[0].error, /Estudiante no encontrado/)
  assert.equal(r.data.actualizados, 2)

  // Los 2 válidos quedaron guardados de verdad
  const guardadas = db.prepare(
    "SELECT descripcion, valor FROM notas_items WHERE calificacionId IN (SELECT id FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND anio = ?)"
  ).all(estudiante.id, asig.materiaId, anio)
  const titulos = guardadas.map(g => g.descripcion).sort()
  assert.deepEqual(titulos, ['Tarea A', 'Tarea B'], 'los válidos persisten')
})

test('período cerrado → fallido visible (antes: silencio total)', async () => {
  // Cerrar el período 2 para la sede del estudiante en el año aislado
  const est = db.prepare('SELECT sede FROM estudiantes WHERE id = ?').get(estudiante.id)
  db.prepare('INSERT INTO periodos_config (id, anio, sede, periodo, nombre, fecha_inicio, fecha_fin, abierto) VALUES (?, ?, ?, 2, ?, ?, ?, 0)')
    .run(crypto.randomUUID(), anio, est.sede, 'P2', '2030-01-01', '2030-06-01')

  const r = await api.post('/api/notas/guardar-grid', {
    token: tokenDocente,
    body: { items: [item({ periodo: 2, titulo: 'Tarea Cerrada' })] },
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.guardados.length, 0)
  assert.equal(r.data.fallidos.length, 1)
  assert.match(r.data.fallidos[0].error, /cerrado para esta sede/)
})

test('título vacío en tipo con columnas → fallido (nunca un item invisible)', async () => {
  const r = await api.post('/api/notas/guardar-grid', {
    token: tokenDocente,
    body: { items: [item({ titulo: '' })] },
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.fallidos.length, 1)
  assert.match(r.data.fallidos[0].error, /título de la nota es requerido/)
})

test('CASO CLAVE: 1 item con error SQL (grupo) + 1 válido → rollback SOLO del grupo, el otro se guarda', async () => {
  // Con token de ADMIN (bypass del IDOR): estudiante REAL + materia falsa
  // pasan todas las validaciones JS, y el error SQL REAL (FK violation al
  // crear la calificación) revienta la transacción de SU grupo
  const r = await api.post('/api/notas/guardar-grid', {
    token: tokenAdmin,
    body: { items: [
      item({ materiaId: 'materia-falsa-para-fk', titulo: 'Tarea FK', valor: 3 }),
      // Grupo 2: válido, debe sobrevivir al fallo del grupo 1
      item({ titulo: 'Tarea Sobreviviente', valor: 5 }),
    ] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.guardados.length, 1, 'el grupo válido se guarda')
  assert.equal(r.data.fallidos.length, 1, 'el grupo con error SQL se reporta')
  assert.match(r.data.fallidos[0].error, /Error del servidor al guardar esta calificaci\u00f3n/)
  assert.equal(r.data.guardados[0], estudiante.id + '_ACTIVIDAD_Tarea Sobreviviente')

  // El válido quedó en BD; nada del grupo fallido
  const sobreviviente = db.prepare(
    "SELECT valor FROM notas_items WHERE descripcion = 'Tarea Sobreviviente' AND calificacionId IN (SELECT id FROM calificaciones WHERE estudianteId = ? AND anio = ?)"
  ).get(estudiante.id, anio)
  assert.ok(sobreviviente, 'el item del grupo sano persistió')
  assert.equal(sobreviviente.valor, 5)
  const calFalsa = db.prepare('SELECT COUNT(*) c FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND anio = ?').get(estudiante.id, 'materia-falsa-para-fk', anio)
  assert.equal(Number(calFalsa.c), 0, 'el grupo fallido no dejó NADA a medias')
})

test('_delete sobre contenedor vacío sigue limpio (regresión del fix anterior)', async () => {
  // Crear contenedor vacío y borrar una nota inexistente → 200 sin crear nada
  const r = await api.post('/api/notas/guardar-grid', {
    token: tokenDocente,
    body: { items: [item({ titulo: 'Tarea A', valor: null, _delete: true })] },
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.guardados.length, 1, 'nada que borrar = item resuelto (no fallido)')
  assert.equal(r.data.fallidos.length, 0)
})
