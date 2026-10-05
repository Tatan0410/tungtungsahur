const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')

let srv, api, db, tokenAdmin

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
})

after(async () => { db.close(); await srv.cerrar() })

test('login sin aceptar los terminos -> 400', async () => {
  const r = await api.post('/api/auth/login', { body: { documento: ADMIN.documento, password: ADMIN.password } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /aceptar los t\u00e9rminos/)
})

test('login con aceptacion registra fecha y version (solo la primera vez)', async () => {
  const antes = db.prepare('SELECT terminos_aceptados_en, terminos_version FROM usuarios WHERE documento = ?').get(ADMIN.documento)
  assert.ok(antes, 'el admin debe existir')
  // El helper de before ya logueo con aceptaTerminos: el registro debe existir
  assert.ok(antes.terminos_aceptados_en, 'la fecha de aceptacion debe estar registrada')
  assert.equal(antes.terminos_version, 'v1.0-2026-10')
  const fechaPrimera = antes.terminos_aceptados_en

  // Re-login: la fecha NO cambia (solo se escribe cuando la version difiere)
  await login(api, ADMIN.documento, ADMIN.password)
  const despues = db.prepare('SELECT terminos_aceptados_en FROM usuarios WHERE documento = ?').get(ADMIN.documento)
  assert.equal(despues.terminos_aceptados_en, fechaPrimera, 're-login con la misma version no re-escribe la fecha')

  // Un usuario que nunca acepto sigue en NULL
  const cualquiera = db.prepare('SELECT documento FROM usuarios WHERE terminos_version IS NULL LIMIT 1').get()
  assert.ok(cualquiera, 'debe haber usuarios sin aceptar (los existentes)')
})

test('auditoria-terminos: resumen por version y detalle por documento', async () => {
  const resumen = await api.get('/api/admin/auditoria-terminos', { token: tokenAdmin })
  assert.equal(resumen.status, 200)
  assert.ok(Array.isArray(resumen.data.porVersion))
  const v1 = resumen.data.porVersion.find(v => v.version === 'v1.0-2026-10')
  assert.ok(v1, 'la version v1.0-2026-10 debe tener al menos el admin')
  assert.ok(v1.cantidad >= 1)
  assert.ok(resumen.data.totalUsuarios >= 700)
  assert.equal(resumen.data.hanAceptado + resumen.data.sinAceptar, resumen.data.totalUsuarios)

  const detalle = await api.get('/api/admin/auditoria-terminos?documento=' + encodeURIComponent(ADMIN.documento), { token: tokenAdmin })
  assert.equal(detalle.status, 200)
  assert.ok(detalle.data.usuario.terminosAceptadosEn, 'el detalle trae la fecha de aceptacion')
  assert.equal(detalle.data.usuario.terminosVersion, 'v1.0-2026-10')

  const inexistente = await api.get('/api/admin/auditoria-terminos?documento=00000000', { token: tokenAdmin })
  assert.equal(inexistente.status, 404)

  // Sin token -> 401
  const sinToken = await api.get('/api/admin/auditoria-terminos')
  assert.equal(sinToken.status, 401)
})

test('las paginas legales existen y tienen el contenido clave', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const politica = fs.readFileSync(path.join(__dirname, '..', 'public', 'politica-datos.html'), 'utf8')
  assert.match(politica, /Ley Estatutaria 1581 de 2012/)
  assert.match(politica, /Derechos ARCO/)
  assert.match(politica, /Volver al login/)

  const terminos = fs.readFileSync(path.join(__dirname, '..', 'public', 'terminos.html'), 'utf8')
  assert.match(terminos, /T\u00e9rminos y Condiciones de Uso/)
  assert.match(terminos, /confidencialidad de su contrase\u00f1a/)
  assert.match(terminos, /Volver al login/)
})
