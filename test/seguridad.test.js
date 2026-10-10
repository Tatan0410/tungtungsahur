// ─────────────────────────────────────────────────────────────────
// SEGURIDAD Fase 1: DELETE /observaciones (rol check), GET
// /observaciones?docenteId (scoping), período cerrado en /items,
// notas inválidas, y desactivar estudiante con usuarioId correcto.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, anio
let tokEst, tokDocAjeno, estPrueba, calAbierta, calCerrada, obsAdmin, obsDocente, obsAjena
let docenteRealId, docAjenoId
let obsCreados = [] // limpiar al final
let itemsCreados = []

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  anio = new Date().getFullYear()

  // Estudiante de 1104 con contraseña conocida
  const est = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso = '1104' LIMIT 1").get()
  estPrueba = est
  const doc = db.prepare('SELECT documento FROM usuarios WHERE id = ?').get(est.usuarioId).documento
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('SegTest123', 10), est.usuarioId)
  tokEst = await login(api, doc, 'SegTest123')

  // Materia y docente del fixture
  const mat = db.prepare('SELECT id FROM materias LIMIT 1').get()
  const docente = db.prepare('SELECT id FROM docentes LIMIT 1').get()

  // Períodos: uno abierto (P1) y uno cerrado (usar el ya cerrado de periodos_config)
  // Verificar cuáles hay
  const cfg = db.prepare('SELECT periodo, abierto FROM periodos_config WHERE anio = ? ORDER BY periodo').all(anio)
  console.log('periodos_config:', JSON.stringify(cfg))
  const abierto = cfg.find(c => c.abierto === 1)
  assert.ok(abierto, 'necesitamos un período abierto')
  const pAbierto = abierto.periodo
  // Cerrar el período 4 para probar (lo restauramos en el after)
  db.prepare('UPDATE periodos_config SET abierto = 0 WHERE anio = ? AND periodo = 4').run(anio)
  const pCerrado = 4

  // Calificaciones en cada período
  const yaAbierta = db.prepare('SELECT id FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?').get(est.id, mat.id, pAbierto, anio)
  if (!yaAbierta) {
    calAbierta = crypto.randomUUID()
    db.prepare('INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)')
      .run(calAbierta, est.id, mat.id, docente.id, pAbierto, anio)
  } else {
    calAbierta = yaAbierta.id
  }

  const yaCerrada = db.prepare('SELECT id FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?').get(est.id, mat.id, pCerrado, anio)
  if (!yaCerrada) {
    calCerrada = crypto.randomUUID()
    db.prepare('INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)')
      .run(calCerrada, est.id, mat.id, docente.id, pCerrado, anio)
  } else {
    calCerrada = yaCerrada.id
  }

  // Observación del admin (docenteId null)
  obsAdmin = crypto.randomUUID()
  db.prepare("INSERT INTO observaciones (id, estudianteId, docenteId, materiaId, texto, tipo, fecha) VALUES (?, ?, NULL, ?, 'Obs del admin test', 'GENERAL', '2026-10-01')")
    .run(obsAdmin, est.id, mat.id)
  obsCreados.push(obsAdmin)

  // Docente real (el que ya existe en dev.db) y su observación
  docenteRealId = docente.id
  obsDocente = crypto.randomUUID()
  db.prepare("INSERT INTO observaciones (id, estudianteId, docenteId, materiaId, texto, tipo, fecha) VALUES (?, ?, ?, ?, 'Obs del docente real', 'GENERAL', '2026-10-01')")
    .run(obsDocente, est.id, docente.id, mat.id)
  obsCreados.push(obsDocente)

  // Docente "ajeno" (sin asignación a 1104) + su observación
  const usuAjeno = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE AJENO TEST', '97000001', 1)").run(usuAjeno, bcrypt.hashSync('Ajeno123', 10))
  docAjenoId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docAjenoId, usuAjeno)
  tokDocAjeno = await login(api, '97000001', 'Ajeno123')
  obsAjena = crypto.randomUUID()
  db.prepare("INSERT INTO observaciones (id, estudianteId, docenteId, materiaId, texto, tipo, fecha) VALUES (?, ?, ?, ?, 'Obs del ajeno', 'GENERAL', '2026-10-01')")
    .run(obsAjena, est.id, docAjenoId, mat.id)
  obsCreados.push(obsAjena)
})

after(async () => {
  // Limpiar observaciones creadas
  for (const id of obsCreados) {
    try { db.prepare('DELETE FROM observaciones WHERE id = ?').run(id) } catch (e) {}
  }
  // Limpiar calificaciones si las creamos
  try {
    for (const id of itemsCreados) { db.prepare('DELETE FROM notas_items WHERE id = ?').run(id) }
    if (calAbierta) db.prepare('DELETE FROM calificaciones WHERE id = ? AND definitiva IS NULL AND NOT EXISTS (SELECT 1 FROM notas_items WHERE calificacionid = calificaciones.id)').run(calAbierta)
    if (calCerrada) db.prepare('DELETE FROM calificaciones WHERE id = ? AND definitiva IS NULL AND NOT EXISTS (SELECT 1 FROM notas_items WHERE calificacionid = calificaciones.id)').run(calCerrada)
  } catch (e) {}
  // Restaurar el período 4 a abierto
  try { db.prepare('UPDATE periodos_config SET abierto = 1 WHERE anio = ? AND periodo = 4').run(anio) } catch (e) {}
  // Limpiar docente ajeno
  try { db.prepare("DELETE FROM usuarios WHERE documento = '97000001'").run() } catch (e) {}
  db.close()
  await srv.cerrar()
})

