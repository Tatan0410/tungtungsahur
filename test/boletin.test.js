// ─────────────────────────────────────────────────────────────────
// BOLETÍN: publicación (REGLA DE ORO), fuga de períodos (solo 1..N),
// sin promedio general ni puesto (el oficial no los lleva), rector
// con nombre texto, deduplicación de materias por nombre normalizado
// con conflicto → celda vacía, e impresión masiva por curso.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, anio
let tok1104, tokOtro, est1104, estOtro

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  anio = new Date().getFullYear()

  const ests = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso = '1104' LIMIT 1").all()
  const otros = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso != '1104' LIMIT 1").all()
  est1104 = ests[0]
  estOtro = otros[0]

  const docs = [est1104, estOtro].map(e =>
    db.prepare('SELECT documento FROM usuarios WHERE id = ?').get(e.usuarioId).documento
  )
  for (const e of [est1104, estOtro]) {
    db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Boletin123', 10), e.usuarioId)
  }
  tok1104 = await login(api, docs[0], 'Boletin123')
  tokOtro = await login(api, docs[1], 'Boletin123')

  // Limpieza de calificaciones del fixture
  db.prepare('DELETE FROM calificaciones WHERE estudianteId IN (?, ?)').run(est1104.id, estOtro.id)

  // Áreas y materias
  const idAreaA = crypto.randomUUID(), idAreaB = crypto.randomUUID()
  db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(idAreaA, 'Área Test A')
  db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(idAreaB, 'Área Test B')
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), idAreaA, '1104')
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), idAreaB, '1104')

  const mats = db.prepare('SELECT id FROM materias LIMIT 2').all()
  const docenteFixture = db.prepare('SELECT id FROM docentes LIMIT 1').get()
  db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 4)').run(crypto.randomUUID(), idAreaA, mats[0].id)
  db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 1)').run(crypto.randomUUID(), idAreaB, mats[1].id)

  // Notas P1, P2, P3 para est1104
  const insertar = (est, materiaId, periodo, def) => db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), est.id, materiaId, docenteFixture.id, periodo, anio, def)
  insertar(est1104, mats[0].id, 1, 4.0)
  insertar(est1104, mats[1].id, 1, 3.0)
  insertar(est1104, mats[0].id, 2, 2.0)
  insertar(est1104, mats[1].id, 2, 4.0)
  insertar(est1104, mats[0].id, 3, 3.0)
  insertar(est1104, mats[1].id, 3, 3.5)

  // Publicar P1, P2, P3 para 1104
  await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: 1, curso: '1104' } })
  await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: 2, curso: '1104' } })
  await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: 3, curso: '1104' } })
  // Nombre del rector
  await api.put('/api/admin/rector', { token: tokenAdmin, body: { nombre: 'RECTOR TEST PILOTO' } })
})

after(async () => { db.close(); await srv.cerrar() })

test('REGLA DE ORO: sin publicación → 403; otro curso sin publicación → 403', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=3&anio=' + (anio + 1), { token: tok1104 })
  assert.equal(r.status, 403)
  const otro = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tokOtro })
  assert.equal(otro.status, 403)
  assert.match(otro.data.error, /a\u00fan no ha sido publicado/)
})

test('boletín P1: solo columna P°1, SIN promedio general NI puesto, celdas vacías sin nota', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.deepEqual(r.data.periodos, [1])
  // Sin promedio general ni puesto
  assert.equal(r.data.promedio, undefined, 'el response NO lleva promedio general')
  assert.equal(r.data.puesto, undefined, 'el response NO lleva puesto')
  assert.equal(r.data.totalRankeados, undefined)
  // Áreas con promedio ponderado I.H.S. y nivel
  const [areaA, areaB] = r.data.areas
  assert.equal(areaA.promedio, 4.0)
  assert.equal(areaA.nivel, 'ALTO')
  assert.equal(areaB.promedio, 3.0)
  assert.equal(areaB.nivel, 'B\u00c1SICO')
  // Notas SOLO del P1 (sin P2/P3 en el response)
  for (const area of r.data.areas) {
    for (const m of area.materias) {
      assert.deepEqual(Object.keys(m.notas), ['1'])
      assert.equal(m.indicadores.length, 0, 'el piloto NO trae indicadores')
    }
  }
  // rectorNombre
  assert.equal(r.data.rectorNombre, 'RECTOR TEST PILOTO')
  assert.ok(r.data.rectorFirma === null || r.data.rectorFirma === undefined, 'sin imagen de firma en el fixture')
})

