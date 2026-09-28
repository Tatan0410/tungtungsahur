const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')

const router = express.Router()

const MAX_INTENTOS = 5
const TIEMPO_BLOQUEO_MS = 15 * 60 * 1000

// Rate limit en memoria por IP para /login: evita fuerza bruta que prueba
// muchos documentos distintos desde la misma máquina.
// Solo cuenta intentos FALLIDOS: los logins exitosos no consumen el cupo,
// así una escuela con muchas peticiones desde la misma IP (NAT) no se bloquea.
const loginPorIp = new Map()
const FALLOS_IP_POR_MINUTO = 30

function fallosPorIp(ip) {
  const ahora = Date.now()
  const reg = loginPorIp.get(ip)
  if (!reg || ahora > reg.resetAt) return 0
  return reg.count
}

function registrarFalloIp(ip) {
  const ahora = Date.now()
  let reg = loginPorIp.get(ip)
  if (!reg || ahora > reg.resetAt) {
    reg = { count: 0, resetAt: ahora + 60 * 1000 }
    loginPorIp.set(ip, reg)
  }
  reg.count++
  // Evita crecer sin límite si llegan IPs de muchas fuentes
  if (loginPorIp.size > 5000) {
    for (const [k, v] of loginPorIp) if (ahora > v.resetAt) loginPorIp.delete(k)
  }
}

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

    // ─── RATE LIMITING POR IP (solo fallos) ───
    const ipLogin = req.ip || req.connection.remoteAddress || 'desconocida'
    if (fallosPorIp(ipLogin) >= FALLOS_IP_POR_MINUTO) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos desde esta IP. Espera un minuto.' })
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
      registrarFalloIp(ipLogin)
      return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
    }

    if (!usuario.activo) {
      return res.status(401).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' })
    }

    const passwordCorrecta = await bcrypt.compare(password, usuario.password)
    if (!passwordCorrecta) {
      registrarIntentoFallido(documento)
      registrarFalloIp(ipLogin)
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

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: '8h',
      issuer: 'sagrado-corazon-sistema',
      audience: 'sagrado-corazon-web'
    })

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
    const datos = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })

    res.json({ usuario: datos })
  } catch (error) {
    res.status(401).json({ error: 'Token inválido o expirado' })
  }
})

// ─── RECUPERACIÓN DE CONTRASEÑA (SOLO DOCENTES) ───

function enviarCodigoRecuperacion(correoDestino, codigo) {
  const nodemailer = require('nodemailer')
  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT) || 465
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) {
    console.log(`⚠️  SMTP no configurado. Código de recuperación para ${correoDestino}: ${codigo}`)
    return Promise.resolve()
  }

  const transporter = nodemailer.createTransport({
    host, port: parseInt(port),
    secure: parseInt(port) === 465,
    auth: { user, pass },
  })

  return transporter.sendMail({
    from: `"Sagrado Corazón" <${user}>`,
    to: correoDestino,
    subject: 'Código de recuperación de contraseña',
    text: `Tu código de recuperación es: ${codigo}\n\nEste código expira en 15 minutos. Si no lo solicitaste, ignora este correo.`,
    html: `<p>Tu código de recuperación es:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${codigo}</p><p>Este código expira en 15 minutos. Si no lo solicitaste, ignora este correo.</p>`,
  }).catch(err => {
    console.error(`Error enviando código a ${correoDestino}:`, err.message)
    console.log(`Código de recuperación para ${correoDestino}: ${codigo}`)
  })
}

// Rate limit en memoria para /recuperar (por IP): 10 solicitudes/minuto
const recuperarPorIp = new Map()

