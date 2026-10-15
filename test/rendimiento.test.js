// ─────────────────────────────────────────────────────────────────
// Fase 3A — panel de rendimiento del director:
//  * permisos resueltos del token + directores_grupo (nunca del cliente)
//  * valores idénticos a calcularConsolidado ejecutado directamente
//  * vista individual sin datos de terceros; comparación null < 5 activos
//  * agregados typeof number; distribución suma el total
//  * medición de tiempo con 30 estudiantes y 8 materias sintéticas
// Cuentas ficticias 88000821..88000860, cursos 9999 y 9998.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')
const { calcularConsolidado } = require('../src/services/consolidado')

let srv, api, db, tokenAdmin, anio
let tokDirector, tokNoDirector, tokEst
let usuDirector, docDirectorId, usuNoDirector, docNoDirId, usuEstPrueba, docEstPrueba
const materiasCreadas = []   // 8 materias sintéticas
const usuariosCreados = []   // todos los usuarios ficticios
const estudiantesCreados = [] // [ {id, usuId, curso} ]
const calificacionesCreadas = []

const N_EST = 30   // fixture de rendimiento
const N_MAT = 8

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  anio = new Date().getFullYear()

  // ── 8 materias sintéticas (para el fixture de rendimiento) ──
  for (let i = 0; i < N_MAT; i++) {
    const id = crypto.randomUUID()
    db.prepare('INSERT INTO materias (id, nombre, grado, nombre_norm) VALUES (?, ?, 9, ?)').run(id, 'REND MAT ' + (i + 1), 'rend mat ' + (i + 1))
    materiasCreadas.push(id)
  }

  // ── Director de DOS cursos (9999 y 9998) ──
  usuDirector = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DIRECTOR DOS CURSOS', '88000822', 1)").run(usuDirector, bcrypt.hashSync('DirDos822', 4))
  docDirectorId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docDirectorId, usuDirector)
  db.prepare("INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, '9999')").run(crypto.randomUUID(), docDirectorId)
  db.prepare("INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, '9998')").run(crypto.randomUUID(), docDirectorId)
  tokDirector = await login(api, '88000822', 'DirDos822')

  // ── Docente SIN dirección ──
  usuNoDirector = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE NO DIRECTOR REND', '88000823', 1)").run(usuNoDirector, bcrypt.hashSync('NoDir823', 4))
  docNoDirId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docNoDirId, usuNoDirector)
  tokNoDirector = await login(api, '88000823', 'NoDir823')

  // ── Estudiantes del curso 9999 (30 activos) ──
  for (let i = 0; i < N_EST; i++) {
    const doc = String(88000831 + i)
    const usuId = crypto.randomUUID()
    db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', ?, ?, 1)").run(usuId, bcrypt.hashSync(doc, 4), 'EST REND ' + doc, doc)
    const estId = crypto.randomUUID()
    db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estId, usuId, doc, doc, 'PPAL - TRIUNFO', 'MAÑANA', 9, '9999')
    usuariosCreados.push(usuId)
    estudiantesCreados.push({ id: estId, usuId, curso: '9999', doc })
  }

  // ── Asignaciones: las 8 materias al curso 9999 (UN docente por
  // materia/curso: el UNIQUE de docente_materias lo exige). Documentos
  // 880009xx: fuera del rango del loop de estudiantes (880008xx) ──
  for (let i = 0; i < N_MAT; i++) {
    const usuDocMat = crypto.randomUUID()
    db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE MAT REND', ?, 1)").run(usuDocMat, bcrypt.hashSync('Mat' + i, 4), String(88000901 + i))
    const docMatId = crypto.randomUUID()
    db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docMatId, usuDocMat)
    db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), docMatId, materiasCreadas[i], '9999')
    usuariosCreados.push(usuDocMat)
  }

  // ── 2 estudiantes del curso 9998 (< 5 activos → comparación null) ──
  for (let i = 0; i < 2; i++) {
    const doc = String(88000641 + i)
    const usuId = crypto.randomUUID()
    db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', ?, ?, 1)").run(usuId, bcrypt.hashSync(doc, 4), 'EST REND AJENO ' + doc, doc)
    const estId = crypto.randomUUID()
    db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estId, usuId, doc, doc, 'PPAL - TRIUNFO', 'MAÑANA', 9, '9998')
    usuariosCreados.push(usuId)
    estudiantesCreados.push({ id: estId, usuId, curso: '9998', doc })
  }
  // La materia 1 también existe en 9998 (para el curso de comparación)
  const usuDocAjeno = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE MAT AJENA', '88000911', 1)").run(usuDocAjeno, bcrypt.hashSync('MatAjena', 4))
  const docAjenoId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docAjenoId, usuDocAjeno)
  db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), docAjenoId, materiasCreadas[0], '9998')
  usuariosCreados.push(usuDocAjeno)

  // Estudiante del rol ESTUDIANTE (para probar 403) — 88000870: fuera del
  // rango del loop de 30 (88000831..88000860) para no chocar el UNIQUE
  usuEstPrueba = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', 'EST REND TOKEN', '88000870', 1)").run(usuEstPrueba, bcrypt.hashSync('88000870', 4))
  const estPruebaId = crypto.randomUUID()
  db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estPruebaId, usuEstPrueba, '88000870', '88000870', 'PPAL - TRIUNFO', 'MAÑANA', 9, '9999')
  usuariosCreados.push(usuEstPrueba)
  estudiantesCreados.push({ id: estPruebaId, usuId: usuEstPrueba, curso: '9999', doc: '88000870' })
  tokEst = await login(api, '88000870', '88000870')

  // TODOS los logins van AL FINAL del fixture (sockets frescos): el bcrypt
  // del fixture tarda > 5 s y los sockets keep-alive abiertos antes de él
  // mueren por el keepAliveTimeout del servidor → ECONNRESET en cascada.
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)

  // ── Calificaciones CONOCIDAS para los 3 primeros estudiantes del 9999 ──
  // (la materia 1: P1-P4 completas; materia 2: solo P1-P2)
  const defConocidas = [
    { P: [3.5, 4.0, 3.0, 4.6] },  // est 1, mat 1: vigente 4.6 SUPERIOR
    { P: [2.0, 2.5, null, null] },// est 1, mat 2: vigente 2.5 BAJO (riesgo)
    { P: [4.0, 4.5, 5.0, 4.0] },  // est 2, mat 1
    { P: [3.0, 3.2, null, null] },// est 2, mat 2
    { P: [1.5, 2.0, 2.8, 3.0] },  // est 3, mat 1
    { P: [5.0, null, null, null] },// est 3, mat 2: solo P1
  ]
  let k = 0
  for (let e = 0; e < 3; e++) {
    for (let m = 0; m < 2; m++) {
      const est = estudiantesCreados[e]
      const def = defConocidas[k++]
      for (let p = 1; p <= 4; p++) {
        if (def.P[p - 1] === null) continue
        const calId = crypto.randomUUID()
        db.prepare('INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
          .run(calId, est.id, materiasCreadas[m], docDirectorId, p, anio, def.P[p - 1])
        calificacionesCreadas.push(calId)
      }
    }
  }
})

