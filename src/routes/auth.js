const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const prisma  = require('../prisma')

const router = express.Router()

// Hash de códigos de recuperación: HMAC-SHA256 con clave derivada del
// JWT_SECRET + sufijo de propósito (distinta de la clave JWT). Derivación
// lazy: lee el secreto al primer uso, no al cargar el módulo.
let _claveHmacCodigos = null
function hashCodigo(codigo) {
  if (!_claveHmacCodigos) {
    _claveHmacCodigos = crypto
      .createHash('sha256')
      .update((process.env.JWT_SECRET || '') + ':recovery-codes')
      .digest('hex')
  }
  return crypto.createHmac('sha256', _claveHmacCodigos).update(String(codigo)).digest('hex')
}

// Comparación en tiempo constante (evita timing oracle); valida largo
function codigoCoincide(hashGuardado, codigoEnviado) {
  const hashCalculado = hashCodigo(codigoEnviado)
  const a = Buffer.from(hashGuardado || '', 'utf8')
  const b = Buffer.from(hashCalculado || '', 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

const MAX_INTENTOS = 5
const TIEMPO_BLOQUEO_MS = 15 * 60 * 1000

// Rate limit en memoria por IP para /login: evita fuerza bruta que prueba
// muchos documentos distintos desde la misma máquina.
// Solo cuenta intentos FALLIDOS: los logins exitosos no consumen el cupo,
// así una escuela con muchas peticiones desde la misma IP (NAT) no se bloquea.
// 80 fallos por ventana de 5 minutos: el colegio comparte UNA IP pública y en
// los picos de login (p. ej. publicación de boletines) los typos colectivos de
// ~800 estudiantes superaban los 30/min antiguos y bloqueaban a toda la sede.
// El límite fino por documento (5 fallos / 15 min) es el que corta la fuerza
// bruta de verdad; este solo frena el ruido masivo por IP.
const loginPorIp = new Map()
const FALLOS_IP_MAX = 80
const FALLOS_IP_VENTANA_MS = 5 * 60 * 1000

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
    reg = { count: 0, resetAt: ahora + FALLOS_IP_VENTANA_MS }
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

// Versión canónica del texto legal (Términos y Condiciones + Política de
// Tratamiento de Datos). El SERVIDOR es quien la define y registra: si el
// texto legal cambia mañana, se sube la versión y todos deben re-aceptar.
const VERSION_TERMINOS = 'v1.0-2026-10'

router.post('/login', async (req, res) => {
  try {
    const { documento, password, aceptaTerminos } = req.body

    if (!documento || !password) {
      return res.status(400).json({ error: 'Documento y contraseña son requeridos' })
    }

    // Evidencia legal: el checkbox de los términos debe estar marcado.
    // Se pide SIEMPRE en el login visible, pero el registro en la BD solo
    // se actualiza cuando la versión del texto cambió (o es la primera vez).
    if (aceptaTerminos !== true) {
      return res.status(400).json({ error: 'Debes aceptar los términos para continuar' })
    }

    // ─── RATE LIMITING POR IP (solo fallos) ───
    const ipLogin = req.ip || req.connection.remoteAddress || 'desconocida'
    if (fallosPorIp(ipLogin) >= FALLOS_IP_MAX) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos desde esta IP. Espera unos minutos.' })
    }

    // ─── RATE LIMITING ───
    const intento = await prisma._db.prepare('SELECT * FROM intentos_login WHERE documento = ?').get(documento)
    if (intento && intento.bloqueadoHasta) {
      const hasta = new Date(intento.bloqueadoHasta)
      if (hasta > new Date()) {
        const minsRest = Math.ceil((hasta - new Date()) / 60000)
        return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${minsRest} minuto(s).` })
      }
      // El bloqueo ya expiró: el ciclo de 5 intentos vuelve a empezar desde
      // cero. Antes el contador acumulado condenaba la cuenta: UN solo fallo
      // tras la espera re-bloqueaba otros 15 min y el estudiante que escribía
      // mal su documento quedaba atrapado en un bucle de bloqueos. Este
      // intento en curso, si falla, cuenta como 1 (no como 6). UPDATE y no
      // DELETE: dos peticiones simultáneas tras expirar no revientan por un
      // INSERT duplicado.
      await prisma._db.prepare('UPDATE intentos_login SET intentos = 0, bloqueadoHasta = NULL WHERE documento = ?').run(documento)
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

    // Evidencia legal: registra la aceptación SOLO si la versión del
    // usuario difiere de la actual (o nunca ha aceptado). Así no se
    // escribe la BD en cada login, y si el texto legal cambia, la
    // próxima aceptación queda registrada con fecha nueva.
    if (usuario.terminosVersion !== VERSION_TERMINOS) {
      await prisma._db.prepare('UPDATE usuarios SET terminos_aceptados_en = ?, terminos_version = ? WHERE id = ?')
        .run(new Date().toISOString(), VERSION_TERMINOS, usuario.id)
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
    // SMTP no configurado: el código NO se imprime en logs (secreto). En
    // producción SMTP está definido; en desarrollo el flujo se prueba con
    // tests que leen la BD directamente.
    console.log('SMTP no configurado: no se pudo enviar el código de recuperación')
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
    // El código NO se imprime en logs (secreto)
    console.error(`Error enviando código a ${correoDestino}:`, err.message)
  })
}

// Rate limit en memoria para /recuperar (por IP): 20 solicitudes/minuto
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
      if (reg.count > 20) {
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

    const codigo = String(crypto.randomInt(100000, 1000000))
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    // Pedir un código nuevo reinicia los intentos fallidos del ciclo anterior
    await prisma._db.prepare("DELETE FROM password_resets WHERE usuarioId = ? AND codigo LIKE 'INVALID-%'").run(usuario.id)
    // creadoEn explícito en ISO-8601: el DEFAULT CURRENT_TIMESTAMP de SQLite
    // guarda 'YYYY-MM-DD HH:MM:SS' (sin T) y no compara bien contra los ISO.
    await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(require('crypto').randomUUID(), usuario.id, hashCodigo(codigo), expira, new Date().toISOString())

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

    // Traer los códigos VIGENTES (sin matchear en SQL) y comparar el hash
    // en tiempo constante: la comparación de strings de SQLite filtra por
    // longitud y no es resistente a timing oracles.
    const candidatos = await prisma._db.prepare(
      "SELECT * FROM password_resets WHERE usuarioId = ? AND usado = 0 AND codigo NOT LIKE 'INVALID-%' ORDER BY creadoEn DESC"
    ).all(usuario.id)
    const reset = candidatos.find(f => codigoCoincide(f.codigo, String(codigo)) && new Date(f.expira) >= new Date())
    if (!reset) {
      // Registrar intento fallido
      await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(
        require('crypto').randomUUID(), usuario.id, 'INVALID-' + require('crypto').randomUUID(), new Date(Date.now() + 15 * 60 * 1000).toISOString(), new Date().toISOString()
      )
      return res.status(400).json({ error: 'Código inválido o expirado. Te quedan ' + (MAX_INTENTOS_CODIGO - (intentosRecientes.c + 1)) + ' intentos.' })
    }

    // ─── Consumo atómico del código + cambio de contraseña en UNA transacción ───
    // El UPDATE solo marca usado=1 si AÚN está vigente (usado=0 y no expirado);
    // si otra petición lo consumió antes, changes=0 y se rechaza. La contraseña
    // se cambia en la MISMA transacción: o se consume el código y se cambia,
    // o no pasa nada.
    const hash = bcrypt.hashSync(String(nuevaPassword), 10)
    const consumido = await prisma._db.transaction(async () => {
      const upd = await prisma._db.prepare(
        'UPDATE password_resets SET usado = 1 WHERE id = ? AND usado = 0 AND expira > ?'
      ).run(reset.id, new Date().toISOString())
      if (upd.changes !== 1) return false
      await prisma._db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, usuario.id)
      // Limpiar cualquier otro código activo
      await prisma._db.prepare('UPDATE password_resets SET usado = 1 WHERE usuarioId = ? AND usado = 0').run(usuario.id)
      return true
    })()
    if (!consumido) {
      return res.status(400).json({ error: 'Código inválido o expirado' })
    }

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

    const codigo = String(crypto.randomInt(100000, 1000000))
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    await prisma._db.prepare("DELETE FROM password_resets WHERE usuarioId = ? AND codigo LIKE 'INVALID-%'").run(usuario.id)
    await prisma._db.prepare('INSERT INTO password_resets (id, usuarioId, codigo, expira, creadoEn) VALUES (?, ?, ?, ?, ?)').run(require('crypto').randomUUID(), usuario.id, hashCodigo(codigo), expira, new Date().toISOString())

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

    // Comparación del hash en tiempo constante (mismo criterio que
    // /recuperar/verificar: traer vigentes y comparar con timingSafeEqual)
    const candidatos = await prisma._db.prepare(
      "SELECT * FROM password_resets WHERE usuarioId = ? AND usado = 0 AND codigo NOT LIKE 'INVALID-%' ORDER BY creadoEn DESC"
    ).all(usuario.id)
    const reset = candidatos.find(f => codigoCoincide(f.codigo, String(codigo)) && new Date(f.expira) >= new Date())
    if (!reset) {
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

    // Consumo atómico del código + cambio en UNA transacción (misma
    // garantía que /recuperar/verificar: o todo, o nada)
    params.push(usuario.id)
    const consumido = await prisma._db.transaction(async () => {
      const upd = await prisma._db.prepare(
        'UPDATE password_resets SET usado = 1 WHERE id = ? AND usado = 0 AND expira > ?'
      ).run(reset.id, new Date().toISOString())
      if (upd.changes !== 1) return false
      await prisma._db.prepare(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`).run(...params)
      return true
    })()
    if (!consumido) {
      return res.status(400).json({ error: 'Código inválido o expirado' })
    }

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
// Exportado para tests: los códigos se guardan hasheados (HMAC), los tests
// derivan el código a partir del hash almacenado usando esta misma función.
module.exports.hashCodigo = hashCodigo