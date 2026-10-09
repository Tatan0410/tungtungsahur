// ─────────────────────────────────────────────────────────────────
// BOLETÍN DEL PERÍODO: publicación por el admin (REGLA DE ORO: el
// servidor nunca envía el boletín sin publicación), fuga de períodos
// (P°1..P°N, nunca futuros), promedio/puesto solo del período
// consultado, área con promedio ponderado I.H.S., y firma del rector.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, anio
let tok1104, tok1104b, tokOtroCurso, est1104, est1104b, estOtro

// Payload mínimo de PNG válido (1x1 px) para probar la subida de la firma
const PNG_MINIMO = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005050204cd0a2ee8600000000049454e44ae426082',
  'hex'
)

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  anio = new Date().getFullYear()

  // ── Fixture: estudiante de 1104, otro de 1104 y uno de OTRO curso ──
  const ests = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso = '1104' LIMIT 2").all()
  const otro = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso != '1104' LIMIT 1").all()
  assert.ok(ests.length === 2 && otro.length === 1, 'faltan estudiantes en dev.db')
  est1104 = ests[0]
  est1104b = ests[1]
  estOtro = otro[0]

  const docs = [est1104, est1104b, estOtro].map(e =>
    db.prepare('SELECT documento FROM usuarios WHERE id = ?').get(e.usuarioId).documento
  )
  for (const e of [est1104, est1104b, estOtro]) {
    db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Boletin123', 10), e.usuarioId)
  }
  tok1104 = await login(api, docs[0], 'Boletin123')
  tok1104b = await login(api, docs[1], 'Boletin123')
  tokOtroCurso = await login(api, docs[2], 'Boletin123')

  // Limpieza de calificaciones previas de los fixture
  const ids = [est1104.id, est1104b.id, estOtro.id]
  db.prepare(`DELETE FROM calificaciones WHERE estudianteId IN (${ids.map(() => '?').join(',')})`).run(...ids)

  // Áreas y materias del curso 1104 (y del otro curso para el caso negativo)
  const idAreaA = crypto.randomUUID(), idAreaB = crypto.randomUUID()
  db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(idAreaA, 'Área Test A')
  db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(idAreaB, 'Área Test B')
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), idAreaA, '1104')
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), idAreaB, '1104')

  const mats = db.prepare('SELECT id FROM materias LIMIT 2').all()
  const docenteFixture = db.prepare('SELECT id FROM docentes LIMIT 1').get()
  // I.H.S. 4 y 1 → promedio del área = (notaA×4 + notaB×1) / 5
  db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 4)').run(crypto.randomUUID(), idAreaA, mats[0].id)
  db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 1)').run(crypto.randomUUID(), idAreaB, mats[1].id)

  // Notas conocidas: est1104 con P1, P2 y P3; est1104b solo P1
  //   est1104 P1: A=4.0 B=3.0 → prom 3.5, área A=4.0 (ALTO)
  //   est1104 P2: A=2.0 B=4.0 → prom 3.0 (¡DISTINTO del acumulado: prueba
  //                              que el promedio es SOLO del período!)
  //   est1104b P1: A=3.0 B=3.0 → prom 3.0
  const insertar = (est, materiaId, periodo, def) => db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), est.id, materiaId, docenteFixture.id, periodo, anio, def)
  insertar(est1104, mats[0].id, 1, 4.0)
  insertar(est1104, mats[1].id, 1, 3.0)
  insertar(est1104, mats[0].id, 2, 2.0)
  insertar(est1104, mats[1].id, 2, 4.0)
  insertar(est1104, mats[0].id, 3, 3.0)
  insertar(est1104, mats[1].id, 3, 3.5)
  insertar(est1104b, mats[0].id, 1, 3.0)
  insertar(est1104b, mats[1].id, 1, 3.0)

  // Publicar P1 y P2 para 1104 (curso específico) — el fixture DEJA P3 sin
  // publicar y P1 publicado para probar el flujo completo
  await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: 1, curso: '1104' } })
  await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: 2, curso: '1104' } })
})

after(async () => { db.close(); await srv.cerrar() })

test('REGLA DE ORO: sin publicación no hay boletín — P3 (no publicado) da 403', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=3&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /a\u00fan no ha sido publicado/)
})

test('REGLA DE ORO: publicación de OTRO curso no habilita el mío', async () => {
  // P1 y P2 están publicados SOLO para 1104 → el estudiante de otro curso: 403
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tokOtroCurso })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /a\u00fan no ha sido publicado/)
})

test('fuga de períodos: boletín P1 NO contiene ni rastro de P2/P3, y el promedio es SOLO P1', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.deepEqual(r.data.periodos, [1], 'solo la columna P°1')
  for (const area of r.data.areas) {
    for (const m of area.materias) {
      assert.deepEqual(Object.keys(m.notas), ['1'], 'notas contiene SOLO la clave "1"')
      assert.equal(m.definitiva !== null, true)
    }
  }
  // Promedio general: SOLO notas del P1 → (4.0 + 3.0) / 2 = 3.5
  // (el acumulado con P2/P3 daría otro número — esto prueba el aislamiento)
  assert.equal(r.data.promedio, 3.5)
  // Puesto SOLO con P1: est1104 (3.5) vs est1104b (3.0) → 1 de 2
  assert.equal(r.data.puesto, 1)
  assert.equal(r.data.totalRankeados, 2)
})