after(async () => {
  // Limpieza FK-seguro: calificaciones → asignaciones/directores_grupo →
  // docentes → estudiantes → usuarios → materias
  const idsUsu = [...usuariosCreados]
  db.prepare(`DELETE FROM calificaciones WHERE estudianteId IN (${estudiantesCreados.map(() => '?').join(',')})`).run(...estudiantesCreados.map(e => e.id))
  db.prepare(`DELETE FROM directores_grupo WHERE docenteId = ?`).run(docDirectorId)
  db.prepare(`DELETE FROM docente_materias WHERE curso IN ('9999', '9998')`).run()
  db.prepare(`DELETE FROM docentes WHERE usuarioId IN (${idsUsu.map(() => '?').join(',')})`).run(...idsUsu)
  db.prepare(`DELETE FROM estudiantes WHERE usuarioId IN (${idsUsu.map(() => '?').join(',')})`).run(...idsUsu)
  db.prepare(`DELETE FROM usuarios WHERE id IN (${idsUsu.map(() => '?').join(',')})`).run(...idsUsu)
  db.prepare(`DELETE FROM materias WHERE id IN (${materiasCreadas.map(() => '?').join(',')})`).run(...materiasCreadas)
  db.close()
  await srv.cerrar()
})

const getCurso = (token, query) => api.get('/api/rendimiento/curso?' + query, { token })
const getEstudiante = (token, query) => api.get('/api/rendimiento/estudiante?' + query, { token })

