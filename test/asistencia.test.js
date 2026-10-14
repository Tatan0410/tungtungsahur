// ─────────────────────────────────────────────────────────────────
// Fase 2A — asistencia: toma de lista, upsert atómico, permisos por
// asignación/dirección, ventana de fechas, resumen del director y
// /mia del estudiante. Cuentas ficticias 88000801..88000809, curso 9999.
// ─────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { arrancarServidor } = require('./helpers/servidor')
const { crearApi, login, ADMIN } = require('./helpers/api')

// "Hoy" en America/Bogota (UTC-5 fijo), igual que el router
const hoyBogota = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10)
const restarDias = (f, n) => {
  const d = new Date(f + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

let srv, api, db, tokenAdmin, materiaId, materiaFictId
let tokAsignado, tokDirector, tokSinAsignacion, tokEstA, tokEstB
let usuAsignado, docAsignado, usuDirector, docDirector, usuSinAsignacion, docSinAsignacion, usuBorrado, docBorrado
let usuEstA, estA, usuEstB, estB, usuEstC, estC, usuOtroCurso, estOtroCurso, usuInactivo, estInactivo

function crearUsuario(db, doc, nombre, rol, password) {
  const id = crypto.randomUUID()
  db.prepare("INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, ?, ?, ?, 1)")
    .run(id, bcrypt.hashSync(password, 10), rol, nombre, doc)
  return id
}
function crearEstudiante(db, usuId, doc, curso, activo = true) {
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, usuId, doc, doc, 'PPAL - TRIUNFO', 'MAÑANA', 9, curso)
  if (!activo) db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(usuId)
  return id
}
function limpiarAsistencia() {
  db.prepare("DELETE FROM asistencia_sesiones WHERE curso IN ('9999', '9998', '9997')").run()
}

before(async () => {
  srv = await arrancarServidor()
  api = crearApi(srv.base)
  db = srv.db()
  tokenAdmin = await login(api, ADMIN.documento, ADMIN.password)
  materiaId = db.prepare('SELECT id FROM materias LIMIT 1').get().id
  assert.ok(materiaId, 'hace falta una materia en el fixture')

  const hoy = hoyBogota()

  // Docente ASIGNADO a la materia en el curso 9999 (toma la lista)
  usuAsignado = crearUsuario(db, '88000801', 'DOCENTE ASIGNADO ASIST', 'DOCENTE', 'Asignado801')
  docAsignado = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docAsignado, usuAsignado)
  db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), docAsignado, materiaId, '9999')
  tokAsignado = await login(api, '88000801', 'Asignado801')

  // DIRECTOR del curso 9999 que ADEMÁS dicta la materia en el curso 9998
  // (para probar que dictar en otro curso NO da acceso al resumen ajeno)
  usuDirector = crearUsuario(db, '88000802', 'DOCENTE DIRECTOR ASIST', 'DOCENTE', 'Director802')
  docDirector = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docDirector, usuDirector)
  db.prepare("INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, '9999')").run(crypto.randomUUID(), docDirector)
  db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), docDirector, materiaId, '9998')
  tokDirector = await login(api, '88000802', 'Director802')

  // Docente SIN ninguna asignación (solo existe como docente)
  usuSinAsignacion = crearUsuario(db, '88000808', 'DOCENTE SIN ASIGNACION', 'DOCENTE', 'SinAsig808')
  docSinAsignacion = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docSinAsignacion, usuSinAsignacion)
  tokSinAsignacion = await login(api, '88000808', 'SinAsig808')

  // Docente que será BORRADO con sesiones encima (autoría histórica).
  // Usa una MATERIA propia: docente_materias tiene UNIQUE (materiaId, curso)
  // — una materia/curso la dicta un solo docente.
  materiaFictId = crypto.randomUUID()
  db.prepare("INSERT INTO materias (id, nombre) VALUES (?, 'MATERIA FICTICIA ASIST BORRADO')").run(materiaFictId)
  usuBorrado = crearUsuario(db, '88000809', 'DOCENTE BORRADO ASIST', 'DOCENTE', 'Borrado809')
  docBorrado = crypto.randomUUID()
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docBorrado, usuBorrado)
  db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), docBorrado, materiaFictId, '9999')

  // Estudiantes activos del curso 9999 (contraseña = documento, regla del sistema)
  usuEstA = crearUsuario(db, '88000803', 'EST A ASIST', 'ESTUDIANTE', '88000803')
  estA = crearEstudiante(db, usuEstA, '88000803', '9999')
  usuEstB = crearUsuario(db, '88000804', 'EST B ASIST', 'ESTUDIANTE', '88000804')
  estB = crearEstudiante(db, usuEstB, '88000804', '9999')
  usuEstC = crearUsuario(db, '88000805', 'EST C ASIST', 'ESTUDIANTE', '88000805')
  estC = crearEstudiante(db, usuEstC, '88000805', '9999')
  tokEstA = await login(api, '88000803', '88000803')
  tokEstB = await login(api, '88000804', '88000804')

  // Estudiante de OTRO curso (9998) e INACTIVO del propio curso
  usuOtroCurso = crearUsuario(db, '88000806', 'EST OTRO CURSO', 'ESTUDIANTE', '88000806')
  estOtroCurso = crearEstudiante(db, usuOtroCurso, '88000806', '9998')
  usuInactivo = crearUsuario(db, '88000807', 'EST INACTIVO', 'ESTUDIANTE', '88000807')
  estInactivo = crearEstudiante(db, usuInactivo, '88000807', '9999', false)
})

