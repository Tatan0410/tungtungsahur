const prisma = require('../prisma')
const { calcularDefinitiva } = require('./calculoNotas')

// Calcula el reporte de corte de un curso para un periodo/año.
// Devuelve los estudiantes con materias en RIESGO (definitiva < 3.0, sea
// cerrada o la parcial "hasta el momento" calculada desde notas_items)
// y las materias PENDIENTE (sin calificación registrada).
// Usado tanto por el reporte del docente/director (notas.js)
// como por el reporte global del admin (admin.js): una sola fuente de verdad.
//
// RENDIMIENTO: 5 queries fijas con JOINs (antes eran 1-2 por cada
// estudiante×materia — un curso de 27×19 eran 500+ queries seguidas).
async function calcularReporteCorte(curso, periodo, anio) {
  const sedeRow = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
  if (!sedeRow) return []

  // Materias del curso con el nombre del docente en el mismo JOIN
  const materias = await prisma._db.prepare(`
    SELECT dm.materiaId, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre"
    FROM docente_materias dm
    JOIN materias m ON m.id = dm.materiaId
    LEFT JOIN docentes d ON d.id = dm.docenteId
    LEFT JOIN usuarios u ON u.id = d.usuarioId
    WHERE dm.curso = ?
  `).all(curso)
  if (!materias.length) return []

  // Todos los calificables del curso para ese período/año en UNA query
  const calificaciones = await prisma._db.prepare(`
    SELECT c.id, c.estudianteId, c.materiaId, c.definitiva
    FROM calificaciones c
    JOIN estudiantes e ON e.id = c.estudianteId
    WHERE e.curso = ? AND c.periodo = ? AND c.anio = ?
  `).all(curso, periodo, anio)

  // Los items SOLO de las filas sin definitiva cerrada (las demás no se usan)
  const calsSinDefinitiva = calificaciones.filter(c => c.definitiva === null).map(c => c.id)
  let itemsPorCal = new Map()
  if (calsSinDefinitiva.length) {
    const marcas = calsSinDefinitiva.map(() => '?').join(',')
    const items = await prisma._db.prepare(
      `SELECT calificacionId, tipo, valor FROM notas_items WHERE calificacionId IN (${marcas})`
    ).all(...calsSinDefinitiva)
    for (const it of items) {
      const clave = it.calificacionId
      if (!itemsPorCal.has(clave)) itemsPorCal.set(clave, [])
      itemsPorCal.get(clave).push({ tipo: it.tipo, valor: it.valor })
    }
  }

  // Índice por (estudiante, materia) para el cruce en memoria
  const calPorPar = new Map(calificaciones.map(c => [c.estudianteId + '|' + c.materiaId, c]))

  const estudiantes = await prisma._db.prepare(`
    SELECT e.id AS "estudianteId", u.nombre AS "estudianteNombre"
    FROM estudiantes e
    JOIN usuarios u ON u.id = e.usuarioId
    WHERE e.curso = ?
  `).all(curso)

  return construirReporte(estudiantes, materias, calPorPar, itemsPorCal)
}

// Versión para UN estudiante (el portal del estudiante): mismas reglas,
// pero solo trae sus calificaciones. 3 queries fijas en vez de recorrer
// el curso entero (que era el cuello de botella de "carga eterna").
async function calcularReporteCorteEstudiante(estudianteId, curso, periodo, anio) {
  const materias = await prisma._db.prepare(`
    SELECT dm.materiaId, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre"
    FROM docente_materias dm
    JOIN materias m ON m.id = dm.materiaId
    LEFT JOIN docentes d ON d.id = dm.docenteId
    LEFT JOIN usuarios u ON u.id = d.usuarioId
    WHERE dm.curso = ?
  `).all(curso)
  if (!materias.length) return []

  const calificaciones = await prisma._db.prepare(
    'SELECT id, materiaId, definitiva FROM calificaciones WHERE estudianteId = ? AND periodo = ? AND anio = ?'
  ).all(estudianteId, periodo, anio)

  const calsSinDefinitiva = calificaciones.filter(c => c.definitiva === null).map(c => c.id)
  let itemsPorCal = new Map()
  if (calsSinDefinitiva.length) {
    const marcas = calsSinDefinitiva.map(() => '?').join(',')
    const items = await prisma._db.prepare(
      `SELECT calificacionId, tipo, valor FROM notas_items WHERE calificacionId IN (${marcas})`
    ).all(...calsSinDefinitiva)
    for (const it of items) {
      const clave = it.calificacionId
      if (!itemsPorCal.has(clave)) itemsPorCal.set(clave, [])
      itemsPorCal.get(clave).push({ tipo: it.tipo, valor: it.valor })
    }
  }

  const calPorPar = new Map(calificaciones.map(c => [estudianteId + '|' + c.materiaId, c]))
  const estudiante = await prisma._db.prepare(`
    SELECT e.id AS "estudianteId", u.nombre AS "estudianteNombre"
    FROM estudiantes e
    JOIN usuarios u ON u.id = e.usuarioId
    WHERE e.id = ?
  `).get(estudianteId)
  if (!estudiante) return []

  return construirReporte([estudiante], materias, calPorPar, itemsPorCal)
}

// Núcleo compartido por ambas versiones: cruza estudiantes×materias contra
// los calificables ya traídos y aplica las mismas reglas de siempre.
function construirReporte(estudiantes, materias, calPorPar, itemsPorCal) {
  const reporte = []
  for (const est of estudiantes) {
    for (const mat of materias) {
      const cal = calPorPar.get(est.estudianteId + '|' + mat.materiaId)

      // definitiva a juzgar: la cerrada, o la parcial "hasta el momento"
      let definitiva = null
      let provisional = false
      let tieneNotas = false

      if (cal && cal.definitiva !== null) {
        definitiva = cal.definitiva
        tieneNotas = true
      } else if (cal) {
        // Hay fila pero sin definitiva cerrada: items guardados a medias.
        const items = itemsPorCal.get(cal.id) || []
        tieneNotas = items.length > 0
        if (tieneNotas) {
          const parcial = calcularDefinitiva(items)
          if (parcial !== null && parcial < 3.0) {
            definitiva = parcial
            provisional = true
          }
          // parcial >= 3.0: va aprobando — no pertenece al reporte de corte
        }
      }

      if (definitiva !== null && definitiva < 3.0) {
        reporte.push({
          estudianteId: est.estudianteId,
          estudianteNombre: est.estudianteNombre,
          materiaId: mat.materiaId,
          materiaNombre: mat.materiaNombre,
          docenteNombre: null,
          definitiva,
          provisional,
          estado: 'RIESGO'
        })
      } else if (!tieneNotas) {
        // Sin fila o fila vacía (sin items ni definitiva): pendiente de notas
        reporte.push({
          estudianteId: est.estudianteId,
          estudianteNombre: est.estudianteNombre,
          materiaId: mat.materiaId,
          materiaNombre: mat.materiaNombre,
          docenteNombre: mat.docenteNombre || '',
          definitiva: null,
          provisional: false,
          estado: 'PENDIENTE'
        })
      }
    }
  }
  return reporte
}

module.exports = { calcularReporteCorte, calcularReporteCorteEstudiante }
