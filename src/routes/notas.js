const express = require('express')
const jwt     = require('jsonwebtoken')
const path    = require('path')
const Database = require('better-sqlite3')
const prisma  = require('../prisma')

const DB_PATH = path.resolve(__dirname, '../../prisma/dev.db')
const db = new Database(DB_PATH)

const router = express.Router()

function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader) {
    return res.status(401).json({ error: 'Acceso denegado. Inicia sesión primero.' })
  }

  try {
    const token  = authHeader.split(' ')[1]
    const datos  = jwt.verify(token, process.env.JWT_SECRET)
    req.usuario  = datos
    next()
  } catch {
    return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' })
  }
}

router.use(verificarToken)

const PESOS_PERIODOS = { 1: 0.20, 2: 0.30, 3: 0.20, 4: 0.30 }

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

    let consulta = await prisma.consultaEstudiante.findUnique({
      where: {
        estudianteId_periodo_anio: { estudianteId, periodo, anio }
      }
    })

    if (!consulta) {
      consulta = await prisma.consultaEstudiante.create({
        data: { estudianteId, periodo, anio, cantidad: 0 }
      })
    }

    if (consulta.cantidad >= 3) {
      return res.status(429).json({
        error: 'Has agotado tus 3 consultas para este período.',
        consultasUsadas: consulta.cantidad,
        consultasMaximas: 3,
        proximoPeriodo: `Período ${periodo + 1} · ${anio}`
      })
    }

    await prisma.consultaEstudiante.update({
      where: {
        estudianteId_periodo_anio: { estudianteId, periodo, anio }
      },
      data: { cantidad: { increment: 1 } }
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
      consultasUsadas:   consulta.cantidad + 1,
      consultasRestantes: 3 - (consulta.cantidad + 1),
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

    res.json(estudiantes.map(est => {
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
    }))

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

    if (valor < 1 || valor > 5) {
      return res.status(400).json({ error: 'El valor debe estar entre 1.0 y 5.0' })
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

    if (valor !== undefined && (valor < 1 || valor > 5)) {
      return res.status(400).json({ error: 'El valor debe estar entre 1.0 y 5.0' })
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

    const periodos = {}
    for (let p = 1; p <= 4; p++) {
      const cal = calificaciones.find(c => c.periodo === p)
      periodos[p] = {
        definitiva: cal?.definitiva || null,
      }
    }

    let anual = null
    if (calificaciones.length >= 4) {
      let suma = 0
      let pesosSum = 0
      for (let p = 1; p <= 4; p++) {
        const cal = calificaciones.find(c => c.periodo === p)
        if (cal?.definitiva !== null && cal?.definitiva !== undefined) {
          suma += cal.definitiva * PESOS_PERIODOS[p]
          pesosSum += PESOS_PERIODOS[p]
        }
      }
      if (pesosSum > 0) {
        anual = parseFloat((suma / pesosSum).toFixed(2))
      }
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
      if (valor < 1 || valor > 5) continue

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
      const rows = db.prepare(`
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

    db.prepare('INSERT OR IGNORE INTO columnas (id, curso, materiaId, periodo, anio, tipo, titulo, creadoEn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(require('crypto').randomUUID(), curso, materiaId, p, a, tipo, titulo.trim(), new Date().toISOString())

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

    db.prepare('UPDATE columnas SET titulo = ? WHERE curso = ? AND materiaId = ? AND periodo = ? AND anio = ? AND tipo = ? AND titulo = ?').run(tituloNuevo.trim(), curso, materiaId, p, a, tipo, tituloViejo)

    const result = db.prepare(`
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

    db.prepare('DELETE FROM columnas WHERE curso = ? AND materiaId = ? AND periodo = ? AND anio = ? AND tipo = ? AND titulo = ?').run(curso, materiaId, p, a, tipo, titulo)

    // Get IDs of items to delete so we can recalculate definitivas
    const itemsToDelete = db.prepare(`
      SELECT ni.id FROM notas_items ni
      JOIN calificaciones c ON c.id = ni.calificacionId
      JOIN estudiantes e ON e.id = c.estudianteId
      WHERE e.curso = ? AND c.materiaId = ? AND c.periodo = ? AND c.anio = ?
      AND ni.tipo = ? AND ni.descripcion = ?
    `).all(curso, materiaId, p, a, tipo, titulo)

    const calIds = new Set()
    for (const item of itemsToDelete) {
      const cal = db.prepare('SELECT calificacionId FROM notas_items WHERE id = ?').get(item.id)
      if (cal) calIds.add(cal.calificacionId)
      db.prepare('DELETE FROM notas_items WHERE id = ?').run(item.id)
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

    for (const item of items) {
      const { estudianteId, materiaId, periodo, anio, tipo, titulo, valor } = item
      if (!estudianteId || !materiaId || !tipo || valor === undefined || valor === null) continue
      if (valor < 1 || valor > 5) continue

      const p = parseInt(periodo) || 1
      const a = parseInt(anio) || new Date().getFullYear()

      const cal = await prisma.calificacion.upsert({
        where: { estudianteId_materiaId_periodo_anio: { estudianteId, materiaId, periodo: p, anio: a } },
        update: {},
        create: { estudianteId, materiaId, docenteId: req.usuario.docenteId, periodo: p, anio: a },
      })

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

      calIdsActualizados.add(cal.id)
    }

    for (const calId of calIdsActualizados) {
      const cal = await prisma.calificacion.findUnique({ where: { id: calId }, include: { notasItems: true } })
      if (cal) {
        const definitiva = calcularDefinitiva(cal.notasItems)
        await prisma.calificacion.update({ where: { id: calId }, data: { definitiva } })
      }
    }

    res.json({ mensaje: `Guardados ${items.length} cambios`, actualizados: calIdsActualizados.size })
  } catch (error) {
    console.error('Error en guardar-grid:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router