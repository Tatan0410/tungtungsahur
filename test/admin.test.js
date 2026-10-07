const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

const NUEVO = { documento: '90099901', nombre: 'Docente Temporal', password: 'ClaveSegura123' }

let srv, api, tokenAdmin, tokenDocente, idNuevo, curso, materiaId

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  const materias = (await api.get('/api/admin/materias', { token: tokenAdmin })).data
  materiaId = materias[0].id

  // Autosuficiente: si no hay asignaciones (podado de cursos), crea una del
  // docente de prueba en un curso vigente
  let todas = (await api.get('/api/admin/asignaciones', { token: tokenAdmin })).data
  if (!todas.length) {
    const profes = (await api.get('/api/admin/profesores', { token: tokenAdmin })).data
    const d = profes.find(p => p.nombre === DOCENTE.documento) || profes.find(p => p.docenteId)
    assert.ok(d && d.docenteId, 'hace falta un docente para la asignación de prueba')
    const cursos = (await api.get('/api/admin/cursos', { token: tokenAdmin })).data
    assert.ok(cursos.length >= 1, 'hace falta un curso vigente')
    await api.post('/api/admin/asignaciones', { token: tokenAdmin, body: { docenteId: d.docenteId, materiaId, curso: cursos[0] } })
    todas = (await api.get('/api/admin/asignaciones', { token: tokenAdmin })).data
  }
  assert.ok(todas.length >= 1, 'la BD debe traer asignaciones de ejemplo')
  curso = todas[0].curso
})
after(async () => { await srv.cerrar() })

test('GET /api/admin/cursos devuelve los 24 vigentes (con o sin estudiantes)', async () => {
  const r = await api.get('/api/admin/cursos', { token: tokenAdmin })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
  assert.ok(r.data.length >= 24, `esperaba ≥24 cursos (601-1104), llegaron ${r.data.length}`)
  assert.ok(r.data.every(c => typeof c === 'string'))
  // Los cursos vacíos también deben aparecer
  for (const vacio of ['604', '704', '804', '803']) {
    assert.ok(r.data.includes(vacio), `el curso vacío ${vacio} debe aparecer`)
  }
})

test('la búsqueda por nombre ignora tildes y ñ (ambas direcciones)', async () => {
  // Estudiante real de la BD con Ñ en el apellido (la matrícula trae 58)
  const r = await api.get('/api/admin/estudiantes?limite=100', { token: tokenAdmin })
  assert.equal(r.status, 200)
  const conEnie = r.data.estudiantes.find(e => /[\u00d1\u00f1\u00c1\u00e1\u00c9\u00e9\u00cd\u00ed\u00d3\u00f3\u00da\u00fa]/.test(e.nombre))
  assert.ok(conEnie, 'la BD de prueba debe traer al menos un nombre con ñ o tilde')

  // La palabra del nombre que tiene la tilde/ñ (puede ser el apellido:
  // la matrícula trae p. ej. "ABEL ANDRES CARREÑO BALLESTEROS")
  const palabras = conEnie.nombre.split(' ')
  const conAcento = palabras.find(p => /[\u00d1\u00f1\u00c1\u00e1\u00c9\u00e9\u00cd\u00ed\u00d3\u00f3\u00da\u00fa]/.test(p))
  assert.ok(conAcento, 'la palabra encontrada debe contener el carácter acentuado')

  // Término SIN acento encuentra al nombre CON acento
  const plegado = plegarEnPrueba(conAcento)
  const sinTilde = await api.get('/api/admin/estudiantes?nombre=' + encodeURIComponent(plegado), { token: tokenAdmin })
  assert.equal(sinTilde.status, 200)
  assert.ok(sinTilde.data.estudiantes.some(e => e.id === conEnie.id),
    `"${plegado}" (sin tilde) debe encontrar a "${conEnie.nombre}"`)

  // Y el término CON acento original también lo encuentra
  const conTilde = await api.get('/api/admin/estudiantes?nombre=' + encodeURIComponent(conAcento), { token: tokenAdmin })
  assert.equal(conTilde.status, 200)
  assert.ok(conTilde.data.estudiantes.some(e => e.id === conEnie.id),
    `"${conAcento}" (original) también debe encontrarlo`)
})

// Plega un término igual que lo hace el backend (para armar la búsqueda sin tildes)
function plegarEnPrueba(s) {
  return String(s).toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00f1/g, 'n').replace(/\u00d1/g, 'n')
}

