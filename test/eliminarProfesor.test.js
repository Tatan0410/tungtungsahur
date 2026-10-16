// ─────────────────────────────────────────────────────────────────
// DELETE /api/admin/profesores/:id — borrar un profesor conserva su
// historial académico (calificaciones + observaciones intactas) y
// limpia la dirección de grupo en la MISMA transacción, dejando el
// curso libre para un director nuevo (antes la fila huérfana de
// directores_grupo provocaba 409 en POST /admin/directores).
// Cuentas ficticias 88000701/702/703 sobre curso 9999.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')

let srv, api, db, tokenAdmin, anio, materiaId, areaId

// Ficticios (rango 88000xxx, curso 9999)
const DOC_DOCENTE = '88000701'
const DOC_ESTUDIANTE = '88000702'
const DOC_DIRECTOR_NUEVO = '88000703'

let usuDocente, docenteId, usuEst, estudianteId, usuDirNueva, dirNuevaId
let calificacionId, obsId, areaMateriaCreadoId, periodoActivo

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  anio = new Date().getFullYear()
  const mat = db.prepare('SELECT id FROM materias LIMIT 1').get()
  assert.ok(mat, 'hace falta una materia en el fixture')
  materiaId = mat.id
})

after(async () => { db.close(); await srv.cerrar() })

