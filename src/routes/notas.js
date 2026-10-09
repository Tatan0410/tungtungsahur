const express = require('express')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')
const { calcularReporteCorte, calcularReporteCorteEstudiante } = require('../services/reporteCorte')
const { calcularDefinitiva } = require('../services/calculoNotas')
const { calcularConsolidado } = require('../services/consolidado')
const { verificarDocenteAsignado, docentePuedeVerEstudiante } = require('../services/autorizacion')

// Mismo adaptador que el resto de la app (SQLite local / Postgres en Supabase)
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

async function obtenerPesosPeriodos(anio, sede) {
  try {
    const rows = await prisma._db.prepare('SELECT periodo, peso FROM periodos_config WHERE anio = ? AND sede = ?').all(anio, sede)
    if (rows.length > 0) {
      const pesos = {}
      for (const r of rows) pesos[r.periodo] = r.peso
      return pesos
    }
  } catch {}
  return { 1: 0.20, 2: 0.30, 3: 0.20, 4: 0.30 }
}

async function periodoAbierto(anio, sede, periodo) {
  try {
    const cfg = await prisma._db.prepare(
      'SELECT abierto, fecha_fin, reapertura_manual FROM periodos_config WHERE anio = ? AND sede = ? AND periodo = ?'
    ).get(anio, sede, periodo)
    if (!cfg) return true
    if (!cfg.abierto) return false
    if (cfg.fecha_fin) {
      const finDate = new Date(cfg.fecha_fin + 'T23:59:59')
      if (finDate < new Date() && !cfg.reapertura_manual) {
        return false
      }
    }
    return true
  } catch { return true }
}

function agruparItems(items) {
  const grupos = { ACTITUDINAL: [], RESPONSABILIDAD: [], ACTIVIDAD: [], EVALUACION: [] }
  for (const item of items) {
    if (grupos[item.tipo]) {
      grupos[item.tipo].push(item)
    }
  }
  return grupos
}

function promediarGrupo(items) {
  if (!items || items.length === 0) return 0
  return items.reduce((a, b) => a + b.valor, 0) / items.length
}

function calcularEstado(definitiva) {
  if (definitiva === null || definitiva === undefined) return 'SIN_NOTA'
  if (definitiva >= 3.5) return 'APROBADO'
  if (definitiva >= 3.0) return 'EN_RIESGO'
  return 'REPROBADO'
}

// ─── BOOTSTRAP DEL PORTAL DEL ESTUDIANTE ───
// Una sola llamada devuelve todo el portal (notas, áreas, corte, observaciones,
// período activo). Reduce la ráfaga de resultados de 5 requests por estudiante
// a 2 (login + bootstrap): el checkpoint de Vercel cuenta requests por IP, así
// la ráfaga de 800 pasa de ~4.000 requests a ~1.600.
// Las funciones compartidas garantizan respuestas IDÉNTICAS a los endpoints
// individuales, que siguen vivos para el selector de períodos P1-P4.

// Período activo con las mismas reglas del frontend (portadas al servidor):
//   1. El período que contenga HOY entre fecha_inicio y fecha_fin
//   2. El de MAYOR número con abierto=true (cubre reabiertos)
//   3. El de mayor número configurado
//   4. 1 (solo si no hay configuración)
// Lee por la caché de 60 s de /api/config/periodos (obtenerPeriodos) — es la
// MISMA tabla; cerrar/reabrir desde el admin la invalida igual.
const { obtenerPeriodos } = require('../services/cachePeriodos')

async function determinarPeriodoActivoServidor(db, sede, anio) {
  let periodos = await obtenerPeriodos(db, anio, sede)
  if (!periodos.length && sede) periodos = await obtenerPeriodos(db, anio)
  if (!periodos.length) return 1
  const hoy = new Date().toISOString().slice(0, 10)
  const dentro = periodos.find(p => p.abierto && p.fecha_inicio && p.fecha_fin && hoy >= p.fecha_inicio && hoy <= p.fecha_fin)
  if (dentro) return dentro.periodo
  const abiertos = periodos.filter(p => p.abierto)
  if (abiertos.length) return Math.max(...abiertos.map(p => p.periodo))
  return Math.max(...periodos.map(p => p.periodo))
}

// Núcleo de GET /mis-notas (sin el role-check): compartido con el bootstrap
async function obtenerMisNotas(estudianteId, periodo, anio) {
  // Upsert ATOMICO: findUnique->create->update tenia carrera con refrescos
  // rapidos (dos peticiones concurrentes creaban la consulta y una reventaba
  // con UNIQUE -> 500 intermitente). El upsert es una sola operacion.
  const consulta = await prisma.consultaEstudiante.upsert({
    where: { estudianteId_periodo_anio: { estudianteId, periodo, anio } },
    update: { cantidad: { increment: 1 } },
    create: { estudianteId, periodo, anio, cantidad: 1 },
  })

  const calificaciones = await prisma.calificacion.findMany({
    where: { estudianteId, periodo, anio },
    include: {
      materia: { select: { nombre: true, grado: true } },
      notasItems: true,
    },
    orderBy: {
      materia: { nombre: 'asc' }
    }
  })

  const notas = calificaciones
    .map(c => c.definitiva)
    .filter(n => n !== null)

  const promedio = notas.length > 0
    ? (notas.reduce((a, b) => a + b, 0) / notas.length).toFixed(2)
    : null

  return {
    periodo,
    anio,
    consultasUsadas: consulta.cantidad,
    promedio,
    calificaciones: calificaciones.map(c => {
      const grupos = agruparItems(c.notasItems)
      return {
        materia:         c.materia.nombre,
        items:           c.notasItems,
        grupos: {
          actitudinal:   { items: grupos.ACTITUDINAL,   promedio: promediarGrupo(grupos.ACTITUDINAL) },
          responsabilidad: { items: grupos.RESPONSABILIDAD, promedio: promediarGrupo(grupos.RESPONSABILIDAD) },
          actividades:   { items: grupos.ACTIVIDAD,     promedio: promediarGrupo(grupos.ACTIVIDAD) },
          evaluacion:    { items: grupos.EVALUACION,    promedio: promediarGrupo(grupos.EVALUACION) },
        },
        definitiva:      c.definitiva,
        estado:          calcularEstado(c.definitiva),
      }
    }),
  }
}

// Núcleo de GET /mis-areas (sin el role-check): compartido con el bootstrap
async function obtenerMisAreas(estudianteId, periodo, anio) {
  const cursoRow = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(estudianteId)
  if (!cursoRow) return { areas: [] }

  const areas = await prisma._db.prepare(`
    SELECT a.id AS "areaId", a.nombre
    FROM area_cursos ac JOIN areas a ON a.id = ac.areaid
    WHERE ac.curso = ?
    ORDER BY a.nombre ASC, a.creadoen ASC
  `).all(cursoRow.curso)

    const resultado = []
    // RENDIMIENTO (antes: 1 query de materias por área + 1 de calificación y
    // 1 de items POR materia — con 4 áreas × 5 materias eran 25-30 queries).
    // Ahora: 3 consultas totales con IN, cruzadas en memoria.
    let materiasPorArea = new Map()
    let calPorMateria = new Map()
    let itemsPorCal = new Map()
    if (areas.length) {
      const areasIds = areas.map(a => a.areaId)
      const marcasA = areasIds.map(() => '?').join(',')
      const todasMaterias = await prisma._db.prepare(`
        SELECT am.areaid AS "areaId", am.materiaid AS "materiaId", am.porcentaje, m.nombre AS "materiaNombre"
        FROM area_materias am JOIN materias m ON m.id = am.materiaId
        WHERE am.areaid IN (${marcasA})
        ORDER BY am.porcentaje DESC, m.nombre ASC
      `).all(...areasIds)
      for (const m of todasMaterias) {
        if (!materiasPorArea.has(m.areaId)) materiasPorArea.set(m.areaId, [])
        materiasPorArea.get(m.areaId).push(m)
      }

      // Todas las calificaciones del estudiante para el período, indexadas
      // por materia; los items solo de las que no tienen definitiva cerrada
      const calsEstudiante = await prisma._db.prepare(
        'SELECT id, materiaId, definitiva FROM calificaciones WHERE estudianteId = ? AND periodo = ? AND anio = ?'
      ).all(estudianteId, periodo, anio)
      calPorMateria = new Map(calsEstudiante.map(c => [c.materiaId, c]))
      const calsSinDefinitiva = calsEstudiante.filter(c => c.definitiva === null).map(c => c.id)
      if (calsSinDefinitiva.length) {
        const marcasC = calsSinDefinitiva.map(() => '?').join(',')
        const items = await prisma._db.prepare(
          `SELECT calificacionId, tipo, valor FROM notas_items WHERE calificacionId IN (${marcasC})`
        ).all(...calsSinDefinitiva)
        for (const it of items) {
          if (!itemsPorCal.has(it.calificacionId)) itemsPorCal.set(it.calificacionId, [])
          itemsPorCal.get(it.calificacionId).push({ tipo: it.tipo, valor: it.valor })
        }
      }
    }

    for (const a of areas) {
      const materias = materiasPorArea.get(a.areaId) || []

      const materiasData = []
      let sumaPonderada = 0
      let sumaPorcentajes = 0
      let parciales = false
      for (const m of materias) {
        const cal = calPorMateria.get(m.materiaId)
        let definitiva = cal ? cal.definitiva : null
        let provisional = false
        if (cal && definitiva === null) {
          const items = itemsPorCal.get(cal.id) || []
          if (items.length) {
            definitiva = calcularDefinitiva(items)
            provisional = definitiva !== null
          }
        }
        if (definitiva !== null) {
          sumaPonderada += definitiva * m.porcentaje
          sumaPorcentajes += m.porcentaje
          if (provisional) parciales = true
        }
        materiasData.push({
          materiaId: m.materiaId,
          materiaNombre: m.materiaNombre,
          porcentaje: m.porcentaje,
          definitiva,
          provisional,
          estado: definitiva === null ? 'SIN_NOTA' : (definitiva < 3.0 ? 'RIESGO' : 'APROBADO'),
        })
      }

      // Promedio ponderado por I.H.S.: Σ(nota × horas) / Σ(horas).
      // El campo "porcentaje" en la BD ahora son horas semanales (I.H.S.),
      // y el % de cada materia se deriva automáticamente:
      //   % = horas_materia / total_horas × 100
      // La fórmula es la misma: Σ(nota×peso)/Σ(pesos) — solo cambia
      // la interpretación del campo (horas, no % pre-calculado).
      const promedio = sumaPorcentajes > 0 ? parseFloat((sumaPonderada / sumaPorcentajes).toFixed(2)) : null
      const todasConNota = materiasData.every(md => md.definitiva !== null)
      resultado.push({
        areaId: a.areaId,
        nombre: a.nombre,
        promedio,
        // Parcial: el promedio no es definitivo — o faltan materias o alguna
        // definitiva es provisional (calculada desde notas a medias)
        provisional: promedio !== null && (parciales || !todasConNota),
        completo: todasConNota,
        estado: promedio === null ? 'SIN_NOTA' : (promedio < 3.0 ? 'RIESGO' : 'APROBADO'),
        materias: materiasData,
      })
    }
    return { areas: resultado }
}

