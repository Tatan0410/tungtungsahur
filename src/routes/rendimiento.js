// =====================================================
// src/routes/rendimiento.js — Fase 3A: panel de rendimiento
// del director de grupo.
//
//  * GET /api/rendimiento/curso?curso&anio — vista global del curso
//    (uso interno del director).
//  * GET /api/rendimiento/estudiante?estudianteId&anio — vista individual
//    para la reunión con padres: SOLO datos de ese estudiante + agregados
//    anónimos del curso (promedio por materia; null si el curso tiene
//    menos de 5 activos, para no identificar a nadie).
//
// Composición SIN duplicar fórmulas:
//  * nivelDeDesempeno — la de notas.js (exportada, el test M12 exige una
//    sola definición).
//  * calcularConsolidado — por materia: da las definitivas P1-P4 y el
//    promedioFinal anual ponderado con los pesos REALES de la sede.
//  * resumenAsistenciaEstudiante — helper compartido de asistencia.js.
// El "promedio general" del estudiante es el mismo enfoque del boletín
// (AVG simple de definitivas, notas.js) aplicado a la definitiva VIGENTE
// de cada materia: composición de datos, no una fórmula nueva de nota.
// =====================================================
const express = require('express')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')
const { calcularConsolidado } = require('../services/consolidado')
const { nivelDeDesempeno } = require('./notas')
const { resumenAsistenciaEstudiante } = require('./asistencia')

const db = prisma._db
const router = express.Router()

function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'Acceso denegado. Inicia sesión primero.' })
  }
  try {
    const token  = authHeader.split(' ')[1]
    const datos  = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })
    req.usuario  = datos
    next()
  } catch {
    return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' })
  }
}

router.use(verificarToken)

// Cursos que dirige (del token, NUNCA del cliente)
async function cursosDeDirector(docenteId) {
  const filas = await db.prepare('SELECT curso FROM directores_grupo WHERE docenteId = ?').all(docenteId)
  return filas.map(f => f.curso)
}

// Año en curso en America/Bogota (UTC-5 fijo, como hoyBogotaUI del frontend)
function anioBogota() {
  return Number(new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 4))
}

function anioValidoOError(req, res) {
  const crudo = req.query.anio
  if (crudo === undefined || crudo === '') return anioBogota()
  const anio = parseInt(crudo, 10)
  if (Number.isNaN(anio) || anio < 2020 || anio > 2100) {
    res.status(400).json({ error: 'El año debe estar entre 2020 y 2100' })
    return null
  }
  return anio
}

// La definitiva VIGENTE de un arreglo [P1..P4]: la del período con nota más
// alto (dato directo de calificaciones, sin recalcular nada).
function ultimaVigente(definitivas) {
  for (let p = 4; p >= 1; p--) {
    if (definitivas[p - 1] !== null && definitivas[p - 1] !== undefined) return definitivas[p - 1]
  }
  return null
}

function promedio(vals) {
  const con = vals.filter(v => v !== null && v !== undefined && !Number.isNaN(Number(v)))
  if (!con.length) return null
  return parseFloat((con.reduce((a, b) => a + Number(b), 0) / con.length).toFixed(2))
}

// calcularConsolidado por materia del curso. El panel solo consume
// definitivas y promedioFinal, que NO dependen de periodoActual (ese
// parámetro solo afecta notaNecesaria/periodoSiguiente), así que se fija
// en 1: con el año completo el bloque COMPLETO produce promedioFinal.
async function consolidadoDelCurso(curso, anio, materias) {
  const porMateria = []
  for (const mat of materias) {
    porMateria.push({
      materiaId: mat.materiaId,
      materiaNombre: mat.materiaNombre,
      filas: await calcularConsolidado(db, curso, mat.materiaId, anio, 1),
    })
  }
  return porMateria
}

function distribucionNivel(valores) {
  const dist = { BAJO: 0, 'BÁSICO': 0, ALTO: 0, SUPERIOR: 0 }
  let total = 0
  for (const v of valores) {
    if (v === null || v === undefined) continue
    const nivel = nivelDeDesempeno(v)
    if (dist[nivel] === undefined) continue
    dist[nivel]++
    total++
  }
  dist.total = total
  return dist
}

// Tendencia del estudiante entre los dos últimos períodos con notas
// (a nivel de todas sus materias): presentación, no fórmula de nota.
function tendencia(definitivasPorMateria) {
  const periodosConNota = new Set()
  for (const d of definitivasPorMateria) {
    for (let p = 1; p <= 4; p++) {
      if (d[p - 1] !== null && d[p - 1] !== undefined) periodosConNota.add(p)
    }
  }
  const ordenados = [...periodosConNota].sort((a, b) => a - b)
  if (ordenados.length < 2) return null
  const ultimo = ordenados[ordenados.length - 1]
  const anterior = ordenados[ordenados.length - 2]
  const promUlt = promedio(definitivasPorMateria.map(d => d[ultimo - 1]))
  const promAnt = promedio(definitivasPorMateria.map(d => d[anterior - 1]))
  if (promUlt === null || promAnt === null) return null
  const delta = parseFloat((promUlt - promAnt).toFixed(2))
  if (delta >= 0.3) return 'mejora'
  if (delta <= -0.3) return 'baja'
  return 'estable'
}