// ── C3: DELETE /observaciones/:id ──

test('C3: ESTUDIANTE → 403 (nunca puede borrar observaciones)', async () => {
  const r = await api.delete('/api/notas/observaciones/' + obsAdmin, { token: tokEst })
  assert.equal(r.status, 403, `esperado 403, dio ${r.status}`)
  assert.match(r.data.error, /Solo docentes/)
})

test('C3: DOCENTE AJENO no puede borrar obs del admin (docenteId null)', async () => {
  const r = await api.delete('/api/notas/observaciones/' + obsAdmin, { token: tokDocAjeno })
  assert.equal(r.status, 403, `docente ajeno vs obs admin → 403, dio ${r.status}`)
  assert.match(r.data.error, /No puedes eliminar/)
})

test('C3: DOCENTE AJENO no puede borrar obs de OTRO docente', async () => {
  const r = await api.delete('/api/notas/observaciones/' + obsDocente, { token: tokDocAjeno })
  assert.equal(r.status, 403)
})

test('C3: ADMIN puede borrar cualquier observación', async () => {
  const obsTemp = crypto.randomUUID()
  const mat = db.prepare('SELECT id FROM materias LIMIT 1').get()
  db.prepare("INSERT INTO observaciones (id, estudianteId, docenteId, materiaId, texto, tipo) VALUES (?, ?, NULL, ?, 'temp', 'GENERAL')").run(obsTemp, estPrueba.id, mat.id)
  const r = await api.delete('/api/notas/observaciones/' + obsTemp, { token: tokenAdmin })
  assert.equal(r.status, 200)
})

// ── M1: GET /observaciones?docenteId ──

test('M1: DOCENTE AJENO no puede leer obs de OTRO docente', async () => {
  const r = await api.get('/api/notas/observaciones?docenteId=' + docenteRealId, { token: tokDocAjeno })
  assert.equal(r.status, 403, `docente pide obs de otro → 403, dio ${r.status}`)
  assert.match(r.data.error, /propias/)
})

test('M1: DOCENTE AJENO no puede leer obs del ADMIN (docenteId null)', async () => {
  const r = await api.get('/api/notas/observaciones?docenteId=' + docAjenoId, { token: tokDocAjeno })
  // docAjenoId es SU id → esto SI es su propia consulta, pero la obs del admin tiene docenteId null y no sale
  assert.equal(r.status, 200, 'su propio docenteId siempre es válido')
  // Verificar que NO incluye la obs del admin (docenteId null)
  const nombres = r.data.map(o => o.texto)
  assert.ok(!nombres.includes('Obs del admin test'), 'la obs del admin (docenteId null) NO aparece en la consulta por docenteId del ajeno')
})

test('M1: DOCENTE sin parámetros solo recibe las SUYAS', async () => {
  const r = await api.get('/api/notas/observaciones', { token: tokDocAjeno })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
  for (const o of r.data) {
    assert.equal(o.docenteId, docAjenoId, `todas deben ser del ajeno, encontró docenteId=${o.docenteId}`)
  }
  // La obs del admin (docenteId null) no debe aparecer
  assert.ok(!r.data.some(o => o.texto === 'Obs del admin test'))
})

test('M1: ADMIN puede filtrar por cualquier docenteId', async () => {
  const r = await api.get('/api/notas/observaciones?docenteId=' + docenteRealId, { token: tokenAdmin })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data))
})

// ── H4: Período cerrado bloquea escritura de notas ──

test('H4: POST /items en período CERRADO → 403 (período desde BD, no del body)', async () => {
  const r = await api.post('/api/notas/items', {
    token: tokenAdmin,
    body: { calificacionId: calCerrada, tipo: 'ACTIVIDAD', valor: 3.0, descripcion: 'Test cerrado', periodo: 1, anio: anio }
  })
  assert.equal(r.status, 403, `período cerrado → 403, dio ${r.status}`)
  assert.match(r.data.error, /cerrado/)
  // El item NO se creó
  const items = db.prepare('SELECT COUNT(*) c FROM notas_items WHERE calificacionid = ?').get(calCerrada)
  assert.equal(Number(items.c), 0)
})

test('H4: PUT /items/:id en período CERRADO → 403', async () => {
  // Crear un item en el período abierto, luego moverlo a la calificación cerrada
  const obsItem = crypto.randomUUID()
  db.prepare("INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion) VALUES (?, ?, 'ACTIVIDAD', 2.0, 'H4 test')").run(obsItem, calCerrada)
  itemsCreados.push(obsItem)
  const r = await api.put('/api/notas/items/' + obsItem, { token: tokenAdmin, body: { valor: 3.0 } })
  assert.equal(r.status, 403, `PUT en cerrado → 403, dio ${r.status}`)
  assert.match(r.data.error, /cerrado/)
})

