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

async function registrarIntentoFallido(documento) {
  const existente = await prisma._db.prepare('SELECT * FROM intentos_login WHERE documento = ?').get(documento)
  if (existente) {
    const nuevos = existente.intentos + 1
    if (nuevos >= MAX_INTENTOS) {
      const bloqueadoHasta = new Date(Date.now() + TIEMPO_BLOQUEO_MS).toISOString()
      await prisma._db.prepare('UPDATE intentos_login SET intentos = ?, bloqueadoHasta = ? WHERE documento = ?').run(nuevos, bloqueadoHasta, documento)
    } else {
      await prisma._db.prepare('UPDATE intentos_login SET intentos = ? WHERE documento = ?').run(nuevos, documento)
    }
  } else {
    await prisma._db.prepare('INSERT INTO intentos_login (documento, intentos, bloqueadoHasta) VALUES (?, 1, NULL)').run(documento)
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
    const intento = await prisma._db.prepare('SELECT * FROM intentos_login WHERE documento = ?').get(documento)
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
      await registrarIntentoFallido(documento)
      registrarFalloIp(ipLogin)
      return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
    }

    if (!usuario.activo) {
      return res.status(401).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' })
    }

    const passwordCorrecta = await bcrypt.compare(password, usuario.password)
    if (!passwordCorrecta) {
      await registrarIntentoFallido(documento)
      registrarFalloIp(ipLogin)
      return res.status(401).json({ error: 'Documento o contraseña incorrectos' })
    }

    // Login exitoso → resetear contador
    await prisma._db.prepare('DELETE FROM intentos_login WHERE documento = ?').run(documento)

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

    // Devuelve los datos FRESCOS de la BD (no los del token): así el panel
    // refleja cambios hechos después del login, como el correo que el
    // administrador le asignó al docente.
    const usuario = await prisma.usuario.findUnique({
      where: { id: datos.id },
      include: { estudiante: true, docente: true }
    })
    if (!usuario || !usuario.activo) return res.status(401).json({ error: 'Token inválido o expirado' })

    res.json({
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
    const ayer = new Date(Date.now() - 86400000).toISOString()
    await prisma._db.prepare('DELETE FROM password_resets WHERE creadoEn < ?').run(ayer)

    const usuario = await prisma.usuario.findUnique({ where: { correo }, include: { docente: true } })
    if (!usuario || (usuario.rol !== 'DOCENTE' && usuario.rol !== 'ADMIN')) {
      // El frontend distingue: correo inexistente → "No se puede atender tu
      // solicitud" (no se muestra el menú del código)
      return res.json({ existe: false, mensaje: 'No se puede atender tu solicitud' })
    }

    if (!usuario.activo) {
      return res.json({ existe: false, mensaje: 'No se puede atender tu solicitud' })
    }

    // Máximo 3 códigos por correo en la última hora (evita bombardeo de emails).
    // Se excluyen las filas INVALID- que registran intentos fallidos, para que
    // unos intentos erróneos no bloqueen la recuperación legítima.
    const ahoraMenosUnaHora = new Date(Date.now() - 3600000).toISOString()
    const enviadosHora = await prisma._db.prepare(
      "SELECT COUNT(*) AS c FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND creadoEn > ?"
    ).get(usuario.id, ahoraMenosUnaHora)
    if (enviadosHora.c >= 3) {
      console.log(`⚠️  Límite de códigos por correo alcanzado: ${correo}`)
      return res.json({ existe: true, mensaje: 'Si el correo existe, recibirás un código de recuperación.' })
    }

    const codigo = String(Math.floor(100000 + Math.random() * 900000))
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    // Pedir un código nuevo reinicia los intentos fallidos del ciclo anterior
    await prisma._db.prepare("DELETE FROM password_resets WHERE usuarioId = ? AND codigo LIKE 'INVALID-%'").run(usuario.id)
    // creadoEn explícito en ISO-8601: el DEFAULT CURRENT_TIMESTAMP de SQLite
    // guarda 'YYYY-MM-DD HH:MM:SS' (sin T) y no compara bien contra los ISO.
    await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(require('crypto').randomUUID(), usuario.id, codigo, expira, new Date().toISOString())

    await enviarCodigoRecuperacion(usuario.correo, codigo)
    res.json({ existe: true, mensaje: 'Si el correo existe, recibirás un código de recuperación.' })
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
    if (!usuario || (usuario.rol !== 'DOCENTE' && usuario.rol !== 'ADMIN')) {
      return res.status(400).json({ error: 'Código inválido o expirado' })
    }

    // ─── RATE LIMIT: bloquear después de 5 intentos fallidos por correo ───
    // Solo cuentan los intentos fallidos (filas INVALID-): el código vigente
    // no consume intentos, así el usuario tiene exactamente 5 oportunidades.
    const MAX_INTENTOS_CODIGO = 5
    const hace15Min = new Date(Date.now() - 900000).toISOString()
    const intentosRecientes = await prisma._db.prepare(`
      SELECT COUNT(*) as c FROM password_resets
      WHERE usuarioId = ? AND codigo LIKE 'INVALID-%' AND creadoEn > ?
    `).get(usuario.id, hace15Min)
    if (intentosRecientes.c >= MAX_INTENTOS_CODIGO) {
      await prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE usuarioId = ? AND usado = 0').run(usuario.id)
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Pide un nuevo código.' })
    }

    const reset = await prisma._db.prepare(
      'SELECT * FROM password_resets WHERE usuarioId = ? AND codigo = ? AND usado = 0 ORDER BY creadoEn DESC LIMIT 1'
    ).get(usuario.id, String(codigo))
    if (!reset || new Date(reset.expira) < new Date()) {
      // Registrar intento fallido
      await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(
        require('crypto').randomUUID(), usuario.id, 'INVALID-' + require('crypto').randomUUID(), new Date(Date.now() + 15 * 60 * 1000).toISOString(), new Date().toISOString()
      )
      return res.status(400).json({ error: 'Código inválido o expirado. Te quedan ' + (MAX_INTENTOS_CODIGO - (intentosRecientes.c + 1)) + ' intentos.' })
    }

    const hash = bcrypt.hashSync(String(nuevaPassword), 10)
    await prisma._db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, usuario.id)
    await prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE id = ?').run(reset.id)
    // Limpiar cualquier otro código activo
    await prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE usuarioId = ? AND usado = 0').run(usuario.id)

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
      const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE correo = ? AND id != ?').get(nuevoCorreo, usuario.id)
      if (existente) return res.status(409).json({ error: 'Ese correo ya está en uso' })
      updates.push('correo = ?')
      params.push(String(nuevoCorreo).trim())
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar (envía nuevaPassword o nuevoCorreo)' })
    }

    params.push(usuario.id)
    await prisma._db.prepare(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    res.json({ mensaje: 'Perfil actualizado exitosamente' })
  } catch (error) {
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Sesión expirada, inicia sesión de nuevo' })
    console.error('Error PUT /mi-perfil:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── CÓDIGO DE VERIFICACIÓN DEL ADMIN (cambios sensibles en su panel) ───
// El admin pide su código → se envía a su correo de recuperación. Con ese
// código puede cambiar su documento, contraseña o correo (PUT /admin/mi-datos).
// El PRIMER correo se agrega SIN código (con la contraseña actual, vía
// PUT /mi-perfil): hasta entonces no hay a dónde enviarle el código.

// Reutiliza password_resets con prefijo CODE- para distinguirlos de los de
// recuperación (INVALID- marca los intentos fallidos de ambos flujos).
router.post('/codigo', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader) return res.status(401).json({ error: 'No hay token' })
    const token = authHeader.split(' ')[1]
    const datos = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })
    if (datos.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo para administradores' })

    const usuario = await prisma.usuario.findUnique({ where: { id: datos.id } })
    if (!usuario || !usuario.activo) return res.status(401).json({ error: 'Sesión inválida' })
    if (!usuario.correo) {
      return res.status(400).json({ error: 'Agrega primero tu correo de recuperación (con tu contraseña actual)' })
    }

    // Máximo 3 códigos por correo en la última hora
    const ahoraMenosUnaHora = new Date(Date.now() - 3600000).toISOString()
    const enviadosHora = await prisma._db.prepare(
      "SELECT COUNT(*) AS c FROM password_resets WHERE usuarioId = ? AND codigo NOT LIKE 'INVALID-%' AND creadoEn > ?"
    ).get(usuario.id, ahoraMenosUnaHora)
    if (enviadosHora.c >= 3) {
      return res.status(429).json({ error: 'Demasiados códigos solicitados. Espera un poco.' })
    }

    const codigo = String(Math.floor(100000 + Math.random() * 900000))
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    await prisma._db.prepare("DELETE FROM password_resets WHERE usuarioId = ? AND codigo LIKE 'INVALID-%'").run(usuario.id)
    await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(require('crypto').randomUUID(), usuario.id, codigo, expira, new Date().toISOString())

    await enviarCodigoRecuperacion(usuario.correo, codigo)
    res.json({ mensaje: 'Código enviado a tu correo de recuperación' })
  } catch (error) {
    console.error('Error POST /codigo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Cambios sensibles del admin (documento / contraseña / correo) con código
router.put('/admin/mi-datos', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader) return res.status(401).json({ error: 'No hay token' })
    const token = authHeader.split(' ')[1]
    const datos = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })
    if (datos.rol !== 'ADMIN') return res.status(403).json({ error: 'Solo para administradores' })

    const usuario = await prisma.usuario.findUnique({ where: { id: datos.id } })
    if (!usuario || !usuario.activo) return res.status(401).json({ error: 'Sesión inválida' })

    const { codigo, nuevoDocumento, nuevaPassword, nuevoCorreo } = req.body
    if (!codigo) return res.status(400).json({ error: 'El código de verificación es requerido' })
    if (!nuevoDocumento && !nuevaPassword && !nuevoCorreo) {
      return res.status(400).json({ error: 'Envía nuevoDocumento, nuevaPassword o nuevoCorreo' })
    }

    // ─── Validar el código (expira 15 min, máx 5 intentos fallidos) ───
    const MAX_INTENTOS_CODIGO = 5
    const hace15Min = new Date(Date.now() - 900000).toISOString()
    const intentosRecientes = await prisma._db.prepare(`
      SELECT COUNT(*) AS c FROM password_resets
      WHERE usuarioId = ? AND codigo LIKE 'INVALID-%' AND creadoEn > ?
    `).get(usuario.id, hace15Min)
    if (intentosRecientes.c >= MAX_INTENTOS_CODIGO) {
      await prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE usuarioId = ? AND usado = 0').run(usuario.id)
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Pide un nuevo código.' })
    }

    const reset = await prisma._db.prepare(
      'SELECT * FROM password_resets WHERE usuarioId = ? AND codigo = ? AND usado = 0 ORDER BY creadoEn DESC LIMIT 1'
    ).get(usuario.id, String(codigo))
    if (!reset || new Date(reset.expira) < new Date()) {
      await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(
        require('crypto').randomUUID(), usuario.id, 'INVALID-' + require('crypto').randomUUID(), new Date(Date.now() + 15 * 60 * 1000).toISOString(), new Date().toISOString()
      )
      return res.status(400).json({ error: 'Código inválido o expirado. Te quedan ' + (MAX_INTENTOS_CODIGO - (intentosRecientes.c + 1)) + ' intentos.' })
    }

    // ─── Aplicar los cambios ───
    const updates = []
    const params = []
    if (nuevoDocumento) {
      if (!/^\d+$/.test(String(nuevoDocumento))) {
        return res.status(400).json({ error: 'El documento debe ser numérico' })
      }
      const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND id != ?').get(String(nuevoDocumento), usuario.id)
      if (existente) return res.status(409).json({ error: 'Ese documento ya está en uso por otro usuario' })
      updates.push('documento = ?')
      params.push(String(nuevoDocumento))
    }
    if (nuevaPassword) {
      if (String(nuevaPassword).length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' })
      }
      updates.push('password = ?')
      params.push(bcrypt.hashSync(String(nuevaPassword), 10))
    }
    if (nuevoCorreo) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(nuevoCorreo).trim())) {
        return res.status(400).json({ error: 'Correo electrónico inválido' })
      }
      const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE correo = ? AND id != ?').get(String(nuevoCorreo).trim(), usuario.id)
      if (existente) return res.status(409).json({ error: 'Ese correo ya está en uso por otro usuario' })
      updates.push('correo = ?')
      params.push(String(nuevoCorreo).trim())
    }

    params.push(usuario.id)
    await prisma._db.prepare(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    // El código se consume
    await prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE id = ?').run(reset.id)

    const mensaje = updates.length === 1
      ? 'Dato actualizado exitosamente'
      : 'Datos actualizados exitosamente'
    const respuesta = { mensaje }
    if (nuevoDocumento) respuesta.documento = String(nuevoDocumento)
    res.json(respuesta)
  } catch (error) {
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Sesión expirada, inicia sesión de nuevo' })
    console.error('Error PUT /admin/mi-datos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router