router.post('/recuperar', async (req, res) => {
  try {
    const { correo } = req.body
    if (!correo) {
      return res.status(400).json({ error: 'El correo es requerido' })
    }

    const ip = req.ip || req.connection.remoteAddress || 'desconocida'
    const ahora = Date.now()
    const reg = recuperarPorIp.get(ip)
    if (!reg || ahora > reg.resetAt) {
      recuperarPorIp.set(ip, { count: 1, resetAt: ahora + 60 * 1000 })
      if (recuperarPorIp.size > 5000) {
        for (const [k, v] of recuperarPorIp) if (ahora > v.resetAt) recuperarPorIp.delete(k)
      }
    } else {
      reg.count++
      if (reg.count > 10) {
        return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' })
      }
    }

    // Limpieza: elimina códigos/registros con más de 24 horas
    prisma._db.prepare("DELETE FROM password_resets WHERE creadoEn < datetime('now', '-1 day')").run()

    const usuario = await prisma.usuario.findUnique({ where: { correo }, include: { docente: true } })
    if (!usuario || usuario.rol !== 'DOCENTE') {
      // No revela si el correo existe (seguridad)
      return res.json({ mensaje: 'Si el correo existe, recibirás un código de recuperación.' })
    }

    // Máximo 3 códigos por correo en la última hora (evita bombardeo de emails).
    // Se excluyen las filas INVALID- que registran intentos fallidos, para que
    // unos intentos erróneos no bloqueen la recuperación legítima.
    const enviadosHora = prisma._db.prepare(
      "SELECT COUNT(*) AS c FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND creadoEn > datetime('now', '-1 hour')"
    ).get(usuario.id)
    if (enviadosHora.c >= 3) {
      console.log(`⚠️  Límite de códigos por correo alcanzado: ${correo}`)
      return res.json({ mensaje: 'Si el correo existe, recibirás un código de recuperación.' })
    }

    const codigo = String(Math.floor(100000 + Math.random() * 900000))
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira) VALUES (?, ?, ?, ?)').run(require('crypto').randomUUID(), usuario.id, codigo, expira)

    await enviarCodigoRecuperacion(usuario.correo, codigo)
    res.json({ mensaje: 'Si el correo existe, recibirás un código de recuperación.' })
  } catch (error) {
    console.error('Error POST /recuperar:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/recuperar/verificar', async (req, res) => {
  try {
    const { correo, codigo, nuevaPassword } = req.body
    if (!correo || !codigo || !nuevaPassword) {
      return res.status(400).json({ error: 'correo, codigo y nuevaPassword son requeridos' })
    }
    if (String(nuevaPassword).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }

    const usuario = await prisma.usuario.findUnique({ where: { correo }, include: { docente: true } })
    if (!usuario || usuario.rol !== 'DOCENTE') {
      return res.status(400).json({ error: 'Código inválido o expirado' })
    }

    // ─── RATE LIMIT: bloquear después de 5 intentos fallidos por correo ───
    const MAX_INTENTOS_CODIGO = 5
    const intentosRecientes = prisma._db.prepare(`
      SELECT COUNT(*) as c FROM password_resets
      WHERE usuarioId = ? AND usado = 0 AND expira > datetime('now')
      AND creadoEn > datetime('now', '-15 minutes')
    `).get(usuario.id)
    if (intentosRecientes.c >= MAX_INTENTOS_CODIGO) {
      prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE usuarioId = ? AND usado = 0').run(usuario.id)
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Pide un nuevo código.' })
    }

    const reset = prisma._db.prepare(
      'SELECT * FROM password_resets WHERE usuarioId = ? AND codigo = ? AND usado = 0 ORDER BY creadoEn DESC LIMIT 1'
    ).get(usuario.id, String(codigo))
    if (!reset || new Date(reset.expira) < new Date()) {
      // Registrar intento fallido
      prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira) VALUES (?, ?, ?, ?)').run(
        require('crypto').randomUUID(), usuario.id, 'INVALID-' + require('crypto').randomUUID(), new Date(Date.now() + 15 * 60 * 1000).toISOString()
      )
      return res.status(400).json({ error: 'Código inválido o expirado. Te quedan ' + (MAX_INTENTOS_CODIGO - (intentosRecientes.c + 1)) + ' intentos.' })
    }

    const hash = bcrypt.hashSync(String(nuevaPassword), 10)
    prisma._db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, usuario.id)
    prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE id = ?').run(reset.id)
    // Limpiar cualquier otro código activo
    prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE usuarioId = ? AND usado = 0').run(usuario.id)

    res.json({ mensaje: 'Contraseña restablecida exitosamente' })
  } catch (error) {
    console.error('Error POST /recuperar/verificar:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── MI PERFIL (self-service: cambiar contraseña o correo) ───

router.put('/mi-perfil', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader) return res.status(401).json({ error: 'No hay token' })
    const token = authHeader.split(' ')[1]
    const datos = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })

    const { passwordActual, nuevaPassword, nuevoCorreo } = req.body
    if (!passwordActual) {
      return res.status(400).json({ error: 'La contraseña actual es requerida' })
    }

    const usuario = await prisma.usuario.findUnique({ where: { id: datos.id } })
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' })

    const passwordCorrecta = await bcrypt.compare(passwordActual, usuario.password)
    if (!passwordCorrecta) {
      return res.status(401).json({ error: 'La contraseña actual es incorrecta' })
    }

    const updates = []
    const params = []
    if (nuevaPassword) {
      if (String(nuevaPassword).length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' })
      }
      updates.push('password = ?')
      params.push(bcrypt.hashSync(String(nuevaPassword), 10))
    }
    if (nuevoCorreo) {
      const existente = prisma._db.prepare('SELECT id FROM usuarios WHERE correo = ? AND id != ?').get(nuevoCorreo, usuario.id)
      if (existente) return res.status(409).json({ error: 'Ese correo ya está en uso' })
      updates.push('correo = ?')
      params.push(String(nuevoCorreo).trim())
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar (envía nuevaPassword o nuevoCorreo)' })
    }

    params.push(usuario.id)
    prisma._db.prepare(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    res.json({ mensaje: 'Perfil actualizado exitosamente' })
  } catch (error) {
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Sesión expirada, inicia sesión de nuevo' })
    console.error('Error PUT /mi-perfil:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router