test('los valores del panel coinciden con calcularConsolidado ejecutado directo', async () => {
  // Fuente de verdad: el MISMO service que usa el endpoint, llamado directo
  const directoMat1 = await calcularConsolidado(db, '9999', materiasCreadas[0], anio, 1)
  const directoMat2 = await calcularConsolidado(db, '9999', materiasCreadas[1], anio, 1)
  const r = await getCurso(tokDirector, 'curso=9999')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const m1 = r.data.porMateria.find(m => m.materiaId === materiasCreadas[0])
  const m2 = r.data.porMateria.find(m => m.materiaId === materiasCreadas[1])

  // Promedio por período del curso = AVG de las definitivas del consolidado
  for (let p = 1; p <= 4; p++) {
    const conNota = directoMat1.map(f => f.definitivas[p - 1]).filter(v => v !== null)
    const esperado = conNota.length ? parseFloat((conNota.reduce((a, b) => a + b, 0) / conNota.length).toFixed(2)) : null
    assert.equal(m1.promedioPorPeriodo[String(p)], esperado, 'P' + p + ' de la materia 1 = consolidado directo')
  }
  // Definitivo ponderado = promedio de los promedioFinal del consolidado
  const finales = directoMat1.map(f => f.promedioFinal).filter(v => v !== null)
  const esperadoFin = finales.length ? parseFloat((finales.reduce((a, b) => a + b, 0) / finales.length).toFixed(2)) : null
  assert.equal(m1.definitivoPonderado, esperadoFin, 'definitivoPonderado = consolidado directo')

  // El estudiante 1 en la vista individual: mismas definitivas del consolidado
  const est1 = estudiantesCreados[0]
  const ri = await getEstudiante(tokDirector, 'estudianteId=' + est1.id)
  assert.equal(ri.status, 200, JSON.stringify(ri.data))
  const im1 = ri.data.porMateria.find(m => m.materiaId === materiasCreadas[0])
  const im2 = ri.data.porMateria.find(m => m.materiaId === materiasCreadas[1])
  const fila1 = directoMat1.find(f => f.estudianteId === est1.id)
  const fila2 = directoMat2.find(f => f.estudianteId === est1.id)
  assert.deepEqual(im1.definitivas, { '1': fila1.definitivas[0], '2': fila1.definitivas[1], '3': fila1.definitivas[2], '4': fila1.definitivas[3] })
  assert.deepEqual(im2.definitivas, { '1': fila2.definitivas[0], '2': fila2.definitivas[1], '3': fila2.definitivas[2], '4': fila2.definitivas[3] })
  assert.equal(im1.definitivoPonderado, fila1.promedioFinal, 'definitivoPonderado individual = consolidado')
})

