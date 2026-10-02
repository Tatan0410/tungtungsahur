const prisma = require('../prisma')
const { calcularDefinitiva } = require('./calculoNotas')

// Calcula el reporte de corte de un curso para un periodo/año.
// Devuelve los estudiantes con materias en RIESGO (definitiva < 3.0, sea
// cerrada o la parcial "hasta el momento" calculada desde notas_items)
// y las materias PENDIENTE (sin calificación registrada).
// Usado tanto por el reporte del docente/director (notas.js)
// como por el reporte global del admin (admin.js): una sola fuente de verdad.
async function calcularReporteCorte(curso, periodo, anio) {
  const sedeRow = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
  if (!sedeRow) return []

  const materias = await prisma._db.prepare(`
    SELECT dm.id AS "dmId", dm.materiaId, m.nombre AS "materiaNombre", d.usuarioId AS "docenteUsuarioId"
    FROM docente_materias dm
    JOIN materias m ON m.id = dm.materiaId
    LEFT JOIN docentes d ON d.id = dm.docenteId
    WHERE dm.curso = ?
  `).all(curso)

  const estudiantes = await prisma._db.prepare(`
    SELECT e.id AS "estudianteId", u.nombre AS "estudianteNombre"
    FROM estudiantes e
    JOIN usuarios u ON u.id = e.usuarioId
    WHERE e.curso = ?
  `).all(curso)

  const reporte = []
  for (const est of estudiantes) {
    for (const mat of materias) {
      const cal = await prisma._db.prepare(
        'SELECT id, definitiva FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?'
      ).get(est.estudianteId, mat.materiaId, periodo, anio)

      // definitiva a juzgar: la cerrada, o la parcial "hasta el momento"
      let definitiva = null
      let provisional = false
      let tieneNotas = false

      if (cal && cal.definitiva !== null) {
        definitiva = cal.definitiva
        tieneNotas = true
      } else if (cal) {
        // Hay fila pero sin definitiva cerrada: items guardados a medias.
        const items = await prisma._db.prepare(
          'SELECT tipo, valor FROM notas_items WHERE calificacionId = ?'
        ).all(cal.id)
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
        let docenteNombre = ''
        if (mat.docenteUsuarioId) {
          const doc = await prisma._db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(mat.docenteUsuarioId)
          if (doc) docenteNombre = doc.nombre
        }
        reporte.push({
          estudianteId: est.estudianteId,
          estudianteNombre: est.estudianteNombre,
          materiaId: mat.materiaId,
          materiaNombre: mat.materiaNombre,
          docenteNombre,
          definitiva: null,
          provisional: false,
          estado: 'PENDIENTE'
        })
      }
    }
  }
  return reporte
}

module.exports = { calcularReporteCorte }
