// ─────────────────────────────────────────────────────────────────
// BOLETÍN DEL PERÍODO (piloto 11-04): estructura por curso, notas
// P1-P3, nivel de desempeño, y puesto estilo deportivo (1,2,2,4).
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN, DOCENTE } = require('./helpers/api')

let srv, api, db, tokenAdmin, tokenDocente, anio
let tokEst1, tokEst2, tokEst3, tokEst4, est1

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  tokenDocente = await login(api, DOCENTE.documento, DOCENTE.password)
  anio = new Date().getFullYear()

  // ── Fixture: 4 estudiantes de 1104, 2 áreas, 2 materias, notas conocidas ──
  const ests = db.prepare("SELECT e.id, e.usuarioId FROM estudiantes e WHERE e.curso = '1104' ORDER BY e.id LIMIT 4").all()
  assert.ok(ests.length === 4, 'hacen falta 4 estudiantes de 1104 en dev.db')
  est1 = ests[0]

  // Contraseñas conocidas para loguearlos (patrón de roles.test.js)
  for (const [i, e] of ests.entries()) {
    db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Boletin123', 10), e.usuarioId)
  }
  // Sus documentos para login
  const docs = ests.map(e => db.prepare('SELECT documento FROM usuarios WHERE id = ?').get(e.usuarioId).documento)
  tokEst1 = await login(api, docs[0], 'Boletin123')
  tokEst2 = await login(api, docs[1], 'Boletin123')
  tokEst3 = await login(api, docs[2], 'Boletin123')
  tokEst4 = await login(api, docs[3], 'Boletin123')

  // Limpieza de calificaciones previas de los 4 (copia temporal, aislado)
  const marcas = ests.map(() => '?').join(',')
  db.prepare(`DELETE FROM calificaciones WHERE estudianteId IN (${marcas})`).run(...ests.map(e => e.id))

  // 2 áreas (en orden de creación: Área A primero) + vínculo al curso 1104
  const idAreaA = crypto.randomUUID(), idAreaB = crypto.randomUUID()
  db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(idAreaA, 'Área Test A')
  db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(idAreaB, 'Área Test B')
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), idAreaA, '1104')
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), idAreaB, '1104')

  // 2 materias reales de la BD, una por área, con I.H.S.
  const mats = db.prepare('SELECT id FROM materias LIMIT 2').all()
  const docenteFixture = db.prepare('SELECT id FROM docentes LIMIT 1').get()
  db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 4)').run(crypto.randomUUID(), idAreaA, mats[0].id)
  db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 1)').run(crypto.randomUUID(), idAreaB, mats[1].id)

  // Calificaciones P1 (y P2 para est1): promedios conocidos
  //   est1: A=4.0 B=4.0 → prom 4.0 → PUESTO 1, nivel Alto
  //   est2: A=3.5 B=3.5 → prom 3.5 → PUESTO 2 (empata con est3)
  //   est3: A=3.5 B=3.5 → prom 3.5 → PUESTO 2
  //   est4: A=3.0 B=3.0 → prom 3.0 → PUESTO 4 (¡el salto deportivo!)
  //   est4 sin notas en P2 → su boletín P2 sin puesto
  const insertar = (est, materiaId, periodo, def) => db.prepare(
    'INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
  ).run(crypto.randomUUID(), est.id, materiaId, docenteFixture.id, periodo, anio, def)
  for (const [i, est] of ests.entries()) {
    insertar(est, mats[0].id, 1, [4.0, 3.5, 3.5, 3.0][i])
    insertar(est, mats[1].id, 1, [4.0, 3.5, 3.5, 3.0][i])
  }
  // P2 de est1: A=2.9 (Bajo) y B=4.6 (Superior) — para probar la escala y las columnas por período
  insertar(est1, mats[0].id, 2, 2.9)
  insertar(est1, mats[1].id, 2, 4.6)
})

after(async () => { db.close(); await srv.cerrar() })

test('mi-boletin P1: estructura del curso, notas por período y nivel de desempeño', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tokEst1 })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.estudiante.curso, '1104')
  assert.equal(r.data.periodo, 1)

  // Áreas en orden de creación (A primero) con solo SUS materias y su I.H.S.
  assert.equal(r.data.areas.length, 2)
  assert.equal(r.data.areas[0].nombre, 'Área Test A')
  assert.equal(r.data.areas[1].nombre, 'Área Test B')
  const [mA, mB] = [r.data.areas[0].materias[0], r.data.areas[1].materias[0]]
  assert.equal(mA.ihs, 4)
  assert.equal(mB.ihs, 1)
  assert.equal(mA.p1, 4.0, 'nota P1 en su columna')
  assert.equal(mA.p2, 2.9, 'la P2 viaja en su columna aunque el boletín sea del P1')
  assert.equal(mA.definitiva, 4.0, 'definitiva del período consultado')
  assert.equal(mA.nivel, 'Desempeño Alto', '4.0 = Alto')

  // Promedio del período consultado
  assert.equal(r.data.promedio, 4.0)
  assert.equal(r.data.puesto, 1)
  assert.equal(r.data.totalRankeados, 4)
})

test('mi-boletin P1: puesto estilo deportivo — empates comparten puesto y el siguiente salta', async () => {
  const r2 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tokEst2 })
  assert.equal(r2.data.puesto, 2, 'est2 empata con est3 en el 2')
  const r3 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tokEst3 })
  assert.equal(r3.data.puesto, 2, 'est3 también puesto 2')
  const r4 = await api.get('/api/notas/mi-boletin?periodo=1&anio=' + anio, { token: tokEst4 })
  assert.equal(r4.data.puesto, 4, 'el siguiente del empate SALTA al 4 (no 3)')
  assert.equal(r4.data.promedio, 3.0)
})

test('mi-boletin P2: niveles de la escala completos (Bajo y Superior) y est4 sin puesto', async () => {
  const r = await api.get('/api/notas/mi-boletin?periodo=2&anio=' + anio, { token: tokEst1 })
  assert.equal(r.status, 200)
  const [mA, mB] = [r.data.areas[0].materias[0], r.data.areas[1].materias[0]]
  assert.equal(mA.nivel, 'Desempeño Bajo', '2.9 = Bajo')
  assert.equal(mB.nivel, 'Desempeño Superior', '4.6 = Superior')
  assert.equal(r.data.promedio, 3.75, 'promedio del P2: (2.9+4.6)/2')
  assert.equal(r.data.puesto, 1, 'solo est1 tiene notas en P2')
  assert.equal(r.data.totalRankeados, 1)

  const r4 = await api.get('/api/notas/mi-boletin?periodo=2&anio=' + anio, { token: tokEst4 })
  assert.equal(r4.data.puesto, null, 'sin notas en el período → sin puesto')
  assert.equal(r4.data.promedio, null)
  assert.equal(r4.data.areas[0].materias[0].nivel, '—')
})

test('mi-boletin: solo estudiantes', async () => {
  const anon = await api.get('/api/notas/mi-boletin?periodo=1')
  assert.equal(anon.status, 401)
  const doc = await api.get('/api/notas/mi-boletin?periodo=1', { token: tokenDocente })
  assert.equal(doc.status, 403)
  const adm = await api.get('/api/notas/mi-boletin?periodo=1', { token: tokenAdmin })
  assert.equal(adm.status, 403)
})
