const express = require('express')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')

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

router.get('/mis-cursos', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }

    const docenteId = req.usuario.docenteId

    const asignaciones = await prisma.docenteMateria.findMany({
      where: { docenteId },
      include: {
        materia: { select: { id: true, nombre: true, grado: true } },
      },
      orderBy: { curso: 'asc' }
    })

    const cursos = [...new Set(asignaciones.map(a => a.curso))].map(curso => {
      const materias = asignaciones.filter(a => a.curso === curso).map(a => ({
        materiaId: a.materia.id,
        materiaNombre: a.materia.nombre,
        grado: a.materia.grado,
      }))
      return { curso, materias }
    })

    res.json({ cursos })
  } catch (error) {
    console.error('Error al obtener cursos del docente:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.get('/mis-materias', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }

    const docenteId = req.usuario.docenteId

    const asignaciones = await prisma.docenteMateria.findMany({
      where: { docenteId },
      include: {
        materia: { select: { id: true, nombre: true, grado: true } },
      },
      orderBy: { materia: { nombre: 'asc' } }
    })

    res.json(asignaciones.map(a => ({
      materiaId: a.materia.id,
      materiaNombre: a.materia.nombre,
      grado: a.materia.grado,
      curso: a.curso,
    })))
  } catch (error) {
    console.error('Error al obtener materias del docente:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router