test('fuga de períodos: boletín P2 muestra P1 y P2, pero promedio/puesto SOLO con P2', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=2&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.periodos, [1, 2], 'columnas P°1 y P°2')
  const mA = r.data.areas[0].materias[0]
  assert.equal(mA.notas['1'], 4.0, 'la columna P°1 se ve')
  assert.equal(mA.notas['2'], 2.0, 'la columna P°2 se ve')
  // Promedio SOLO P2: (2.0 + 4.0) / 2 = 3.0 — si acumulara P1 daría 3.25
  assert.equal(r.data.promedio, 3.0, 'el promedio NO mezcla períodos')
  // Puesto SOLO con P2: est1104 (3.0) es el único con notas en P2 → 1 de 1
  assert.equal(r.data.puesto, 1)
  assert.equal(r.data.totalRankeados, 1)
})

test('área con promedio ponderado I.H.S. del período consultado + nivel', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  const [areaA, areaB] = r.data.areas
  // Área A: 1 materia IHS 4, nota 4.0 → promedio 4.0 → ALTO
  assert.equal(areaA.promedio, 4.0)
  assert.equal(areaA.nivel, 'ALTO')
  // Área B: 1 materia IHS 1, nota 3.0 → promedio 3.0 → BÁSICO
  assert.equal(areaB.promedio, 3.0)
  assert.equal(areaB.nivel, 'B\u00c1SICO')
  // Niveles de materia: 4.0 = ALTO, 3.0 = BÁSICO
  assert.equal(areaA.materias[0].nivel, 'ALTO')
  assert.equal(areaB.materias[0].nivel, 'B\u00c1SICO')
})

test('puesto estilo deportivo y notaFmt sin ceros de relleno', async () => {
  // est1104b P1: A=3.0 B=3.0 → prom 3.0, debajo de est1104 (3.5) → puesto 2 de 2
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104b })
  assert.equal(r.data.puesto, 2)
  assert.equal(r.data.totalRankeados, 2)
  // 4.0 llega como 4 (sin ceros), 3.0 como 3
  const mA = r.data.areas[0].materias[0]
  assert.equal(mA.notas['1'], 3)
})

test('retirar la publicación bloquea el boletín de inmediato', async () => {
  const antes = await api.get('/api/notas/mi-boletin?periodo=2&anio=' + anio, { token: tok1104 })
  assert.equal(antes.status, 200)
  // Buscar el id de la publicación P2/1104
  const lista = await api.get('/api/admin/boletines?anio=' + anio, { token: tokenAdmin })
  const pub = lista.data.publicaciones.find(p => p.periodo === 2 && p.curso === '1104')
  assert.ok(pub, 'la publicación P2/1104 existe en el listado')
  const del = await api.delete('/api/admin/boletines/' + pub.id, { token: tokenAdmin })
  assert.equal(del.status, 200)
  const despues = await api.get('/api/notas/mi-boletin?periodo=2&anio=' + anio, { token: tok1104 })
  assert.equal(despues.status, 403, 'retirado = bloqueado al instante')
})

test('permisos: solo el admin publica/retira; estudiante y docente no', async () => {
  const comoEst = await api.post('/api/admin/boletines', { token: tok1104, body: { periodo: 3 } })
  assert.equal(comoEst.status, 403)
  const comoDoc = await api.post('/api/admin/boletines', { token: tokenDocente, body: { periodo: 3 } })
  assert.equal(comoDoc.status, 403)
  const anioMal = await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: 7 } })
  assert.equal(anioMal.status, 400)
})

test('bootstrap expone boletinesDisponibles y el endpoint mínimo para el fallback', async () => {
  const boot = await api.get('/api/notas/mi-bootstrap?anio=' + anio, { token: tok1104 })
  assert.equal(boot.status, 200)
  assert.ok(Array.isArray(boot.data.boletinesDisponibles))
  assert.ok(boot.data.boletinesDisponibles.includes(1), 'P1 publicado para 1104 está en la lista')
  const mini = await api.get('/api/notas/boletines-publicados?anio=' + anio, { token: tok1104 })
  assert.equal(mini.status, 200)
  assert.deepEqual(mini.data.periodos, [1], 'P2 fue retirado: solo queda el P1')
  // Estudiante de otro curso: ninguno publicado para él
  const otroMini = await api.get('/api/notas/boletines-publicados?anio=' + anio, { token: tokOtroCurso })
  assert.deepEqual(otroMini.data.periodos, [])
})

test('firma virtual del rector: subida admin, visible en el boletín, rechazos correctos', async () => {
  // Subir la firma (PNG mínimo válido) como multipart
  const res = await fetch(srv.base + '/api/admin/rector-firma', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tokenAdmin },
    body: (() => {
      const fd = new FormData()
      fd.append('firma', new Blob([PNG_MINIMO], { type: 'image/png' }), 'firma.png')
      return fd
    })(),
  })
  assert.equal(res.status, 200, 'el admin sube la firma')
  // El boletín ahora la incluye
  const bol = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.ok(bol.data.rectorFirma && bol.data.rectorFirma.startsWith('data:image/png;base64,'), 'la firma viaja en el boletín')
  // GET del admin la lista
  const lista = await api.get('/api/admin/boletines?anio=' + anio, { token: tokenAdmin })
  assert.ok(lista.data.rectorFirma, 'el admin ve su firma actual')
  // Un estudiante NO puede subirla
  const comoEst = await fetch(srv.base + '/api/admin/rector-firma', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok1104 },
    body: (() => { const fd = new FormData(); fd.append('firma', new Blob([PNG_MINIMO], { type: 'image/png' }), 'firma.png'); return fd })(),
  })
  assert.equal(comoEst.status, 403)
  // Eliminarla → el boletín queda con rectorFirma null
  const del = await api.delete('/api/admin/rector-firma', { token: tokenAdmin })
  assert.equal(del.status, 200)
  const bol2 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(bol2.data.rectorFirma, null)
})
