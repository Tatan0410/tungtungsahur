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
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE AJENO TEST', '88000601', 1)").run(usuAjeno, bcrypt.hashSync('Ajeno123', 10))
  docAjenoId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docAjenoId, usuAjeno)
  tokDocAjeno = await login(api, '88000601', 'Ajeno123')
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
  try { db.prepare("DELETE FROM usuarios WHERE documento = '88000601'").run() } catch (e) {}
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

// ── H4 batch mixto: items de P4 (abierto) + P1 (cerrado) en guardar-grid ──

test('H4 batch mixto: guardar-grid con items P4 (abierto) + P1 (cerrado) → P4 guardados, P1 fallidos con PERIODO_CERRADO', async () => {
  const mat = db.prepare('SELECT id FROM materias LIMIT 1').get()
  const r = await api.post('/api/notas/guardar-grid', {
    token: tokenAdmin,
    body: { items: [
      // P4 (cerrado en el fixture) → falla
      { estudianteId: estPrueba.id, materiaId: mat.id, periodo: 4, anio, tipo: 'ACTIVIDAD', titulo: 'Stale P4', valor: 2.0 },
      // P1 (abierto en el fixture) → pasa
      { estudianteId: estPrueba.id, materiaId: mat.id, periodo: 1, anio, tipo: 'ACTIVIDAD', titulo: 'Nuevo P1 ' + Date.now(), valor: 4.0 },
    ] },
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.guardados.length, 1, 'el item del período ABIERTO se guarda')
  assert.equal(r.data.fallidos.length, 1, 'el item del período CERRADO falla')

  const f = r.data.fallidos[0]
  assert.equal(f.codigo, 'PERIODO_CERRADO', 'el fallido trae el código estructurado')
  assert.equal(f.periodo, 4, 'el fallido nombra el período REAL del item (4)')
  assert.match(f.error, /período 4/)

  // El item del período abierto SÍ se guardó
  const guardado = db.prepare("SELECT COUNT(*) c FROM notas_items WHERE calificacionid = ? AND valor = 4.0").get(calAbierta)
  assert.equal(Number(guardado.c), 1, 'el item del período abierto está en la BD')

  // El item del período cerrado NO está en la BD (usar la descripción única del batch mixto)
  const noGuardado = db.prepare("SELECT COUNT(*) c FROM notas_items WHERE calificacionid = ? AND descripcion = ?").get(calCerrada, 'Stale P4')
  assert.equal(Number(noGuardado.c), 0, 'el item del período cerrado NO está en la BD')

  // Limpiar el item guardado
  const limpiar = db.prepare("DELETE FROM notas_items WHERE calificacionid = ? AND valor = 4.0 AND descripcion LIKE 'Nuevo P1%'").run(calAbierta)
  // Limpiar cualquier definitiva calculada
  if (limpiar.changes > 0) {
    db.prepare('UPDATE calificaciones SET definitiva = NULL WHERE id = ?').run(calAbierta)
  }
})

// ── Fase 2: validación estricta de la nota en guardar-grid ──
// Antes el batch usaba parseFloat: "3<img>" y "3,5" pasaban y se
// guardaban SILENCIOSAMENTE como 3. Ahora rige normalizarYValidarNota
// en TODA la tanda (como /items y /bulk-update) y se persiste el
// número ya normalizado, nunca el texto crudo.

test('Fase 2 grid: "3<img>" → 400 sin guardar; "3,5" → 200 como 3.5; 5.1 → 400', async () => {
  // Estudiante ficticio (curso 9999) en un año aislado: cero contacto con datos reales
  const anioAislado = anio + 50
  const usuId = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', 'EST GRID FASE2', '88000456', 1)").run(usuId, bcrypt.hashSync('Fase2Grid456', 10))
  const estId = crypto.randomUUID()
  db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(estId, usuId, '88000456', '88000456', 'PPAL - TRIUNFO', 'MAÑANA', 9, '9999')
  const matId = db.prepare('SELECT id FROM materias LIMIT 1').get().id
  // Contenedor pre-creado (patrón del before de este archivo): el ADMIN no
  // tiene docenteId y calificaciones.docenteId es NOT NULL, así que el
  // admin solo puede ACTUALIZAR calificaciones existentes, no crearlas
  const calId = crypto.randomUUID()
  db.prepare('INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP)')
    .run(calId, estId, matId, db.prepare('SELECT id FROM docentes LIMIT 1').get().id, anioAislado)
  const item = valor => ({ estudianteId: estId, materiaId: matId, periodo: 1, anio: anioAislado, tipo: 'ACTIVIDAD', titulo: 'Fase2 Grid', valor })

  try {
    // "3<img>": número con HTML pegado → 400, la tanda entera se rechaza
    const rXss = await api.post('/api/notas/guardar-grid', { token: tokenAdmin, body: { items: [item('3<img>')] } })
    assert.equal(rXss.status, 400, 'el valor con HTML se rechaza')

    // "3,5": coma decimal → 200 y guardado como 3.5 (antes: parseFloat → 3)
    const rComa = await api.post('/api/notas/guardar-grid', { token: tokenAdmin, body: { items: [item('3,5')] } })
    assert.equal(rComa.status, 200)
    assert.equal(rComa.data.guardados.length, 1)
    const fila = db.prepare("SELECT valor FROM notas_items WHERE descripcion = 'Fase2 Grid'").get()
    assert.ok(fila, 'la nota con coma decimal se guardó')
    assert.equal(fila.valor, 3.5, 'se persiste el número normalizado (3.5), no el texto ni 3')

    // 5.1: fuera de rango → 400
    const rRango = await api.post('/api/notas/guardar-grid', { token: tokenAdmin, body: { items: [item(5.1)] } })
    assert.equal(rRango.status, 400)

    // Los rechazados no dejaron rastro: solo existe la nota 3.5
    const total = db.prepare("SELECT COUNT(*) c FROM notas_items WHERE descripcion = 'Fase2 Grid'").get()
    assert.equal(Number(total.c), 1, '"3<img>" y 5.1 no llegaron a la BD')
  } finally {
    db.prepare("DELETE FROM notas_items WHERE descripcion = 'Fase2 Grid'").run()
    db.prepare('DELETE FROM calificaciones WHERE estudianteid = ?').run(estId)
    db.prepare('DELETE FROM estudiantes WHERE id = ?').run(estId)
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuId)
  }
})