// ─── (a) GET /api/rendimiento/curso — vista global, uso interno ───
router.get('/curso', async (req, res) => {
  try {
    const curso = String(req.query.curso || '').trim()
    if (!curso) return res.status(400).json({ error: 'curso es requerido' })
    const anio = anioValidoOError(req, res)
    if (anio === null) return

    if (req.usuario.rol === 'DOCENTE') {
      const cursos = await cursosDeDirector(req.usuario.docenteId)
      if (!cursos.includes(curso)) {
        return res.status(403).json({ error: 'No eres el director de grupo de este curso' })
      }
    } else if (req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo el director de grupo puede ver el rendimiento' })
    }

    const materias = await db.prepare(`
      SELECT DISTINCT dm.materiaId, m.nombre AS "materiaNombre"
      FROM docente_materias dm JOIN materias m ON m.id = dm.materiaId
      WHERE dm.curso = ?
      ORDER BY m.nombre ASC
    `).all(curso)
    const activos = await db.prepare(`
      SELECT e.id AS "estudianteId", u.nombre
      FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
      WHERE e.curso = ? AND u.activo = 1
      ORDER BY u.nombre ASC
    `).all(curso)
    if (!activos.length) return res.status(404).json({ error: 'Curso sin estudiantes activos' })

    const consolidado = await consolidadoDelCurso(curso, anio, materias)

    // Por materia: promedio del curso por período, definitivo ponderado
    // (promedioFinal oficial del consolidado) y distribución por nivel
    // sobre la definitiva VIGENTE de cada estudiante.
    const porMateria = consolidado.map(c => {
      const promPorPeriodo = {}
      for (let p = 1; p <= 4; p++) {
        promPorPeriodo[String(p)] = promedio(c.filas.map(f => f.definitivas[p - 1]))
      }
      const finales = c.filas.map(f => f.promedioFinal).filter(v => v !== null)
      return {
        materiaId: c.materiaId,
        materiaNombre: c.materiaNombre,
        promedioPorPeriodo: promPorPeriodo,
        definitivoPonderado: finales.length ? parseFloat((finales.reduce((a, b) => a + b, 0) / finales.length).toFixed(2)) : null,
        distribucion: distribucionNivel(c.filas.map(f => ultimaVigente(f.definitivas))),
      }
    })

    // Por estudiante: promedio general (AVG de definitivas vigentes, el
    // enfoque del boletín), nivel, materias en riesgo (< 3.0) y tendencia.
    const porEstudiante = activos.map(e => {
      const filasDelEstudiante = consolidado.map(c => c.filas.find(f => f.estudianteId === e.estudianteId)).filter(Boolean)
      const vigentes = filasDelEstudiante.map(f => ultimaVigente(f.definitivas))
      const promGeneral = promedio(vigentes)
      return {
        estudianteId: e.estudianteId,
        nombre: e.nombre,
        promedioGeneral: promGeneral,
        nivel: promGeneral !== null ? nivelDeDesempeno(promGeneral) : null,
        materiasEnRiesgo: vigentes.filter(v => v !== null && v < 3.0).length,
        tendencia: tendencia(filasDelEstudiante.map(f => f.definitivas)),
      }
    })

    res.json({
      curso, anio,
      uso: 'interno',
      porMateria,
      distribucionGeneral: distribucionNivel(porEstudiante.map(e => e.promedioGeneral)),
      porEstudiante,
    })
  } catch (error) {
    console.error('Error GET /rendimiento/curso:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── (b) GET /api/rendimiento/estudiante — vista individual (padres) ───
router.get('/estudiante', async (req, res) => {
  try {
    const estudianteId = String(req.query.estudianteId || '').trim()
    if (!estudianteId) return res.status(400).json({ error: 'estudianteId es requerido' })
    const anio = anioValidoOError(req, res)
    if (anio === null) return

    // El curso del estudiante sale de la BD, jamás del cliente
    const est = await db.prepare(`
      SELECT e.curso, u.nombre, e.sede
      FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
      WHERE e.id = ?
    `).get(estudianteId)

    if (!est) {
      // ADMIN: 404 (puede saber que no existe). DIRECTOR: 403 (no revelar
      // la existencia de estudiantes de otros cursos).
      if (req.usuario.rol === 'ADMIN') return res.status(404).json({ error: 'Estudiante no encontrado' })
      return res.status(403).json({ error: 'No eres el director de grupo de este estudiante' })
    }
    if (req.usuario.rol === 'DOCENTE') {
      const cursos = await cursosDeDirector(req.usuario.docenteId)
      if (!cursos.includes(est.curso)) {
        return res.status(403).json({ error: 'No eres el director de grupo de este estudiante' })
      }
    } else if (req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo el director de grupo puede ver el rendimiento' })
    }

    const materias = await db.prepare(`
      SELECT DISTINCT dm.materiaId, m.nombre AS "materiaNombre"
      FROM docente_materias dm JOIN materias m ON m.id = dm.materiaId
      WHERE dm.curso = ?
      ORDER BY m.nombre ASC
    `).all(est.curso)
    const activos = await db.prepare(`
      SELECT COUNT(*) AS c
      FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
      WHERE e.curso = ? AND u.activo = 1
    `).get(est.curso)
    const totalActivos = Number(activos.c)
    // Menos de 5 activos: sin comparación (un promedio de 4 o menos
    // "compañeros" puede identificar a cualquiera de ellos).
    const comparacionDisponible = totalActivos >= 5

    const consolidado = await consolidadoDelCurso(est.curso, anio, materias)

    const porMateria = consolidado.map(c => {
      const mia = c.filas.find(f => f.estudianteId === estudianteId)
      const definitivas = mia ? mia.definitivas : [null, null, null, null]
      const vigente = ultimaVigente(definitivas)
      const promedioCurso = comparacionDisponible
        ? promedio(c.filas.map(f => ultimaVigente(f.definitivas)))
        : null
      return {
        materiaId: c.materiaId,
        materiaNombre: c.materiaNombre,
        definitivas: { '1': definitivas[0], '2': definitivas[1], '3': definitivas[2], '4': definitivas[3] },
        definitivoPonderado: mia ? mia.promedioFinal : null,
        nivel: vigente !== null ? nivelDeDesempeno(vigente) : null,
        promedioCurso,
      }
    })

    const vigentes = porMateria.map(m => ultimaVigente([m.definitivas['1'], m.definitivas['2'], m.definitivas['3'], m.definitivas['4']]))

    // Promedio por período: la MISMA aritmética del promedio general del
    // boletín (notas.js:1937-1941: AVG(definitiva) simple de las materias
    // del curso con nota EN ese período; null si ninguna la tiene),
    // calculada en memoria sobre el consolidado ya obtenido (sin consultas
    // nuevas). Es el valor que calza 1:1 con un boletín impreso.
    const promedioPorPeriodo = {}
    const nivelPorPeriodo = {}
    for (let p = 1; p <= 4; p++) {
      const prom = promedio(porMateria.map(m => m.definitivas[String(p)]))
      promedioPorPeriodo[String(p)] = prom
      nivelPorPeriodo[String(p)] = prom !== null ? nivelDeDesempeno(prom) : null
    }

    // promedioVigente (antes promedioGeneral): promedio de las definitivas
    // VIGENTES (la última con nota de cada materia). NO es el promedio del
    // boletín: el boletín promedia las notas DE un período fijo (AVG de
    // definitivas del período), así que a mitad de año difieren cuando las
    // materias tienen distintos períodos con nota. Es un valor REFERENCIAL
    // del estado actual del año; para comparar contra un boletín impreso
    // está promedioPorPeriodo.
    const promedioVigente = promedio(vigentes)

    // Asistencia del año: desde anio-01-01 hasta el MENOR entre hoy
    // (Bogotá) y anio-12-31. Si anio es futuro (desde > hasta) → vacía
    // (totales en 0, listas vacías), sin error.
    const hoyBog = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10)
    const desdeAsistencia = anio + '-01-01'
    const hastaAsistencia = [hoyBog, anio + '-12-31'].sort()[0]
    let asistencia
    if (desdeAsistencia > hastaAsistencia) {
      asistencia = { totales: { ausencias: 0, tardanzas: 0, excusas: 0 }, porMateria: [], ultimas: [] }
    } else {
      asistencia = await resumenAsistenciaEstudiante(db, estudianteId, est.curso, desdeAsistencia, hastaAsistencia)
    }

    res.json({
      estudiante: { nombre: est.nombre, curso: est.curso },
      anio,
      uso: 'reunion-padres',
      comparacionDisponible,
      porMateria,
      promedioPorPeriodo,
      nivelPorPeriodo,
      promedioVigente,
      nivel: promedioVigente !== null ? nivelDeDesempeno(promedioVigente) : null,
      materiasEnRiesgo: vigentes.filter(v => v !== null && v < 3.0).length,
      asistencia,
    })
  } catch (error) {
    console.error('Error GET /rendimiento/estudiante:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
