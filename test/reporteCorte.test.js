const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')

const RAIZ = path.resolve(__dirname, '..')
const ANIO_PRUEBA = 1999 // año imposible en los datos reales: aisla las pruebas

let db, calcularReporteCorte, dir
let curso, estudiantes, materias

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagrado-reporte-'))
  const ruta = path.join(dir, 'dev.db')
  const origen = new Database(path.join(RAIZ, 'prisma', 'dev.db'), { readonly: true })
  await origen.backup(ruta)
  origen.close()

  process.env.DATABASE_PATH = ruta
  ;({ calcularReporteCorte } = require('../src/services/reporteCorte'))
  db = new Database(ruta)

  // Autosuficiente: si no hay asignaciones (podado de cursos), crea dos en el
  // curso con más estudiantes
  let asignaciones = db.prepare('SELECT COUNT(*) c FROM docente_materias').get().c
  if (!asignaciones) {
    const D2 = require('../src/db/cliente')
    const dbAdapt = new D2.ClienteSQLite(ruta)
    const docentes = db.prepare('SELECT id FROM docentes LIMIT 2').all()
    const materias = db.prepare('SELECT id FROM materias LIMIT 2').all()
    const cursoTop = db.prepare('SELECT curso, COUNT(*) n FROM estudiantes GROUP BY curso ORDER BY COUNT(*) DESC LIMIT 1').get()
    assert.ok(docentes.length >= 2 && materias.length >= 2 && cursoTop, 'hacen falta docentes, materias y estudiantes de ejemplo')
    for (let i = 0; i < 2; i++) {
      await dbAdapt.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(
        'test-asig-' + i, docentes[i].id, materias[i].id, cursoTop.curso)
    }
    await dbAdapt.close()
  }

  // Curso con más asignaciones, para que haya materias y estudiantes
  curso = db.prepare(
    'SELECT curso FROM docente_materias GROUP BY curso ORDER BY COUNT(*) DESC LIMIT 1'
  ).get().curso
  estudiantes = db.prepare('SELECT id, documento FROM estudiantes WHERE curso = ?').all(curso)
  materias = db.prepare('SELECT materiaId, docenteId FROM docente_materias WHERE curso = ?').all(curso)
  assert.ok(estudiantes.length >= 3, 'hacen falta ≥3 estudiantes en el curso')
  assert.ok(materias.length >= 2, 'hacen falta ≥2 materias en el curso')

  // Nota deficiente (2.5) y nota aprobada (4.0) para la misma alumna
  const ins = db.prepare(
    `INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn)
     VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'))`
  )
  ins.run('test-riesgo', estudiantes[0].id, materias[0].materiaId, materias[0].docenteId, ANIO_PRUEBA, 2.5)
  ins.run('test-aprobada', estudiantes[0].id, materias[1].materiaId, materias[1].docenteId, ANIO_PRUEBA, 4.0)

  // Notas "a medias" (PERIODO 2, para no tocar las assertions de p1):
  // - items que promedian 1.2 (< 3.0): debe salir RIESGO con nota parcial
  // - items que promedian 3.0 (≥ 3.0): va aprobando, no debe aparecer
  // - fila sin definitiva ni items: debe salir PENDIENTE
  const insSinDef = db.prepare(
    `INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn)
     VALUES (?, ?, ?, ?, 2, ?, NULL, datetime('now'))`
  )
  const insItem = db.prepare(
    `INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion, creadoEn)
     VALUES (?, ?, ?, ?, 'test', datetime('now'))`
  )
  // 2º estudiante, materia 1: 2.0*0.35 + 2.0*0.25 = 1.2 < 3.0 → RIESGO parcial
  insSinDef.run('test-parcial-mala', estudiantes[1].id, materias[0].materiaId, materias[0].docenteId, ANIO_PRUEBA)
  insItem.run('test-it-1', 'test-parcial-mala', 'ACTIVIDAD', 2.0)
  insItem.run('test-it-2', 'test-parcial-mala', 'RESPONSABILIDAD', 2.0)
  // 2º estudiante, materia 2: 5.0*0.35 + 5.0*0.25 = 3.0 (≥ 3.0) → no aparece
  insSinDef.run('test-parcial-buena', estudiantes[1].id, materias[1].materiaId, materias[1].docenteId, ANIO_PRUEBA)
  insItem.run('test-it-3', 'test-parcial-buena', 'ACTIVIDAD', 5.0)
  insItem.run('test-it-4', 'test-parcial-buena', 'RESPONSABILIDAD', 5.0)
  // 3º estudiante, materia 1: fila vacía (sin items ni definitiva) → PENDIENTE
  insSinDef.run('test-fila-vacia', estudiantes[2].id, materias[0].materiaId, materias[0].docenteId, ANIO_PRUEBA)
})