// ═══════════════════════════════════════════════════════════════
// SEGURIDAD Fase 2: CORS fail-closed, HSTS, M12 y M13
// ═══════════════════════════════════════════════════════════════

// El servidor de test arranca con ALLOWED_ORIGINS='http://localhost:3000'
test('CORS fail-closed: un Origin ajeno NO recibe Access-Control-Allow-Origin', async () => {
  const r = await fetch(srv.base + '/api/ping', {
    headers: { Origin: 'https://evil.example.com' },
  })
  assert.equal(r.status, 200, 'la petición llega (CORS no bloquea el servidor)')
  assert.ok(!r.headers.get('access-control-allow-origin'),
    'un origen NO autorizado NO debe recibir el header CORS (fail-closed)')
})

test('CORS fail-closed: el preflight de un Origin ajeno no se autoriza', async () => {
  const r = await fetch(srv.base + '/api/ping', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example.com',
      'Access-Control-Request-Method': 'GET',
    },
  })
  assert.ok(!r.headers.get('access-control-allow-origin'),
    'el preflight de un origen ajeno NO recibe autorización')
})

test('HSTS: todas las respuestas llevan Strict-Transport-Security sin includeSubDomains', async () => {
  const r = await fetch(srv.base + '/api/ping')
  const hsts = r.headers.get('strict-transport-security')
  assert.ok(hsts, 'debe llevar el header HSTS')
  assert.match(hsts, /max-age=31536000/, 'max-age de 1 año')
  assert.ok(!/includeSubDomains/i.test(hsts), 'sin includeSubDomains (decisión del colegio)')
})

test('M12: nivelDeDesempeno existe UNA sola vez y devuelve MAYÚSCULAS', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'notas.js'), 'utf8')
  const definiciones = [...src.matchAll(/function nivelDeDesempeno\(/g)]
  assert.equal(definiciones.length, 1, 'debe haber EXACTAMENTE una definición (la de MAYÚSCULAS, que es la vigente por hoisting)')
  const cuerpo = src.slice(definiciones[0].index)
  assert.match(cuerpo.slice(0, 300), /'BAJO'/, 'la definición vigente es la de MAYÚSCULAS')
})

test('M13: /reporte-corte devuelve fechaCorte real (awaits en las queries)', async () => {
  // Director de grupo del curso 1104 con un docente nuevo
  const usuDir = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DIRECTOR TEST', '88000602', 1)").run(usuDir, bcrypt.hashSync('Director123', 10))
  const dirId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(dirId, usuDir)
  try {
    db.prepare('DELETE FROM directores_grupo WHERE curso = ?').run('1104')
    db.prepare('INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), dirId, '1104')

    // sede real del curso + fecha de corte del período 1
    const sede = db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get('1104').sede
    const fechaFutura = new Date(Date.now() + 7 * 86400000).toISOString()
    db.prepare('UPDATE periodos_config SET fecha_corte = ? WHERE sede = ? AND periodo = 1 AND anio = ?').run(fechaFutura, sede, anio)

    const tokDir = await login(api, '88000602', 'Director123')
    const r = await api.get(`/api/notas/reporte-corte?curso=1104&periodo=1&anio=${anio}`, { token: tokDir })
    assert.equal(r.status, 200, `esperado 200, dio ${r.status}: ${JSON.stringify(r.data)}`)
    assert.ok(r.data.fechaCorte, 'fechaCorte debe llegar poblada (antes los awaits faltantes la dejaban en null)')
    assert.equal(r.data.yaPaso, false, 'con fecha futura yaPaso=false')
  } finally {
    // Orden inverso a las FKs (RESTRICT): hijo → padre
    db.prepare('DELETE FROM directores_grupo WHERE docenteId = ?').run(dirId)
    db.prepare('DELETE FROM docentes WHERE id = ?').run(dirId)
    db.prepare("DELETE FROM usuarios WHERE documento = '88000602'").run()
  }
})
