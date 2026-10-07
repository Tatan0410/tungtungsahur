const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const crypto = require('node:crypto')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, tokenEstudiante, cursoDirector, cursoAjeno, correoEstudiante
// Fixtures IDOR: estudiante + calificación + item en un curso (999) donde el
// docente de prueba NO tiene asignaciones ni dirección de grupo
let estudianteIdor, materiaIdor, calIdor, itemIdor, docId

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()

  // Crea un estudiante de prueba: se elige uno existente y se le pone clave conocida
  const est = db.prepare(
    'SELECT u.id, u.documento FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id LIMIT 1'
  ).get()
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Estudiante123', 10), est.id)
  correoEstudiante = est.documento

  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  tokenEstudiante = await login(api, est.documento, 'Estudiante123')

  // Curso que el docente dirige (si dirige alguno) y curso ajeno
  const usu = db.prepare("SELECT id FROM usuarios WHERE documento = ?").get(DOCENTE.documento)
  const doc = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(usu.id)
  const dirige = db.prepare('SELECT curso FROM directores_grupo WHERE docenteId = ?').all(doc.id)
  cursoDirector = dirige.length ? dirige[0].curso : null

  // Autosuficiente: si el docente no tiene asignaciones (podado de cursos),
  // el admin le crea una en un curso vigente
  const tieneAsignaciones = db.prepare('SELECT COUNT(*) c FROM docente_materias WHERE docenteId = ?').get(doc.id).c
  if (!tieneAsignaciones) {
    const materias = (await api.get('/api/admin/materias', { token: tokenAdmin })).data
    const cursos = db.prepare('SELECT DISTINCT curso FROM estudiantes ORDER BY curso').all().map(r => r.curso)
    await api.post('/api/admin/asignaciones', { token: tokenAdmin, body: { docenteId: doc.id, materiaId: materias[0].id, curso: cursos[0] } })
  }

  const todos = db.prepare('SELECT DISTINCT curso FROM estudiantes').all().map(r => r.curso)
  cursoAjeno = todos.find(c => !dirige.some(d => d.curso === c)) || todos[0]

  // ── Fixtures para las pruebas IDOR ──
  // El curso '999' no existe para nadie: garantiza que el par
  // (materia, '999') no esté asignado al docente de prueba
  docId = doc.id
  const uId = crypto.randomUUID()
  db.prepare(
    'INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, ?, ?, ?, 1)'
  ).run(uId, bcrypt.hashSync('Idor123', 10), 'ESTUDIANTE', 'EST IDOR PRUEBA', '88000123')
  estudianteIdor = crypto.randomUUID()
  db.prepare(
    'INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(estudianteIdor, uId, '88000123', '88000123', 'PPAL - TRIUNFO', 'MAÑANA', 9, '999')
  materiaIdor = db.prepare('SELECT id FROM materias LIMIT 1').get().id
  calIdor = crypto.randomUUID()
  db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)'
  ).run(calIdor, estudianteIdor, materiaIdor, doc.id, 1, new Date().getFullYear())
  itemIdor = crypto.randomUUID()
  db.prepare(
    'INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion) VALUES (?, ?, ?, ?, ?)'
  ).run(itemIdor, calIdor, 'ACTIVIDAD', 3.0, 'Columna IDOR test')
})

after(async () => { db.close(); await srv.cerrar() })

test('rutas admin: sin token 401, estudiante 403, docente 403, admin 200', async () => {
  assert.equal((await api.get('/api/admin/profesores')).status, 401)
  assert.equal((await api.get('/api/admin/profesores', { token: tokenEstudiante })).status, 403)
  assert.equal((await api.get('/api/admin/profesores', { token: tokenDocente })).status, 403)
  assert.equal((await api.get('/api/admin/profesores', { token: tokenAdmin })).status, 200)
})

test('POST /api/admin/profesores rechaza a no-admin', async () => {
  const r = await api.post('/api/admin/profesores', {
    token: tokenDocente,
    body: { documento: '90099977', nombre: 'X', password: '123456' },
  })
  assert.equal(r.status, 403)
})

test('observaciones-curso: sin token 401 y sin curso 400', async () => {
  assert.equal((await api.get('/api/notas/observaciones-curso?curso=301')).status, 401)
  const sinCurso = await api.get('/api/notas/observaciones-curso', { token: tokenAdmin })
  assert.equal(sinCurso.status, 400)
})

test('observaciones-curso: el docente solo ve cursos que dirige', async () => {
  if (cursoDirector) {
    const propio = await api.get('/api/notas/observaciones-curso?curso=' + encodeURIComponent(cursoDirector), { token: tokenDocente })
    assert.equal(propio.status, 200)
    assert.ok(Array.isArray(propio.data))
  }
  const ajeno = await api.get('/api/notas/observaciones-curso?curso=' + encodeURIComponent(cursoAjeno), { token: tokenDocente })
  assert.equal(ajeno.status, 403)
  assert.match(ajeno.data.error, /director/)
})

