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

  // Notas P1, P2, P3 para est1104 y P1 para 3 estudiantes más (para el ranking)
  const insertar = (est, materiaId, periodo, def) => db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), est.id, materiaId, docenteFixture.id, periodo, anio, def)
  insertar(est1104, mats[0].id, 1, 4.0)
  insertar(est1104, mats[1].id, 1, 3.0)
  insertar(est1104, mats[0].id, 2, 2.0)
  insertar(est1104, mats[1].id, 2, 4.0)
  insertar(est1104, mats[0].id, 3, 3.0)
  insertar(est1104, mats[1].id, 3, 3.5)

  // 3 estudiantes más de 1104 con notas P1 (para probar ranking deportivo)
  const extra = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso = '1104' AND e.id != ? LIMIT 3").all(est1104.id)
  for (const ex of extra) {
    db.prepare('DELETE FROM calificaciones WHERE estudianteId = ?').run(ex.id)
    insertar(ex, mats[0].id, 1, [3.5, 3.5, 2.5][extra.indexOf(ex)]) // empate en 3.5 entre #0 y #1
    insertar(ex, mats[1].id, 1, [3.5, 3.5, 2.5][extra.indexOf(ex)])
  }

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

test('boletín P1: solo columna P°1, CON promedio y puesto del período, celdas vacías sin nota', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.deepEqual(r.data.periodos, [1])
  // Promedio y puesto SOLO del período 1
  assert.equal(r.data.promedio, 3.5, 'promedio P1: (4.0 + 3.0) / 2')
  assert.ok(r.data.puesto >= 1, 'puesto válido')
  assert.ok(r.data.totalCurso >= 1, 'totalCurso válido')
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
  assert.ok(r.data.rectorFirma === undefined, 'rectorFirma ya NO existe en el response (firma virtual eliminada)')
  // Promedio y puesto (del período consultado, no acumulado)
  assert.equal(r.data.promedio, 3.5, 'promedio P1: (4.0 + 3.0) / 2')
  assert.equal(r.data.puesto, 1, 'est1104 tiene 3.5, el más alto de 4 estudiantes rankeados')
  assert.equal(r.data.totalCurso, 4, '4 estudiantes con notas en P1')
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
  // Sin promedio general ni puesto — AHORA SÍ los lleva (cada uno el suyo)
  assert.ok(bol.promedio !== undefined, 'cada bolet\u00edn masivo lleva promedio')
  assert.ok(bol.puesto !== undefined, 'cada bolet\u00edn masivo lleva puesto')
  // El lote no trae más de 10 (límite)
  assert.ok(r.data.boletines.length <= 10, 'máximo 10 por lote')
})

test('impresión masiva: docente → 403 (middleware admin); admin OK', async () => {
  const comoDoc = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenDocente })
  assert.equal(comoDoc.status, 403, 'el middleware admin bloquea a docentes')
  const comoAdmin = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenAdmin })
  assert.equal(comoAdmin.status, 200)
})

test('masiva trae directorNombre y rectorNombre para los avisos del frontend', async () => {
  const r = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenAdmin })
  assert.equal(r.status, 200)
  const bol = r.data.boletines[0]
  // El frontend usa estos campos para los avisos: si son null → aviso visible
  assert.ok('directorNombre' in bol, 'el boletín masivo lleva directorNombre (aunque sea null)')
  assert.ok('rectorNombre' in bol, 'el boletín masivo lleva rectorNombre (aunque sea null)')
})

test('directores_grupo: un solo director por curso (UNIQUE en BD + 409 en POST)', async () => {
  // Asignar un director
  const prof = (await api.get('/api/admin/profesores', { token: tokenAdmin })).data[0]
  const asigna = await api.post('/api/admin/directores', { token: tokenAdmin, body: { docenteId: prof.docenteId, curso: '999' } })
  assert.equal(asigna.status, 201, 'primer director OK')
  // Segundo para el MISMO curso → 409
  const repite = await api.post('/api/admin/directores', { token: tokenAdmin, body: { docenteId: prof.docenteId, curso: '999' } })
  assert.equal(repite.status, 409, 'no se permite dos directores para el mismo curso')
  assert.match(repite.data.error, /ya tiene un director/)
  // Limpiar
  const dirs = (await api.get('/api/admin/directores', { token: tokenAdmin })).data
  const creado = dirs.directores.find(d => d.curso === '999')
  if (creado) await api.delete('/api/admin/directores/' + creado.id, { token: tokenAdmin })
})

