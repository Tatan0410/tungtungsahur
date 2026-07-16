const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')

const router = express.Router()

const MAX_INTENTOS = 5
const TIEMPO_BLOQUEO_MS = 15 * 60 * 1000

function registrarIntentoFallido(documento) {
  const existente = prisma._db.prepare('SELECT * FROM intentos_login WHERE documento = ?').get(documento)
  if (existente) {
    const nuevos = existente.intentos + 1
    if (nuevos >= MAX_INTENTOS) {
      const bloqueadoHasta = new Date(Date.now() + TIEMPO_BLOQUEO_MS).toISOString()
      prisma._db.prepare('UPDATE intentos_login SET intentos = ?, bloqueadoHasta = ? WHERE documento = ?').run(nuevos, bloqueadoHasta, documento)
    } else {
      prisma._db.prepare('UPDATE intentos_login SET intentos = ? WHERE documento = ?').run(nuevos, documento)
    }
  } else {
    prisma._db.prepare('INSERT INTO intentos_login (documento, intentos, bloqueadoHasta) VALUES (?, 1, NULL)').run(documento)
  }
}

router.post('/login', async (req, res) => {
  try {
    const { documento, password } = req.body

    if (!documento || !password) {
      return res.status(400).json({ error: 'Documento y contraseña son requeridos' })
    }

    // ─── RATE LIMITING ───
    const intento = prisma._db.prepare('SELECT * FROM intentos_login WHERE documento = ?').get(documento)
    if (intento && intento.bloqueadoHasta) {
      const hasta = new Date(intento.bloqueadoHasta)
      if (hasta > new Date()) {
        const minsRest = Math.ceil((hasta - new Date()) / 60000)
        return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${minsRest} minuto(s).` })
      }
    }

    const usuario = await prisma.usuario.findUnique({
      where: { documento },
      include: {
        estudiante: true,
        docente: true,
      }
    })

    if (!usuario) {
      registrarIntentoFallido(documento)
      return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
    }

    if (!usuario.activo) {
      return res.status(401).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' })
    }

    const passwordCorrecta = await bcrypt.compare(password, usuario.password)
    if (!passwordCorrecta) {
      registrarIntentoFallido(documento)
      return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
    }

    // Login exitoso → resetear contador
    prisma._db.prepare('DELETE FROM intentos_login WHERE documento = ?').run(documento)

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
        docenteId: usuario.docente?.id || null,
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