test('observaciones-curso: el admin ve cualquier curso', async () => {
  const r = await api.get('/api/notas/observaciones-curso?curso=' + encodeURIComponent(cursoAjeno), { token: tokenAdmin })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
})

test('rutas de estudiante: estudiante 200 y docente 403', async () => {
  const est = await api.get('/api/notas/mis-notas', { token: tokenEstudiante })
  assert.equal(est.status, 200)

  const doc = await api.get('/api/notas/mis-notas', { token: tokenDocente })
  assert.equal(doc.status, 403)
})

test('rutas de docente: docente/admin 200 y estudiante 403', async () => {
  assert.equal((await api.get('/api/docente/mis-cursos', { token: tokenDocente })).status, 200)
  assert.equal((await api.get('/api/docente/mis-cursos', { token: tokenEstudiante })).status, 403)
})

test('mis-cursos devuelve materiaNombre y grado como claves correctas (aliases PG)', async () => {
  // Regresión: en Postgres los alias sin comillas llegan en minúscula y el
  // desplegable de materias del docente salía en blanco
  const r = await api.get('/api/docente/mis-cursos', { token: tokenDocente })
  assert.equal(r.status, 200)
  const cursos = r.data.cursos
  assert.ok(Array.isArray(cursos) && cursos.length > 0, 'el docente de prueba debe tener asignaciones')
  for (const c of cursos) {
    assert.ok(c.curso, 'cada curso debe traer su nombre')
    for (const m of c.materias) {
      assert.equal(typeof m.materiaNombre, 'string', 'materiaNombre debe ser string')
      assert.ok(m.materiaNombre.length > 0, 'materiaNombre no debe venir vacío (alias PG en minúscula)')
      assert.equal(typeof m.materiaId, 'string', 'materiaId debe ser string')
    }
  }
})

test('normalizarFila restaura las claves camelCase que Postgres pasa a minúscula', () => {
  const { normalizarFila, normalizarFilas } = require('../src/db/cliente')
  const filaPg = {
    id: 'abc', usuarioid: 'u1', materiaid: 'm1', docenteid: 'd1',
    estudianteid: 'e1', calificacionid: 'c1', creadoen: '2026-01-01',
    actualizadoen: '2026-01-02', rutapdf: '/x.pdf', bloqueadohasta: null,
  }
  const fila = normalizarFila(filaPg)
  assert.equal(fila.usuarioId, 'u1')
  assert.equal(fila.materiaId, 'm1')
  assert.equal(fila.docenteId, 'd1')
  assert.equal(fila.estudianteId, 'e1')
  assert.equal(fila.calificacionId, 'c1')
  assert.equal(fila.creadoEn, '2026-01-01')
  assert.equal(fila.actualizadoEn, '2026-01-02')
  assert.equal(fila.rutaPdf, '/x.pdf')
  assert.equal(fila.bloqueadoHasta, null)
  assert.equal(fila.id, 'abc', 'las claves que ya están bien no se tocan')
  const lista = normalizarFilas([filaPg, { id: 'x', creadoen: 'y' }])
  assert.equal(lista[1].creadoEn, 'y')
  assert.equal(normalizarFilas(null), null)
  assert.equal(normalizarFila(undefined), undefined)
})

test('login de estudiante devuelve curso y sede', async () => {
  const r = await api.post('/api/auth/login', { body: { documento: correoEstudiante, password: 'Estudiante123', aceptaTerminos: true } })
  assert.equal(r.status, 200)
  assert.equal(r.data.usuario.rol, 'ESTUDIANTE')
  assert.ok(r.data.usuario.curso, 'payload debe incluir curso')
  assert.ok(r.data.usuario.sede, 'payload debe incluir sede')
})

// ═══════════════════════════════════════════════════════════════
// PRUEBAS IDOR: un docente SIN la asignación recibe 403 al intentar
// operar sobre una materia/curso que no es suyo. El ADMIN pasa siempre.
// Fixtures: estudiante del curso '999' + calificación + item, creados en before().
// ═══════════════════════════════════════════════════════════════

test('IDOR GET /grupo: docente 403 en curso/materia ajeno, admin 200', async () => {
  const r = await api.get('/api/notas/grupo?curso=999&materiaId=' + materiaIdor, { token: tokenDocente })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
  const a = await api.get('/api/notas/grupo?curso=999&materiaId=' + materiaIdor, { token: tokenAdmin })
  assert.equal(a.status, 200)
})