test('permisos: no-director 403; curso/estudiante ajeno 403; estudiante 403; admin 200; director de 2 cursos ve ambos', async () => {
  assert.equal((await getCurso(tokNoDirector, 'curso=9999')).status, 403, 'docente NO director → /curso 403')
  assert.equal((await getEstudiante(tokNoDirector, 'estudianteId=' + estudiantesCreados[0].id)).status, 403, 'docente NO director → /estudiante 403')

  const rAjeno = await getCurso(tokDirector, 'curso=9997')
  assert.equal(rAjeno.status, 403, 'director pidiendo un TERCER curso → 403')

  const estAjeno = await getEstudiante(tokDirector, 'estudianteId=' + estudiantesCreados[30].id) // curso 9998... lo dirige
  // El director de 9999 Y 9998 SÍ puede ver estudiantes de 9998 (lo dirige)
  assert.equal(estAjeno.status, 200, 'director de 9998 puede ver a sus estudiantes de 9998')
  const r9998 = await getCurso(tokDirector, 'curso=9998')
  assert.equal(r9998.status, 200, 'director de dos cursos ve el segundo')

  // Un estudiante de un curso que NO dirige (creamos uno en 9997)
  const usuAjeno = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', 'EST CURSO 9997', '88000650', 1)").run(usuAjeno, bcrypt.hashSync('88000650', 4))
  const estAjenoId = crypto.randomUUID()
  db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estAjenoId, usuAjeno, '88000650', '88000650', 'PPAL - TRIUNFO', 'MAÑANA', 9, '9997')
  try {
    assert.equal((await getEstudiante(tokDirector, 'estudianteId=' + estAjenoId)).status, 403, 'estudiante de curso NO dirigido → 403')
  } finally {
    db.prepare('DELETE FROM estudiantes WHERE id = ?').run(estAjenoId)
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuAjeno)
  }

  assert.equal((await getCurso(tokEst, 'curso=9999')).status, 403, 'rol ESTUDIANTE → /curso 403')
  assert.equal((await getEstudiante(tokEst, 'estudianteId=' + estudiantesCreados[0].id)).status, 403, 'estudiante pidiendo la ficha de OTRO → 403')
  // Self-acceso: el estudiante ve SU propia ficha (portal "Mi rendimiento")
  const propio = estudiantesCreados.find(e => e.doc === '88000870')
  const rPropio = await getEstudiante(tokEst, 'estudianteId=' + propio.id)
  assert.equal(rPropio.status, 200, 'estudiante pidiendo SU propia ficha → 200')
  assert.ok(rPropio.data.estudiante && rPropio.data.estudiante.nombre === 'EST REND TOKEN', 'la ficha propia trae su nombre')
  assert.ok(Array.isArray(rPropio.data.porMateria), 'con porMateria')
  assert.equal(typeof rPropio.data.comparacionDisponible, 'boolean', 'comparacionDisponible booleano')
  assert.ok(!JSON.stringify(rPropio.data).includes(estudiantesCreados[0].id), 'la ficha propia no expone ids de otros estudiantes')

  assert.equal((await getCurso(tokenAdmin, 'curso=9999')).status, 200, 'admin → /curso 200')
  assert.equal((await getEstudiante(tokenAdmin, 'estudianteId=' + estudiantesCreados[0].id)).status, 200, 'admin → /estudiante 200')

  // Estudiante inexistente: admin 404, director 403 (no revelar existencia)
  assert.equal((await getEstudiante(tokenAdmin, 'estudianteId=no-existe-xyz')).status, 404, 'admin con estudiante inexistente → 404')
  assert.equal((await getEstudiante(tokDirector, 'estudianteId=no-existe-xyz')).status, 403, 'director con estudiante inexistente → 403 (no revelar)')

  // Año inválido
  assert.equal((await getCurso(tokDirector, 'curso=9999&anio=abc')).status, 400, 'año no numérico → 400')
  assert.equal((await getCurso(tokDirector, 'curso=9999&anio=1999')).status, 400, 'año fuera de rango → 400')
})

