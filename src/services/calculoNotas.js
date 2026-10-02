// Cálculo compartido de la definitiva de una materia a partir de los
// items de nota. Misma fuente de verdad para el guardado del docente
// (notas.js), el reporte de corte (reporteCorte.js) y el visor de notas
// del admin (admin.js).
//
// items: [{ tipo: 'ACTITUDINAL'|'RESPONSABILIDAD'|'ACTIVIDAD'|'EVALUACION', valor }]
// Pesos: actitudinal 25%, responsabilidad 25%, actividad 35%, evaluación 15%.
function calcularDefinitiva(items) {
  if (!items || items.length === 0) return null

  const v = arr => arr.filter(v => v !== null && v !== undefined)
  const actitudinales  = v(items.filter(i => i.tipo === 'ACTITUDINAL').map(i => i.valor))
  const responsabilidades = v(items.filter(i => i.tipo === 'RESPONSABILIDAD').map(i => i.valor))
  const actividades    = v(items.filter(i => i.tipo === 'ACTIVIDAD').map(i => i.valor))
  const evaluaciones   = v(items.filter(i => i.tipo === 'EVALUACION').map(i => i.valor))

  const promAct = actitudinales.length > 0 ? actitudinales.reduce((a, b) => a + b, 0) / actitudinales.length : 0
  const promResp = responsabilidades.length > 0 ? responsabilidades.reduce((a, b) => a + b, 0) / responsabilidades.length : 0
  const promActv = actividades.length > 0 ? actividades.reduce((a, b) => a + b, 0) / actividades.length : 0
  const evalUnica = evaluaciones.length > 0 ? evaluaciones[0] : 0

  return parseFloat((
    (promAct * 0.25) +
    (promResp * 0.25) +
    (promActv * 0.35) +
    (evalUnica * 0.15)
  ).toFixed(2))
}

module.exports = { calcularDefinitiva }
