const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

// Carga .env igual que el servidor, para poder firmar tokens con el mismo secreto
require('dotenv').config()

let srv, api, db

before(async () => { srv = await arrancarServidor(); api = crearApi(srv.base); db = srv.db() })
after(async () => { db.close(); await srv.cerrar() })

test('login de administrador devuelve token y rol ADMIN', async () => {
  const r = await api.post('/api/auth/login', { body: { ...ADMIN, aceptaTerminos: true } })
  assert.equal(r.status, 200)
  assert.ok(r.data.token, 'debe devolver token')
  assert.equal(r.data.usuario.rol, 'ADMIN')
  assert.equal(r.data.usuario.documento, ADMIN.documento)
})

test('login de docente devuelve token y rol DOCENTE', async () => {
  const r = await api.post('/api/auth/login', { body: { ...DOCENTE, aceptaTerminos: true } })
  assert.equal(r.status, 200)
  assert.equal(r.data.usuario.rol, 'DOCENTE')
  assert.ok(r.data.usuario.docenteId, 'payload debe incluir docenteId')
})

test('contraseña incorrecta → 401', async () => {
  const r = await api.post('/api/auth/login', { body: { documento: ADMIN.documento, password: 'clave-mala', aceptaTerminos: true } })
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

test('los logins exitosos NO consumen el cupo por IP (85 seguidos)', async () => {
  // 85 > 80 (FALLOS_IP_MAX): si los éxitos consumieran cupo, el 81º sería 429
  for (let i = 0; i < 85; i++) {
    const r = await api.post('/api/auth/login', { body: { ...ADMIN, aceptaTerminos: true } })
    assert.equal(r.status, 200, `intento exitoso #${i + 1} no debe ser rechazado`)
  }
})

test('5 contraseñas malas bloquean el documento 15 min (6º → 429)', async () => {
  const objetivo = '30010002' // docente distinto al que usa el resto de tests
  for (let i = 1; i <= 5; i++) {
    const r = await api.post('/api/auth/login', { body: { documento: objetivo, password: 'mala' + i, aceptaTerminos: true } })
    assert.equal(r.status, 401, `intento ${i} debe ser 401`)
  }
  const r = await api.post('/api/auth/login', { body: { documento: objetivo, password: 'mala6', aceptaTerminos: true } })
  assert.equal(r.status, 429)
  assert.match(r.data.error, /Demasiados intentos/)
})

// ─── Contador de intentos cuando el bloqueo de 15 min expira ───
// Cuentas ficticias 88000xxx sobre la BD temporal del test (curso 9999).
// La contraseña de la cuenta es su documento, como la de todo estudiante.
function crearCuentaFicticia(doc, nombre) {
  const usuId = crypto.randomUUID()
  const estId = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', ?, ?, 1)").run(usuId, bcrypt.hashSync(doc, 10), nombre, doc)
  db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estId, usuId, doc, doc, 'PPAL - TRIUNFO', 'MAÑANA', 9, '9999')
  return { usuId, estId }
}

function borrarCuentaFicticia(doc, cuenta) {
  db.prepare('DELETE FROM intentos_login WHERE documento = ?').run(doc)
  db.prepare('DELETE FROM estudiantes WHERE id = ?').run(cuenta.estId)
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(cuenta.usuId)
}

const intentoFallido = (doc, n) => api.post('/api/auth/login', { body: { documento: doc, password: 'mala' + n, aceptaTerminos: true } })

// El bug: expirado el bloqueo, el contador acumulado (>= 5) no se reiniciaba
// y UN solo fallo nuevo re-bloqueaba otros 15 min — el estudiante que
// escribia mal su documento quedaba atrapado en un bucle de bloqueos.
test('tras expirar el bloqueo, UN fallo NO re-bloquea: el contador vuelve a 0', async () => {
  const doc = '88000777'
  const cuenta = crearCuentaFicticia(doc, 'EST EXPIRA BLOQUEO')
  try {
    // 5 fallos → bloqueo de 15 min (el ciclo original)
    for (let i = 1; i <= 5; i++) {
      assert.equal((await intentoFallido(doc, i)).status, 401, `fallo ${i} → 401`)
    }
    assert.equal((await intentoFallido(doc, 6)).status, 429, 'el 6º intento del ciclo queda bloqueado')

    // Simular la expiración: el bloqueo queda en el pasado
    db.prepare('UPDATE intentos_login SET bloqueadoHasta = ? WHERE documento = ?').run(new Date(Date.now() - 60000).toISOString(), doc)

    // UN fallo tras la espera: cuenta como intento 1 del ciclo NUEVO
    assert.equal((await intentoFallido(doc, 7)).status, 401)
    const fila = db.prepare('SELECT intentos, bloqueadoHasta FROM intentos_login WHERE documento = ?').get(doc)
    assert.equal(fila.intentos, 1, 'el fallo tras expirar cuenta como 1, no como 6 (el contador acumulado re-bloqueaba en bucle)')
    assert.equal(fila.bloqueadoHasta, null, 'un solo fallo tras la espera NO re-bloquea')

    // El intento siguiente sigue sin bloqueo: el bucle quedó roto
    assert.equal((await intentoFallido(doc, 8)).status, 401, 'el siguiente intento tampoco está bloqueado')
  } finally {
    borrarCuentaFicticia(doc, cuenta)
  }
})

test('tras expirar el bloqueo, la contraseña correcta entra (200) y limpia el contador', async () => {
  const doc = '88000778'
  const cuenta = crearCuentaFicticia(doc, 'EST LOGIN TRAS BLOQUEO')
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await intentoFallido(doc, i)).status, 401)
    assert.equal((await intentoFallido(doc, 6)).status, 429, 'bloqueado tras 5 fallos')

    db.prepare('UPDATE intentos_login SET bloqueadoHasta = ? WHERE documento = ?').run(new Date(Date.now() - 60000).toISOString(), doc)

    const ok = await api.post('/api/auth/login', { body: { documento: doc, password: doc, aceptaTerminos: true } })
    assert.equal(ok.status, 200, 'la contraseña correcta tras la espera debe entrar')
    assert.ok(ok.data.token, 'login exitoso con token')
    assert.equal(db.prepare('SELECT * FROM intentos_login WHERE documento = ?').get(doc), undefined, 'el login exitoso borra el contador')
  } finally {
    borrarCuentaFicticia(doc, cuenta)
  }
})