test('vista individual: SIN datos de terceros; comparación null con < 5 activos y presente con 5+', async () => {
  const est1 = estudiantesCreados[0]
  const r = await getEstudiante(tokDirector, 'estudianteId=' + est1.id)
  assert.equal(r.status, 200)
  const json = JSON.stringify(r.data)

  // Nada de otros estudiantes: ni ids ni nombres ni notas individuales
  for (let i = 1; i < estudiantesCreados.length; i++) {
    assert.ok(!json.includes('"' + estudiantesCreados[i].id + '"'), 'no aparece el id del estudiante ' + i)
  }
  // Nombres de otros: los del fixture se llaman 'EST REND 88000832'..; el
  // nombre del propio es 'EST REND 88000831'
  assert.ok(json.includes('EST REND 88000831'), 'el nombre del propio estudiante SÍ está')
  for (let i = 1; i < 3; i++) {
    assert.ok(!json.includes('EST REND ' + estudiantesCreados[i].doc), 'no aparece el nombre del estudiante ' + i)
  }
  // Sin campo porEstudiante ni puestos
  assert.ok(!('porEstudiante' in r.data), 'la vista individual no expone porEstudiante')

  // Forma de promedioPorPeriodo / nivelPorPeriodo: exactamente las claves
  // "1".."4"; valores number|null y nivel válido|null
  assert.deepEqual(Object.keys(r.data.promedioPorPeriodo), ['1', '2', '3', '4'])
  assert.deepEqual(Object.keys(r.data.nivelPorPeriodo), ['1', '2', '3', '4'])
  for (const k of ['1', '2', '3', '4']) {
    assert.ok(r.data.promedioPorPeriodo[k] === null || typeof r.data.promedioPorPeriodo[k] === 'number', 'promedioPorPeriodo[' + k + '] number|null')
    assert.ok(r.data.nivelPorPeriodo[k] === null || ['BAJO', 'BÁSICO', 'ALTO', 'SUPERIOR'].includes(r.data.nivelPorPeriodo[k]), 'nivelPorPeriodo[' + k + '] nivel válido|null')
  }

  // Comparación: curso 9999 tiene 31 activos → presente y numérico
  assert.equal(r.data.comparacionDisponible, true)
  const conProm = r.data.porMateria.filter(m => m.promedioCurso !== null)
  assert.ok(conProm.length > 0, 'hay promedios de curso en las materias con notas')
  for (const m of conProm) {
    assert.equal(typeof m.promedioCurso, 'number', 'promedioCurso es number')
  }

  // Curso 9998 con 2 activos → comparación null
  const rAjeno = await getEstudiante(tokDirector, 'estudianteId=' + estudiantesCreados[30].id)
  assert.equal(rAjeno.status, 200)
  assert.equal(rAjeno.data.comparacionDisponible, false, '9998 tiene < 5 activos')
  for (const m of rAjeno.data.porMateria) {
    assert.equal(m.promedioCurso, null, 'sin comparación en curso pequeño (anonimato)')
  }
  // 9998 no tiene calificaciones: promedioPorPeriodo todo null (documentado)
  for (const k of ['1', '2', '3', '4']) {
    assert.equal(rAjeno.data.promedioPorPeriodo[k], null, 'sin notas → P' + k + ' null')
  }
})

test('distribución por nivel suma el total con nota; materia sin notas no rompe', async () => {
  const r = await getCurso(tokDirector, 'curso=9999')
  assert.equal(r.status, 200)

  // Materias 3..8 no tienen notas: distribución total 0, promedios null
  for (const m of r.data.porMateria) {
    const suma = m.distribucion.BAJO + m.distribucion['BÁSICO'] + m.distribucion.ALTO + m.distribucion.SUPERIOR
    assert.equal(suma, m.distribucion.total, 'la distribución de ' + m.materiaNombre + ' suma su total')
    if (['REND MAT 3', 'REND MAT 4', 'REND MAT 5', 'REND MAT 6', 'REND MAT 7', 'REND MAT 8'].includes(m.materiaNombre)) {
      assert.equal(m.distribucion.total, 0, 'materia sin notas → total 0 (documentado)')
      for (let p = 1; p <= 4; p++) {
        assert.equal(m.promedioPorPeriodo[String(p)], null, 'período sin notas → null (documentado)')
      }
      assert.equal(m.definitivoPonderado, null)
    }
  }

  // La materia 1 tiene 3 estudiantes con notas P1: distribución total 3
  const m1 = r.data.porMateria.find(m => m.materiaId === materiasCreadas[0])
  assert.equal(m1.distribucion.total, 3, 'materia 1: 3 estudiantes con vigente')
  assert.equal(m1.distribucion.SUPERIOR, 1, 'est 1 (vigente 4.6) → SUPERIOR')
  assert.equal(m1.distribucion.ALTO, 1, 'est 2 (vigente 4.0) → ALTO')
  assert.equal(m1.distribucion['BÁSICO'], 1, 'est 3 (vigente 3.0 en P4) → BÁSICO')

  // Todos los agregados number o null
  const porEst = r.data.porEstudiante
  assert.equal(porEst.length, 31, '31 activos en 9999')
  for (const e of porEst) {
    assert.ok(e.promedioGeneral === null || typeof e.promedioGeneral === 'number', 'promedioGeneral number|null')
    assert.ok(e.materiasEnRiesgo === null || typeof e.materiasEnRiesgo === 'number', 'materiasEnRiesgo number')
  }
  // Est 1: mat 1 vigente 4.6 (SUPERIOR), mat 2 vigente 2.5 (riesgo) → 1 en riesgo
  const est1 = porEst.find(e => e.estudianteId === estudiantesCreados[0].id)
  assert.equal(est1.materiasEnRiesgo, 1, 'el est 1 tiene 1 materia en riesgo')
})