// Núcleo de GET /mi-reporte-corte (sin el role-check): compartido con el bootstrap
async function obtenerMiReporteCorte(estudianteId, periodo, anio) {
  const estudiante = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(estudianteId)
  if (!estudiante) {
    return { error: 404, mensaje: 'Datos de estudiante no encontrados' }
  }
  // RENDIMIENTO: versión por estudiante (3 queries) — antes calculaba el
  // reporte del curso COMPLETO y filtraba 1: el N+1 de la "carga eterna"
  const rep = await calcularReporteCorteEstudiante(estudianteId, estudiante.curso, parseInt(periodo), parseInt(anio))
  const reporte = rep
    .filter(r => r.estudianteId === estudianteId)
    .map(r => ({
      materiaId: r.materiaId,
      materiaNombre: r.materiaNombre,
      definitiva: r.definitiva,
      estado: r.estado
    }))

  const sedeRow = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(estudiante.curso)
  const sede = sedeRow ? sedeRow.sede : 'PPAL - TRIUNFO'
  const cfg = await prisma._db.prepare(
    'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
  ).get(sede, parseInt(periodo), parseInt(anio))
  const fechaCorte = cfg?.fecha_corte || null
  const yaPaso = fechaCorte ? new Date(fechaCorte) <= new Date() : false
  return { reporte, fechaCorte, yaPaso }
}

// Núcleo de GET /mis-observaciones (sin el role-check): compartido con el bootstrap
async function obtenerMisObservaciones(estudianteId) {
  return prisma._db.prepare(`
    SELECT o.id, o.texto, o.tipo, o.fecha, o.creadoEn, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre"
    FROM observaciones o
    LEFT JOIN materias m ON m.id = o.materiaId
    LEFT JOIN docentes d ON d.id = o.docenteId
    LEFT JOIN usuarios u ON u.id = d.usuarioId
    WHERE o.estudianteId = ?
    ORDER BY o.fecha DESC, o.creadoEn DESC
  `).all(estudianteId)
}