test('boletín P3: columnas P1+P2+P3 pero sin datos de P4 (nunca existió)', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=3&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.periodos, [1, 2, 3])
  const mA = r.data.areas[0].materias[0]
  assert.equal(mA.notas['1'], 4)
  assert.equal(mA.notas['2'], 2)
  assert.equal(mA.notas['3'], 3)
  // Nivel del período consultado (3.0 → BÁSICO)
  assert.equal(mA.nivel, 'B\u00c1SICO')
})

test('materia sin nota en un período → celda VACÍA, sin "NS"', async () => {
  // Quitar las notas del P2 de la materia B
  db.prepare('DELETE FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = 2').run(est1104.id, db.prepare('SELECT id FROM materias LIMIT 2 OFFSET 1').get().id)
  const r = await api.get('/api/notas/mi-boletin?periodo=2&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 200)
  const mB = r.data.areas[1].materias[0]
  assert.equal(mB.notas['2'], null, 'sin nota → null (celda vacía)')
  assert.equal(mB.nivel, null, 'sin nivel para ese período')
  // La nota del P1 sigue visible
  assert.equal(mB.notas['1'], 3)
  // Ningún "NS" en el response
  const json = JSON.stringify(r.data)
  assert.ok(!json.includes('"NS"') && !json.includes("'NS'"), 'nunca NS en el boletín')
})

test('PUT /rector: solo admin; nombre correcto viaja en el boletín', async () => {
  const comoDoc = await api.put('/api/admin/rector', { token: tokenDocente, body: { nombre: 'X' } })
  assert.equal(comoDoc.status, 403)
  const cambio = await api.put('/api/admin/rector', { token: tokenAdmin, body: { nombre: 'RECTOR CAMBIADO' } })
  assert.equal(cambio.status, 200)
  const bol = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(bol.data.rectorNombre, 'RECTOR CAMBIADO')
  // Restaurar
  await api.put('/api/admin/rector', { token: tokenAdmin, body: { nombre: 'RECTOR TEST PILOTO' } })
})

test('POST /materias: nombre duplicado normalizado → 400', async () => {
  // Usar una materia que YA existe en la BD (la primera del fixture)
  const primera = db.prepare('SELECT nombre, nombre_norm FROM materias LIMIT 1').get()
  assert.ok(primera, 'hay materias en la BD')
  const r = await api.post('/api/admin/materias', { token: tokenAdmin, body: { nombre: primera.nombre } })
  assert.equal(r.status, 400, 'duplicado detectado: ' + JSON.stringify({ nombre: primera.nombre, norm: primera.nombre_norm, got: r.status, data: r.data }))
  assert.match(r.data.error, /Ya existe/)
})

test('impresión masiva: lotes de 10, datos del curso, director/rector, sin datos cruzados', async () => {
  const r = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenAdmin })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.boletines.length >= 1, 'al menos 1 estudiante')
  assert.ok(r.data.total >= r.data.boletines.length, 'total >= boletines devueltos')
  const bol = r.data.boletines[0]
  assert.equal(bol.rectorNombre, 'RECTOR TEST PILOTO')
  assert.ok(bol.estudiante.nombre, 'cada boletín lleva su estudiante')
  assert.ok(bol.areas.length >= 2, 'áreas del curso')
  // Sin promedio general ni puesto
  assert.equal(bol.promedio, undefined)
  assert.equal(bol.puesto, undefined)
  // El lote no trae más de 10 (límite)
  assert.ok(r.data.boletines.length <= 10, 'máximo 10 por lote')
})

test('impresión masiva: docente → 403 (middleware admin); admin OK', async () => {
  const comoDoc = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenDocente })
  assert.equal(comoDoc.status, 403, 'el middleware admin bloquea a docentes')
  const comoAdmin = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenAdmin })
  assert.equal(comoAdmin.status, 200)
})
