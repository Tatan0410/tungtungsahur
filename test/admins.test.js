const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')
const bcrypt = require('bcryptjs')

let srv, api, db, tokenAdmin, tokenDocente, idAdmin, tokenEstudiante, correoEstudiante

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  const admins = (await api.get('/api/admin/administradores', { token: tokenAdmin })).data
  idAdmin = admins.find(a => a.documento === ADMIN.documento).id
  // Estudiante de prueba con clave conocida
  const est = db.prepare('SELECT u.id, u.documento FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id LIMIT 1').get()
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Estudiante123', 10), est.id)
  tokenEstudiante = await login(api, est.documento, 'Estudiante123')
})

after(async () => { db.close(); await srv.cerrar() })

test('el admin crea, lista y elimina otro admin', async () => {
  const NUEVO = { documento: '80010001', nombre: 'Admin Secundario', password: 'ClaveAdmin123' }
  const creada = await api.post('/api/admin/administradores', { token: tokenAdmin, body: NUEVO })
  assert.equal(creada.status, 201)
  const idNuevo = creada.data.id

  const lista = (await api.get('/api/admin/administradores', { token: tokenAdmin })).data
  assert.ok(lista.some(a => a.id === idNuevo && a.documento === NUEVO.documento))
  // Sin correo (usuarios y contraseñas solamente)
  const nuevoEnLista = lista.find(a => a.id === idNuevo)
  assert.equal(nuevoEnLista.correo, null, 'el admin nuevo nace sin correo')

  // El nuevo admin puede iniciar sesión
  const loginNuevo = await api.post('/api/auth/login', { body: { documento: NUEVO.documento, password: NUEVO.password } })
  assert.equal(loginNuevo.status, 200)
  assert.equal(loginNuevo.data.usuario.rol, 'ADMIN')

  // El admin logueado NO puede eliminarse a sí mismo
  const auto = await api.delete('/api/admin/administradores/' + idAdmin, { token: tokenAdmin })
  assert.equal(auto.status, 409)
  assert.match(auto.data.error, /tu propio administrador/)

  // Eliminar al otro admin sí funciona
  const borrado = await api.delete('/api/admin/administradores/' + idNuevo, { token: tokenAdmin })
  assert.equal(borrado.status, 200)

  const inexistente = await api.delete('/api/admin/administradores/' + idNuevo, { token: tokenAdmin })
  assert.equal(inexistente.status, 404)
})

test('crear admin: documento duplicado 409, numérico, contraseña corta', async () => {
  const dup = await api.post('/api/admin/administradores', {
    token: tokenAdmin, body: { documento: ADMIN.documento, nombre: 'X', password: '123456' },
  })
  assert.equal(dup.status, 409)

  const noNum = await api.post('/api/admin/administradores', {
    token: tokenAdmin, body: { documento: 'abc', nombre: 'X', password: '123456' },
  })
  assert.equal(noNum.status, 400)

  const corta = await api.post('/api/admin/administradores', {
    token: tokenAdmin, body: { documento: '80010002', nombre: 'X', password: '123' },
  })
  assert.equal(corta.status, 400)
})

test('no-admin no puede crear administradores', async () => {
  const r = await api.post('/api/admin/administradores', {
    token: tokenDocente, body: { documento: '80010003', nombre: 'X', password: '123456' },
  })
  assert.equal(r.status, 403)
  const r2 = await api.post('/api/admin/administradores', {
    token: tokenEstudiante, body: { documento: '80010003', nombre: 'X', password: '123456' },
  })
  assert.equal(r2.status, 403)
})

test('flujo del código: pedir código (admin con correo), mi-datos cambia documento con código', async () => {
  // El admin de prueba tiene correo (99999999@admin.edu.co) → pedir código OK
  const r = await api.post('/api/auth/codigo', { token: tokenAdmin })
  assert.equal(r.status, 200)
  assert.match(r.data.mensaje, /Código enviado/)

  // El docente y el estudiante no pueden pedir código
  const rDoc = await api.post('/api/auth/codigo', { token: tokenDocente })
  assert.equal(rDoc.status, 403)

  // mi-datos sin código → 400
  const sinCodigo = await api.put('/api/auth/admin/mi-datos', {
    token: tokenAdmin, body: { nuevoDocumento: '99999998' },
  })
  assert.equal(sinCodigo.status, 400)

  // mi-datos con código ERRADO → 400 y cuenta como intento
  const malCodigo = await api.put('/api/auth/admin/mi-datos', {
    token: tokenAdmin, body: { codigo: '000000', nuevoDocumento: '99999998' },
  })
  assert.equal(malCodigo.status, 400)

  // mi-datos con el código REAL → cambia el documento
  const real = db.prepare(
    "SELECT codigo FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND usado = 0 ORDER BY creadoEn DESC, rowid DESC LIMIT 1"
  ).get(idAdmin)
  assert.ok(real, 'debe existir el código real')
  const ok = await api.put('/api/auth/admin/mi-datos', {
    token: tokenAdmin, body: { codigo: real.codigo, nuevoDocumento: '99999998' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.documento, '99999998')

  // El login viejo (documento anterior) ya no funciona; el nuevo sí
  const viejo = await api.post('/api/auth/login', { body: ADMIN })
  assert.equal(viejo.status, 401)
  const nuevo = await api.post('/api/auth/login', { body: { documento: '99999998', password: ADMIN.password } })
  assert.equal(nuevo.status, 200)
  assert.equal(nuevo.data.usuario.rol, 'ADMIN')

  // El código se consumió
  const consumido = db.prepare('SELECT usado FROM password_resets WHERE id = (SELECT id FROM password_resets WHERE usuarioId = ? AND codigo = ? ORDER BY creadoEn DESC LIMIT 1)').get(idAdmin, real.codigo)
  assert.equal(consumido.usado, 1)

  // Pedir código nuevo y restaurar el documento original para los demás tests
  const cod2 = await api.post('/api/auth/codigo', { token: nuevo.data.token })
  assert.equal(cod2.status, 200)
  const real2 = db.prepare(
    "SELECT codigo FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND usado = 0 ORDER BY creadoEn DESC, rowid DESC LIMIT 1"
  ).get(idAdmin)
  const ok2 = await api.put('/api/auth/admin/mi-datos', {
    token: nuevo.data.token, body: { codigo: real2.codigo, nuevoDocumento: ADMIN.documento },
  })
  assert.equal(ok2.status, 200)
  assert.equal(ok2.data.documento, ADMIN.documento)
})

test('mi-datos: solo ADMIN, contraseña corta 400, correo inválido 400', async () => {
  const rDoc = await api.put('/api/auth/admin/mi-datos', {
    token: tokenDocente, body: { codigo: '123456', nuevaPassword: 'ClaveNueva123' },
  })
  assert.equal(rDoc.status, 403)

  const passCorta = await api.put('/api/auth/admin/mi-datos', {
    token: tokenAdmin, body: { codigo: '123456', nuevaPassword: '123' },
  })
  assert.equal(passCorta.status, 400)

  const correoMalo = await api.put('/api/auth/admin/mi-datos', {
    token: tokenAdmin, body: { codigo: '123456', nuevoCorreo: 'no-es-un-correo' },
  })
  assert.equal(correoMalo.status, 400)
})
