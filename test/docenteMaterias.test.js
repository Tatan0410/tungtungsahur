const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, tokenAdmin, tokenDocente, curso, cursoAjeno

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)

  // Cursos del docente de prueba (30010001 tiene 11 asignaciones)
  const r = await api.get('/api/docente/mis-cursos', { token: tokenDocente })
  const cursos = r.data.cursos || []
  assert.ok(cursos.length >= 1, 'el docente de prueba debe tener asignaciones')
  curso = cursos[0].curso
  // Un curso donde el docente NO tiene asignaciones
  const adminCursos = (await api.get('/api/admin/cursos', { token: tokenAdmin })).data
  cursoAjeno = adminCursos.find(c => !cursos.some(x => x.curso === c)) || adminCursos[0]
})

after(async () => { await srv.cerrar() })

test('el docente crea una materia nueva en su curso', async () => {
  const nombre = 'Robótica ' + Date.now()
  const r = await api.post('/api/docente/materias', { token: tokenDocente, body: { nombre, curso } })
  assert.equal(r.status, 201)
  assert.ok(r.data.materiaId)
  assert.equal(r.data.materiaNombre, nombre)

  // Aparece en mis-cursos con el nombre correcto
  const r2 = await api.get('/api/docente/mis-cursos', { token: tokenDocente })
  const c = (r2.data.cursos || []).find(x => x.curso === curso)
  assert.ok(c, 'el curso debe seguir en mis-cursos')
  assert.ok(c.materias.some(m => m.materiaId === r.data.materiaId && m.materiaNombre === nombre), 'la materia nueva debe aparecer')
})

test('el docente reutiliza una materia existente por nombre normalizado', async () => {
  // Crea con mayúsculas/minúsculas distintas: es la misma materia
  const nombre = 'Robótica ' + Date.now()
  const r1 = await api.post('/api/docente/materias', { token: tokenDocente, body: { nombre, curso } })
  assert.equal(r1.status, 201)

  const r2 = await api.post('/api/docente/materias', {
    token: tokenDocente, body: { nombre: nombre.toLowerCase(), curso },
  })
  assert.equal(r2.status, 200, 'debe reutilizar la materia existente')
  assert.equal(r2.data.materiaId, r1.data.materiaId, 'misma materia (no duplicada)')

  // No se creó una segunda materia con ese nombre
  const r3 = await api.get('/api/docente/mis-cursos', { token: tokenDocente })
  const c = (r3.data.cursos || []).find(x => x.curso === curso)
  const veces = c.materias.filter(m => m.materiaId === r1.data.materiaId).length
  assert.equal(veces, 1, 'una sola asignación para (curso, materia)')
})

test('409 si el curso ya tiene la materia con OTRO maestro', async () => {
  const nombre = 'Química Extra ' + Date.now()
  const r1 = await api.post('/api/docente/materias', { token: tokenDocente, body: { nombre, curso } })
  assert.equal(r1.status, 201)

  // El admin reasigna la materia a otro maestro
  const profes = (await api.get('/api/admin/profesores', { token: tokenAdmin })).data
  const otro = profes.find(p => p.docenteId && p.nombre !== DOCENTE.documento)
  assert.ok(otro, 'hace falta otro maestro')
  const asigs = (await api.get('/api/admin/asignaciones?curso=' + encodeURIComponent(curso), { token: tokenAdmin })).data
  const asig = asigs.find(a => a.materia === nombre)
  assert.ok(asig, 'la asignación debe existir')
  await api.put('/api/admin/asignaciones/' + asig.id, { token: tokenAdmin, body: { docenteId: otro.docenteId } })

  // El docente intenta crear la misma materia en el mismo curso → 409
  const r2 = await api.post('/api/docente/materias', { token: tokenDocente, body: { nombre, curso } })
  assert.equal(r2.status, 409)
  assert.match(r2.data.error, /otro maestro/)
})

test('curso no permitido → 403', async () => {
  const r = await api.post('/api/docente/materias', {
    token: tokenDocente, body: { nombre: 'Materia Prohibida', curso: cursoAjeno },
  })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /asignación|director/)

  // Sin datos → 400
  const vacia = await api.post('/api/docente/materias', { token: tokenDocente, body: {} })
  assert.equal(vacia.status, 400)
})
