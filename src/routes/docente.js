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
    const datos  = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })
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

// ─── CREAR MATERIA (docente) ───
// El docente puede crear una materia nueva (o reutilizar una existente por
// nombre) y asignarla a un curso donde ya tiene asignación o es director.
function normalizarNombreMateria(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

router.post('/materias', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo para docentes' })
    }
    const docenteId = req.usuario.docenteId
    if (!docenteId) return res.status(403).json({ error: 'No eres docente' })

    const { nombre, curso } = req.body
    if (!nombre || !curso) return res.status(400).json({ error: 'nombre y curso son requeridos' })

    // SEGURIDAD: solo en cursos donde ya tiene alguna asignación o es director
    const tieneAsignacion = await prisma._db.prepare('SELECT id FROM docente_materias WHERE docenteId = ? AND curso = ? LIMIT 1').get(docenteId, curso)
    const esDirector = await prisma._db.prepare('SELECT id FROM directores_grupo WHERE docenteId = ? AND curso = ? LIMIT 1').get(docenteId, curso)
    if (!tieneAsignacion && !esDirector) {
      return res.status(403).json({ error: 'Solo puedes crear materias en cursos donde ya tienes una asignación o donde eres director de grupo' })
    }

    const norm = normalizarNombreMateria(nombre)
    let materia = await prisma._db.prepare('SELECT id, nombre FROM materias WHERE nombre_norm = ?').get(norm)

    // ¿El curso ya tiene una asignación de esta materia?
    const existente = materia ? await prisma._db.prepare('SELECT id, docenteId FROM docente_materias WHERE materiaId = ? AND curso = ?').get(materia.id, curso) : null

    if (existente && existente.docenteId && existente.docenteId !== docenteId) {
      return res.status(409).json({ error: `El curso ya tiene "${materia.nombre}" con otro maestro` })
    }

    if (!materia) {
      const id = require('crypto').randomUUID()
      await prisma._db.prepare('INSERT INTO materias (id, nombre, grado, nombre_norm) VALUES (?, ?, NULL, ?)').run(id, String(nombre).trim(), norm)
      materia = { id, nombre: String(nombre).trim() }
    }

    if (!existente) {
      const id = require('crypto').randomUUID()
      await prisma._db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(id, docenteId, materia.id, curso)
      return res.status(201).json({ mensaje: 'Materia creada y asignada', materiaId: materia.id, materiaNombre: materia.nombre, curso })
    }

    // Ya existe sin docente → se la asigna a él
    await prisma._db.prepare('UPDATE docente_materias SET docenteId = ? WHERE id = ?').run(docenteId, existente.id)
    res.status(200).json({ mensaje: 'Materia existente asignada a ti', materiaId: materia.id, materiaNombre: materia.nombre, curso })
  } catch (error) {
    console.error('Error POST /docente/materias:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router