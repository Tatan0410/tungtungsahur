const express = require('express')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')
const { calcularReporteCorte } = require('../services/reporteCorte')
const { calcularDefinitiva } = require('../services/calculoNotas')
const { calcularConsolidado } = require('../services/consolidado')

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

router.get('/mis-notas', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE') {
      return res.status(403).json({ error: 'Esta ruta es solo para estudiantes' })
    }

    const estudianteId = req.usuario.estudianteId
    const periodo      = parseInt(req.query.periodo) || 1
    const anio         = parseInt(req.query.anio)    || new Date().getFullYear()

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

    res.json({
      periodo,
      anio,
      consultasUsadas:   consulta.cantidad,
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
      })
    })

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

    const estudiantes = await prisma.estudiante.findMany({
      where: { curso },
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

if (tipo === 'EVALUACION') {
       const existente = await prisma.notaItem.findFirst({
         where: { calificacionId, tipo: 'EVALUACION' }
       })
       if (existente) {
         return res.status(400).json({ error: 'Solo se permite una nota de evaluación. Edita la existente o elimínala primero.' })
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

    const est = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE id = ?').get(estudianteId)
    const sede = est?.sede || 'PPAL - TRIUNFO'
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

    const calIds = [...new Set(resultados.map(r => r.calificacionId))]
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

    const p = parseInt(periodo) || 1
    const a = parseInt(anio) || new Date().getFullYear()

    // ON CONFLICT DO NOTHING = INSERT OR IGNORE en ambos motores (requiere el
    // índice único columnas_unicas)
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

    const calIdsActualizados = new Set()
    const advertencias = new Set()

    for (const item of items) {
      const { estudianteId, materiaId, periodo, anio, tipo, titulo, valor, _delete } = item
      if (!estudianteId || !materiaId || !tipo) continue

      // Defensa en profundidad: la nota solo puede ir de 0 a 5 (el frontend
      // ya lo restringe con mensaje; esto evita que llegue cualquier otra cosa)
      if (valor !== null && valor !== undefined && valor !== '') {
        const vNota = parseFloat(valor)
        if (isNaN(vNota) || vNota < 0 || vNota > 5) {
          return res.status(400).json({ error: 'La nota solo puede ir de 0 a 5' })
        }
      }

      const p = parseInt(periodo) || 1
      const a = parseInt(anio) || new Date().getFullYear()

      const est = await prisma._db.prepare('SELECT sede, curso FROM estudiantes WHERE id = ?').get(estudianteId)
      if (!est) continue
      const sede = est.sede
      const cursoEstudiante = est.curso

      // SEGURIDAD: un docente NO puede guardar notas de una materia/curso que no tiene asignada
      if (req.usuario.rol === 'DOCENTE') {
        const asignacion = await prisma._db.prepare(
          'SELECT id FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?'
        ).get(req.usuario.docenteId, materiaId, cursoEstudiante)
        if (!asignacion) {
          advertencias.add('No tienes asignada la materia en el curso ' + cursoEstudiante + ' — se ignoró el cambio.')
          continue
        }
      }

      // Periodo cerrado manualmente → saltar
      if (!(await periodoAbierto(a, sede, p))) {
        continue
      }

      // Fecha límite pasada pero período aún abierto → advertir
      const cfg = await prisma._db.prepare('SELECT fecha_fin, reapertura_manual FROM periodos_config WHERE anio = ? AND sede = ? AND periodo = ?').get(a, sede, p)
      if (cfg?.fecha_fin) {
        const fechaFin = new Date(cfg.fecha_fin)
        if (fechaFin < new Date() && cfg.reapertura_manual) {
          advertencias.add('⚠️ El corte final ya pasó, pero el período fue reabierto manualmente. Guarda tus notas pronto.')
        }
      }

      const cal = await prisma.calificacion.upsert({
        where: { estudianteId_materiaId_periodo_anio: { estudianteId, materiaId, periodo: p, anio: a } },
        update: {},
        create: { estudianteId, materiaId, docenteId: req.usuario.docenteId, periodo: p, anio: a },
      })

      if (_delete) {
        if (tipo === 'EVALUACION') {
          const existente = await prisma.notaItem.findFirst({
            where: { calificacionId: cal.id, tipo: 'EVALUACION' }
          })
          if (existente) {
            await prisma.notaItem.delete({ where: { id: existente.id } })
          }
        } else if (titulo && titulo.trim()) {
          const existente = await prisma.notaItem.findFirst({
            where: { calificacionId: cal.id, tipo, descripcion: titulo.trim() }
          })
          if (existente) {
            await prisma.notaItem.delete({ where: { id: existente.id } })
          }
        }
        // Si la calificación quedó sin items y sin definitiva cerrada:
        // borrar también la fila contenedora (la BD no acumula filas vacías).
        // Si tiene definitiva cerrada, se queda (el docente la cerró).
        const restantes = await prisma.notaItem.findMany({ where: { calificacionId: cal.id } })
        if (restantes.length === 0 && cal.definitiva === null) {
          await prisma.calificacion.delete({ where: { id: cal.id } })
        }
      } else {
        if (valor === undefined || valor === null) continue
        // El 0 es válido (rango 0-5, coherente con el frontend)
        if (valor < 0 || valor > 5) continue

        if (tipo === 'EVALUACION') {
          const existente = await prisma.notaItem.findFirst({
            where: { calificacionId: cal.id, tipo: 'EVALUACION' }
          })
          if (existente) {
            await prisma.notaItem.update({ where: { id: existente.id }, data: { valor: parseFloat(valor) } })
          } else {
            await prisma.notaItem.create({ data: { calificacionId: cal.id, tipo: 'EVALUACION', valor: parseFloat(valor), descripcion: null } })
          }
        } else if (titulo && titulo.trim()) {
          const existente = await prisma.notaItem.findFirst({
            where: { calificacionId: cal.id, tipo, descripcion: titulo.trim() }
          })
          if (existente) {
            await prisma.notaItem.update({ where: { id: existente.id }, data: { valor: parseFloat(valor) } })
          } else {
            await prisma.notaItem.create({ data: { calificacionId: cal.id, tipo, valor: parseFloat(valor), descripcion: titulo.trim() } })
          }
        }
      }

      calIdsActualizados.add(cal.id)
    }

    for (const calId of calIdsActualizados) {
      const cal = await prisma.calificacion.findUnique({ where: { id: calId }, include: { notasItems: true } })
      if (cal) {
        const definitiva = calcularDefinitiva(cal.notasItems)
        await prisma.calificacion.update({ where: { id: calId }, data: { definitiva } })
      }
    }

    const respuesta = { mensaje: `Guardados ${items.length} cambios`, actualizados: calIdsActualizados.size }
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
    const estudianteId = req.query.estudianteId
    const docenteId = req.query.docenteId
    const where = []
    const params = []
    if (estudianteId) { where.push('o.estudianteId = ?'); params.push(estudianteId) }
    if (docenteId) { where.push('o.docenteId = ?'); params.push(docenteId) }
    if (where.length === 0) return res.status(400).json({ error: 'Se requiere al menos estudianteId o docenteId' })
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

    if (req.usuario.rol !== 'ADMIN') {
      const asignacion = await prisma._db.prepare(
        'SELECT id FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?'
      ).get(req.usuario.docenteId, materiaId, estudiante.curso)
      if (!asignacion) {
        return res.status(403).json({ error: 'No tienes asignada esta materia en el curso del estudiante' })
      }
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
    const rows = await prisma._db.prepare(`
      SELECT o.id, o.texto, o.tipo, o.fecha, o.creadoEn, m.nombre AS "materiaNombre", u.nombre AS "docenteNombre"
      FROM observaciones o
      LEFT JOIN materias m ON m.id = o.materiaId
      LEFT JOIN docentes d ON d.id = o.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      WHERE o.estudianteId = ?
      ORDER BY o.fecha DESC, o.creadoEn DESC
    `).all(req.usuario.estudianteId)
    res.json(rows)
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

    const estudiante = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(req.usuario.estudianteId)
    if (!estudiante) {
      return res.status(404).json({ error: 'Estudiante no encontrado' })
    }
    const curso = estudiante.curso
    const rep = await calcularReporteCorte(curso, parseInt(periodo), parseInt(anio))
    const reporte = rep
      .filter(r => r.estudianteId === req.usuario.estudianteId)
      .map(r => ({
        materiaId: r.materiaId,
        materiaNombre: r.materiaNombre,
        definitiva: r.definitiva,
        estado: r.estado
      }))

    const sedeRow = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
    const sede = sedeRow ? sedeRow.sede : 'PPAL - TRIUNFO'
    const cfg = await prisma._db.prepare(
      'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
    ).get(sede, parseInt(periodo), parseInt(anio))
    const fechaCorte = cfg?.fecha_corte || null
    const yaPaso = fechaCorte ? new Date(fechaCorte) <= new Date() : false

    res.json({ reporte, fechaCorte, yaPaso })
  } catch (error) {
    console.error('Error GET /mi-reporte-corte:', error)
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
    const estudianteId = req.usuario.estudianteId
    const periodo = parseInt(req.query.periodo) || 1
    const anio = parseInt(req.query.anio) || new Date().getFullYear()

    const cursoRow = await prisma._db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(estudianteId)
    if (!cursoRow) return res.json({ areas: [] })

    const areas = await prisma._db.prepare(`
      SELECT a.id AS "areaId", a.nombre
      FROM area_cursos ac JOIN areas a ON a.id = ac.areaid
      WHERE ac.curso = ?
      ORDER BY a.nombre ASC, a.creadoen ASC
    `).all(cursoRow.curso)

    const resultado = []
    for (const a of areas) {
      const materias = await prisma._db.prepare(`
        SELECT am.materiaid AS "materiaId", am.porcentaje, m.nombre AS "materiaNombre"
        FROM area_materias am JOIN materias m ON m.id = am.materiaId
        WHERE am.areaid = ?
        ORDER BY am.porcentaje DESC, m.nombre ASC
      `).all(a.areaId)

      const materiasData = []
      let sumaPonderada = 0
      let sumaPorcentajes = 0
      let parciales = false
      for (const m of materias) {
        const cal = await prisma._db.prepare(
          'SELECT id, definitiva FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?'
        ).get(estudianteId, m.materiaId, periodo, anio)
        let definitiva = cal ? cal.definitiva : null
        let provisional = false
        if (cal && definitiva === null) {
          const items = await prisma._db.prepare('SELECT tipo, valor FROM notas_items WHERE calificacionId = ?').all(cal.id)
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
    res.json({ areas: resultado })
  } catch (error) {
    console.error('Error GET /notas/mis-areas:', error)
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

    if (req.usuario.rol === 'DOCENTE') {
      const asignacion = await prisma._db.prepare(
        'SELECT id FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?'
      ).get(req.usuario.docenteId, materiaId, curso)
      if (!asignacion) return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const estudiantes = await calcularConsolidado(prisma._db, curso, materiaId, anio, periodoActual)
    res.json({ estudiantes, anio })
  } catch (error) {
    console.error('Error en consolidado:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router