test('IDOR GET /columnas: docente 403 en curso/materia ajeno', async () => {
  const r = await api.get('/api/notas/columnas?curso=999&materiaId=' + materiaIdor + '&periodo=1', { token: tokenDocente })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
})

test('IDOR POST /columna: docente 403 y no crea la columna', async () => {
  const body = { curso: '999', materiaId: materiaIdor, tipo: 'ACTIVIDAD', titulo: 'Col IDOR' }
  const r = await api.post('/api/notas/columna', { token: tokenDocente, body })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
  const creada = db.prepare('SELECT id FROM columnas WHERE curso = ? AND materiaId = ? AND titulo = ?').get('999', materiaIdor, 'Col IDOR')
  assert.equal(creada, undefined, 'la columna no debe existir')
})

test('IDOR PUT /columna: docente 403 en curso/materia ajeno', async () => {
  const body = { curso: '999', materiaId: materiaIdor, tipo: 'ACTIVIDAD', tituloViejo: 'X', tituloNuevo: 'Y' }
  const r = await api.put('/api/notas/columna', { token: tokenDocente, body })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
})

test('IDOR DELETE /columna: docente 403 en curso/materia ajeno', async () => {
  const body = { curso: '999', materiaId: materiaIdor, tipo: 'ACTIVIDAD', titulo: 'Col IDOR' }
  const r = await api.delete('/api/notas/columna', { token: tokenDocente, body })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
})

test('IDOR POST /items: docente 403 sobre calificación ajena', async () => {
  const r = await api.post('/api/notas/items', { token: tokenDocente, body: { calificacionId: calIdor, tipo: 'ACTIVIDAD', valor: 4 } })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
})

test('IDOR PUT /items/:id: docente 403 sobre item ajeno y no lo modifica', async () => {
  const r = await api.put('/api/notas/items/' + itemIdor, { token: tokenDocente, body: { valor: 1 } })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
  const item = db.prepare('SELECT valor FROM notas_items WHERE id = ?').get(itemIdor)
  assert.equal(item.valor, 3.0, 'el valor no debe cambiar')
})

test('IDOR DELETE /items/:id: docente 403 sobre item ajeno y no lo borra', async () => {
  const r = await api.delete('/api/notas/items/' + itemIdor, { token: tokenDocente })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
  const item = db.prepare('SELECT id FROM notas_items WHERE id = ?').get(itemIdor)
  assert.ok(item, 'el item no debe borrarse')
})

test('IDOR PUT /guardar: docente 403 sobre estudiante/materia ajeno', async () => {
  const r = await api.put('/api/notas/guardar', {
    token: tokenDocente,
    body: { estudianteId: estudianteIdor, materiaId: materiaIdor, periodo: 1, anio: new Date().getFullYear() },
  })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignada/)
})

test('IDOR POST /bulk-update: docente ignora calificaciones ajenas', async () => {
  const r = await api.post('/api/notas/bulk-update', {
    token: tokenDocente,
    body: [{ calificacionId: calIdor, tipo: 'ACTIVIDAD', valor: 5 }],
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.items.length, 1)
  assert.equal(r.data.items[0].ignorado, true, 'el item debe venir marcado como ignorado')
  const item = db.prepare('SELECT valor FROM notas_items WHERE id = ?').get(itemIdor)
  assert.equal(item.valor, 3.0, 'el valor no debe cambiar')
})

test('IDOR GET /observaciones: estudiante 403 (sin rol), docente 403 ajeno, admin 200', async () => {
  const est = await api.get('/api/notas/observaciones?estudianteId=' + estudianteIdor, { token: tokenEstudiante })
  assert.equal(est.status, 403, 'un estudiante no puede leer observaciones de nadie')
  const doc = await api.get('/api/notas/observaciones?estudianteId=' + estudianteIdor, { token: tokenDocente })
  assert.equal(doc.status, 403)
  assert.match(doc.data.error, /asignada/)
  const adm = await api.get('/api/notas/observaciones?estudianteId=' + estudianteIdor, { token: tokenAdmin })
  assert.equal(adm.status, 200)
  assert.ok(Array.isArray(adm.data))
})

test('GET /observaciones: el docente puede consultar por su propio docenteId', async () => {
  const r = await api.get('/api/notas/observaciones?docenteId=' + docId, { token: tokenDocente })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
})

test('GET /observaciones: el docente director de grupo ve a los estudiantes de su curso', async () => {
  if (!cursoDirector) return // el docente de prueba no dirige ningún curso
  const est = db.prepare('SELECT id FROM estudiantes WHERE curso = ? LIMIT 1').get(cursoDirector)
  if (!est) return // curso sin estudiantes
  const r = await api.get('/api/notas/observaciones?estudianteId=' + est.id, { token: tokenDocente })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
})