after(() => {
  if (db) db.close()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp ya borrado */ }
})

test('el reporte marca RIESGO solo debajo de 3.0', async () => {
  const rep = await calcularReporteCorte(curso, 1, ANIO_PRUEBA)
  const riesgo = rep.filter(r => r.estado === 'RIESGO')
  assert.equal(riesgo.length, 1, 'solo la nota 2.5 debe quedar en riesgo')
  assert.equal(riesgo[0].estudianteId, estudiantes[0].id)
  assert.equal(riesgo[0].definitiva, 2.5)
  assert.ok(riesgo[0].materiaNombre, 'debe traer el nombre de la materia')
  assert.ok(!rep.some(r => r.definitiva === 4.0), 'una definitiva aprobada no aparece')
})

test('las materias sin nota aparecen como PENDIENTE', async () => {
  const rep = await calcularReporteCorte(curso, 1, ANIO_PRUEBA)
  const pendientes = rep.filter(r => r.estado === 'PENDIENTE')
  assert.ok(pendientes.length >= 1)
  assert.equal(pendientes[0].definitiva, null)
  assert.equal(pendientes[0].estado, 'PENDIENTE')

  // Todos los pares estudiante×materia, menos la aprobada que se omite
  assert.equal(rep.length, estudiantes.length * materias.length - 1)
  assert.ok(rep.every(r => r.estudianteId && r.materiaId && r.materiaNombre))
})

test('un curso inexistente devuelve lista vacía', async () => {
  assert.deepEqual(await calcularReporteCorte('ZZZ-INEXISTENTE', 1, ANIO_PRUEBA), [])
})

test('otro año no toca las notas insertadas', async () => {
  const rep = await calcularReporteCorte(curso, 1, 1998)
  assert.equal(rep.filter(r => r.estado === 'RIESGO').length, 0)
  assert.equal(rep.length, estudiantes.length * materias.length, 'todo queda PENDIENTE en ese año')
})

test('items sin definitiva y promedio < 3.0 salen como RIESGO con la nota parcial', async () => {
  const rep = await calcularReporteCorte(curso, 2, ANIO_PRUEBA)
  const riesgo = rep.filter(r => r.estado === 'RIESGO')
  assert.equal(riesgo.length, 1, 'solo el 2º estudiante en la materia 1 queda en riesgo')
  const fila = riesgo[0]
  assert.equal(fila.estudianteId, estudiantes[1].id)
  assert.equal(fila.materiaId, materias[0].materiaId)
  assert.equal(fila.definitiva, 1.2, 'la nota parcial debe calcularse desde los items (2.0*0.35 + 2.0*0.25)')
  assert.equal(fila.provisional, true, 'la nota no está cerrada: es provisional')
})

test('items con promedio ≥ 3.0 no aparecen (va aprobando)', async () => {
  const rep = await calcularReporteCorte(curso, 2, ANIO_PRUEBA)
  assert.ok(
    !rep.some(r => r.estudianteId === estudiantes[1].id && r.materiaId === materias[1].materiaId),
    'la materia con parcial 3.0 no debe salir en el reporte'
  )
})

test('una fila de calificación vacía (sin items ni definitiva) sale como PENDIENTE', async () => {
  const rep = await calcularReporteCorte(curso, 2, ANIO_PRUEBA)
  const fila = rep.find(r => r.estudianteId === estudiantes[2].id && r.materiaId === materias[0].materiaId)
  assert.ok(fila, 'el 3º estudiante debe aparecer por la fila vacía')
  assert.equal(fila.estado, 'PENDIENTE')
  assert.equal(fila.definitiva, null)
  assert.equal(fila.provisional, false)
})
