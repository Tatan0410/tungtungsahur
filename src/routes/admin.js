const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')
const { calcularReporteCorte } = require('../services/reporteCorte')
const { calcularDefinitiva } = require('../services/calculoNotas')

const router = express.Router()

function verificarTokenAdmin(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'Acceso denegado. Inicia sesión primero.' })
  }
  try {
    const token  = authHeader.split(' ')[1]
    const datos  = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })
    req.usuario  = datos
    if (datos.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo administradores' })
    }
    next()
  } catch {
    return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' })
  }
}

router.use(verificarTokenAdmin)

// ─── PROFESORES ───

router.get('/profesores', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(`
      SELECT u.id, u.nombre, u.documento, u.activo, d.id AS "docenteId"
      FROM usuarios u
      JOIN docentes d ON d.usuarioId = u.id
      ORDER BY u.nombre ASC
    `).all()
    const data = await Promise.all(rows.map(async r => {
      const asignaciones = await prisma._db.prepare(`
        SELECT dm.id AS "asignacionId", dm.curso, m.nombre as materia
        FROM docente_materias dm
        JOIN materias m ON m.id = dm.materiaId
        WHERE dm.docenteId = ?
        ORDER BY dm.curso, m.nombre
      `).all(r.docenteId)
      return { ...r, asignaciones }
    }))
    res.json(data)
  } catch (error) {
    console.error('Error GET /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/profesores', async (req, res) => {
  try {
    const { documento, nombre, password } = req.body
    if (!documento || !nombre || !password) {
      return res.status(400).json({ error: 'documento, nombre y password son requeridos' })
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(documento)
    if (existente) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese documento' })
    }
    const hash = bcrypt.hashSync(password, 10)
    const id = require('crypto').randomUUID()
    const docenteId = require('crypto').randomUUID()
    await prisma._db.transaction(async () => {
      await prisma._db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, documento + '@docente.edu.co', hash, 'DOCENTE', nombre, documento)
      await prisma._db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docenteId, id)
    })()
    res.status(201).json({ mensaje: 'Profesor creado', id, nombre, documento })
  } catch (error) {
    console.error('Error POST /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/password', async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'password es requerido' })
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const hash = bcrypt.hashSync(password, 10)
    await prisma._db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, req.params.id)
    res.json({ mensaje: 'Contraseña actualizada' })
  } catch (error) {
    console.error('Error PUT /profesores/password:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/documento', async (req, res) => {
  try {
    const { documento } = req.body
    if (!documento) return res.status(400).json({ error: 'documento es requerido' })
    if (!/^\d+$/.test(documento)) return res.status(400).json({ error: 'El documento debe ser numérico' })
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND id != ?').get(documento, req.params.id)
    if (existente) return res.status(409).json({ error: 'Ese documento ya está en uso por otro usuario' })
    await prisma._db.prepare('UPDATE usuarios SET documento = ? WHERE id = ?').run(documento, req.params.id)
    res.json({ mensaje: 'Documento actualizado. El profesor deberá usar el nuevo documento en su próximo inicio de sesión.' })
  } catch (error) {
    console.error('Error PUT /profesores/documento:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/activo', async (req, res) => {
  try {
    const { activo } = req.body
    if (activo === undefined || activo === null) return res.status(400).json({ error: 'activo es requerido (true/false)' })
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    await prisma._db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, req.params.id)
    res.json({ mensaje: 'Estado actualizado', activo: !!activo })
  } catch (error) {
    console.error('Error PUT /profesores/activo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/profesores/:id', async (req, res) => {
  try {
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const docente = await prisma._db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(req.params.id)
    await prisma._db.transaction(async () => {
      if (docente) {
        await prisma._db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docente.id)
        await prisma._db.prepare('DELETE FROM docentes WHERE id = ?').run(docente.id)
      }
      await prisma._db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id)
    })()
    res.json({ mensaje: 'Profesor eliminado' })
  } catch (error) {
    console.error('Error DELETE /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/correo', async (req, res) => {
  try {
    const { correo } = req.body
    if (!correo) return res.status(400).json({ error: 'correo es requerido' })
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(String(correo).trim())) {
      return res.status(400).json({ error: 'Correo electrónico inválido' })
    }
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE correo = ? AND id != ?').get(String(correo).trim(), req.params.id)
    if (existente) return res.status(409).json({ error: 'Ese correo ya está en uso por otro usuario' })
    await prisma._db.prepare('UPDATE usuarios SET correo = ? WHERE id = ?').run(String(correo).trim(), req.params.id)
    res.json({ mensaje: 'Correo actualizado exitosamente' })
  } catch (error) {
    console.error('Error PUT /profesores/correo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ADMINISTRADORES ───
// Los admins pueden crear y eliminar otros admins. Regla de seguridad: el
// admin LOGUEADO nunca puede eliminarse a sí mismo ("el actual", pase lo que
// pase); el resto de admins sí puede ser eliminado por otro admin logueado.

router.get('/administradores', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(`
      SELECT id, nombre, documento, correo, activo, creadoEn
      FROM usuarios WHERE rol = 'ADMIN'
      ORDER BY nombre ASC
    `).all()
    res.json(rows)
  } catch (error) {
    console.error('Error GET /administradores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/administradores', async (req, res) => {
  try {
    const { documento, nombre, password } = req.body
    if (!documento || !nombre || !password) {
      return res.status(400).json({ error: 'documento, nombre y password son requeridos' })
    }
    if (!/^\d+$/.test(String(documento))) {
      return res.status(400).json({ error: 'El documento debe ser numérico' })
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(String(documento))
    if (existente) return res.status(409).json({ error: 'Ya existe un usuario con ese documento' })
    const hash = bcrypt.hashSync(String(password), 10)
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, ?, ?, ?, 1)').run(id, hash, 'ADMIN', String(nombre).trim(), String(documento))
    res.status(201).json({ mensaje: 'Administrador creado', id, nombre: String(nombre).trim(), documento: String(documento) })
  } catch (error) {
    console.error('Error POST /administradores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/administradores/:id', async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) {
      return res.status(409).json({ error: 'No puedes eliminar tu propio administrador' })
    }
    const admin = await prisma._db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'ADMIN'").get(req.params.id)
    if (!admin) return res.status(404).json({ error: 'Administrador no encontrado' })
    await prisma._db.prepare('DELETE FROM password_resets WHERE usuarioId = ?').run(req.params.id)
    await prisma._db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Administrador eliminado' })
  } catch (error) {
    console.error('Error DELETE /administradores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── MATERIAS ───

router.get('/materias', async (req, res) => {
  try {
    const rows = await prisma._db.prepare('SELECT * FROM materias ORDER BY nombre_norm ASC, nombre ASC').all()
    res.json(rows)
  } catch (error) {
    console.error('Error GET /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Normaliza un nombre de materia: minúsculas, sin acentos, sin espacios repetidos
function normalizarNombre(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

router.post('/materias', async (req, res) => {
  try {
    const { nombre, grado } = req.body
    if (!nombre) return res.status(400).json({ error: 'nombre es requerido' })
    const norm = normalizarNombre(nombre)
    const existente = await prisma._db.prepare('SELECT id, nombre FROM materias WHERE nombre_norm = ?').get(norm)
    if (existente) return res.status(409).json({ error: `La materia "${existente.nombre}" ya existe (los nombres se comparan sin acentos ni mayúsculas)` })
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO materias (id, nombre, grado, nombre_norm) VALUES (?, ?, ?, ?)').run(id, String(nombre).trim(), grado ? parseInt(grado) : null, norm)
    res.status(201).json({ mensaje: 'Materia creada', id, nombre: String(nombre).trim(), grado: grado ? parseInt(grado) : null })
  } catch (error) {
    console.error('Error POST /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ASIGNACIONES ───

// Lista FIJA de cursos vigentes. Los cursos existan o no estudiantes
// matriculados (p. ej. 604/704/804 vacíos) deben aparecer como opción
// en los dropdowns del panel para poder asignarles materias y mover
// estudiantes allí.
const CURSOS_VIGENTES = [
  '601', '602', '603', '604',
  '701', '702', '703', '704',
  '801', '802', '803', '804',
  '901', '902', '903', '904',
  '1001', '1002', '1003', '1004',
  '1101', '1102', '1103', '1104',
]

// Deriva grado/jornada/sede de un código de curso:
// 6xx→6° … 11xx→11° · sufijo 01/02→MAÑANA, 03/04→TARDE
function derivarCurso(curso) {
  const codigo = String(curso)
  const grado = parseInt(codigo.slice(0, codigo.length - 2), 10)
  const sufijo = codigo.slice(-2)
  let jornada = 'MAÑANA'
  if (sufijo === '03' || sufijo === '04') jornada = 'TARDE'
  return { grado, jornada, sede: 'PPAL - TRIUNFO' }
}

router.get('/cursos', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(
      "SELECT DISTINCT e.curso, e.grado, e.sede, e.jornada FROM estudiantes e WHERE e.curso != ''"
    ).all()
    const vistos = new Map()
    // Cursos reales de la BD (mantienen su grado/jornada/sede reales)
    for (const r of rows) vistos.set(String(r.curso), { curso: String(r.curso), grado: r.grado, sede: r.sede, jornada: r.jornada })
    // Los vigentes fijos siempre presentes, aunque no tengan estudiantes
    for (const c of CURSOS_VIGENTES) {
      if (!vistos.has(c)) {
        const d = derivarCurso(c)
        vistos.set(c, { curso: c, grado: d.grado, sede: d.sede, jornada: d.jornada })
      }
    }
    const cursos = [...vistos.values()].sort((a, b) => a.curso.localeCompare(b.curso, undefined, { numeric: true }))
    res.json(cursos.map(c => c.curso))
  } catch (error) {
    console.error('Error GET /cursos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/asignaciones', async (req, res) => {
  try {
    // LEFT JOIN: una asignación puede estar "sin maestro" (docenteId NULL)
    // mientras el admin la asigna a un curso.
    let sql = `
      SELECT dm.id, dm.curso, u.nombre as profesor, m.nombre as materia, m.grado as materia_grado, d.id AS "docenteId"
      FROM docente_materias dm
      LEFT JOIN docentes d ON d.id = dm.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      JOIN materias m ON m.id = dm.materiaId
    `
    const params = []
    if (req.query.curso) {
      sql += ' WHERE dm.curso = ?'
      params.push(String(req.query.curso))
    }
    sql += " ORDER BY dm.curso, m.nombre"
    res.json(await prisma._db.prepare(sql).all(...params))
  } catch (error) {
    console.error('Error GET /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

async function resolverDocenteId(docenteId, docenteDocumento) {
  if (docenteId) return docenteId
  if (!docenteDocumento) return null
  const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND rol = ?').get(docenteDocumento, 'DOCENTE')
  if (!user) return undefined
  const doc = await prisma._db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(user.id)
  if (!doc) return undefined
  return doc.id
}

router.post('/asignaciones', async (req, res) => {
  try {
    const { docenteDocumento, materiaId, curso } = req.body
    const docenteId = await resolverDocenteId(req.body.docenteId, docenteDocumento)
    if (docenteId === undefined) return res.status(404).json({ error: 'Profesor no encontrado' })
    if (!materiaId || !curso) return res.status(400).json({ error: 'materiaId y curso requeridos' })
    // Una materia se asigna una vez por curso (con o sin maestro)
    const existente = await prisma._db.prepare('SELECT id FROM docente_materias WHERE materiaId = ? AND curso = ?').get(materiaId, curso)
    if (existente) return res.status(409).json({ error: 'Esa materia ya está asignada a ese curso' })
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(id, docenteId, materiaId, curso)
    res.status(201).json({ mensaje: 'Asignación creada', id })
  } catch (error) {
    console.error('Error POST /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Asignar o cambiar el maestro de una asignación ya creada
// (también acepta docenteId: null para dejarla sin maestro).
router.put('/asignaciones/:id', async (req, res) => {
  try {
    const asig = await prisma._db.prepare('SELECT id FROM docente_materias WHERE id = ?').get(req.params.id)
    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' })

    const { docenteId, docenteDocumento } = req.body
    if (docenteId === undefined && docenteDocumento === undefined) {
      return res.status(400).json({ error: 'docenteId o docenteDocumento requeridos' })
    }

    // docenteId/docenteDocumento en null → dejar la asignación sin maestro
    const quitaMaestro = docenteId === null || docenteDocumento === null
    const resuelto = quitaMaestro ? null : await resolverDocenteId(docenteId, docenteDocumento)
    if (resuelto === undefined) return res.status(404).json({ error: 'Profesor no encontrado' })

    await prisma._db.prepare('UPDATE docente_materias SET docenteId = ? WHERE id = ?').run(resuelto, req.params.id)
    res.json({ mensaje: 'Maestro asignado' })
  } catch (error) {
    console.error('Error PUT /asignaciones/:id:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/asignaciones/:id', async (req, res) => {
  try {
    const asig = await prisma._db.prepare('SELECT id FROM docente_materias WHERE id = ?').get(req.params.id)
    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' })
    await prisma._db.prepare('DELETE FROM docente_materias WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Asignación eliminada' })
  } catch (error) {
    console.error('Error DELETE /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GESTIÓN DE PERIODOS POR SEDE ───

router.get('/sedes', async (req, res) => {
  try {
    const rows = await prisma._db.prepare('SELECT DISTINCT sede FROM estudiantes ORDER BY sede').all()
    res.json(rows.map(r => r.sede))
  } catch (error) {
    console.error('Error GET /sedes:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/periodos', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    let rows
    if (req.query.sede) {
      rows = await prisma._db.prepare('SELECT * FROM periodos_config WHERE sede = ? AND anio = ? ORDER BY periodo').all(req.query.sede, anio)
    } else {
      rows = await prisma._db.prepare('SELECT * FROM periodos_config WHERE anio = ? ORDER BY sede, periodo').all(anio)
    }
    const hoy = new Date()
    const rowsConEstado = rows.map(r => {
      let estado = 'ABIERTO'
      if (!r.abierto) {
        estado = 'CERRADO_MANUAL'
      } else if (r.fecha_fin) {
        const finDate = new Date(r.fecha_fin + 'T23:59:59')
        if (finDate < hoy && !r.reapertura_manual) {
          estado = 'CERRADO_AUTOMATICO'
        }
      }
      return { ...r, estado }
    })
    res.json(rowsConEstado)
  } catch (error) {
    console.error('Error GET /periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/periodos/:id', async (req, res) => {
  try {
    const { fecha_inicio, fecha_corte, fecha_fin } = req.body
    const existing = await prisma._db.prepare('SELECT id FROM periodos_config WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Período no encontrado' })
    const updates = []
    const params = []
    if (fecha_inicio !== undefined) { updates.push('fecha_inicio = ?'); params.push(fecha_inicio || null) }
    if (fecha_fin !== undefined) { updates.push('fecha_fin = ?'); params.push(fecha_fin || null) }
    if (fecha_corte !== undefined) { updates.push('fecha_corte = ?'); params.push(fecha_corte || null) }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' })
    params.push(req.params.id)
    await prisma._db.prepare(`UPDATE periodos_config SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    res.json({ mensaje: 'Período actualizado' })
  } catch (error) {
    console.error('Error PUT /periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── CERRAR PERÍODO MANUALMENTE ───

router.post('/periodos/cerrar', async (req, res) => {
  try {
    const { sede, periodo, anio } = req.body
    if (!sede || !periodo || !anio) {
      return res.status(400).json({ error: 'sede, periodo y anio son requeridos' })
    }
    const row = await prisma._db.prepare(
      'UPDATE periodos_config SET abierto = 0 WHERE sede = ? AND periodo = ? AND anio = ?'
    ).run(sede, parseInt(periodo), parseInt(anio))
    if (row.changes === 0) return res.status(404).json({ error: 'Período no encontrado' })
    res.json({ mensaje: 'Período cerrado manualmente.' })
  } catch (error) {
    console.error('Error POST /periodos/cerrar:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── REABRIR PERÍODO MANUALMENTE ───

router.post('/periodos/reabrir', async (req, res) => {
  try {
    const { sede, periodo, anio } = req.body
    if (!sede || !periodo || !anio) {
      return res.status(400).json({ error: 'sede, periodo y anio son requeridos' })
    }
    await prisma._db.prepare(
      'UPDATE periodos_config SET abierto = 1, reapertura_manual = 1 WHERE sede = ? AND periodo = ? AND anio = ?'
    ).run(sede, parseInt(periodo), parseInt(anio))
    res.json({ mensaje: 'Período reabierto. Los profesores pueden volver a guardar notas aunque haya pasado la fecha de corte final.' })
  } catch (error) {
    console.error('Error POST /periodos/reabrir:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ADMIN: REPORT DE CORTE ───

router.get('/reporte-corte', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo administradores' })
    }
    const { curso, periodo, anio, sede } = req.query
    if (!periodo || !anio) {
      return res.status(400).json({ error: 'periodo y anio son requeridos' })
    }

    const p = parseInt(periodo)
    const a = parseInt(anio)
    const reporte = []

    if (curso) {
      const r = await calcularReporteCorte(curso, p, a)
      reporte.push(...r)
    } else {
      let cursosQuery = 'SELECT DISTINCT curso FROM estudiantes'
      let params = []
      if (sede) {
        cursosQuery += ' WHERE sede = ?'
        params.push(sede)
      }
      const cursos = await prisma._db.prepare(cursosQuery).all(...params)
      for (const c of cursos) {
        const r = await calcularReporteCorte(c.curso, p, a)
        reporte.push(...r)
      }
    }

    let fechaCorte = null
    let yaPaso = false
    if (curso) {
      const sedeRow = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
      const s = sedeRow ? sedeRow.sede : 'PPAL - TRIUNFO'
      const cfg = await prisma._db.prepare(
        'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
      ).get(s, p, a)
      fechaCorte = cfg?.fecha_corte || null
      yaPaso = fechaCorte ? new Date(fechaCorte) <= new Date() : false
    } else {
      const sedes = await prisma._db.prepare('SELECT DISTINCT sede FROM periodos_config WHERE anio = ? AND periodo = ?').all(a, p)
      for (const s of sedes) {
        const cfg = await prisma._db.prepare(
          'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
        ).get(s.sede, p, a)
        if (cfg?.fecha_corte) {
          fechaCorte = cfg.fecha_corte
          yaPaso = new Date(fechaCorte) <= new Date()
          break
        }
      }
    }

    res.json({ reporte, fechaCorte, yaPaso })
  } catch (error) {
    console.error('Error GET /admin/reporte-corte:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── VISTA GLOBAL DE OBSERVACIONES (ADMIN) ───

router.get('/observaciones', async (req, res) => {
  try {
    const { curso, materiaId, sede, desde, hasta, pagina = 1 } = req.query
    const limite = 50
    const offset = (parseInt(pagina) - 1) * limite
    const where = []
    const params = []
    if (curso) { where.push('e.curso = ?'); params.push(curso) }
    if (materiaId) { where.push('o.materiaId = ?'); params.push(materiaId) }
    if (sede) { where.push('e.sede = ?'); params.push(sede) }
    if (desde) { where.push('o.fecha >= ?'); params.push(desde) }
    if (hasta) { where.push('o.fecha <= ?'); params.push(hasta) }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    let total = { total: 0 }
    try {
      total = await prisma._db.prepare(`
        SELECT COUNT(*) as total FROM observaciones o
        JOIN estudiantes e ON e.id = o.estudianteId
        ${whereClause}
      `).get(...params)
    } catch (e) { total = { total: 0 } }

    const rows = await prisma._db.prepare(`
      SELECT o.id, o.fecha, o.texto, o.tipo, o.creadoEn,
             u2.nombre AS "estudianteNombre", e.curso, e.sede,
             m.nombre AS "materiaNombre",
             u.nombre AS "docenteNombre"
      FROM observaciones o
      JOIN estudiantes e ON e.id = o.estudianteId
      JOIN usuarios u2 ON u2.id = e.usuarioId
      LEFT JOIN materias m ON m.id = o.materiaId
      LEFT JOIN docentes d ON d.id = o.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      ${whereClause}
      ORDER BY o.fecha DESC, o.creadoEn DESC
      LIMIT ? OFFSET ?
    `).all(...params, limite, offset)

    res.json({ observaciones: rows, total: total.total, pagina: parseInt(pagina), paginas: Math.ceil(total.total / limite) })
  } catch (error) {
    console.error('Error GET /admin/observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ESTUDIANTES ───

router.get('/estudiantes', async (req, res) => {
  try {
    const { curso, sede, grado, nombre, pagina = 1 } = req.query
    const limite = 100
    const offset = (parseInt(pagina) - 1) * limite
    const where = []
    const params = []
    if (curso) { where.push('e.curso = ?'); params.push(curso) }
    if (sede) { where.push('e.sede = ?'); params.push(sede) }
    if (grado) { where.push('e.grado = ?'); params.push(parseInt(grado)) }
    if (nombre) { where.push('u.nombre LIKE ?'); params.push('%' + String(nombre).trim() + '%') }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    let total = { total: 0 }
    try {
      total = await prisma._db.prepare(`
        SELECT COUNT(*) as total FROM estudiantes e
        JOIN usuarios u ON u.id = e.usuarioId
        ${whereClause}
      `).get(...params)
    } catch (e) { total = { total: 0 } }

    const rows = await prisma._db.prepare(`
      SELECT e.id, u.nombre, e.documento, e.curso, e.grado, e.sede, e.jornada
      FROM estudiantes e
      JOIN usuarios u ON u.id = e.usuarioId
      ${whereClause}
      ORDER BY u.nombre ASC
      LIMIT ? OFFSET ?
    `).all(...params, limite, offset)

    res.json({ estudiantes: rows, total: total.total, pagina: parseInt(pagina), paginas: Math.ceil(total.total / limite) })
  } catch (error) {
    console.error('Error GET /admin/estudiantes:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Notas de un estudiante en las materias de su curso, para el visor del
// panel de admin. Por materia trae los 4 periodos del año con la
// definitiva cerrada o, si aún no está cerrada, la parcial calculada
// en vivo desde las notas guardadas ("hasta el momento").
router.get('/estudiantes/:id/notas', async (req, res) => {
  try {
    const estudiante = await prisma._db.prepare(`
      SELECT e.id, u.nombre, e.documento, e.curso, e.grado, e.sede, e.jornada
      FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
      WHERE e.id = ?
    `).get(req.params.id)
    if (!estudiante) return res.status(404).json({ error: 'Estudiante no encontrado' })

    const materias = await prisma._db.prepare(`
      SELECT dm.materiaId, m.nombre AS "materiaNombre"
      FROM docente_materias dm
      JOIN materias m ON m.id = dm.materiaId
      WHERE dm.curso = ?
      ORDER BY m.nombre ASC
    `).all(estudiante.curso)

    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const resultado = []
    for (const mat of materias) {
      const periodos = []
      for (const p of [1, 2, 3, 4]) {
        const cal = await prisma._db.prepare(
          'SELECT id, definitiva FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?'
        ).get(estudiante.id, mat.materiaId, p, anio)
        let definitiva = cal ? cal.definitiva : null
        let provisional = false
        if (cal && definitiva === null) {
          const items = await prisma._db.prepare(
            'SELECT tipo, valor FROM notas_items WHERE calificacionId = ?'
          ).all(cal.id)
          if (items.length) {
            definitiva = calcularDefinitiva(items)
            provisional = definitiva !== null
          }
        }
        periodos.push({
          periodo: p,
          definitiva,
          provisional,
          estado: definitiva === null ? 'SIN_NOTA' : (definitiva < 3.0 ? 'RIESGO' : 'APROBADO'),
        })
      }
      resultado.push({ materiaId: mat.materiaId, materiaNombre: mat.materiaNombre, periodos })
    }
    res.json({ estudiante, anio, materias: resultado })
  } catch (error) {
    console.error('Error GET /admin/estudiantes/notas:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/cursos-disponibles', async (req, res) => {
  try {
    const { sede } = req.query
    const where = []
    const params = []
    if (sede) { where.push('sede = ?'); params.push(sede) }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    const rows = await prisma._db.prepare(`
      SELECT DISTINCT curso, grado, sede FROM estudiantes
      ${whereClause}
      ORDER BY curso ASC
    `).all(...params)

    const vistos = new Map()
    const agregar = r => {
      const sufijo = String(r.curso).slice(-2)
      let jornada = 'MAÑANA'
      if (sufijo === '01' || sufijo === '02') jornada = 'MAÑANA'
      else if (sufijo === '03' || sufijo === '04') jornada = 'TARDE'
      vistos.set(String(r.curso), { curso: r.curso, grado: r.grado, sede: r.sede, jornada })
    }
    for (const r of rows) agregar(r)
    // Los vigentes fijos siempre disponibles aunque no tengan estudiantes
    for (const c of CURSOS_VIGENTES) {
      if (!vistos.has(c)) agregar({ curso: c, ...derivarCurso(c) })
    }

    const cursos = [...vistos.values()].sort((a, b) => String(a.curso).localeCompare(String(b.curso), undefined, { numeric: true }))
    res.json({ cursos })
  } catch (error) {
    console.error('Error GET /admin/cursos-disponibles:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/estudiantes/:id/curso', async (req, res) => {
  try {
    const { curso, grado } = req.body
    if (!curso || !grado) {
      return res.status(400).json({ error: 'curso y grado son requeridos' })
    }

    const estudiante = await prisma._db.prepare('SELECT * FROM estudiantes WHERE id = ?').get(req.params.id)
    if (!estudiante) {
      return res.status(404).json({ error: 'Estudiante no encontrado' })
    }

    const sufijo = curso.slice(-2)
    let nuevaJornada = estudiante.jornada
    if (sufijo === '01' || sufijo === '02') nuevaJornada = 'MAÑANA'
    else if (sufijo === '03' || sufijo === '04') nuevaJornada = 'TARDE'

    await prisma._db.prepare(
      'UPDATE estudiantes SET curso = ?, grado = ?, jornada = ? WHERE id = ?'
    ).run(curso, parseInt(grado), nuevaJornada, req.params.id)

    res.json({ mensaje: `Estudiante movido a curso ${curso} (grado ${grado}, jornada ${nuevaJornada})` })
  } catch (error) {
    console.error('Error PUT /admin/estudiantes/curso:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── DIRECTORES DE GRUPO ───

router.get('/directores', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(`
      SELECT dg.id, dg.docenteId, dg.curso, dg.creadoEn,
             u.nombre AS "docenteNombre", u.documento AS "docenteDocumento"
      FROM directores_grupo dg
      JOIN docentes d ON d.id = dg.docenteId
      JOIN usuarios u ON u.id = d.usuarioId
      ORDER BY dg.curso ASC
    `).all()
    res.json({ directores: rows })
  } catch (error) {
    console.error('Error GET /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/directores', async (req, res) => {
  try {
    const { docenteId, curso } = req.body
    if (!docenteId || !curso) {
      return res.status(400).json({ error: 'docenteId y curso son requeridos' })
    }

    const docente = await prisma._db.prepare('SELECT id FROM docentes WHERE id = ?').get(docenteId)
    if (!docente) {
      return res.status(404).json({ error: 'Docente no encontrado' })
    }

    const existente = await prisma._db.prepare('SELECT id FROM directores_grupo WHERE curso = ?').get(curso)
    if (existente) {
      return res.status(409).json({ error: 'Este curso ya tiene un director asignado. Elimínalo primero si quieres reasignarlo.' })
    }

    const id = require('crypto').randomUUID()
    await prisma._db.prepare(
      'INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, ?)'
    ).run(id, docenteId, curso)

    res.status(201).json({ mensaje: 'Director asignado correctamente', id })
  } catch (error) {
    console.error('Error POST /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/directores/:id', async (req, res) => {
  try {
    const existing = await prisma._db.prepare('SELECT * FROM directores_grupo WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Asignación no encontrada' })
    }
    await prisma._db.prepare('DELETE FROM directores_grupo WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Director eliminado del curso' })
  } catch (error) {
    console.error('Error DELETE /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