test('GET /api/admin/asignaciones filtra por curso y expone profesor/materia', async () => {
  const r = await api.get('/api/admin/asignaciones?curso=' + encodeURIComponent(curso), { token: tokenAdmin })
  assert.equal(r.status, 200)
  assert.ok(r.data.length >= 1)
  for (const a of r.data) {
    assert.equal(a.curso, curso)
    assert.ok(a.profesor, 'cada asignación debe traer el profesor')
    assert.ok(a.materia, 'cada asignación debe traer la materia')
    assert.ok(a.id)
  }
})

test('crear profesor valida contraseña corta (400) y documento duplicado (409)', async () => {
  const corta = await api.post('/api/admin/profesores', {
    token: tokenAdmin, body: { documento: NUEVO.documento, nombre: NUEVO.nombre, password: '123' },
  })
  assert.equal(corta.status, 400)
  assert.match(corta.data.error, /6 caracteres/)

  const ok = await api.post('/api/admin/profesores', {
    token: tokenAdmin, body: { documento: NUEVO.documento, nombre: NUEVO.nombre, password: NUEVO.password },
  })
  assert.equal(ok.status, 201)
  idNuevo = ok.data.id

  const dup = await api.post('/api/admin/profesores', {
    token: tokenAdmin, body: { documento: NUEVO.documento, nombre: 'Otro', password: NUEVO.password },
  })
  assert.equal(dup.status, 409)
})

test('el profesor recién creado puede iniciar sesión', async () => {
  const r = await api.post('/api/auth/login', { body: { documento: NUEVO.documento, password: NUEVO.password, aceptaTerminos: true } })
  assert.equal(r.status, 200)
  assert.equal(r.data.usuario.rol, 'DOCENTE')
  assert.ok(r.data.usuario.docenteId)
})

test('cambiar contraseña del profesor: corta 400, válida 200 y sirve para entrar', async () => {
  const corta = await api.put(`/api/admin/profesores/${idNuevo}/password`, {
    token: tokenAdmin, body: { password: '12345' },
  })
  assert.equal(corta.status, 400)

  const ok = await api.put(`/api/admin/profesores/${idNuevo}/password`, {
    token: tokenAdmin, body: { password: 'OtraClave456' },
  })
  assert.equal(ok.status, 200)

  const vieja = await api.post('/api/auth/login', { body: { documento: NUEVO.documento, password: NUEVO.password, aceptaTerminos: true } })
  assert.equal(vieja.status, 401)
  const nueva = await api.post('/api/auth/login', { body: { documento: NUEVO.documento, password: 'OtraClave456', aceptaTerminos: true } })
  assert.equal(nueva.status, 200)
})

test('CRUD de asignaciones: crear, duplicado 409, listar, eliminar', async () => {
  const creada = await api.post('/api/admin/asignaciones', {
    token: tokenAdmin, body: { docenteDocumento: NUEVO.documento, materiaId, curso },
  })
  assert.equal(creada.status, 201)
  const idAsig = creada.data.id

  const dup = await api.post('/api/admin/asignaciones', {
    token: tokenAdmin, body: { docenteDocumento: NUEVO.documento, materiaId, curso },
  })
  assert.equal(dup.status, 409)

  const lista = await api.get('/api/admin/asignaciones?curso=' + encodeURIComponent(curso), { token: tokenAdmin })
  const creadaEnLista = lista.data.find(a => a.id === idAsig)
  assert.ok(creadaEnLista, 'la asignación creada debe aparecer en el listado')
  assert.equal(creadaEnLista.profesor, NUEVO.nombre)

  const borrada = await api.delete('/api/admin/asignaciones/' + idAsig, { token: tokenAdmin })
  assert.equal(borrada.status, 200)

  const trasBorrar = await api.get('/api/admin/asignaciones?curso=' + encodeURIComponent(curso), { token: tokenAdmin })
  assert.ok(!trasBorrar.data.some(a => a.id === idAsig), 'ya no debe aparecer')
})

test('crear asignación sin datos → 400 y con profesor inexistente → 404', async () => {
  const vacia = await api.post('/api/admin/asignaciones', { token: tokenAdmin, body: {} })
  assert.equal(vacia.status, 400)

  const noExiste = await api.post('/api/admin/asignaciones', {
    token: tokenAdmin, body: { docenteDocumento: '00000000', materiaId, curso },
  })
  assert.equal(noExiste.status, 404)
})

test('eliminar profesor → desaparece del listado', async () => {
  const listaAntes = (await api.get('/api/admin/profesores', { token: tokenAdmin })).data
  assert.ok(listaAntes.some(p => p.id === idNuevo))

  const del = await api.delete('/api/admin/profesores/' + idNuevo, { token: tokenAdmin })
  assert.equal(del.status, 200)

  const listaDespues = (await api.get('/api/admin/profesores', { token: tokenAdmin })).data
  assert.ok(!listaDespues.some(p => p.id === idNuevo))
})
