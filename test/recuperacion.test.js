const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, DOCENTE } = require('./helpers/api')

let srv, api, db

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
})
after(async () => { db.close(); await srv.cerrar() })

const idDocente = () => db.prepare("SELECT id FROM usuarios WHERE documento = ?").get(DOCENTE.documento).id

function ultimoCodigoReal() {
  return db.prepare(
    "SELECT codigo FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND usado = 0 ORDER BY creadoEn DESC, rowid DESC LIMIT 1"
  ).get(idDocente())
}

test('correo inexistente → 200 con mensaje genérico (no revela si existe)', async () => {
  const r = await api.post('/api/auth/recuperar', { body: { correo: 'nadie@inexistente.com' } })
  assert.equal(r.status, 200)
  assert.match(r.data.mensaje, /Si el correo existe/)
})

test('los códigos INVALID- no bloquean la recuperación (regresión del DoS)', async () => {
  db.prepare("DELETE FROM password_resets WHERE usuarioId = ?").run(idDocente())
  const insert = db.prepare(
    "INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, datetime('now','+15 minutes'), datetime('now'))"
  )
  for (let i = 0; i < 3; i++) insert.run('ip-' + i, idDocente(), 'INVALID-' + i)

  const r = await api.post('/api/auth/recuperar', { body: { correo: DOCENTE.documento + '@ejemplo.edu.co' } })
  assert.equal(r.status, 200)

  // Antes del fix, esas 3 filas llenaban el cupo de 3/hora y no se creaba código
  const reales = db.prepare(
    "SELECT COUNT(*) c FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND creadoEn > datetime('now','-1 hour')"
  ).get(idDocente()).c
  assert.equal(reales, 1, 'debe crearse un código real pese a las filas INVALID-')
  assert.match(ultimoCodigoReal().codigo, /^\d{6}$/, 'el código debe ser de 6 dígitos')
  assert.match(srv.logs(), /SMTP no configurado/, 'los tests nunca deben intentar enviar correo')
})

test('5 códigos incorrectos agotan los intentos y el 6º pide esperar (429)', async () => {
  db.prepare('DELETE FROM password_resets').run()
  const r0 = await api.post('/api/auth/recuperar', { body: { correo: DOCENTE.documento + '@ejemplo.edu.co' } })
  assert.equal(r0.status, 200)

  for (let i = 1; i <= 5; i++) {
    const r = await api.post('/api/auth/recuperar/verificar', {
      body: { correo: DOCENTE.documento + '@ejemplo.edu.co', codigo: '000000', nuevaPassword: 'NuevaClave123' },
    })
    assert.equal(r.status, 400, `intento ${i} debe ser 400`)
    assert.match(r.data.error, /Te quedan \d+ intentos/)
  }
  const r = await api.post('/api/auth/recuperar/verificar', {
    body: { correo: DOCENTE.documento + '@ejemplo.edu.co', codigo: '000000', nuevaPassword: 'NuevaClave123' },
  })
  assert.equal(r.status, 429)
  assert.match(r.data.error, /Pide un nuevo código/)
})

test('flujo feliz: código correcto restablece la contraseña', async () => {
  const correo = DOCENTE.documento + '@ejemplo.edu.co'
  const r0 = await api.post('/api/auth/recuperar', { body: { correo } })
  assert.equal(r0.status, 200)

  const { codigo } = ultimoCodigoReal()
  const ok = await api.post('/api/auth/recuperar/verificar', {
    body: { correo, codigo, nuevaPassword: 'NuevaClave123' },
  })
  assert.equal(ok.status, 200)
  assert.match(ok.data.mensaje, /restablecida/)

  const vieja = await api.post('/api/auth/login', { body: DOCENTE })
  assert.equal(vieja.status, 401, 'la contraseña anterior deja de funcionar')

  const nueva = await api.post('/api/auth/login', { body: { documento: DOCENTE.documento, password: 'NuevaClave123' } })
  assert.equal(nueva.status, 200, 'la contraseña nueva funciona')
  assert.equal(nueva.data.usuario.rol, 'DOCENTE')
})

test('validaciones de /recuperar y /verificar', async () => {
  const sinCorreo = await api.post('/api/auth/recuperar', { body: {} })
  assert.equal(sinCorreo.status, 400)

  // Un admin no puede usar la recuperación (es solo docentes) y no se filtra
  const admin = await api.post('/api/auth/recuperar', { body: { correo: 'admin@ejemplo.edu.co' } })
  assert.equal(admin.status, 200)
  assert.match(admin.data.mensaje, /Si el correo existe/)

  const sinCampos = await api.post('/api/auth/recuperar/verificar', { body: { correo: 'x@y.co' } })
  assert.equal(sinCampos.status, 400)

  const passCorta = await api.post('/api/auth/recuperar/verificar', {
    body: { correo: DOCENTE.documento + '@ejemplo.edu.co', codigo: '123456', nuevaPassword: '12345' },
  })
  assert.equal(passCorta.status, 400)
  assert.match(passCorta.data.error, /6 caracteres/)
})
