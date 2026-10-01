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
  assert.ok(estudiantes.length >= 2, 'hacen falta ≥2 estudiantes en el curso')
  assert.ok(materias.length >= 2, 'hacen falta ≥2 materias en el curso')

  // Nota deficiente (2.5) y nota aprobada (4.0) para la misma alumna
  const ins = db.prepare(
    `INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn)
     VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'))`
  )
  ins.run('test-riesgo', estudiantes[0].id, materias[0].materiaId, materias[0].docenteId, ANIO_PRUEBA, 2.5)
  ins.run('test-aprobada', estudiantes[0].id, materias[1].materiaId, materias[1].docenteId, ANIO_PRUEBA, 4.0)
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
