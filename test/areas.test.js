const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')
const bcrypt = require('bcryptjs')

let srv, api, db, tokenAdmin, tokenEstudiante, idEstudiante, curso
let idArea1, idArea2

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)

  // Estudiante de prueba con clave conocida (ojo: calificaciones.estudianteId
  // referencia a estudiantes.id, no al id del usuario)
  const est = db.prepare('SELECT u.id AS usuarioId, e.id AS id, u.documento, e.curso FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE e.curso != \'\' LIMIT 1').get()
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(bcrypt.hashSync('Estudiante123', 10), est.usuarioId)
  tokenEstudiante = await login(api, est.documento, 'Estudiante123')
  idEstudiante = est.id
  curso = est.curso

  // Asignaciones al curso del estudiante (para que las materias tengan notas posibles)
  const materias = (await api.get('/api/admin/materias', { token: tokenAdmin })).data
  const docentes = (await api.get('/api/admin/profesores', { token: tokenAdmin })).data
  let asignadas = 0
  for (const m of materias) {
    if (asignadas >= 3) break
    const d = docentes.find(p => p.docenteId)
    if (!d) break
    const r = await api.post('/api/admin/asignaciones', { token: tokenAdmin, body: { docenteId: d.docenteId, materiaId: m.id, curso } })
    if (r.status === 201) asignadas++
  }

  // Área 1: dos materias con porcentajes que suman 100
  const r1 = await api.post('/api/admin/areas', {
    token: tokenAdmin,
    body: { nombre: 'Área Test Matemáticas', materias: [ { materiaId: materias[0].id, porcentaje: 70 }, { materiaId: materias[1].id, porcentaje: 30 } ] }
  })
  assert.equal(r1.status, 201, 'crear área: ' + JSON.stringify(r1.data))
  idArea1 = r1.data.id

  // Asignar área 1 al curso
  const ra1 = await api.post('/api/admin/areas/' + idArea1 + '/cursos', { token: tokenAdmin, body: { curso } })
  assert.equal(ra1.status, 201)

  // Área 2: mismo nombre, porcentajes distintos (permitido crearla)
  const r2 = await api.post('/api/admin/areas', {
    token: tokenAdmin,
    body: { nombre: 'Área Test Matemáticas', materias: [ { materiaId: materias[0].id, porcentaje: 50 }, { materiaId: materias[1].id, porcentaje: 25 }, { materiaId: materias[2].id, porcentaje: 25 } ] }
  })
  assert.equal(r2.status, 201, 'crear área con nombre repetido debe permitirse')
  idArea2 = r2.data.id
})

after(async () => { db.close(); await srv.cerrar() })

test('listar áreas trae materias, porcentajes y cursos', async () => {
  const r = await api.get('/api/admin/areas', { token: tokenAdmin })
  assert.equal(r.status, 200)
  const a1 = r.data.find(a => a.id === idArea1)
  assert.ok(a1, 'el área 1 debe aparecer')
  assert.equal(a1.materias.length, 2)
  assert.ok(a1.materias.every(m => m.materiaNombre && typeof m.porcentaje === 'number'))
  assert.ok(a1.cursos.includes(curso))
})

test('validaciones: acumulado >100 → 400, materia repetida → 400, vacía → 400', async () => {
  const materias = (await api.get('/api/admin/materias', { token: tokenAdmin })).data
  const excede = await api.post('/api/admin/areas', {
    token: tokenAdmin,
    body: { nombre: 'X', materias: [ { materiaId: materias[0].id, porcentaje: 60 }, { materiaId: materias[1].id, porcentaje: 60 } ] }
  })
  assert.equal(excede.status, 400)
  assert.match(excede.data.error, /100/)

  const repetida = await api.post('/api/admin/areas', {
    token: tokenAdmin,
    body: { nombre: 'X', materias: [ { materiaId: materias[0].id, porcentaje: 50 }, { materiaId: materias[0].id, porcentaje: 50 } ] }
  })
  assert.equal(repetida.status, 400)

  const vacia = await api.post('/api/admin/areas', { token: tokenAdmin, body: { nombre: 'X', materias: [] } })
  assert.equal(vacia.status, 400)
})