// BOOTSTRAP: todo el portal del estudiante en UNA llamada
router.get('/mi-bootstrap', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE' || !req.usuario.estudianteId) {
      return res.status(403).json({ error: 'Solo para estudiantes' })
    }
    const estudianteId = req.usuario.estudianteId
    const anio = parseInt(req.query.anio) || new Date().getFullYear()

    // Período activo (las mismas reglas del frontend, con la caché de 60 s)
    const est = await prisma._db.prepare('SELECT sede, curso FROM estudiantes WHERE id = ?').get(estudianteId)
    const periodo = await determinarPeriodoActivoServidor(prisma._db, est ? est.sede : null, anio)

    // Boletines publicados para SU curso (habilita el botón del portal):
    // global ('') o específico. 1 query — el botón se muestra si hay ≥ 1.
    const boletinesDisponibles = est
      ? (await prisma._db.prepare(
          "SELECT DISTINCT periodo FROM boletines_publicados WHERE anio = ? AND curso IN ('', ?) ORDER BY periodo"
        ).all(anio, est.curso)).map(r => r.periodo)
      : []

    const [notas, areas, corte, observaciones] = await Promise.all([
      obtenerMisNotas(estudianteId, periodo, anio),
      obtenerMisAreas(estudianteId, periodo, anio),
      obtenerMiReporteCorte(estudianteId, periodo, anio),
      obtenerMisObservaciones(estudianteId),
    ])

    if (corte.error) return res.status(corte.error).json({ error: corte.mensaje })
    res.json({
      periodoActivo: periodo,
      ...notas,
      areas: areas.areas,
      corte,
      observaciones,
      boletinesDisponibles,
    })
  } catch (error) {
    console.error('Error GET /mi-bootstrap:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Los boletines publicados para el curso del estudiante — lo usa el flujo
// fallback del portal (cuando el bootstrap falla) para pintar/ocultar el botón
router.get('/boletines-publicados', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE' || !req.usuario.estudianteId) {
      return res.status(403).json({ error: 'Solo para estudiantes' })
    }
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const est = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(req.usuario.estudianteId)
    const periodos = est
      ? (await prisma._db.prepare(
          "SELECT DISTINCT periodo FROM boletines_publicados WHERE anio = ? AND curso IN ('', ?) ORDER BY periodo"
        ).all(anio, est.curso)).map(r => r.periodo)
      : []
    res.json({ periodos })
  } catch (error) {
    console.error('Error GET /boletines-publicados:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Los endpoints individuales quedan como wrappers finos de las mismas
// funciones del bootstrap: respuestas idénticas por construcción
router.get('/mis-notas', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE') {
      return res.status(403).json({ error: 'Esta ruta es solo para estudiantes' })
    }
    const periodo = parseInt(req.query.periodo) || 1
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    res.json(await obtenerMisNotas(req.usuario.estudianteId, periodo, anio))
  } catch (error) {
    console.error('Error al obtener notas:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.get('/mis-consultas', async (req, res) => {
  if (req.usuario.rol !== 'ESTUDIANTE') {
    return res.status(403).json({ error: 'Solo para estudiantes' })
  }

  const estudianteId = req.usuario.estudianteId
  const periodo      = parseInt(req.query.periodo) || 1
  const anio         = parseInt(req.query.anio)    || new Date().getFullYear()

  const consulta = await prisma.consultaEstudiante.findUnique({
    where: { estudianteId_periodo_anio: { estudianteId, periodo, anio } }
  })

  res.json({
    consultasUsadas:    consulta?.cantidad || 0,
    consultasRestantes: 3 - (consulta?.cantidad || 0),
    consultasMaximas:   3,
  })
})

router.get('/grupo', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }

    const { curso, materiaId, periodo = 1, anio = new Date().getFullYear() } = req.query

    if (!curso || !materiaId) {
      return res.status(400).json({ error: 'Debes enviar curso y materiaId' })
    }

    // SEGURIDAD: el docente solo ve el grupo si tiene la materia asignada en ese curso
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const estudiantes = await prisma.estudiante.findMany({
      where: { curso, usuario: { activo: true } },
      include: {
        usuario: { select: { nombre: true } },
        calificaciones: {
          where: {
            materiaId,
            periodo: parseInt(periodo),
            anio:    parseInt(anio),
          },
          include: {
            notasItems: true,
          }
        }
      },
      orderBy: {
        usuario: { nombre: 'asc' }
      }
    })

    let periodInfo = null
    if (estudiantes.length > 0) {
      const sede = estudiantes[0].sede
      periodInfo = await prisma._db.prepare('SELECT nombre, fecha_inicio, fecha_fin, abierto, reapertura_manual FROM periodos_config WHERE anio = ? AND sede = ? AND periodo = ?').get(parseInt(anio), sede, parseInt(periodo))
    }

    res.json({
      estudiantes: estudiantes.map(est => {
        const cal = est.calificaciones[0]
        const grupos = cal ? agruparItems(cal.notasItems) : { ACTITUDINAL: [], RESPONSABILIDAD: [], ACTIVIDAD: [], EVALUACION: [] }

        return {
          estudianteId:    est.id,
          nombre:          est.usuario.nombre,
          documento:       est.documento,
          calificacionId:  cal?.id || null,
          definitiva:      cal?.definitiva || null,
          estado:          calcularEstado(cal?.definitiva),
          grupos: {
            actitudinal: {
              items:    grupos.ACTITUDINAL,
              promedio: promediarGrupo(grupos.ACTITUDINAL),
            },
            responsabilidad: {
              items:    grupos.RESPONSABILIDAD,
              promedio: promediarGrupo(grupos.RESPONSABILIDAD),
            },
            actividades: {
              items:    grupos.ACTIVIDAD,
              promedio: promediarGrupo(grupos.ACTIVIDAD),
            },
            evaluacion: {
              items:    grupos.EVALUACION,
              promedio: promediarGrupo(grupos.EVALUACION),
            },
          },
        }
      }),
      periodo: periodInfo,
    })

  } catch (error) {
    console.error('Error al obtener grupo:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.post('/items', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes pueden modificar notas' })
    }

    const { calificacionId, tipo, valor, descripcion } = req.body

    if (!calificacionId || !tipo || valor === undefined || valor === null) {
      return res.status(400).json({ error: 'calificacionId, tipo y valor son requeridos' })
    }

    if (valor < 0 || valor > 5) {
      return res.status(400).json({ error: 'La nota solo puede ir de 0 a 5' })
    }

    const tiposValidos = ['ACTITUDINAL', 'RESPONSABILIDAD', 'ACTIVIDAD', 'EVALUACION']
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: `Tipo inválido. Debe ser: ${tiposValidos.join(', ')}` })
    }

    // SEGURIDAD: el docente solo agrega notas a calificaciones de sus materias/cursos
    // (va antes de las validaciones de negocio: no filtrar información a quien
    // no debería operar este recurso)
    if (req.usuario.rol === 'DOCENTE') {
      const cal = await prisma._db.prepare(
        'SELECT c.materiaId, e.curso FROM calificaciones c JOIN estudiantes e ON e.id = c.estudianteId WHERE c.id = ?'
      ).get(calificacionId)
      if (!cal || !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, cal.materiaId, cal.curso))) {
        return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
      }
    }

    if (tipo === 'EVALUACION') {
       const existente = await prisma.notaItem.findFirst({
         where: { calificacionId, tipo: 'EVALUACION' }
       })
       if (existente) {
         return res.status(400).json({ error: 'Solo se permite una nota de evaluación. Edita la existente o elimínala primero.' })
       }
    } else {
      // La planilla es un modelo de columnas: un item sin título jamás tiene
      // celda (GET /columnas exige descripcion NOT NULL) pero SÍ cuenta para
      // la definitiva. Los tipos con columnas propias exigen título.
      if (!descripcion || !String(descripcion).trim()) {
        return res.status(400).json({ error: 'El título de la nota es requerido en esta columna' })
      }
      // Duplicado (calificacionId, tipo, descripcion): el índice UNIQUE lo
      // reventaba con un 500 crudo; se avisa claro para editar la existente.
      const dup = await prisma.notaItem.findFirst({
        where: { calificacionId, tipo, descripcion: String(descripcion).trim() }
      })
      if (dup) {
        return res.status(409).json({ error: 'Ya existe una nota con ese título en esta columna — edítala o elimínala primero' })
      }
    }

    const item = await prisma.notaItem.create({
      data: {
        calificacionId,
        tipo,
        valor: parseFloat(valor),
        descripcion: descripcion || null,
      }
    })

    const calificacion = await prisma.calificacion.findUnique({
      where: { id: calificacionId },
      include: { notasItems: true }
    })

    const definitiva = calcularDefinitiva(calificacion.notasItems)
    await prisma.calificacion.update({
      where: { id: calificacionId },
      data: { definitiva }
    })

    res.json({
      mensaje: 'Nota agregada',
      item,
      definitiva,
      estado: calcularEstado(definitiva),
    })

  } catch (error) {
    console.error('Error al crear item:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.put('/items/:id', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes pueden modificar notas' })
    }

    const { id } = req.params
    const { valor, descripcion } = req.body

    if (valor !== undefined && (valor < 0 || valor > 5)) {
      return res.status(400).json({ error: 'La nota solo puede ir de 0 a 5' })
    }

    const itemExistente = await prisma.notaItem.findUnique({ where: { id } })
    if (!itemExistente) {
      return res.status(404).json({ error: 'Item no encontrado' })
    }

    // SEGURIDAD: el docente solo edita notas de sus materias/cursos
    if (req.usuario.rol === 'DOCENTE') {
      const cal = await prisma._db.prepare(
        'SELECT c.materiaId, e.curso FROM calificaciones c JOIN estudiantes e ON e.id = c.estudianteId WHERE c.id = ?'
      ).get(itemExistente.calificacionId)
      if (!cal || !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, cal.materiaId, cal.curso))) {
        return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
      }
    }

    // Cambiar el título: los tipos con columnas propias no admiten vacío
    // (un item sin título es invisible en la planilla) ni duplicados
    // (el índice UNIQUE reventaba con un 500 crudo).
    if (descripcion !== undefined && itemExistente.tipo !== 'EVALUACION') {
      if (!descripcion || !String(descripcion).trim()) {
        return res.status(400).json({ error: 'El título de la nota es requerido en esta columna' })
      }
      const dup = await prisma.notaItem.findFirst({
        where: { calificacionId: itemExistente.calificacionId, tipo: itemExistente.tipo, descripcion: String(descripcion).trim() }
      })
      if (dup && dup.id !== id) {
        return res.status(409).json({ error: 'Ya existe una nota con ese título en esta columna — edítala o elimínala primero' })
      }
    }

    const updateData = {}
    if (valor !== undefined) updateData.valor = parseFloat(valor)
    if (descripcion !== undefined) updateData.descripcion = descripcion

    const item = await prisma.notaItem.update({
      where: { id },
      data: updateData,
    })

    const calificacion = await prisma.calificacion.findUnique({
      where: { id: item.calificacionId },
      include: { notasItems: true }
    })

    const definitiva = calcularDefinitiva(calificacion.notasItems)
    await prisma.calificacion.update({
      where: { id: calificacion.id },
      data: { definitiva }
    })

    res.json({
      mensaje: 'Nota actualizada',
      item,
      definitiva,
      estado: calcularEstado(definitiva),
    })

  } catch (error) {
    console.error('Error al actualizar item:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.delete('/items/:id', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes pueden modificar notas' })
    }

    const { id } = req.params
    const item = await prisma.notaItem.findUnique({ where: { id } })

    if (!item) {
      return res.status(404).json({ error: 'Item no encontrado' })
    }

    // SEGURIDAD: el docente solo elimina notas de sus materias/cursos
    if (req.usuario.rol === 'DOCENTE') {
      const cal = await prisma._db.prepare(
        'SELECT c.materiaId, e.curso FROM calificaciones c JOIN estudiantes e ON e.id = c.estudianteId WHERE c.id = ?'
      ).get(item.calificacionId)
      if (!cal || !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, cal.materiaId, cal.curso))) {
        return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
      }
    }

    await prisma.notaItem.delete({ where: { id } })

    const calificacion = await prisma.calificacion.findUnique({
      where: { id: item.calificacionId },
      include: { notasItems: true }
    })

    const definitiva = calcularDefinitiva(calificacion.notasItems)
    await prisma.calificacion.update({
      where: { id: calificacion.id },
      data: { definitiva }
    })

    res.json({
      mensaje: 'Nota eliminada',
      definitiva,
      estado: calcularEstado(definitiva),
    })

  } catch (error) {
    console.error('Error al eliminar item:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.put('/guardar', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes pueden guardar notas' })
    }

    const { estudianteId, materiaId, periodo, anio } = req.body
    const docenteId = req.usuario.docenteId

    if (!estudianteId || !materiaId || !periodo || !anio) {
      return res.status(400).json({ error: 'estudianteId, materiaId, periodo y anio son requeridos' })
    }

    const est = await prisma._db.prepare('SELECT sede, curso FROM estudiantes WHERE id = ?').get(estudianteId)
    const sede = est?.sede || 'PPAL - TRIUNFO'

    // SEGURIDAD: el docente solo guarda notas de sus materias/cursos
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, est?.curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    if (!(await periodoAbierto(parseInt(anio), sede, parseInt(periodo)))) {
      return res.status(403).json({ error: 'Este período está cerrado para esta sede' })
    }

    let calificacion = await prisma.calificacion.findUnique({
      where: {
        estudianteId_materiaId_periodo_anio: {
          estudianteId,
          materiaId,
          periodo: parseInt(periodo),
          anio: parseInt(anio),
        }
      },
      include: { notasItems: true }
    })

    if (!calificacion) {
      calificacion = await prisma.calificacion.create({
        data: {
          estudianteId,
          materiaId,
          docenteId,
          periodo: parseInt(periodo),
          anio: parseInt(anio),
        },
      })
      calificacion = await prisma.calificacion.findUnique({
        where: { id: calificacion.id },
        include: { notasItems: true }
      })
    }

    const definitiva = calcularDefinitiva(calificacion.notasItems)
    await prisma.calificacion.update({
      where: { id: calificacion.id },
      data: { definitiva }
    })

    res.json({
      mensaje: 'Calificación guardada',
      calificacionId: calificacion.id,
      definitiva,
      estado: calcularEstado(definitiva),
      grupos: {
        actitudinal:   (calificacion.notasItems || []).filter(i => i.tipo === 'ACTITUDINAL').length,
        responsabilidad: (calificacion.notasItems || []).filter(i => i.tipo === 'RESPONSABILIDAD').length,
        actividades:   (calificacion.notasItems || []).filter(i => i.tipo === 'ACTIVIDAD').length,
        evaluacion:    (calificacion.notasItems || []).filter(i => i.tipo === 'EVALUACION').length,
      }
    })

  } catch (error) {
    console.error('Error al guardar nota:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.get('/anual', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE') {
      return res.status(403).json({ error: 'Solo para estudiantes' })
    }

    const estudianteId = req.usuario.estudianteId
    const materiaId    = req.query.materiaId
    const anio         = parseInt(req.query.anio) || new Date().getFullYear()

    if (!materiaId) {
      return res.status(400).json({ error: 'materiaId es requerido' })
    }

    const calificaciones = await prisma.calificacion.findMany({
      where: { estudianteId, materiaId, anio },
      orderBy: { periodo: 'asc' }
    })

    const estudiante = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE id = ?').get(estudianteId)
    const sede = estudiante?.sede || 'PPAL - TRIUNFO'
    const pesos = await obtenerPesosPeriodos(anio, sede)

    const periodos = {}
    for (let p = 1; p <= 4; p++) {
      const cal = calificaciones.find(c => c.periodo === p)
      periodos[p] = {
        definitiva: cal?.definitiva || null,
      }
    }

    let anual = null
    let suma = 0
    let pesosSum = 0
    for (let p = 1; p <= 4; p++) {
      const cal = calificaciones.find(c => c.periodo === p)
      if (cal?.definitiva !== null && cal?.definitiva !== undefined) {
        const peso = pesos[p] || 0.25
        suma += cal.definitiva * peso
        pesosSum += peso
      }
    }
    if (pesosSum > 0) {
      anual = parseFloat((suma / pesosSum).toFixed(2))
    }

    res.json({
      materiaId,
      anio,
      periodos,
      definitivaAnual: anual,
      estadoAnual: calcularEstado(anual),
    })

  } catch (error) {
    console.error('Error al obtener nota anual:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.post('/bulk-update', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes pueden modificar notas' })
    }

    const items = req.body
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Se requiere un arreglo de items' })
    }

    const resultados = []
    for (const item of items) {
      const { calificacionId, tipo, valor } = item
      if (!calificacionId || !tipo || valor === undefined || valor === null) continue
      if (valor < 0 || valor > 5) continue

      const tiposValidos = ['ACTITUDINAL', 'RESPONSABILIDAD', 'ACTIVIDAD', 'EVALUACION']
      if (!tiposValidos.includes(tipo)) continue

      // SEGURIDAD: el docente solo modifica notas de sus materias/cursos
      if (req.usuario.rol === 'DOCENTE') {
        const cal = await prisma._db.prepare(
          'SELECT c.materiaId, e.curso FROM calificaciones c JOIN estudiantes e ON e.id = c.estudianteId WHERE c.id = ?'
        ).get(calificacionId)
        if (!cal || !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, cal.materiaId, cal.curso))) {
          resultados.push({ calificacionId, tipo, ignorado: true, error: 'No tienes asignada esa materia en ese curso' })
          continue
        }
      }

      if (tipo === 'EVALUACION') {
        const existente = await prisma.notaItem.findFirst({
          where: { calificacionId, tipo: 'EVALUACION' }
        })
        if (existente) {
          await prisma.notaItem.update({
            where: { id: existente.id },
            data: { valor: parseFloat(valor) }
          })
          resultados.push({ calificacionId, tipo, valor: parseFloat(valor), actualizado: true })
          continue
        }
      }

      if (tipo === 'ACTITUDINAL') {
        const existente = await prisma.notaItem.findFirst({
          where: { calificacionId, tipo: 'ACTITUDINAL' }
        })
        if (existente) {
          await prisma.notaItem.update({
            where: { id: existente.id },
            data: { valor: parseFloat(valor) }
          })
          resultados.push({ calificacionId, tipo, valor: parseFloat(valor), actualizado: true })
          continue
        }
      }

      const nuevoItem = await prisma.notaItem.create({
        data: {
          calificacionId,
          tipo,
          valor: parseFloat(valor),
          descripcion: null,
        }
      })
      resultados.push({ calificacionId, tipo, valor: parseFloat(valor), creado: true, id: nuevoItem.id })
    }

    const calIds = [...new Set(resultados.filter(r => !r.ignorado).map(r => r.calificacionId))]
    for (const calId of calIds) {
      const calificacion = await prisma.calificacion.findUnique({
        where: { id: calId },
        include: { notasItems: true }
      })
      if (calificacion) {
        const definitiva = calcularDefinitiva(calificacion.notasItems)
        await prisma.calificacion.update({
          where: { id: calId },
          data: { definitiva }
        })
      }
    }

    res.json({ mensaje: 'Cambios guardados', items: resultados })
  } catch (error) {
    console.error('Error en bulk-update:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.get('/columnas', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const { curso, materiaId, periodo = 1, anio = new Date().getFullYear() } = req.query
    if (!curso || !materiaId) return res.status(400).json({ error: 'curso y materiaId requeridos' })

    // SEGURIDAD: el docente solo ve columnas de materias/cursos asignados
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const TIPOS_CAT = ['ACTITUDINAL', 'RESPONSABILIDAD', 'ACTIVIDAD']
    const columnas = {}
    const p = parseInt(periodo)
    const a = parseInt(anio)

    for (const tipo of TIPOS_CAT) {
      const rows = await db.prepare(`
        SELECT DISTINCT titulo FROM (
          SELECT titulo FROM columnas WHERE curso = ? AND materiaId = ? AND periodo = ? AND anio = ? AND tipo = ?
          UNION
          SELECT ni.descripcion FROM notas_items ni
          JOIN calificaciones c ON c.id = ni.calificacionId
          JOIN estudiantes e ON e.id = c.estudianteId
          WHERE e.curso = ? AND c.materiaId = ? AND c.periodo = ? AND c.anio = ?
          AND ni.tipo = ? AND ni.descripcion IS NOT NULL AND ni.descripcion != ''
        ) ORDER BY titulo ASC
      `).all(curso, materiaId, p, a, tipo, curso, materiaId, p, a, tipo)
      columnas[tipo] = rows.map(r => r.titulo)
    }
    columnas['EVALUACION'] = []
    res.json({ columnas })
  } catch (error) {
    console.error('Error en GET /columnas:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.post('/columna', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const { curso, materiaId, periodo, anio, tipo, titulo } = req.body
    if (!curso || !materiaId || !tipo || !titulo || !titulo.trim()) {
      return res.status(400).json({ error: 'curso, materiaId, tipo y titulo son requeridos' })
    }
    if (tipo === 'EVALUACION') {
      return res.status(400).json({ error: 'No se pueden agregar columnas a Evaluación' })
    }
    const tiposValidos = ['ACTITUDINAL', 'RESPONSABILIDAD', 'ACTIVIDAD']
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido' })
    }

    // SEGURIDAD: el docente solo crea columnas en materias/cursos asignados
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const p = parseInt(periodo) || 1
    const a = parseInt(anio) || new Date().getFullYear()

    // ¿Ya existe una columna con ese título? Antes el ON CONFLICT DO NOTHING
    // tragaba el duplicado en silencio y respondía 200 "agregada" aunque no
    // creó nada: el docente veía el toast de éxito pero la columna jamás
    // aparecía en la planilla (el bug del botón "+ Agregar nota").
    const yaExiste = await db.prepare(
      'SELECT id FROM columnas WHERE curso = ? AND materiaId = ? AND periodo = ? AND anio = ? AND tipo = ? AND titulo = ?'
    ).get(curso, materiaId, p, a, tipo, titulo.trim())
    if (yaExiste) {
      return res.status(409).json({ error: `Ya existe una columna con el título "${titulo.trim()}" en este período` })
    }

    // ON CONFLICT DO NOTHING = INSERT OR IGNORE en ambos motores (requiere el
    // índice único columnas_unicas) — queda como red de seguridad ante carreras
    await db.prepare('INSERT INTO columnas (id, curso, materiaId, periodo, anio, tipo, titulo, creadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(require('crypto').randomUUID(), curso, materiaId, p, a, tipo, titulo.trim(), new Date().toISOString())

    res.json({ mensaje: `Columna "${titulo}" agregada` })
  } catch (error) {
    console.error('Error en POST /columna:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.put('/columna', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const { curso, materiaId, periodo, anio, tipo, tituloViejo, tituloNuevo } = req.body
    if (!curso || !materiaId || !tipo || !tituloViejo || !tituloNuevo || !tituloNuevo.trim()) {
      return res.status(400).json({ error: 'curso, materiaId, tipo, tituloViejo y tituloNuevo son requeridos' })
    }
    if (tipo === 'EVALUACION') {
      return res.status(400).json({ error: 'No se puede renombrar la columna de Evaluación' })
    }

    // SEGURIDAD: el docente solo renombra columnas de materias/cursos asignados
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const p = parseInt(periodo) || 1
    const a = parseInt(anio) || new Date().getFullYear()

    await db.prepare('UPDATE columnas SET titulo = ? WHERE curso = ? AND materiaId = ? AND periodo = ? AND anio = ? AND tipo = ? AND titulo = ?').run(tituloNuevo.trim(), curso, materiaId, p, a, tipo, tituloViejo)

    const result = await db.prepare(`
      UPDATE notas_items SET descripcion = ?
      WHERE calificacionId IN (
        SELECT c.id FROM calificaciones c
        JOIN estudiantes e ON e.id = c.estudianteId
        WHERE e.curso = ? AND c.materiaId = ? AND c.periodo = ? AND c.anio = ?
      ) AND tipo = ? AND descripcion = ?
    `).run(tituloNuevo.trim(), curso, materiaId, p, a, tipo, tituloViejo)

    res.json({ mensaje: `Columna renombrada a "${tituloNuevo}"`, actualizados: result.changes })
  } catch (error) {
    console.error('Error en PUT /columna:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.delete('/columna', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const { curso, materiaId, periodo, anio, tipo, titulo } = req.body
    if (!curso || !materiaId || !tipo || !titulo || !titulo.trim()) {
      return res.status(400).json({ error: 'curso, materiaId, tipo y titulo son requeridos' })
    }
    if (tipo === 'EVALUACION') {
      return res.status(400).json({ error: 'No se puede eliminar la columna de Evaluación' })
    }

    // SEGURIDAD: el docente solo elimina columnas de materias/cursos asignados
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const p = parseInt(periodo) || 1
    const a = parseInt(anio) || new Date().getFullYear()

    await db.prepare('DELETE FROM columnas WHERE curso = ? AND materiaId = ? AND periodo = ? AND anio = ? AND tipo = ? AND titulo = ?').run(curso, materiaId, p, a, tipo, titulo)

    // Get IDs of items to delete so we can recalculate definitivas
    const itemsToDelete = await db.prepare(`
      SELECT ni.id FROM notas_items ni
      JOIN calificaciones c ON c.id = ni.calificacionId
      JOIN estudiantes e ON e.id = c.estudianteId
      WHERE e.curso = ? AND c.materiaId = ? AND c.periodo = ? AND c.anio = ?
      AND ni.tipo = ? AND ni.descripcion = ?
    `).all(curso, materiaId, p, a, tipo, titulo)

    const calIds = new Set()
    for (const item of itemsToDelete) {
      const cal = await db.prepare('SELECT calificacionId FROM notas_items WHERE id = ?').get(item.id)
      if (cal) calIds.add(cal.calificacionId)
      await db.prepare('DELETE FROM notas_items WHERE id = ?').run(item.id)
    }

    // Recalculate definitivas
    for (const calId of calIds) {
      const cal = await prisma.calificacion.findUnique({ where: { id: calId }, include: { notasItems: true } })
      if (cal) {
        const definitiva = calcularDefinitiva(cal.notasItems)
        await prisma.calificacion.update({ where: { id: calId }, data: { definitiva } })
      }
    }

    res.json({ mensaje: `Columna "${titulo}" eliminada`, itemsEliminados: itemsToDelete.length, calificacionesActualizadas: calIds.size })
  } catch (error) {
    console.error('Error en DELETE /columna:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.post('/guardar-grid', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const { items } = req.body
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Se requiere un arreglo de items' })
    }

    // Defensa en profundidad: la nota solo puede ir de 0 a 5 (el frontend
    // ya lo restringe). Se valida TODA la tanda antes de tocar la BD:
    // una nota inválida no guarda nada, ni siquiera los items previos.
    for (const item of items) {
      const { valor } = item
      if (valor !== null && valor !== undefined && valor !== '') {
        const vNota = parseFloat(valor)
        if (isNaN(vNota) || vNota < 0 || vNota > 5) {
          return res.status(400).json({ error: 'La nota solo puede ir de 0 a 5' })
        }
      }
    }

    const claveDe = it => it.estudianteId + '_' + it.tipo + '_' + (it.titulo || '')
    const guardados = []
    const fallidos = []
    const advertencias = new Set()
    const grupos = new Map() // gKey → { estudianteId, materiaId, periodo, anio, items }

    // Memos POR PETICIÓN: una tanda típica repite el mismo estudiante (varias
    // columnas), la misma asignación y el mismo período decenas de veces —
    // validar cada item contra la BD era un N+1 (4 queries × N items).
    const memoEst = new Map()
    const memoAsignacion = new Map()
    const memoPeriodo = new Map()
    const memoCfg = new Map()

    // ── Fase 1: validaciones en JS, solo lecturas (nada se escribe aún) ──
    // Los fallos de esta fase se reportan por item sin tocar la BD.
    for (const item of items) {
      const { estudianteId, materiaId, periodo, anio, tipo, titulo, _delete } = item
      if (!estudianteId || !materiaId || !tipo) {
        fallidos.push({ clave: claveDe(item), error: 'Item incompleto (falta estudianteId, materiaId o tipo)' })
        continue
      }
      // La planilla es un modelo de columnas: sin título el item sería
      // invisible (Evaluación es la única columna fija, no lleva título)
      if (!_delete && tipo !== 'EVALUACION' && (!titulo || !titulo.trim())) {
        fallidos.push({ clave: claveDe(item), error: 'El título de la nota es requerido en esta columna' })
        continue
      }

      const p = parseInt(periodo) || 1
      const a = parseInt(anio) || new Date().getFullYear()

      if (!memoEst.has(estudianteId)) {
        memoEst.set(estudianteId, await prisma._db.prepare('SELECT sede, curso FROM estudiantes WHERE id = ?').get(estudianteId))
      }
      const est = memoEst.get(estudianteId)
      if (!est) {
        fallidos.push({ clave: claveDe(item), error: 'Estudiante no encontrado' })
        continue
      }

      // SEGURIDAD (IDOR): un docente NO puede guardar notas de una materia/
      // curso que no tiene asignada
      if (req.usuario.rol === 'DOCENTE') {
        const claveAsig = req.usuario.docenteId + '|' + materiaId + '|' + est.curso
        if (!memoAsignacion.has(claveAsig)) {
          memoAsignacion.set(claveAsig, await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, est.curso))
        }
        if (!memoAsignacion.get(claveAsig)) {
          fallidos.push({ clave: claveDe(item), error: 'No tienes asignada la materia en el curso ' + est.curso })
          continue
        }
      }

      // Período cerrado manualmente → este item no se guarda
      const clavePeriodo = a + '|' + est.sede + '|' + p
      if (!memoPeriodo.has(clavePeriodo)) {
        memoPeriodo.set(clavePeriodo, await periodoAbierto(a, est.sede, p))
      }
      if (!memoPeriodo.get(clavePeriodo)) {
        fallidos.push({ clave: claveDe(item), error: 'El período ' + p + ' está cerrado para esta sede' })
        continue
      }

      // Fecha límite pasada pero período reabierto → advertir (informativo)
      if (!memoCfg.has(clavePeriodo)) {
        memoCfg.set(clavePeriodo, await prisma._db.prepare('SELECT fecha_fin, reapertura_manual FROM periodos_config WHERE anio = ? AND sede = ? AND periodo = ?').get(a, est.sede, p))
      }
      const cfg = memoCfg.get(clavePeriodo)
      if (cfg?.fecha_fin) {
        const fechaFin = new Date(cfg.fecha_fin)
        if (fechaFin < new Date() && cfg.reapertura_manual) {
          advertencias.add('⚠️ El corte final ya pasó, pero el período fue reabierto manualmente. Guarda tus notas pronto.')
        }
      }

      // Agrupar por calificación: una sola transacción corta por grupo
      const gKey = estudianteId + '|' + materiaId + '|' + p + '|' + a
      if (!grupos.has(gKey)) {
        grupos.set(gKey, { estudianteId, materiaId, periodo: p, anio: a, items: [] })
      }
      grupos.get(gKey).items.push(item)
    }

    // ── Fase 2: una transacción CORTA por calificación ──
    // El pooler de Supabase mata transacciones largas: cada grupo son pocos
    // round-trips y commitea solo. Un error SQL revienta la transacción del
    // grupo (rollback completo de ESA unidad) y se reporta como fallido de
    // sus items; los demás grupos ya commiteados no se deshacen. NUNCA se
    // captura por sentencia dentro de la transacción: en Postgres una
    // sentencia fallida aborta toda la transacción.
    for (const grupo of grupos.values()) {
      const clavesGrupo = grupo.items.map(claveDe)
      try {
        await prisma._db.transaction(async () => {
          let cal = await prisma.calificacion.findUnique({
            where: { estudianteId_materiaId_periodo_anio: { estudianteId: grupo.estudianteId, materiaId: grupo.materiaId, periodo: grupo.periodo, anio: grupo.anio } }
          })

          for (const item of grupo.items) {
            const { tipo, titulo, valor, _delete } = item

            if (_delete) {
              // Un _delete sobre una calificación inexistente no tiene nada
              // que borrar: crear la fila solo para dejarla vacía genera
              // "contenedores basura"
              if (!cal) continue
              if (tipo === 'EVALUACION') {
                const existente = await prisma.notaItem.findFirst({ where: { calificacionId: cal.id, tipo: 'EVALUACION' } })
                if (existente) await prisma.notaItem.delete({ where: { id: existente.id } })
              } else if (titulo && titulo.trim()) {
                const existente = await prisma.notaItem.findFirst({ where: { calificacionId: cal.id, tipo, descripcion: titulo.trim() } })
                if (existente) await prisma.notaItem.delete({ where: { id: existente.id } })
              }
              // Si la calificación quedó sin items y sin definitiva cerrada:
              // borrar también la fila contenedora. Si tiene definitiva
              // cerrada, se queda (el docente la cerró).
              const restantes = await prisma.notaItem.findMany({ where: { calificacionId: cal.id } })
              if (restantes.length === 0 && cal.definitiva === null) {
                await prisma.calificacion.delete({ where: { id: cal.id } })
                cal = null
              }
            } else {
              if (valor === undefined || valor === null) continue
              // El 0 es válido (rango 0-5, coherente con el frontend)
              if (valor < 0 || valor > 5) continue
              if (!cal) {
                cal = await prisma.calificacion.create({
                  data: { estudianteId: grupo.estudianteId, materiaId: grupo.materiaId, docenteId: req.usuario.docenteId, periodo: grupo.periodo, anio: grupo.anio }
                })
              }
              if (tipo === 'EVALUACION') {
                const existente = await prisma.notaItem.findFirst({ where: { calificacionId: cal.id, tipo: 'EVALUACION' } })
                if (existente) {
                  await prisma.notaItem.update({ where: { id: existente.id }, data: { valor: parseFloat(valor) } })
                } else {
                  await prisma.notaItem.create({ data: { calificacionId: cal.id, tipo: 'EVALUACION', valor: parseFloat(valor), descripcion: null } })
                }
              } else {
                const existente = await prisma.notaItem.findFirst({ where: { calificacionId: cal.id, tipo, descripcion: titulo.trim() } })
                if (existente) {
                  await prisma.notaItem.update({ where: { id: existente.id }, data: { valor: parseFloat(valor) } })
                } else {
                  await prisma.notaItem.create({ data: { calificacionId: cal.id, tipo, valor: parseFloat(valor), descripcion: titulo.trim() } })
                }
              }
            }
          }

          // Recalcular la definitiva dentro de la MISMA transacción (pocos
          // round-trips) — si el grupo quedó sin calificación, nada que
          // recalcular
          if (cal) {
            const calCompleta = await prisma.calificacion.findUnique({ where: { id: cal.id }, include: { notasItems: true } })
            const definitiva = calcularDefinitiva(calCompleta.notasItems)
            await prisma.calificacion.update({ where: { id: cal.id }, data: { definitiva } })
          }
        })()

        for (const clave of clavesGrupo) guardados.push(clave)
      } catch (err) {
        // Error SQL real: la transacción del grupo hizo rollback completo —
        // nada de esta calificación quedó a medias. Los demás grupos siguen.
        console.error('Error SQL al guardar calificación en guardar-grid:', err)
        for (const clave of clavesGrupo) {
          fallidos.push({ clave, error: 'Error del servidor al guardar esta calificación — inténtalo de nuevo' })
        }
      }
    }

    const respuesta = {
      mensaje: `Guardados ${guardados.length} de ${items.length} cambios`,
      actualizados: guardados.length,
      guardados,
      fallidos,
    }
    if (advertencias.size > 0) {
      respuesta.advertencia = [...advertencias].join(' ')
    }
    res.json(respuesta)
  } catch (error) {
    console.error('Error en guardar-grid:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// ─── OBSERVACIONES ───

router.get('/observaciones', async (req, res) => {
  try {
    // SEGURIDAD: antes no había ni check de rol — cualquier usuario autenticado
    // podía leer observaciones de cualquier estudiante (IDOR)
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes y administradores' })
    }

    const estudianteId = req.query.estudianteId
    const docenteId = req.query.docenteId
    const where = []
    const params = []
    if (estudianteId) { where.push('o.estudianteId = ?'); params.push(estudianteId) }
    if (docenteId) { where.push('o.docenteId = ?'); params.push(docenteId) }
    if (where.length === 0) return res.status(400).json({ error: 'Se requiere al menos estudianteId o docenteId' })

    // SEGURIDAD: el docente solo consulta estudiantes de sus cursos
    // (materia asignada o director de grupo); sus propias observaciones siempre
    if (req.usuario.rol === 'DOCENTE' && estudianteId && !(await docentePuedeVerEstudiante(prisma._db, req.usuario.docenteId, estudianteId))) {
      return res.status(403).json({ error: 'No tienes asignada ninguna materia en el curso de ese estudiante' })
    }

    const rows = await prisma._db.prepare(`
      SELECT o.*, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre"
      FROM observaciones o
      LEFT JOIN materias m ON m.id = o.materiaId
      LEFT JOIN docentes d ON d.id = o.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      WHERE ${where.join(' AND ')}
      ORDER BY o.fecha DESC, o.creadoEn DESC
    `).all(...params)
    res.json(rows)
  } catch (error) {
    console.error('Error GET /observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/observaciones', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes y administradores' })
    }
    const { estudianteId, materiaId, texto, tipo, fecha } = req.body
    if (!estudianteId || !materiaId || !texto) {
      return res.status(400).json({ error: 'estudianteId, materiaId y texto requeridos' })
    }

    const estudiante = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(estudianteId)
    if (!estudiante) return res.status(404).json({ error: 'Estudiante no encontrado' })

    if (req.usuario.rol !== 'ADMIN' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, estudiante.curso))) {
      return res.status(403).json({ error: 'No tienes asignada esta materia en el curso del estudiante' })
    }

    const id = require('crypto').randomUUID()
    // Fecha de hoy en zona Colombia (el server corre con TZ=America/Bogota)
    const hoy = new Date().toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Bogota' }).split('/').reverse().join('-')
    const obsFecha = fecha || hoy
    await prisma._db.prepare(
      'INSERT INTO observaciones (id, estudianteId, docenteId, materiaId, texto, tipo, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, estudianteId, req.usuario.docenteId, materiaId, texto, tipo || 'GENERAL', obsFecha)
    res.status(201).json({ mensaje: 'Observación creada', id })
  } catch (error) {
    console.error('Error POST /observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/observaciones/:id', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes y administradores' })
    }
    const obs = await prisma._db.prepare('SELECT * FROM observaciones WHERE id = ?').get(req.params.id)
    if (!obs) return res.status(404).json({ error: 'Observación no encontrada' })
    if (req.usuario.rol !== 'ADMIN' && obs.docenteId !== req.usuario.docenteId) {
      return res.status(403).json({ error: 'No puedes editar esta observación' })
    }

    const { texto, fecha, materiaId } = req.body
    if (!texto && !fecha && !materiaId) {
      return res.status(400).json({ error: 'Nada que actualizar (envía texto, fecha o materiaId)' })
    }

    if (materiaId && req.usuario.rol !== 'ADMIN') {
      const estudiante = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(obs.estudianteId)
      if (estudiante) {
        const asignacion = await prisma._db.prepare(
          'SELECT id FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?'
        ).get(req.usuario.docenteId, materiaId, estudiante.curso)
        if (!asignacion) {
          return res.status(403).json({ error: 'No tienes asignada esa materia en el curso del estudiante' })
        }
      }
    }

    const updates = []
    const params = []
    if (texto !== undefined) { updates.push('texto = ?'); params.push(texto) }
    if (fecha !== undefined) { updates.push('fecha = ?'); params.push(fecha) }
    if (materiaId !== undefined) { updates.push('materiaId = ?'); params.push(materiaId) }
    params.push(req.params.id)
    await prisma._db.prepare(`UPDATE observaciones SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    const updated = await prisma._db.prepare(`
      SELECT o.*, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre"
      FROM observaciones o
      LEFT JOIN materias m ON m.id = o.materiaId
      LEFT JOIN docentes d ON d.id = o.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      WHERE o.id = ?
    `).get(req.params.id)
    res.json(updated)
  } catch (error) {
    console.error('Error PUT /observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/mis-observaciones', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE') {
      return res.status(403).json({ error: 'Solo para estudiantes' })
    }
    res.json(await obtenerMisObservaciones(req.usuario.estudianteId))
  } catch (error) {
    console.error('Error GET /mis-observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/observaciones/:id', async (req, res) => {
  try {
    const obs = await prisma._db.prepare('SELECT * FROM observaciones WHERE id = ?').get(req.params.id)
    if (!obs) return res.status(404).json({ error: 'Observación no encontrada' })
    if (req.usuario.rol !== 'ADMIN' && obs.docenteId !== req.usuario.docenteId) {
      return res.status(403).json({ error: 'No puedes eliminar esta observación' })
    }
    await prisma._db.prepare('DELETE FROM observaciones WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Observación eliminada' })
  } catch (error) {
    console.error('Error DELETE /observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── DIRECTOR: OBSERVACIONES DE SU CURSO ───

router.get('/observaciones-curso', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes y administradores' })
    }
    const { curso } = req.query
    if (!curso) {
      return res.status(400).json({ error: 'curso es requerido' })
    }

    // El admin ve cualquier curso; el docente solo si es director del curso
    if (req.usuario.rol !== 'ADMIN') {
      const director = await prisma._db.prepare(
        'SELECT * FROM directores_grupo WHERE docenteId = ? AND curso = ?'
      ).get(req.usuario.docenteId, curso)
      if (!director) {
        return res.status(403).json({ error: 'No eres director de este curso' })
      }
    }

    const rows = await prisma._db.prepare(`
      SELECT o.*, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre",
             e.curso AS "estudianteCurso", u2.nombre AS "estudianteNombre"
      FROM observaciones o
      JOIN estudiantes e ON e.id = o.estudianteId
      JOIN usuarios u2 ON u2.id = e.usuarioId
      LEFT JOIN materias m ON m.id = o.materiaId
      LEFT JOIN docentes d ON d.id = o.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      WHERE e.curso = ?
      ORDER BY o.fecha DESC, o.creadoEn DESC
    `).all(curso)

    res.json(rows)
  } catch (error) {
    console.error('Error GET /observaciones-curso:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── DIRECTOR: CHECK IF TEACHER IS DIRECTOR ───

router.get('/soy-director', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE') {
      return res.status(403).json({ error: 'Solo docentes' })
    }
    const rows = await prisma._db.prepare(
      'SELECT curso FROM directores_grupo WHERE docenteId = ?'
    ).all(req.usuario.docenteId)
    res.json({ cursos: rows.map(r => r.curso) })
  } catch (error) {
    console.error('Error GET /soy-director:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── REPORT DE CORTE — DOCENTE (DIRECTOR) ───

router.get('/reporte-corte', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE') {
      return res.status(403).json({ error: 'Solo docentes' })
    }
    const { curso, periodo, anio } = req.query
    if (!curso || !periodo || !anio) {
      return res.status(400).json({ error: 'curso, periodo y anio son requeridos' })
    }

    const director = await prisma._db.prepare(
      'SELECT * FROM directores_grupo WHERE docenteId = ? AND curso = ?'
    ).get(req.usuario.docenteId, curso)
    if (!director) {
      return res.status(403).json({ error: 'No eres director de este curso' })
    }

    const reporte = await calcularReporteCorte(curso, parseInt(periodo), parseInt(anio))

    const sedeRow = prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
    const sede = sedeRow ? sedeRow.sede : 'PPAL - TRIUNFO'
    const cfg = prisma._db.prepare(
      'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
    ).get(sede, parseInt(periodo), parseInt(anio))
    const fechaCorte = cfg?.fecha_corte || null
    const yaPaso = fechaCorte ? new Date(fechaCorte) <= new Date() : false

    res.json({ reporte, fechaCorte, yaPaso })
  } catch (error) {
    console.error('Error GET /reporte-corte:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── REPORT DE CORTE — ESTUDIANTE (PROPIO) ───

router.get('/mi-reporte-corte', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE') {
      return res.status(403).json({ error: 'Solo estudiantes' })
    }
    const { periodo, anio } = req.query
    if (!periodo || !anio) {
      return res.status(400).json({ error: 'periodo y anio son requeridos' })
    }
    if (!req.usuario.estudianteId) {
      return res.status(404).json({ error: 'Datos de estudiante no encontrados' })
    }
    res.json(await obtenerMiReporteCorte(req.usuario.estudianteId, periodo, anio))
  } catch (error) {
    console.error('Error GET /reporte-corte:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ÁREAS (vista del estudiante por áreas) ───
// Áreas asignadas al curso del estudiante: por área trae su promedio
// (renormalizado: Σ(nota×pct)/Σpct, parcial con las materias que tengan
// nota) y las materias del área con su definitiva individual (calculada
// en vivo desde las notas si la definitiva está a medias).
router.get('/mis-areas', async (req, res) => {
  try {
    if (!req.usuario || !req.usuario.estudianteId) {
      return res.status(403).json({ error: 'Solo estudiantes' })
    }
    const periodo = parseInt(req.query.periodo) || 1
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    res.json(await obtenerMisAreas(req.usuario.estudianteId, periodo, anio))
  } catch (error) {
    console.error('Error GET /mis-areas:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── BOLETÍN DEL PERÍODO (piloto 11-04) ───
// Documento académico formal por período: áreas y materias ASIGNADAS AL CURSO
// del estudiante (nada más), notas P1-P3, nivel de desempeño, promedio y
// puesto en el salon (estilo deportivo: empates comparten puesto y el
// siguiente salta). Solo lecturas.

function nivelDeDesempeno(definitiva) {
  if (definitiva === null || definitiva === undefined) return '—'
  if (definitiva < 3) return 'Desempeño Bajo'
  if (definitiva < 4) return 'Desempeño Básico'
  if (definitiva < 4.6) return 'Desempeño Alto'
  return 'Desempeño Superior'
}

// ─── BOLETÍN DEL PERÍODO (piloto 11-04) ───
// Documento académico digital: áreas y materias ASIGNADAS AL CURSO del
// estudiante, columnas P°1..P°N (nada de períodos futuros — REGLA DE ORO:
// el servidor nunca envía lo que el estudiante no debe ver), nivel de
// desempeño, y puesto en el salon (estilo deportivo: empates comparten
// puesto y el siguiente salta). SOLO VISIBLE si el admin lo publicó para
// (anio, periodo, su curso). Firma virtual del rector (imagen subida
// desde el panel). Solo lecturas.

function nivelDeDesempeno(definitiva) {
  if (definitiva === null || definitiva === undefined) return '—'
  if (definitiva < 3) return 'BAJO'
  if (definitiva < 4) return 'BÁSICO'
  if (definitiva < 4.6) return 'ALTO'
  return 'SUPERIOR'
}

function notaFmt(v) {
  if (v === null || v === undefined) return null
  return parseFloat(Number(v).toFixed(2))
}

router.get('/mi-boletin', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE' || !req.usuario.estudianteId) {
      return res.status(403).json({ error: 'Solo para estudiantes' })
    }
    const estudianteId = req.usuario.estudianteId
    const periodo = parseInt(req.query.periodo) || 1
    const anio = parseInt(req.query.anio) || new Date().getFullYear()

    // Datos del estudiante
    const est = await prisma._db.prepare(`
      SELECT u.nombre, e.curso, e.grado, e.jornada, e.sede
      FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
      WHERE e.id = ?
    `).get(estudianteId)
    if (!est) return res.status(404).json({ error: 'Estudiante no encontrado' })

    // PUBLICACIÓN: sin orden del admin no hay boletín (server-side, siempre)
    const publicado = await prisma._db.prepare(
      "SELECT id FROM boletines_publicados WHERE anio = ? AND periodo = ? AND curso IN ('', ?) LIMIT 1"
    ).get(anio, periodo, est.curso)
    if (!publicado) {
      return res.status(403).json({ error: 'El boletín de este período aún no ha sido publicado' })
    }

    // Director de grupo del curso
    const director = await prisma._db.prepare(`
      SELECT u.nombre AS "directorNombre"
      FROM directores_grupo dg
      JOIN docentes d ON d.id = dg.docenteId
      JOIN usuarios u ON u.id = d.usuarioId
      WHERE dg.curso = ?
    `).get(est.curso)

    // Rector: nombre (texto) + firma (imagen opcional)
    const rectorNombre = await prisma._db.prepare(
      "SELECT valor FROM config_institucion WHERE clave = 'rector_nombre'"
    ).get()
    const rectorFirma = await prisma._db.prepare(
      "SELECT valor FROM config_institucion WHERE clave = 'rector_firma'"
    ).get()

    // Áreas del curso en el orden del boletín físico (creación) + sus materias
    const areas = await prisma._db.prepare(`
      SELECT a.id AS "areaId", a.nombre
      FROM area_cursos ac JOIN areas a ON a.id = ac.areaid
      WHERE ac.curso = ?
      ORDER BY a.creadoen ASC, a.nombre ASC
    `).all(est.curso)

    let areasMaterias = new Map()
    let notasPorMateria = new Map()
    if (areas.length) {
      const areasIds = areas.map(a => a.areaId)
      const marcasA = areasIds.map(() => '?').join(',')
      const materias = await prisma._db.prepare(`
        SELECT am.areaid AS "areaId", am.materiaid AS "materiaId", am.porcentaje, m.nombre AS "materiaNombre"
        FROM area_materias am JOIN materias m ON m.id = am.materiaid
        WHERE am.areaid IN (${marcasA})
        ORDER BY m.nombre ASC
      `).all(...areasIds)
      for (const m of materias) {
        if (!areasMaterias.has(m.areaId)) areasMaterias.set(m.areaId, [])
        areasMaterias.get(m.areaId).push({ materiaId: m.materiaId, nombre: m.materiaNombre, ihs: m.porcentaje })
      }

      const cals = await prisma._db.prepare(`
        SELECT c.materiaId, c.periodo, c.definitiva
        FROM calificaciones c
        WHERE c.estudianteId = ? AND c.anio = ? AND c.periodo <= ?
      `).all(estudianteId, anio, periodo)

      // SOLO períodos 1..N del boletín consultado (nunca futuros).
      // DEDUPLICACIÓN: si ya hay un valor DISTINTO para el mismo
      // estudiante+materia+período (dos registros con el mismo nombre
      // normalizado), NO elegir: celda vacía y conflicto en el log.
      for (const c of cals) {
        const clave = c.materiaId + '|' + c.periodo
        if (notasPorMateria.has(clave) && notasPorMateria.get(clave) !== c.definitiva) {
          console.error('CONFLICTO bolet\u00edn: estudiante=' + estudianteId + ' materia=' + c.materiaId + ' per\u00edodo=' + c.periodo + ' valores=' + notasPorMateria.get(clave) + ' vs ' + c.definitiva + ' \u2014 celda vac\u00eda')
          notasPorMateria.set(clave, '__CONFLICTO__')
        } else if (!notasPorMateria.has(clave)) {
          notasPorMateria.set(clave, c.definitiva)
        }
      }
    }

    const periodos = []
    for (let p = 1; p <= periodo; p++) periodos.push(p)

    // DEDUPLICACIÓN de materias por nombre normalizado dentro de cada área
    const normBol = txt => String(txt).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()

    const areasBoletin = areas.map(a => {
      const brutas = areasMaterias.get(a.areaId) || []
      const porNorm = new Map()
      for (const m of brutas) {
        const k = normBol(m.nombre)
        if (!porNorm.has(k)) porNorm.set(k, { nombre: m.nombre, ihs: m.ihs, materiaId: m.materiaId })
      }
      const materias = [...porNorm.values()].map(m => {
        const notas = {}
        for (const p of periodos) {
          const v = notasPorMateria.get(m.materiaId + '|' + p)
          notas[String(p)] = v === '__CONFLICTO__' ? null : notaFmt(v)
        }
        const definitiva = notas[String(periodo)]
        return {
          nombre: m.nombre,
          ihs: m.ihs,
          notas,
          definitiva,
          nivel: definitiva !== null && definitiva !== undefined ? nivelDeDesempeno(definitiva) : null,
          indicadores: [],
        }
      })
      // Promedio del área: Σ(nota × I.H.S.) / Σ(I.H.S.) — solo materias con
      // definitiva del período consultado
      let sumaPonderada = 0
      let sumaIhs = 0
      for (const m of materias) {
        if (m.definitiva !== null) {
          sumaPonderada += m.definitiva * m.ihs
          sumaIhs += m.ihs
        }
      }
      const promedio = sumaIhs > 0 ? parseFloat((sumaPonderada / sumaIhs).toFixed(2)) : null
      return {
        nombre: a.nombre,
        promedio,
        nivel: nivelDeDesempeno(promedio),
        materias,
      }
    })

    // Config: ¿mostrar puesto en el boletín? (default '1' = sí)
    const mostrarPuesto = await prisma._db.prepare(
      "SELECT valor FROM config_institucion WHERE clave = 'mostrar_puesto'"
    ).get()
    const conPuesto = !mostrarPuesto || mostrarPuesto.valor !== '0'

    // Promedio general: SOLO las definitivas del período consultado
    // (las de períodos anteriores se ven en su columna pero no se promedian)
    const propia = await prisma._db.prepare(`
      SELECT AVG(definitiva) prom FROM calificaciones
      WHERE estudianteId = ? AND periodo = ? AND anio = ? AND definitiva IS NOT NULL
    `).get(estudianteId, periodo, anio)
    const promedio = propia && propia.prom !== null ? parseFloat(Number(propia.prom).toFixed(2)) : null

    // Puesto en el salon: RANK() estilo deportivo (1,2,2,4) — SOLO con las
    // notas del período consultado, entre los estudiantes del curso con al
    // menos una nota. Nunca se envían datos de otros estudiantes.
    let puesto = null
    let totalCurso = 0
    if (conPuesto && promedio !== null) {
      const ranking = await prisma._db.prepare(`
        WITH promedios AS (
          SELECT c.estudianteId, AVG(c.definitiva) AS prom
          FROM calificaciones c
          JOIN estudiantes e ON e.id = c.estudianteId
          WHERE e.curso = ? AND c.periodo = ? AND c.anio = ? AND c.definitiva IS NOT NULL
          GROUP BY c.estudianteId
        )
        SELECT COUNT(*) OVER () AS total, estudianteId, RANK() OVER (ORDER BY prom DESC) AS puesto
        FROM promedios
      `).all(est.curso, periodo, anio)
      totalCurso = ranking.length > 0 ? Number(ranking[0].total) : 0
      const fila = ranking.find(r => r.estudianteId === estudianteId)
      puesto = fila ? Number(fila.puesto) : null
    }

    res.json({
      estudiante: { nombre: est.nombre, curso: est.curso, grado: est.grado, jornada: est.jornada, sede: est.sede },
      directorNombre: director ? director.directorNombre : null,
      rectorNombre: rectorNombre ? rectorNombre.valor : null,
      rectorFirma: rectorFirma ? rectorFirma.valor : null,
      periodo, anio,
      periodos,
      areas: areasBoletin,
      promedio,
      puesto,
      totalCurso,
    })
  } catch (error) {
    console.error('Error GET /mi-boletin:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── CONSOLIDADO (docente) ───
// La nota mínima que necesita cada estudiante para llegar a 3.0 en la
// materia seleccionada. Solo materias que el docente tiene asignadas.
router.get('/consolidado', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const { curso, materiaId } = req.query
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const periodoActual = parseInt(req.query.periodo) || 1
    if (!curso || !materiaId) return res.status(400).json({ error: 'Debes enviar curso y materiaId' })

    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(prisma._db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const estudiantes = await calcularConsolidado(prisma._db, curso, materiaId, anio, periodoActual)
    res.json({ estudiantes, anio })
  } catch (error) {
    console.error('Error en consolidado:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router