test('el límite por documento sigue vigente: 5 fallos → bloqueo de ~15 min', async () => {
  const doc = '88000779'
  const cuenta = crearCuentaFicticia(doc, 'EST LIMITE DOC')
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await intentoFallido(doc, i)).status, 401)
    assert.equal((await intentoFallido(doc, 6)).status, 429, 'el 6º intento se bloquea')

    const fila = db.prepare('SELECT intentos, bloqueadoHasta FROM intentos_login WHERE documento = ?').get(doc)
    assert.ok(fila.bloqueadoHasta, 'queda bloqueado')
    const minutos = (new Date(fila.bloqueadoHasta) - Date.now()) / 60000
    assert.ok(minutos > 13 && minutos <= 15, `el bloqueo dura ~15 min (quedan ${minutos.toFixed(1)})`)
  } finally {
    borrarCuentaFicticia(doc, cuenta)
  }
})

test('intentos fallidos desde una IP se cortan (429 con mención de IP)', async () => {
  let gatillado = false
  // Documentos inexistentes y distintos: solo cuenta el límite por IP.
  // 120 > 80 (FALLOS_IP_MAX): el 429 debe aparecer dentro del recorrido.
  for (let i = 1; i <= 120 && !gatillado; i++) {
    const r = await api.post('/api/auth/login', {
      body: { documento: '7999' + String(10000 + i), password: 'inventada', aceptaTerminos: true },
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