test('H4: DELETE /items/:id en período CERRADO → 403', async () => {
  const obsItem = crypto.randomUUID()
  db.prepare("INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion) VALUES (?, ?, 'ACTIVIDAD', 2.0, 'H4 del test')").run(obsItem, calCerrada)
  itemsCreados.push(obsItem)
  const r = await api.delete('/api/notas/items/' + obsItem, { token: tokenAdmin })
  assert.equal(r.status, 403, `DELETE en cerrado → 403, dio ${r.status}`)
  assert.match(r.data.error, /cerrado/)
  // El item sigue vivo
  const v = db.prepare('SELECT id FROM notas_items WHERE id = ?').get(obsItem)
  assert.ok(v, 'el item NO fue borrado')
})

test('H4: POST /bulk-update con item de período CERRADO → ignorado con error', async () => {
  const r = await api.post('/api/notas/bulk-update', {
    token: tokenAdmin,
    body: [{ calificacionId: calCerrada, tipo: 'ACTIVIDAD', valor: 4.0, periodo: 1 }]
  })
  assert.equal(r.status, 200)
  assert.ok(r.data.items.some(i => i.ignorado && i.error && i.error.includes('cerrado')), 'el item se reporta con error de período cerrado')
  // El item NO se creó
  const items = db.prepare('SELECT COUNT(*) c FROM notas_items WHERE calificacionid = ? AND valor = 4.0').get(calCerrada)
  assert.equal(Number(items.c), 0, 'ningún item con valor 4.0 en el período cerrado')
})

test('H4: POST /items en período ABIERTO sigue funcionando', async () => {
  const r = await api.post('/api/notas/items', {
    token: tokenAdmin,
    body: { calificacionId: calAbierta, tipo: 'ACTIVIDAD', valor: 3.0, descripcion: 'H4 abierto test ' + Date.now() }
  })
  assert.equal(r.status, 200, `período abierto → 200, dio ${r.status}: ${JSON.stringify(r.data)}`)
  if (r.data.item) itemsCreados.push(r.data.item.id)
})

// ── H5: Notas inválidas ──

test('H5: POST /items "3,5" → 200 con valor 3.5', async () => {
  const r = await api.post('/api/notas/items', {
    token: tokenAdmin,
    body: { calificacionId: calAbierta, tipo: 'ACTIVIDAD', valor: '3,5', descripcion: 'H5 coma ' + Date.now() }
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.item.valor, 3.5, '"3,5" se normaliza a 3.5')
  itemsCreados.push(r.data.item.id)
})

test('H5: POST /items "abc" → 400', async () => {
  const r = await api.post('/api/notas/items', { token: tokenAdmin, body: { calificacionId: calAbierta, tipo: 'ACTIVIDAD', valor: 'abc', descripcion: 'X' } })
  assert.equal(r.status, 400)
})

test('H5: POST /items "1e1" → 400', async () => {
  const r = await api.post('/api/notas/items', { token: tokenAdmin, body: { calificacionId: calAbierta, tipo: 'ACTIVIDAD', valor: '1e1', descripcion: 'X' } })
  assert.equal(r.status, 400)
})

test('H5: POST /items "5.1" → 400, "-1" → 400, "0x3" → 400, "3.5abc" → 400, "Infinity" → 400', async () => {
  for (const mal of ['5.1', '-1', '0x3', '3.5abc', 'Infinity', 'NaN', 'true']) {
    const r = await api.post('/api/notas/items', { token: tokenAdmin, body: { calificacionId: calAbierta, tipo: 'ACTIVIDAD', valor: mal, descripcion: 'X' } })
    assert.equal(r.status, 400, `valor "${mal}" → 400, dio ${r.status}`)
  }
})

// ── M10: Desactivar estudiante con el ID correcto ──

test('M10: PUT /estudiantes/:id/activo usa el usuarioId correcto', async () => {
  const r = await api.put('/api/admin/estudiantes/' + estPrueba.id + '/activo', { token: tokenAdmin, body: { activo: false } })
  assert.equal(r.status, 200)
  const u = db.prepare('SELECT activo FROM usuarios WHERE id = ?').get(estPrueba.usuarioId)
  assert.equal(u.activo, 0, 'el USUARIO quedó desactivado')
  const doc = db.prepare('SELECT documento FROM usuarios WHERE id = ?').get(estPrueba.usuarioId).documento
  const loginR = await api.post('/api/auth/login', { body: { documento: doc, password: 'SegTest123', aceptaTerminos: true } })
  assert.equal(loginR.status, 401, 'login de desactivado → 401')
  const r2 = await api.put('/api/admin/estudiantes/' + estPrueba.id + '/activo', { token: tokenAdmin, body: { activo: true } })
  assert.equal(r2.status, 200)
  const u2 = db.prepare('SELECT activo FROM usuarios WHERE id = ?').get(estPrueba.usuarioId)
  assert.equal(u2.activo, 1, 'el USUARIO quedó reactivado')
})
