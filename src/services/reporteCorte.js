const prisma = require('../prisma')

// Calcula el reporte de corte de un curso para un periodo/año.
// Devuelve los estudiantes con materias en RIESGO (definitiva < 3.0)
// y las materias PENDIENTE (sin calificación registrada).
// Usado tanto por el reporte del docente/director (notas.js)
// como por el reporte global del admin (admin.js): una sola fuente de verdad.
function calcularReporteCorte(curso, periodo, anio) {
  const sedeRow = prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
  if (!sedeRow) return []

  const materias = prisma._db.prepare(`
    SELECT dm.id as dmId, dm.materiaId, m.nombre as materiaNombre, d.usuarioId as docenteUsuarioId
    FROM docente_materias dm
    JOIN materias m ON m.id = dm.materiaId
    LEFT JOIN docentes d ON d.id = dm.docenteId
    WHERE dm.curso = ?
  `).all(curso)

  const estudiantes = prisma._db.prepare(`
    SELECT e.id as estudianteId, u.nombre as estudianteNombre
    FROM estudiantes e
    JOIN usuarios u ON u.id = e.usuarioId
    WHERE e.curso = ?
  `).all(curso)

  const reporte = []
  for (const est of estudiantes) {
    for (const mat of materias) {
      const cal = prisma._db.prepare(
        'SELECT definitiva FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?'
      ).get(est.estudianteId, mat.materiaId, periodo, anio)

      if (!cal) {
        let docenteNombre = ''
        if (mat.docenteUsuarioId) {
          const doc = prisma._db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(mat.docenteUsuarioId)
          if (doc) docenteNombre = doc.nombre
        }
        reporte.push({
          estudianteId: est.estudianteId,
          estudianteNombre: est.estudianteNombre,
          materiaId: mat.materiaId,
          materiaNombre: mat.materiaNombre,
          docenteNombre: docenteNombre,
          definitiva: null,
          estado: 'PENDIENTE'
        })
      } else if (cal.definitiva !== null && cal.definitiva < 3.0) {
        reporte.push({
          estudianteId: est.estudianteId,
          estudianteNombre: est.estudianteNombre,
          materiaId: mat.materiaId,
          materiaNombre: mat.materiaNombre,
          docenteNombre: null,
          definitiva: cal.definitiva,
          estado: 'RIESGO'
        })
      }
    }
  }
  return reporte
}

module.exports = { calcularReporteCorte }