test('medición: /curso con 30 estudiantes y 8 materias en menos de 1.5 s', async () => {
  const inicio = Date.now()
  const r = await getCurso(tokDirector, 'curso=9999')
  const duracion = Date.now() - inicio
  assert.equal(r.status, 200)
  assert.equal(r.data.porMateria.length, 8, 'las 8 materias del fixture')
  assert.equal(r.data.porEstudiante.length, 31, 'los 31 activos (30 + el del token)')
  // ~34 consultas: 2 (materias+activos) + 8×4 (calcularConsolidado por materia)
  console.log('  ⏱ /rendimiento/curso: ' + duracion + ' ms (~34 consultas: 2 + 8 materias × 4 del consolidado)')
  assert.ok(duracion < 1500, '/curso debe tardar < 1.5 s (tardó ' + duracion + ' ms)')
})

test('año por defecto = año Bogotá; asistencia acotada al año pedido; año futuro = asistencia vacía', async () => {
  const est1 = estudiantesCreados[0]
  const anioBogota = Number(new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 4))

  // a) Sin ?anio → el del response es el año Bogotá
  const rDef = await getCurso(tokDirector, 'curso=9999')
  assert.equal(rDef.status, 200)
  assert.equal(rDef.data.anio, anioBogota, 'año por defecto = America/Bogota')

  // b) Sesión de HOY (año actual): el año actual la incluye, el año
  //    pasado NO (rango hasta = 31-dic de ese año, no hoy)
  const hoyBog = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10)
  const sesionHoy = crypto.randomUUID()
  db.prepare('INSERT INTO asistencia_sesiones (id, curso, materiaId, docenteId, fecha, creadoEn, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sesionHoy, '9999', materiasCreadas[0], docDirectorId, hoyBog, new Date().toISOString(), new Date().toISOString())
  db.prepare('INSERT INTO asistencia_registros (id, sesionId, estudianteId, estado) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), sesionHoy, est1.id, 'AUSENTE')

  try {
    const rActual = await getEstudiante(tokDirector, 'estudianteId=' + est1.id)
    assert.equal(rActual.status, 200)
    assert.equal(rActual.data.asistencia.totales.ausencias, 1, 'año actual incluye la sesión de hoy')
    assert.ok(rActual.data.asistencia.porMateria.length >= 1, 'la materia de la sesión aparece en el año actual')

    const rPasado = await getEstudiante(tokDirector, 'estudianteId=' + est1.id + '&anio=' + (anioBogota - 1))
    assert.equal(rPasado.status, 200)
    assert.equal(rPasado.data.asistencia.totales.ausencias, 0, 'año pasado NO incluye la sesión de este año')
    assert.deepEqual(rPasado.data.asistencia.porMateria, [], 'año pasado: sin materias en el rango')
  } finally {
    db.prepare('DELETE FROM asistencia_registros WHERE sesionId = ?').run(sesionHoy)
    db.prepare('DELETE FROM asistencia_sesiones WHERE id = ?').run(sesionHoy)
  }

  // c) Año futuro (desde > hasta) → asistencia VACÍA sin error
  const rFuturo = await getEstudiante(tokDirector, 'estudianteId=' + est1.id + '&anio=2099')
  assert.equal(rFuturo.status, 200, 'año futuro no debe dar error: ' + JSON.stringify(rFuturo.data))
  assert.deepEqual(rFuturo.data.asistencia.totales, { ausencias: 0, tardanzas: 0, excusas: 0 }, 'año futuro → totales en 0')
  assert.deepEqual(rFuturo.data.asistencia.porMateria, [], 'año futuro → sin materias')
  assert.deepEqual(rFuturo.data.asistencia.ultimas, [], 'año futuro → sin últimas')
  // Las notas también vienen vacías (no hay calificaciones de 2099) pero sin error
  assert.equal(rFuturo.data.promedioVigente, null, 'sin notas de un año futuro → promedio vigente null (documentado)')
  for (const k of ['1', '2', '3', '4']) {
    assert.equal(rFuturo.data.promedioPorPeriodo[k], null, 'año futuro → P' + k + ' null')
  }
})