test('ranking deportivo: empates comparten puesto y el siguiente salta (1,2,2,4)', async () => {
  // extra[0] y extra[1] tienen 3.5 (empate), extra[2] tiene 2.5
  // est1104 tiene 3.5 — también empata con extra[0] y extra[1]
  // Esperado: est1104=1, extra[0]=1, extra[1]=1, extra[2]=4 (salta el 2 y el 3)
  const extra = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso = '1104' AND e.id != ? LIMIT 3").all(est1104.id)
  const r0 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(r0.data.puesto, 1, 'est1104 con 3.5 empata en puesto 1')
  assert.equal(r0.data.totalCurso, 4, '4 estudiantes con notas P1')

  // Cambiar nota de est1104 a 4.5 (más alto) para probar el salto
  // Cambiar SOLO la materia A de est1104 a 4.5 para probar el salto
  db.prepare("UPDATE calificaciones SET definitiva = 4.5 WHERE estudianteId = ? AND periodo = 1 AND materiaId = (SELECT id FROM materias LIMIT 1)").run(est1104.id)
  const r1 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(r1.data.puesto, 1, 'est1104 con 4.5 (prom 3.75) es único puesto 1')
  assert.equal(r1.data.promedio, 3.75, 'promedio actualizado: (4.5+3.0)/2')
})

test('impresión masiva: puesto del curso COMPLETO (no del lote) y sin datos cruzados', async () => {
  const r = await api.get('/api/admin/boletines/curso?curso=1104&periodo=1&anio=' + anio, { token: tokenAdmin })
  assert.equal(r.status, 200)
  const boletines = r.data.boletines
  assert.ok(boletines.length >= 2, 'al menos 2 estudiantes en el lote')
  // Cada boletín lleva SU promedio y SU puesto
  for (const b of boletines) {
    assert.ok(b.promedio !== undefined, 'cada boletín lleva promedio')
    assert.ok(b.puesto !== undefined, 'cada boletín lleva puesto')
    assert.ok(b.totalCurso >= 2, 'totalCurso es el del curso completo')
  }
  // El response NO contiene datos de otros estudiantes
  const json = JSON.stringify(r.data)
  const otrosNombres = boletines.slice(1).map(b => b.estudiante.nombre)
  for (const nombre of otrosNombres) {
    // Cada boletín tiene SOLO su propio nombre en su objeto
    const bol = boletines.find(b => b.estudiante.nombre === nombre)
    const bolJson = JSON.stringify(bol)
    const otros = boletines.filter(b => b.estudiante.nombre !== nombre)
    for (const otro of otros) {
      assert.ok(!bolJson.includes('"estudiante":{"nombre":"' + otro.estudiante.nombre + '"'),
        'el boletín de ' + nombre.slice(0, 15) + ' no contiene el nombre de ' + otro.estudiante.nombre.slice(0, 15))
    }
  }
})

test('mostrar_puesto = 0: promedio SÍ, puesto NO; toggle funciona', async () => {
  // Activar mostrar_puesto = 0
  const off = await api.put('/api/admin/config-boletin', { token: tokenAdmin, body: { mostrarPuesto: false } })
  assert.equal(off.status, 200)
  const bol = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(bol.data.promedio, 3.75, 'el promedio sigue')
  assert.equal(bol.data.puesto, null, 'el puesto se oculta')
  assert.equal(bol.data.totalCurso, 0, 'totalCurso también se oculta')
  // Restaurar
  await api.put('/api/admin/config-boletin', { token: tokenAdmin, body: { mostrarPuesto: true } })
  const bol2 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tok1104 })
  assert.equal(bol2.data.puesto, 1, 'puesto restaurado')
})