test('borrar profesor conserva notas y observaciones, limpia la dirección y libera el curso', async () => {
  // ── Setup: docente ficticio con asignación y dirección del curso 9999 ──
  usuDocente = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE FICTICIO BORRADO', ?, 1)").run(usuDocente, bcrypt.hashSync('DocFicticio701', 10), DOC_DOCENTE)
  docenteId = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docenteId, usuDocente)
  db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), docenteId, materiaId, '9999')
  db.prepare('INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), docenteId, '9999')

  // ── Setup: estudiante ficticio del curso 9999 (contraseña = documento) ──
  usuEst = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'ESTUDIANTE', 'EST FICTICIO BORRADO', ?, 1)").run(usuEst, bcrypt.hashSync(DOC_ESTUDIANTE, 10), DOC_ESTUDIANTE)
  estudianteId = crypto.randomUUID()
  db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estudianteId, usuEst, DOC_ESTUDIANTE, DOC_ESTUDIANTE, 'PPAL - TRIUNFO', 'MAÑANA', 9, '9999')
  const tokEst = await login(api, DOC_ESTUDIANTE, DOC_ESTUDIANTE)

  // ── Área FICTICIA del curso 9999 con la materia (para el boletín) ──
  areaId = crypto.randomUUID()
  db.prepare("INSERT INTO areas (id, nombre, creadoen) VALUES (?, 'ÁREA FICTICIA BORRADO TEST', CURRENT_TIMESTAMP)").run(areaId)
  db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(crypto.randomUUID(), areaId, '9999')
  const yaAm = db.prepare('SELECT id FROM area_materias WHERE areaid = ? AND materiaid = ?').get(areaId, materiaId)
  if (!yaAm) {
    areaMateriaCreadoId = crypto.randomUUID()
    db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, 100)').run(areaMateriaCreadoId, areaId, materiaId)
  }

  // ── Período activo de la sede del estudiante (regla de notas.js:101-111) ──
  const probe = await api.get('/api/notas/mi-bootstrap', { token: tokEst })
  assert.equal(probe.status, 200, 'el bootstrap del estudiante ficticio debe funcionar: ' + JSON.stringify(probe.data))
  periodoActivo = probe.data.periodoActivo
  assert.ok(periodoActivo >= 1 && periodoActivo <= 4, 'período activo válido')

  // ── Historial académico del docente: calificación (2.26, en riesgo) + 2 items + observación ──
  calificacionId = crypto.randomUUID()
  db.prepare('INSERT INTO calificaciones (id, estudianteId, materiaId, docenteId, periodo, anio, definitiva, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, 2.26, CURRENT_TIMESTAMP)')
    .run(calificacionId, estudianteId, materiaId, docenteId, periodoActivo, anio)
  db.prepare("INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion) VALUES (?, ?, 'ACTIVIDAD', 2.2, 'Tarea borrado test')").run(crypto.randomUUID(), calificacionId)
  db.prepare("INSERT INTO notas_items (id, calificacionId, tipo, valor, descripcion) VALUES (?, ?, 'EVALUACION', 2.4, NULL)").run(crypto.randomUUID(), calificacionId)
  obsId = crypto.randomUUID()
  db.prepare("INSERT INTO observaciones (id, estudianteId, docenteId, materiaId, texto, tipo, fecha) VALUES (?, ?, ?, ?, 'Obs del docente ficticio antes del borrado', 'GENERAL', '2026-10-01')")
    .run(obsId, estudianteId, docenteId, materiaId)

  // ── Publicar el boletín del período activo para el curso 9999 ──
  const pub = await api.post('/api/admin/boletines', { token: tokenAdmin, body: { periodo: periodoActivo, anio, curso: '9999' } })
  assert.ok(pub.status === 201 || pub.status === 200, 'publicación del boletín: ' + JSON.stringify(pub.data))

  try {
    // ── EL BORRADO ──
    const del = await api.delete('/api/admin/profesores/' + usuDocente, { token: tokenAdmin })
    assert.equal(del.status, 200, 'borrado del profesor: ' + JSON.stringify(del.data))

    // ── BD: lo que se borra (misma transacción) ──
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM docentes WHERE id = ?').get(docenteId).c), 0, 'la fila de docentes se borró')
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM docente_materias WHERE docenteId = ?').get(docenteId).c), 0, 'las asignaciones se borraron')
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM directores_grupo WHERE docenteId = ?').get(docenteId).c), 0, 'la dirección del curso se limpia en la MISMA transacción (fix)')
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM usuarios WHERE id = ?').get(usuDocente).c), 0, 'el usuario se borró')

    // ── BD: lo que se CONSERVA (decisión del usuario: historial intacto) ──
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM calificaciones WHERE id = ?').get(calificacionId).c), 1, 'la calificación se conserva')
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM notas_items WHERE calificacionid = ?').get(calificacionId).c), 2, 'las notas se conservan')
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM observaciones WHERE id = ?').get(obsId).c), 1, 'la observación se conserva')

    // El endpoint restaura el PRAGMA en finally (patrón leer-estado-previo
    // de migraciones.js:79-101). La conexión del servidor vive en su propio
    // proceso; esta aserción verifica el estado del driver sobre el mismo
    // archivo de BD tras el borrado.
    const fk = db.prepare('PRAGMA foreign_keys').all()[0]
    assert.equal(Number(fk.foreign_keys), 1, 'las FKs siguen activas tras el borrado: el finally restauró el PRAGMA')

    // ── Planilla (GET /grupo, admin): las notas del docente borrado siguen ──
    const planilla = await api.get('/api/notas/grupo?curso=9999&materiaId=' + materiaId + '&periodo=' + periodoActivo + '&anio=' + anio, { token: tokenAdmin })
    assert.equal(planilla.status, 200)
    const est = (planilla.data.estudiantes || []).find(e => e.estudianteId === estudianteId)
    assert.ok(est, 'el estudiante sigue en la planilla')
    assert.equal(est.calificacionId, calificacionId, 'la calificación del docente borrado sigue en la planilla')
    assert.equal(est.definitiva, 2.26, 'la definitiva sigue siendo 2.26')
    assert.ok((est.grupos.actividades.items || []).some(i => i.valor === 2.2), 'el item 2.2 sigue en la planilla')
    assert.ok((est.grupos.evaluacion.items || []).some(i => i.valor === 2.4), 'el item 2.4 sigue en la planilla')

    // ── Portal del estudiante (mi-bootstrap): notas y observación intactas ──
    const boot = await api.get('/api/notas/mi-bootstrap', { token: tokEst })
    assert.equal(boot.status, 200)
    const jsonBoot = JSON.stringify(boot.data)
    assert.ok(jsonBoot.includes('2.2') && jsonBoot.includes('2.4'), 'los items del período activo siguen en el portal')
    assert.ok(jsonBoot.includes('Obs del docente ficticio antes del borrado'), 'la observación del docente borrado sigue visible al estudiante')

    // ── Boletín: notas presentes y curso SIN director (aviso normal) ──
    const bol = await api.get('/api/notas/mi-boletin?periodo=' + periodoActivo + '&anio=' + anio, { token: tokEst })
    assert.equal(bol.status, 200, 'el boletín no se pierde: ' + JSON.stringify(bol.data))
    assert.equal(bol.data.directorNombre, null, 'sin director: el boletín sale con el aviso normal (el ternario de notas.js lo tolera)')
    const jsonBol = JSON.stringify(bol.data)
    assert.ok(jsonBol.includes('2.26'), 'la nota del período sigue en el boletín')

    // ── El curso quedó libre: un director NUEVO se puede asignar (antes: 409 por la fila huérfana) ──
    usuDirNueva = crypto.randomUUID()
    db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, 'DOCENTE', 'DOCENTE FICTICIO DIRECTOR', ?, 1)").run(usuDirNueva, bcrypt.hashSync('DirNuevo703', 10), DOC_DIRECTOR_NUEVO)
    dirNuevaId = crypto.randomUUID()
    db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(dirNuevaId, usuDirNueva)
    // La materia sigue asignada al curso con el docente nuevo (así el reporte de corte la lista)
    db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), dirNuevaId, materiaId, '9999')
    const asig = await api.post('/api/admin/directores', { token: tokenAdmin, body: { docenteId: dirNuevaId, curso: '9999' } })
    assert.equal(asig.status, 201, 'el curso liberado acepta un director nuevo (antes del fix la fila huérfana daba 409): ' + JSON.stringify(asig.data))

    // ── Reporte de corte del director nuevo: las notas del docente borrado siguen ──
    const tokDir = await login(api, DOC_DIRECTOR_NUEVO, 'DirNuevo703')
    const corte = await api.get('/api/notas/reporte-corte?curso=9999&periodo=' + periodoActivo + '&anio=' + anio, { token: tokDir })
    assert.equal(corte.status, 200, 'el reporte de corte no se pierde: ' + JSON.stringify(corte.data))
    const jsonCorte = JSON.stringify(corte.data)
    assert.ok(jsonCorte.includes(estudianteId), 'el estudiante sigue en el reporte de corte')
    assert.ok(jsonCorte.includes('2.26'), 'la nota del docente borrado sigue en el reporte de corte (LEFT JOIN a docentes)')
  } finally {
    // Limpieza FK-safe de TODO lo creado (idempotente: el DELETE ya pudo borrar varias)
    db.prepare('DELETE FROM notas_items WHERE calificacionid = ?').run(calificacionId)
    db.prepare('DELETE FROM calificaciones WHERE id = ?').run(calificacionId)
    db.prepare('DELETE FROM observaciones WHERE id = ?').run(obsId)
    db.prepare("DELETE FROM boletines_publicados WHERE curso = '9999'").run()
    db.prepare("DELETE FROM area_cursos WHERE curso = '9999'").run()
    if (areaMateriaCreadoId) db.prepare('DELETE FROM area_materias WHERE id = ?').run(areaMateriaCreadoId)
    db.prepare('DELETE FROM areas WHERE id = ?').run(areaId)
    db.prepare("DELETE FROM directores_grupo WHERE curso = '9999'").run()
    db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docenteId)
    db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(dirNuevaId)
    db.prepare('DELETE FROM docentes WHERE id = ?').run(docenteId)
    db.prepare('DELETE FROM docentes WHERE id = ?').run(dirNuevaId)
    db.prepare('DELETE FROM estudiantes WHERE id = ?').run(estudianteId)
    db.prepare('DELETE FROM usuarios WHERE id IN (?, ?, ?)').run(usuDocente, usuDirNueva, usuEst)
  }
})
