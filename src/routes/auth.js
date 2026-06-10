const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')

const router = express.Router()

router.post('/login', async (req, res) => {
  try {
    const { documento, password } = req.body

    if (!documento || !password) {
      return res.status(400).json({ error: 'Documento y contraseña son requeridos' })
    }

    const usuario = await prisma.usuario.findUnique({
      where: { documento },
      include: {
        estudiante: true,
        docente: true,
      }
    })

    if (!usuario) {
      return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
    }

    if (!usuario.activo) {
      return res.status(401).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' })
    }

  const passwordCorrecta = await bcrypt.compare(password, usuario.password)
  if (!passwordCorrecta) {
    return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
  }

  if (usuario.rol === 'ESTUDIANTE' && usuario.estudiante) {
    const periodo = parseInt(req.body.periodo) || parseInt(req.query.periodo) || 2
    const anio = parseInt(req.body.anio) || parseInt(req.query.anio) || new Date().getFullYear()
    const consulta = await prisma.consultaEstudiante.findUnique({
      where: { estudianteId_periodo_anio: { estudianteId: usuario.estudiante.id, periodo, anio } }
    })
    if (consulta && consulta.cantidad >= 3) {
      return res.status(429).json({ error: 'Has gastado tus consultas por este periodo' })
    }
  }

  const payload = {
      id:     usuario.id,
      correo: usuario.correo,
      rol:    usuario.rol,
      nombre: usuario.nombre,
      documento: usuario.documento,
      estudianteId: usuario.estudiante?.id || null,
      docenteId:    usuario.docente?.id    || null,
    }

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' })

    res.json({
      token,
      usuario: {
        nombre: usuario.nombre,
        correo: usuario.correo,
        documento: usuario.documento,
        rol:    usuario.rol,
        ...(usuario.estudiante && {
          grado:  usuario.estudiante.grado,
          curso:  usuario.estudiante.curso,
          sede:   usuario.estudiante.sede,
        }),
      }
    })

  } catch (error) {
    console.error('Error en login:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.get('/yo', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader) return res.status(401).json({ error: 'No hay token' })

    const token = authHeader.split(' ')[1]
    const datos = jwt.verify(token, process.env.JWT_SECRET)

    res.json({ usuario: datos })
  } catch (error) {
    res.status(401).json({ error: 'Token inválido o expirado' })
  }
})

module.exports = router