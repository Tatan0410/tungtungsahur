// =====================================================
// src/routes/asistencia.js — Fase 2A: toma de asistencia
//
// Roles:
//  * DOCENTE: toma/consulta la lista SOLO de cursos+materias que tiene
//    asignados (verificarDocenteAsignado). Nunca fechas futuras ni de más
//    de 30 días atrás.
//  * DIRECTOR (DOCENTE con fila en directores_grupo): resumen de SU curso.
//    El curso permitido sale de directores_grupo + token, NUNCA del cliente:
//    pedir un curso ajeno (aunque dicte en él) es 403.
//  * ADMIN: guarda como autor al docente asignado a (materiaId, curso);
//    ve el resumen de cualquier curso y puede registrar fechas antiguas.
//  * ESTUDIANTE: solo /mia (su propia asistencia, sin parámetros de identidad).
// =====================================================
const express = require('express')
const jwt     = require('jsonwebtoken')
const crypto  = require('node:crypto')
const prisma  = require('../prisma')
const { verificarDocenteAsignado } = require('../services/autorizacion')

const db = prisma._db
const router = express.Router()

const ESTADOS_VALIDOS = ['AUSENTE', 'TARDANZA', 'EXCUSA']

// Mismo middleware de autenticación que notas.js
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

// ─── Utilidades de fecha (AAAA-MM-DD; "hoy" = America/Bogota = UTC-5 fijo) ───

function hoyBogota() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10)
}