after(async () => {
  limpiarAsistencia()
  const ids = [usuAsignado, usuDirector, usuSinAsignacion, usuBorrado, usuEstA, usuEstB, usuEstC, usuOtroCurso, usuInactivo]
  db.prepare(`DELETE FROM estudiantes WHERE usuarioId IN (${ids.map(() => '?').join(',')})`).run(...ids)
  // Orden FK-seguro: directores_grupo y asignaciones ANTES de docentes
  db.prepare('DELETE FROM directores_grupo WHERE docenteId = ?').run(docDirector)
  db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docAsignado)
  db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docDirector)
  db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docBorrado)
  db.prepare(`DELETE FROM docentes WHERE usuarioId IN (${ids.map(() => '?').join(',')})`).run(...ids)
  db.prepare('DELETE FROM materias WHERE id = ?').run(materiaFictId)
  db.prepare(`DELETE FROM usuarios WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  db.close()
  await srv.cerrar()
})

const postSesion = (token, body) => api.post('/api/asistencia/sesion', { token, body })
const getSesion = (token, query) => api.get('/api/asistencia/sesion?' + query, { token })
const getResumen = (token, query) => api.get('/api/asistencia/resumen?' + query, { token })

test('docente asignado toma la lista; re-tomar REEMPLAZA sin duplicar', async () => {
  const hoy = hoyBogota()
  try {
    const r1 = await postSesion(tokAsignado, {
      curso: '9999', materiaId, fecha: hoy,
      registros: [{ estudianteId: estA, estado: 'AUSENTE' }, { estudianteId: estB, estado: 'TARDANZA' }],
    })
    assert.equal(r1.status, 200, JSON.stringify(r1.data))
    assert.ok(r1.data.sesionId, 'devuelve sesionId')
    assert.equal(r1.data.ausentes, 1)
    assert.equal(r1.data.tardanzas, 1)
    assert.equal(r1.data.excusas, 0)
    assert.equal(r1.data.presentes, 1, 'presentes = activos(3) - registros(2)')

    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM asistencia_sesiones WHERE curso = ? AND materiaId = ? AND fecha = ?').get('9999', materiaId, hoy).c), 1)
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM asistencia_registros WHERE sesionId = ?').get(r1.data.sesionId).c), 2)

    // Lectura del día: estados y presente implícito
    const g = await getSesion(tokAsignado, 'curso=9999&materiaId=' + materiaId + '&fecha=' + hoy)
    assert.equal(g.status, 200)
    assert.equal(g.data.tomada, true)
    assert.equal(g.data.estudiantes.length, 3, 'solo estudiantes ACTIVOS del curso')
    const mapa = new Map(g.data.estudiantes.map(e => [e.estudianteId, e.estado]))
    assert.equal(mapa.get(estA), 'AUSENTE')
    assert.equal(mapa.get(estB), 'TARDANZA')
    assert.equal(mapa.get(estC), null, 'sin registro = presente (null)')

    // Re-toma: REEMPLAZA los registros (última escritura gana, sin duplicar)
    const r2 = await postSesion(tokAsignado, {
      curso: '9999', materiaId, fecha: hoy,
      registros: [{ estudianteId: estB, estado: 'EXCUSA' }],
    })
    assert.equal(r2.status, 200)
    assert.equal(r2.data.sesionId, r1.data.sesionId, 'misma sesión (upsert por curso+materia+fecha)')
    assert.equal(r2.data.ausentes, 0)
    assert.equal(r2.data.excusas, 1)
    assert.equal(r2.data.presentes, 2)
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM asistencia_registros WHERE sesionId = ?').get(r1.data.sesionId).c), 1, 'sin duplicar')
    const g2 = await getSesion(tokAsignado, 'curso=9999&materiaId=' + materiaId + '&fecha=' + hoy)
    assert.equal(new Map(g2.data.estudiantes.map(e => [e.estudianteId, e.estado])).get(estA), null, 'el AUSENTE volvió a presente')
  } finally { limpiarAsistencia() }
})

test('fechas: inválida/formato/futura/31 días → 400; 30 días y admin antiguo → permitidos', async () => {
  const hoy = hoyBogota()
  const base = { curso: '9999', materiaId, registros: [] }
  try {
    assert.equal((await postSesion(tokAsignado, { ...base, fecha: '2026-02-30' })).status, 400, '30 de febrero no es fecha real')
    assert.equal((await postSesion(tokAsignado, { ...base, fecha: '12-10-2026' })).status, 400, 'formato distinto')
    assert.equal((await postSesion(tokAsignado, { ...base, fecha: restarDias(hoy, -1) })).status, 400, 'futura')
    assert.equal((await postSesion(tokAsignado, { ...base, fecha: restarDias(hoy, 31) })).status, 400, 'docente >30 días')
    assert.equal((await postSesion(tokAsignado, { ...base, fecha: restarDias(hoy, 30) })).status, 200, 'docente exactamente 30 días')
    assert.equal((await postSesion(tokenAdmin, { ...base, fecha: restarDias(hoy, 100) })).status, 200, 'admin fecha antigua')
    assert.equal((await postSesion(tokenAdmin, { ...base, fecha: restarDias(hoy, -1) })).status, 400, 'admin tampoco fecha futura')
  } finally { limpiarAsistencia() }
})

test('validaciones de registros: estado, duplicado, curso ajeno, inactivo, tope 200', async () => {
  const hoy = hoyBogota()
  const base = { curso: '9999', materiaId, fecha: hoy }
  try {
    assert.equal((await postSesion(tokAsignado, { ...base, registros: [{ estudianteId: estA, estado: 'TARDE' }] })).status, 400, 'estado inválido')
    assert.equal((await postSesion(tokAsignado, { ...base, registros: [{ estudianteId: estA, estado: 'AUSENTE' }, { estudianteId: estA, estado: 'TARDANZA' }] })).status, 400, 'duplicado')
    assert.equal((await postSesion(tokAsignado, { ...base, registros: [{ estudianteId: estOtroCurso, estado: 'AUSENTE' }] })).status, 400, 'estudiante de otro curso')
    assert.equal((await postSesion(tokAsignado, { ...base, registros: [{ estudianteId: estInactivo, estado: 'AUSENTE' }] })).status, 400, 'estudiante inactivo del propio curso')
    const exceso = Array.from({ length: 201 }, (_, i) => ({ estudianteId: 'inventado-' + i, estado: 'AUSENTE' }))
    assert.equal((await postSesion(tokAsignado, { ...base, registros: exceso })).status, 400, 'máximo 200')
    const sinArreglo = await postSesion(tokAsignado, { curso: '9999', materiaId, fecha: hoy })
    assert.equal(sinArreglo.status, 400, 'registros debe ser un arreglo')
  } finally { limpiarAsistencia() }
})

test('permisos de sesión: docente sin asignación 403; ADMIN guarda la autoría del asignado', async () => {
  const hoy = hoyBogota()
  try {
    assert.equal((await postSesion(tokSinAsignacion, { curso: '9999', materiaId, fecha: hoy, registros: [] })).status, 403, 'POST sin asignación')
    assert.equal((await getSesion(tokSinAsignacion, 'curso=9999&materiaId=' + materiaId + '&fecha=' + hoy)).status, 403, 'GET sin asignación')

    // ADMIN: guarda como autor al docente asignado a (materiaId, curso)
    const r = await postSesion(tokenAdmin, { curso: '9999', materiaId, fecha: hoy, registros: [] })
    assert.equal(r.status, 200)
    const fila = db.prepare('SELECT docenteId FROM asistencia_sesiones WHERE id = ?').get(r.data.sesionId)
    assert.equal(fila.docenteId, docAsignado, 'la autoría es del docente asignado, no del admin')

    // ADMIN en un curso/materia SIN docente asignado → 400
    assert.equal((await postSesion(tokenAdmin, { curso: '9997', materiaId, fecha: hoy, registros: [] })).status, 400, 'sin docente asignado')
  } finally { limpiarAsistencia() }
})

test('resumen: no-director 403; curso ajeno (aunque dicte en él) 403; director/admin OK con % correctos', async () => {
  const hoy = hoyBogota()
  const ayer = restarDias(hoy, 1)
  try {
    // Dos sesiones: hoy (A ausente, B tardanza) y ayer (A ausente)
    await postSesion(tokAsignado, { curso: '9999', materiaId, fecha: hoy, registros: [{ estudianteId: estA, estado: 'AUSENTE' }, { estudianteId: estB, estado: 'TARDANZA' }] })
    await postSesion(tokAsignado, { curso: '9999', materiaId, fecha: ayer, registros: [{ estudianteId: estA, estado: 'AUSENTE' }] })

    const q = 'curso=9999&desde=' + ayer + '&hasta=' + hoy
    assert.equal((await getResumen(tokSinAsignacion, q)).status, 403, 'docente NO director')
    assert.equal((await getResumen(tokDirector, 'curso=9998&desde=' + ayer + '&hasta=' + hoy)).status, 403, 'director pidiendo curso donde DICTA pero no dirige')

    const r = await getResumen(tokDirector, q)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.sesiones, 2)
    const por = new Map(r.data.porEstudiante.map(e => [e.estudianteId, e]))
    assert.equal(por.get(estA).ausencias, 2)
    assert.equal(por.get(estA).porcentajeInasistencia, 100, '2 ausencias / 2 sesiones = 100%')
    assert.equal(por.get(estB).tardanzas, 1)
    assert.equal(por.get(estB).porcentajeInasistencia, 0, 'la tardanza NO cuenta como inasistencia')
    assert.equal(por.get(estC).porcentajeInasistencia, 0)
    assert.equal(por.get(estC).porMateria.length, 1, 'la materia aparece aunque el estudiante no tenga registros')
    assert.equal(por.get(estC).porMateria[0].sesiones, 2, 'el total de sesiones por materia coincide')
    assert.equal(por.get(estC).porMateria[0].ausencias, 0)
    assert.equal(por.get(estC).porMateria[0].porcentajeInasistencia, 0)
    assert.equal(por.get(estA).porMateria.length, 1, 'resumen por materia')
    assert.equal(por.get(estA).porMateria[0].sesiones, 2)

    assert.equal((await getResumen(tokenAdmin, q)).status, 200, 'admin ve cualquier curso')
    assert.equal((await getResumen(tokEstA, q)).status, 403, 'estudiante no puede el resumen')

    // Validaciones de rango
    assert.equal((await getResumen(tokDirector, 'curso=9999&desde=' + hoy + '&hasta=' + ayer)).status, 400, 'desde > hasta')
    const hace2Anios = restarDias(hoy, 800)
    assert.equal((await getResumen(tokDirector, 'curso=9999&desde=' + hace2Anios + '&hasta=' + hoy)).status, 400, 'rango > 1 año')
  } finally { limpiarAsistencia() }
})

test('/mia: el estudiante solo ve lo suyo y no accede a los demás endpoints', async () => {
  const hoy = hoyBogota()
  const ayer = restarDias(hoy, 1)
  try {
    // estA acumula 1 ausencia + 1 excusa; estB queda SIN registros (presente
    // en todas): su porMateria debe incluir la materia igualmente con 0%
    await postSesion(tokAsignado, { curso: '9999', materiaId, fecha: hoy, registros: [{ estudianteId: estA, estado: 'AUSENTE' }] })
    await postSesion(tokAsignado, { curso: '9999', materiaId, fecha: ayer, registros: [{ estudianteId: estA, estado: 'EXCUSA' }] })

    const rA = await api.get('/api/asistencia/mia', { token: tokEstA })
    assert.equal(rA.status, 200, JSON.stringify(rA.data))
    assert.equal(rA.data.totales.ausencias, 1)
    assert.equal(rA.data.totales.excusas, 1)
    assert.equal(rA.data.porMateria.length, 1)
    assert.equal(rA.data.porMateria[0].sesiones, 2)
    assert.equal(rA.data.porMateria[0].porcentajeInasistencia, 50, '1 ausencia / 2 sesiones')
    assert.equal(rA.data.ultimas.length, 2, 'últimas inasistencias')
    const jsonA = JSON.stringify(rA.data)
    assert.ok(!jsonA.includes(estB) && !jsonA.includes(estC), 'la respuesta NO contiene ids de otros estudiantes')

    const rB = await api.get('/api/asistencia/mia', { token: tokEstB })
    assert.equal(rB.status, 200)
    assert.equal(rB.data.totales.ausencias, 0, 'presente no genera ausencias')
    assert.equal(rB.data.totales.tardanzas, 0)
    assert.equal(rB.data.porMateria.length, 1, 'la materia aparece aunque estB no tenga registros')
    assert.equal(rB.data.porMateria[0].sesiones, 2, 'el total de sesiones por materia coincide')
    assert.equal(rB.data.porMateria[0].porcentajeInasistencia, 0)

    // El estudiante no puede tocar los endpoints de docente/director
    assert.equal((await getSesion(tokEstA, 'curso=9999&materiaId=' + materiaId + '&fecha=' + hoy)).status, 403)
    assert.equal((await getResumen(tokEstA, 'curso=9999&desde=' + ayer + '&hasta=' + hoy)).status, 403)
    assert.equal((await postSesion(tokEstA, { curso: '9999', materiaId, fecha: hoy, registros: [] })).status, 403)
  } finally { limpiarAsistencia() }
})

test('borrar un docente con sesiones NO las destruye (autoría histórica, sin FK)', async () => {
  const hoy = hoyBogota()
  const tokBorrado = await login(api, '88000809', 'Borrado809')
  try {
    const r = await postSesion(tokBorrado, { curso: '9999', materiaId: materiaFictId, fecha: hoy, registros: [{ estudianteId: estA, estado: 'EXCUSA' }] })
    assert.equal(r.status, 200)
    const del = await api.delete('/api/admin/profesores/' + usuBorrado, { token: tokenAdmin })
    assert.equal(del.status, 200, 'borrar docente con asistencia funciona: ' + JSON.stringify(del.data))
    const quedan = db.prepare('SELECT COUNT(*) c FROM asistencia_sesiones WHERE docenteId = ?').get(docBorrado)
    assert.equal(Number(quedan.c), 1, 'las sesiones del docente eliminado se conservan')
    assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM asistencia_registros WHERE sesionId = ?').get(r.data.sesionId).c), 1, 'los registros se conservan')
  } finally {
    db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docBorrado)
    db.prepare('DELETE FROM docentes WHERE id = ?').run(docBorrado)
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuBorrado)
    limpiarAsistencia()
  }
})
