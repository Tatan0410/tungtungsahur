// ─────────────────────────────────────────────────────────────────
// Autorización de docentes: validación compartida contra IDOR.
//
// SEGURIDAD: un docente solo puede operar sobre materias/cursos que
// tiene asignados en docente_materias. El ADMIN pasa siempre (bypass).
// Todos los endpoints de notas que reciben un materiaId (directo o
// via JOIN desde una calificación) deben validar con estas funciones
// antes de leer o escribir.
// ─────────────────────────────────────────────────────────────────

// ¿El docente tiene asignada esa materia en ese curso?
// Devuelve true/false. El bypass de ADMIN se evalúa en el endpoint
// (req.usuario.rol !== 'ADMIN') para mantener el mensaje de error igual
// al patrón original de /consolidado.
async function verificarDocenteAsignado(db, docenteId, materiaId, curso) {
  if (!docenteId || !materiaId || !curso) return false
  const asignacion = await db.prepare(
    'SELECT id FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?'
  ).get(docenteId, materiaId, curso)
  return !!asignacion
}

// ¿El docente puede ver datos de este estudiante? Tiene materia
// asignada en su curso O es director del grupo. Para GET /observaciones.
async function docentePuedeVerEstudiante(db, docenteId, estudianteId) {
  const est = await db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(estudianteId)
  if (!est) return false
  const asignacion = await db.prepare(
    'SELECT id FROM docente_materias WHERE docenteId = ? AND curso = ?'
  ).get(docenteId, est.curso)
  if (asignacion) return true
  const director = await db.prepare(
    'SELECT id FROM directores_grupo WHERE docenteId = ? AND curso = ?'
  ).get(docenteId, est.curso)
  return !!director
}

module.exports = { verificarDocenteAsignado, docentePuedeVerEstudiante }
