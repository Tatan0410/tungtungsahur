const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, tokenEstudiante, cursoDirector, cursoAjeno, correoEstudiante

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
  const todos = db.prepare('SELECT DISTINCT curso FROM estudiantes').all().map(r => r.curso)
  cursoAjeno = todos.find(c => !dirige.some(d => d.curso === c)) || todos[0]
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
  const r = await api.post('/api/auth/login', { body: { documento: correoEstudiante, password: 'Estudiante123' } })
  assert.equal(r.status, 200)
  assert.equal(r.data.usuario.rol, 'ESTUDIANTE')
  assert.ok(r.data.usuario.curso, 'payload debe incluir curso')
  assert.ok(r.data.usuario.sede, 'payload debe incluir sede')
})
