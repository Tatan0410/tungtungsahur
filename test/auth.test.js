const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

// Carga .env igual que el servidor, para poder firmar tokens con el mismo secreto
require('dotenv').config()

let srv, api

before(async () => { srv = await arrancarServidor(); api = crearApi(srv.base) })
after(async () => { await srv.cerrar() })

test('login de administrador devuelve token y rol ADMIN', async () => {
  const r = await api.post('/api/auth/login', { body: ADMIN })
  assert.equal(r.status, 200)
  assert.ok(r.data.token, 'debe devolver token')
  assert.equal(r.data.usuario.rol, 'ADMIN')
  assert.equal(r.data.usuario.documento, ADMIN.documento)
})

test('login de docente devuelve token y rol DOCENTE', async () => {
  const r = await api.post('/api/auth/login', { body: DOCENTE })
  assert.equal(r.status, 200)
  assert.equal(r.data.usuario.rol, 'DOCENTE')
  assert.ok(r.data.usuario.docenteId, 'payload debe incluir docenteId')
})

test('contraseña incorrecta → 401', async () => {
  const r = await api.post('/api/auth/login', { body: { documento: ADMIN.documento, password: 'clave-mala' } })
  assert.equal(r.status, 401)
  assert.match(r.data.error, /incorrectos/)
})

test('faltan campos → 400', async () => {
  const r = await api.post('/api/auth/login', { body: { documento: ADMIN.documento } })
  assert.equal(r.status, 400)
})

test('token firmado con otro secreto → 401', async () => {
  const falso = jwt.sign(
    { id: 'x', rol: 'ADMIN', documento: ADMIN.documento },
    'secreto-falso-para-la-prueba',
    { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' }
  )
  const r = await api.get('/api/admin/cursos', { token: falso })
  assert.equal(r.status, 401)
})

test('token con issuer/audience ajenos → 401 (no basta con el secreto)', async () => {
  const malIssuer = jwt.sign(
    { id: 'x', rol: 'ADMIN', documento: ADMIN.documento },
    process.env.JWT_SECRET,
    { issuer: 'otro-emisor', audience: 'otra-app' }
  )
  const r = await api.get('/api/admin/cursos', { token: malIssuer })
  assert.equal(r.status, 401)
})

test('sin token → 401', async () => {
  const r = await api.get('/api/admin/cursos')
  assert.equal(r.status, 401)
})

test('los logins exitosos NO consumen el cupo por IP (35 seguidos)', async () => {
  for (let i = 0; i < 35; i++) {
    const r = await api.post('/api/auth/login', { body: ADMIN })
    assert.equal(r.status, 200, `intento exitoso #${i + 1} no debe ser rechazado`)
  }
})

test('5 contraseñas malas bloquean el documento 15 min (6º → 429)', async () => {
  const objetivo = '30010002' // docente distinto al que usa el resto de tests
  for (let i = 1; i <= 5; i++) {
    const r = await api.post('/api/auth/login', { body: { documento: objetivo, password: 'mala' + i } })
    assert.equal(r.status, 401, `intento ${i} debe ser 401`)
  }
  const r = await api.post('/api/auth/login', { body: { documento: objetivo, password: 'mala6' } })
  assert.equal(r.status, 429)
  assert.match(r.data.error, /Demasiados intentos/)
})

test('intentos fallidos desde una IP se cortan (429 con mención de IP)', async () => {
  let gatillado = false
  // Documentos inexistentes y distintos: solo cuenta el límite por IP
  for (let i = 1; i <= 70 && !gatillado; i++) {
    const r = await api.post('/api/auth/login', {
      body: { documento: '7999' + String(10000 + i), password: 'inventada' },
    })
    if (r.status === 429) {
      assert.match(r.data.error, /IP/)
      gatillado = true
    } else {
      assert.equal(r.status, 401)
    }
  }
  assert.ok(gatillado, 'los fallos por IP deben producir 429')
})