// Fecha real de calendario en formato AAAA-MM-DD (rechaza 2026-02-30, 12-10-2026…)
function esFechaReal(f) {
  if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false
  const d = new Date(f + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return false
  const [y, m, dia] = f.split('-').map(Number)
  return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === dia
}

function restarDias(f, n) {
  const d = new Date(f + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function sesionDe(curso, materiaId, fecha) {
  return db.prepare('SELECT * FROM asistencia_sesiones WHERE curso = ? AND materiaId = ? AND fecha = ?')
    .get(curso, materiaId, fecha)
}

async function estudiantesActivos(curso) {
  return db.prepare(`
    SELECT e.id AS "estudianteId", u.nombre
    FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
    WHERE e.curso = ? AND u.activo = 1
    ORDER BY u.nombre ASC
  `).all(curso)
}

function pct(parte, total) {
  if (!total) return 0
  return Math.round((parte / total) * 1000) / 10
}

// ─── (a) POST /api/asistencia/sesion — tomar/reemplazar la lista ───
router.post('/sesion', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes y administradores' })
    }
    const { materiaId, fecha, registros } = req.body
    const curso = String(req.body.curso || '').trim()
    if (!curso || !materiaId || !fecha) {
      return res.status(400).json({ error: 'curso, materiaId y fecha son requeridos' })
    }
    if (!esFechaReal(fecha)) {
      return res.status(400).json({ error: 'La fecha debe ser una fecha real en formato AAAA-MM-DD' })
    }
    const hoy = hoyBogota()
    if (fecha > hoy) {
      return res.status(400).json({ error: 'La fecha no puede ser futura' })
    }

    let docenteAutor = req.usuario.docenteId
    if (req.usuario.rol === 'DOCENTE') {
      if (!(await verificarDocenteAsignado(db, req.usuario.docenteId, materiaId, curso))) {
        return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
      }
      if (fecha < restarDias(hoy, 30)) {
        return res.status(400).json({ error: 'La fecha no puede ser de más de 30 días atrás' })
      }
    } else {
      // ADMIN: la autoría es del docente asignado a esa materia/curso
      const asig = await db.prepare('SELECT docenteId FROM docente_materias WHERE materiaId = ? AND curso = ?').get(materiaId, curso)
      if (!asig) {
        return res.status(400).json({ error: 'No hay docente asignado a esa materia en ese curso' })
      }
      docenteAutor = asig.docenteId
    }

    if (!Array.isArray(registros)) {
      return res.status(400).json({ error: 'registros debe ser un arreglo' })
    }
    if (registros.length > 200) {
      return res.status(400).json({ error: 'Máximo 200 registros por sesión' })
    }
    const vistos = new Set()
    for (const r of registros) {
      if (!r || !r.estudianteId || !ESTADOS_VALIDOS.includes(r.estado)) {
        return res.status(400).json({ error: 'Cada registro necesita estudianteId y estado (AUSENTE, TARDANZA o EXCUSA)' })
      }
      if (vistos.has(r.estudianteId)) {
        return res.status(400).json({ error: 'Hay estudiantes repetidos en la lista' })
      }
      vistos.add(r.estudianteId)
    }
    if (registros.length) {
      const marcas = registros.map(() => '?').join(',')
      const filas = await db.prepare(`
        SELECT e.id FROM estudiantes e
        WHERE e.id IN (${marcas}) AND e.curso = ?
          AND EXISTS (SELECT 1 FROM usuarios u WHERE u.id = e.usuarioId AND u.activo = 1)
      `).all(...registros.map(r => r.estudianteId), curso)
      if (filas.length !== registros.length) {
        return res.status(400).json({ error: 'Hay estudiantes que no pertenecen a este curso o están inactivos' })
      }
    }

    const ahora = new Date().toISOString()
    const activos = (await estudiantesActivos(curso)).length
    let sesionId = null

    // Upsert atómico: la sesión se crea (o se actualiza) y SUS registros se
    // reemplazan completos dentro de la misma transacción. Lista vacía =
    // todos presentes. Última escritura gana.
    await db.transaction(async () => {
      const existente = await sesionDe(curso, materiaId, fecha)
      if (existente) {
        sesionId = existente.id
        await db.prepare('UPDATE asistencia_sesiones SET actualizadoEn = ? WHERE id = ?').run(ahora, sesionId)
        await db.prepare('DELETE FROM asistencia_registros WHERE sesionId = ?').run(sesionId)
      } else {
        sesionId = crypto.randomUUID()
        await db.prepare(
          'INSERT INTO asistencia_sesiones (id, curso, materiaId, docenteId, fecha, creadoEn, actualizadoEn) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(sesionId, curso, materiaId, docenteAutor, fecha, ahora, ahora)
      }
      for (const r of registros) {
        await db.prepare('INSERT INTO asistencia_registros (id, sesionId, estudianteId, estado) VALUES (?, ?, ?, ?)')
          .run(crypto.randomUUID(), sesionId, r.estudianteId, r.estado)
      }
    })()

    const conteo = { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
    for (const r of registros) conteo[r.estado]++
    res.json({
      sesionId,
      ausentes: conteo.AUSENTE,
      tardanzas: conteo.TARDANZA,
      excusas: conteo.EXCUSA,
      presentes: Math.max(0, activos - registros.length),
    })
  } catch (error) {
    console.error('Error POST /asistencia/sesion:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── (b) GET /api/asistencia/sesion — la lista de un día ───
router.get('/sesion', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo docentes y administradores' })
    }
    const { materiaId, fecha } = req.query
    const curso = String(req.query.curso || '').trim()
    if (!curso || !materiaId || !fecha) {
      return res.status(400).json({ error: 'curso, materiaId y fecha son requeridos' })
    }
    if (!esFechaReal(fecha)) {
      return res.status(400).json({ error: 'La fecha debe ser una fecha real en formato AAAA-MM-DD' })
    }
    if (req.usuario.rol === 'DOCENTE' && !(await verificarDocenteAsignado(db, req.usuario.docenteId, materiaId, curso))) {
      return res.status(403).json({ error: 'No tienes asignada esa materia en ese curso' })
    }

    const activos = await estudiantesActivos(curso)
    const sesion = await sesionDe(curso, materiaId, fecha)
    const estados = new Map()
    if (sesion) {
      const regs = await db.prepare('SELECT estudianteId, estado FROM asistencia_registros WHERE sesionId = ?').all(sesion.id)
      for (const r of regs) estados.set(r.estudianteId, r.estado)
    }
    res.json({
      curso, materiaId, fecha,
      tomada: !!sesion,
      sesionId: sesion ? sesion.id : null,
      estudiantes: activos.map(e => ({
        estudianteId: e.estudianteId,
        nombre: e.nombre,
        estado: estados.get(e.estudianteId) || null,
      })),
    })
  } catch (error) {
    console.error('Error GET /asistencia/sesion:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── (c) GET /api/asistencia/resumen — SOLO director del curso o admin ───
router.get('/resumen', async (req, res) => {
  try {
    if (req.usuario.rol !== 'DOCENTE' && req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo el director de grupo puede ver el resumen de asistencia' })
    }
    const { materiaId } = req.query
    const curso = String(req.query.curso || '').trim()
    const desde = req.query.desde, hasta = req.query.hasta
    if (!curso || !desde || !hasta) {
      return res.status(400).json({ error: 'curso, desde y hasta son requeridos' })
    }
    if (!esFechaReal(desde) || !esFechaReal(hasta)) {
      return res.status(400).json({ error: 'desde y hasta deben ser fechas reales en formato AAAA-MM-DD' })
    }
    if (desde > hasta) {
      return res.status(400).json({ error: 'desde no puede ser posterior a hasta' })
    }
    if (new Date(hasta + 'T00:00:00Z') - new Date(desde + 'T00:00:00Z') > 366 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'El rango no puede superar un año' })
    }

    if (req.usuario.rol === 'DOCENTE') {
      // El curso permitido sale de directores_grupo + token, NUNCA del cliente
      const dir = await db.prepare('SELECT id FROM directores_grupo WHERE docenteId = ? AND curso = ?')
        .get(req.usuario.docenteId, curso)
      if (!dir) {
        return res.status(403).json({ error: 'No eres el director de grupo de este curso' })
      }
    }

    let sesiones
    if (materiaId) {
      sesiones = await db.prepare('SELECT id, materiaId FROM asistencia_sesiones WHERE curso = ? AND fecha BETWEEN ? AND ? AND materiaId = ?')
        .all(curso, desde, hasta, materiaId)
    } else {
      sesiones = await db.prepare('SELECT id, materiaId FROM asistencia_sesiones WHERE curso = ? AND fecha BETWEEN ? AND ?')
        .all(curso, desde, hasta)
    }

    let regs
    if (materiaId) {
      regs = await db.prepare(`
        SELECT r.estudianteId, s.materiaId, r.estado, COUNT(*) AS c
        FROM asistencia_registros r JOIN asistencia_sesiones s ON s.id = r.sesionId
        WHERE s.curso = ? AND s.fecha BETWEEN ? AND ? AND s.materiaId = ?
        GROUP BY r.estudianteId, s.materiaId, r.estado
      `).all(curso, desde, hasta, materiaId)
    } else {
      regs = await db.prepare(`
        SELECT r.estudianteId, s.materiaId, r.estado, COUNT(*) AS c
        FROM asistencia_registros r JOIN asistencia_sesiones s ON s.id = r.sesionId
        WHERE s.curso = ? AND s.fecha BETWEEN ? AND ?
        GROUP BY r.estudianteId, s.materiaId, r.estado
      `).all(curso, desde, hasta)
    }

    const sesionesPorMateria = {}
    for (const s of sesiones) sesionesPorMateria[s.materiaId] = (sesionesPorMateria[s.materiaId] || 0) + 1

    const nombresMaterias = new Map(
      (await db.prepare('SELECT id, nombre FROM materias').all()).map(m => [m.id, m.nombre])
    )
    const activos = await estudiantesActivos(curso)

    const porEstudiante = activos.map(e => {
      const tot = { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
      const porMat = {}
      for (const r of regs) {
        if (r.estudianteId !== e.estudianteId) continue
        tot[r.estado] += r.c
        if (!porMat[r.materiaId]) porMat[r.materiaId] = { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
        porMat[r.materiaId][r.estado] += r.c
      }
      return {
        estudianteId: e.estudianteId,
        nombre: e.nombre,
        ausencias: tot.AUSENTE,
        tardanzas: tot.TARDANZA,
        excusas: tot.EXCUSA,
        porcentajeInasistencia: pct(tot.AUSENTE, sesiones.length),
        porMateria: Object.keys(sesionesPorMateria).map(mid => {
          const m = porMat[mid] || { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
          return {
            materiaId: mid,
            materiaNombre: nombresMaterias.get(mid) || '—',
            sesiones: sesionesPorMateria[mid],
            ausencias: m.AUSENTE,
            tardanzas: m.TARDANZA,
            excusas: m.EXCUSA,
            porcentajeInasistencia: pct(m.AUSENTE, sesionesPorMateria[mid]),
          }
        }),
      }
    })

    res.json({ curso, desde, hasta, sesiones: sesiones.length, porEstudiante })
  } catch (error) {
    console.error('Error GET /asistencia/resumen:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── (d) GET /api/asistencia/mia — SOLO el estudiante del token ───
router.get('/mia', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ESTUDIANTE' || !req.usuario.estudianteId) {
      return res.status(403).json({ error: 'Solo estudiantes' })
    }
    const hoy = hoyBogota()
    let desde = req.query.desde, hasta = req.query.hasta
    if (desde !== undefined && !esFechaReal(desde)) {
      return res.status(400).json({ error: 'desde debe ser una fecha real en formato AAAA-MM-DD' })
    }
    if (hasta !== undefined && !esFechaReal(hasta)) {
      return res.status(400).json({ error: 'hasta debe ser una fecha real en formato AAAA-MM-DD' })
    }
    if (!desde) desde = hoy.slice(0, 4) + '-01-01'
    if (!hasta) hasta = hoy
    if (desde > hasta) {
      return res.status(400).json({ error: 'desde no puede ser posterior a hasta' })
    }

    const estudianteId = req.usuario.estudianteId
    const est = await db.prepare('SELECT curso FROM estudiantes WHERE id = ?').get(estudianteId)
    if (!est) return res.status(404).json({ error: 'Estudiante no encontrado' })

    const regs = await db.prepare(`
      SELECT s.fecha, s.materiaId, r.estado
      FROM asistencia_registros r JOIN asistencia_sesiones s ON s.id = r.sesionId
      WHERE r.estudianteId = ? AND s.fecha BETWEEN ? AND ?
      ORDER BY s.fecha DESC
    `).all(estudianteId, desde, hasta)

    const sesionesCurso = await db.prepare(
      'SELECT materiaId, COUNT(*) AS c FROM asistencia_sesiones WHERE curso = ? AND fecha BETWEEN ? AND ? GROUP BY materiaId'
    ).all(est.curso, desde, hasta)

    const nombresMaterias = new Map(
      (await db.prepare('SELECT id, nombre FROM materias').all()).map(m => [m.id, m.nombre])
    )
    const sesionesPorMat = new Map(sesionesCurso.map(s => [s.materiaId, s.c]))

    const tot = { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
    const porMat = {}
    for (const r of regs) {
      tot[r.estado]++
      if (!porMat[r.materiaId]) porMat[r.materiaId] = { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
      porMat[r.materiaId][r.estado]++
    }

    res.json({
      desde, hasta,
      totales: { ausencias: tot.AUSENTE, tardanzas: tot.TARDANZA, excusas: tot.EXCUSA },
      porMateria: [...sesionesPorMat.keys()].map(mid => {
        const m = porMat[mid] || { AUSENTE: 0, TARDANZA: 0, EXCUSA: 0 }
        return {
          materiaId: mid,
          materiaNombre: nombresMaterias.get(mid) || '—',
          sesiones: sesionesPorMat.get(mid) || 0,
          ausencias: m.AUSENTE,
          tardanzas: m.TARDANZA,
          excusas: m.EXCUSA,
          porcentajeInasistencia: pct(m.AUSENTE, sesionesPorMat.get(mid) || 0),
        }
      }),
      ultimas: regs.slice(0, 10).map(r => ({
        fecha: r.fecha,
        materiaNombre: nombresMaterias.get(r.materiaId) || '—',
        estado: r.estado,
      })),
    })
  } catch (error) {
    console.error('Error GET /asistencia/mia:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
