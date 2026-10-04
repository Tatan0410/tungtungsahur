// ─────────────────────────────────────────────────────────────────
// Consolidado: nota mínima que necesita cada estudiante para llegar a 3.0
// en una materia. Usado por el docente (/api/notas/consolidado) y por el
// admin (/api/admin/consolidado): una sola fuente de verdad.
//
// Fórmula (promedio simple, confirmada por el colegio):
//   mínimo = 3.0 x n - suma(definitivas anteriores)
//   con n = periodos con nota + 1 (los periodos sin nota no penalizan)
//   Redondeo hacia arriba (ceil) a 1 decimal: si da 3.46 se muestra 3.5 (garantiza que alcance
//   tras el redondeo real del sistema).
//   Casos: <= 0 -> ASEGURADO (ya pasa con cualquier nota)
//          > 5  -> RIESGO_CRITICO (no alcanza en el siguiente periodo)
//          sin periodos anteriores -> el mínimo es 3.0 (pasar este periodo)
// ─────────────────────────────────────────────────────────────────
function calcularMinimoRequerido(definitivasAnteriores) {
  const conNota = (definitivasAnteriores || []).filter(d => d !== null && d !== undefined)
  if (!conNota.length) return { minimo: 3.0, estado: 'ALCANZABLE' }
  const n = conNota.length + 1
  const suma = conNota.reduce((a, b) => a + b, 0)
  const minimo = Math.ceil((3.0 * n - suma) * 10) / 10
  if (minimo <= 0) return { minimo: 0, estado: 'ASEGURADO' }
  if (minimo > 5) return { minimo: null, estado: 'RIESGO_CRITICO' }
  return { minimo, estado: 'ALCANZABLE' }
}

// El consolidado completo de un curso para una materia: por estudiante
// devuelve las definitivas de P1-P4, la nota necesaria para el PRIMER
// periodo sin calificar (el "siguiente") y, si ya complet los 4, el
// promedio final ponderado real (con los pesos reales de la sede).
async function calcularConsolidado(db, curso, materiaId, anio, periodoActual) {
  const estudiantes = await db.prepare(`
    SELECT e.id AS "estudianteId", u.nombre
    FROM estudiantes e
    JOIN usuarios u ON u.id = e.usuarioId
    WHERE e.curso = ?
    ORDER BY u.nombre ASC
  `).all(curso)

  const cals = await db.prepare(`
    SELECT cal.estudianteid AS "estudianteId", cal.periodo, cal.definitiva
    FROM calificaciones cal
    JOIN estudiantes e ON e.id = cal.estudianteid
    WHERE e.curso = ? AND cal.materiaid = ? AND cal.anio = ?
  `).all(curso, materiaId, anio)

  const porEstudiante = new Map()
  for (const c of cals) {
    if (!porEstudiante.has(c.estudianteId)) porEstudiante.set(c.estudianteId, [])
    porEstudiante.get(c.estudianteId).push({ periodo: c.periodo, definitiva: c.definitiva })
  }

  // Pesos REALES de la sede (no hardcodeados; el esquema los guarda por sede)
  const sedeRow = await db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
  let pesos = { 1: 0.20, 2: 0.30, 3: 0.20, 4: 0.30 }
  if (sedeRow) {
    try {
      const rows = await db.prepare('SELECT periodo, peso FROM periodos_config WHERE anio = ? AND sede = ?').all(anio, sedeRow.sede)
      if (rows.length > 0) {
        const p = {}
        for (const r of rows) p[r.periodo] = r.peso
        pesos = p
      }
    } catch { /* fallback a los pesos por defecto */ }
  }

  const resultado = []
  for (const est of estudiantes) {
    const calsEst = porEstudiante.get(est.estudianteId) || []
    const porPeriodo = new Map(calsEst.map(c => [c.periodo, c.definitiva]))
    const definitivas = [1, 2, 3, 4].map(p => porPeriodo.has(p) ? porPeriodo.get(p) : null)

    // El "siguiente" periodo: el PRIMERO SIN calificar que sea >= el periodo
    // actual (nunca uno ya pasado: si estamos en P4, la nota necesaria es
    // para P4 o nada, no para P1)
    let siguiente = -1
    for (let p = (periodoActual || 1); p <= 4; p++) {
      if (definitivas[p - 1] === null) { siguiente = p; break }
    }
    if (siguiente >= 0) {
      // Solo cuentan los periodos ANTERIORES al siguiente que tengan nota
      const anteriores = definitivas.slice(0, siguiente - 1).filter(d => d !== null)
      const r = calcularMinimoRequerido(anteriores)
      resultado.push({
        estudianteId: est.estudianteId,
        nombre: est.nombre,
        definitivas,
        periodoSiguiente: siguiente,
        notaNecesaria: r.minimo,
        estadoNecesaria: r.estado,
        completo: false,
        promedioFinal: null,
        aprobado: null,
      })
    } else {
      // COMPLETO: todos los periodos >= el actual ya calificados (o P4 pasado):
      // promedio final ponderado con los pesos reales de TODO el año
      let sumaP = 0, sumaW = 0
      for (let p = 1; p <= 4; p++) {
        const w = parseFloat(pesos[p])
        const d = definitivas[p - 1]
        if (d !== null && d !== undefined && !isNaN(w)) { sumaP += d * w; sumaW += w }
      }
      const promedioFinal = sumaW > 0 ? parseFloat((sumaP / sumaW).toFixed(2)) : null
      resultado.push({
        estudianteId: est.estudianteId,
        nombre: est.nombre,
        definitivas,
        periodoSiguiente: null,
        notaNecesaria: null,
        estadoNecesaria: 'COMPLETO',
        completo: true,
        promedioFinal,
        aprobado: promedioFinal !== null ? promedioFinal >= 3.0 : null,
      })
    }
  }
  return resultado
}

module.exports = { calcularMinimoRequerido, calcularConsolidado }