test('promedioPorPeriodo: misma fórmula del boletín (SQL por período) y calza 1:1 con /mi-boletin', async () => {
  const est1 = estudiantesCreados[0]
  const r = await getEstudiante(tokDirector, 'estudianteId=' + est1.id)
  assert.equal(r.status, 200)

  // Valor esperado: la MISMA consulta SQL del promedio general del boletín
  // (notas.js:1937-1941), ejecutada aquí por período
  for (let p = 1; p <= 4; p++) {
    const fila = db.prepare(`
      SELECT AVG(definitiva) prom FROM calificaciones
      WHERE estudianteId = ? AND periodo = ? AND anio = ? AND definitiva IS NOT NULL
    `).get(est1.id, p, anio)
    const esperado = fila && fila.prom !== null ? parseFloat(Number(fila.prom).toFixed(2)) : null
    assert.equal(r.data.promedioPorPeriodo[String(p)], esperado, 'P' + p + ' = AVG(definitiva) del boletín')
  }

  // Niveles por período con las notas CONOCIDAS del fixture (est 1:
  // mat1 = 3.5·4.0·3.0·4.6, mat2 = 2.0·2.5·—·—)
  assert.deepEqual(r.data.promedioPorPeriodo, { '1': 2.75, '2': 3.25, '3': 3.0, '4': 4.6 })
  assert.deepEqual(r.data.nivelPorPeriodo, { '1': 'BAJO', '2': 'BÁSICO', '3': 'BÁSICO', '4': 'SUPERIOR' })

  // End-to-end con el boletín real: publicar los 4 períodos del curso 9999
  // (vía la API de admin, como boletin.test.js) y consultar /mi-boletin con
  // el token del PROPIO estudiante
  try {
    for (let p = 1; p <= 4; p++) {
      const pub = await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: p, anio, curso: '9999' } })
      assert.ok(pub.status === 200 || pub.status === 201, 'publicación P' + p + ': ' + JSON.stringify(pub.data))
    }
    const tokEst1 = await login(api, est1.doc, est1.doc)
    for (let p = 1; p <= 4; p++) {
      const bol = await api.get('/api/notas/mi-boletin?periodo=' + p + '&anio=' + anio, { token: tokEst1 })
      assert.equal(bol.status, 200, 'mi-boletin P' + p + ': ' + JSON.stringify(bol.data))
      assert.equal(bol.data.promedio, r.data.promedioPorPeriodo[String(p)], 'boletín P' + p + ' = promedioPorPeriodo del panel')
    }
  } finally {
    db.prepare("DELETE FROM boletines_publicados WHERE curso = '9999'").run()
  }
})