test('regla A: el mismo nombre no puede asignarse dos veces al mismo curso', async () => {
  // El área 2 tiene el MISMO nombre que el área 1, que ya está en el curso
  const r = await api.post('/api/admin/areas/' + idArea2 + '/cursos', { token: tokenAdmin, body: { curso } })
  assert.equal(r.status, 409)
  assert.match(r.data.error, /mismo nombre/)

  // La misma área-instancia dos veces → 409 también
  const r2 = await api.post('/api/admin/areas/' + idArea1 + '/cursos', { token: tokenAdmin, body: { curso } })
  assert.equal(r2.status, 409)
  assert.match(r2.data.error, /ya está asignada/)
})

test('mis-areas: promedio renormalizado y parcial', async () => {
  const materiasArea = (await api.get('/api/admin/areas', { token: tokenAdmin })).data.find(a => a.id === idArea1).materias
  // docenteId es NOT NULL en calificaciones: uso el docente de la asignación
  const asig = db.prepare('SELECT docenteId FROM docente_materias WHERE materiaId = ? AND curso = ?').get(materiasArea[0].materiaId, curso)
  // Notas: materia 1 → 4.0, materia 2 → sin nota
  const ins = db.prepare(
    `INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn)
     VALUES (?, ?, ?, ?, 1, 1999, ?, datetime('now'))`
  )
  ins.run('test-area-cal', idEstudiante, materiasArea[0].materiaId, asig ? asig.docenteId : null, 4.0)

  const r = await api.get('/api/notas/mis-areas?periodo=1&anio=1999', { token: tokenEstudiante })
  assert.equal(r.status, 200)
  const area = r.data.areas.find(a => a.areaId === idArea1)
  assert.ok(area, 'el área debe aparecer para el estudiante')
  // Renormalizado: (4.0 × 70) / 70 = 4.0 (solo la materia con nota cuenta)
  assert.equal(area.promedio, 4.0)
  assert.equal(area.provisional, true, 'falta la materia 2: parcial')
  assert.equal(area.completo, false)

  // La materia con nota sale con su definitiva; la otra SIN_NOTA
  const conNota = area.materias.find(m => m.materiaId === materiasArea[0].materiaId)
  assert.equal(conNota.definitiva, 4.0)
  const sinNota = area.materias.find(m => m.materiaId === materiasArea[1].materiaId)
  assert.equal(sinNota.definitiva, null)
  assert.equal(sinNota.estado, 'SIN_NOTA')

  // Agregamos la nota de la materia 2 (2.0 → riesgo): (4.0×70 + 2.0×30)/100 = 3.4
  ins.run('test-area-cal2', idEstudiante, materiasArea[1].materiaId, asig ? asig.docenteId : null, 2.0)
  const r2 = await api.get('/api/notas/mis-areas?periodo=1&anio=1999', { token: tokenEstudiante })
  const area2 = r2.data.areas.find(a => a.areaId === idArea1)
  assert.equal(area2.promedio, 3.4)
  assert.equal(area2.provisional, false, 'todas las materias tienen nota: no es parcial')
  assert.equal(area2.completo, true)
  assert.equal(area2.estado, 'APROBADO', '3.4 ≥ 3.0: aprobado')
})

test('editar materias del área y eliminar área', async () => {
  const materias = (await api.get('/api/admin/materias', { token: tokenAdmin })).data
  const editar = await api.put('/api/admin/areas/' + idArea2 + '/materias', {
    token: tokenAdmin,
    body: { materias: [ { materiaId: materias[0].id, porcentaje: 100 } ] }
  })
  assert.equal(editar.status, 200)

  const lista = (await api.get('/api/admin/areas', { token: tokenAdmin })).data
  const a2 = lista.find(a => a.id === idArea2)
  assert.equal(a2.materias.length, 1)
  assert.equal(a2.materias[0].porcentaje, 100)

  // Eliminar el área 2: desaparece con sus asignaciones
  const del = await api.delete('/api/admin/areas/' + idArea2, { token: tokenAdmin })
  assert.equal(del.status, 200)
  const trasBorrar = (await api.get('/api/admin/areas', { token: tokenAdmin })).data
  assert.ok(!trasBorrar.some(a => a.id === idArea2))

  const inexistente = await api.delete('/api/admin/areas/' + idArea2, { token: tokenAdmin })
  assert.equal(inexistente.status, 404)

  // Desasignar el área 1 del curso
  const des = await api.delete('/api/admin/areas/' + idArea1 + '/cursos/' + encodeURIComponent(curso), { token: tokenAdmin })
  assert.equal(des.status, 200)
})
