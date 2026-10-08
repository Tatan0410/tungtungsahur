// =====================================================
// scripts/generar-estudiantes-prueba.js
// Genera N estudiantes de prueba para la prueba de escalabilidad k6.
//
//   node scripts/generar-estudiantes-prueba.js 800
//
// Documentos 99000001..990000+N, cursos 990/991, password = documento
// (bcrypt), activos, con términos ya aceptados (para no gastar un UPDATE
// por estudiante en su primer login durante la prueba). Idempotente:
// re-ejecutarlo no duplica nada.
//
// LIMPIEZA: scripts/remover-estudiantes-prueba.js borra TODO lo que
// empieza con el prefijo 9900 (verificado: no hay documentos reales
// con ese prefijo).
// =====================================================
require('dotenv').config({ override: false })
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const { crearCliente } = require('../src/db/cliente')

const TOTAL = parseInt(process.argv[2]) || 800
const NOMBRES = ['UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ']
const APELLIDOS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL']

;(async () => {
  const db = crearCliente()
  console.log('Motor:', db.motor)
  console.log('Objetivo:', TOTAL, 'estudiantes \u00b7 documentos 99000001..' + (99000000 + TOTAL) + ' \u00b7 cursos 990/991')

  let creados = 0, yaExistian = 0
  for (let lote = 0; lote < TOTAL; lote += 50) {
    await db.transaction(async () => {
      for (let i = lote; i < Math.min(lote + 50, TOTAL); i++) {
        const documento = String(99000001 + i)
        const existe = await db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(documento)
        if (existe) { yaExistian++; continue }
        const curso = i < TOTAL / 2 ? '990' : '991'
        const nombre = 'PRUEBA K6 ' + NOMBRES[i % 10] + ' ' + APELLIDOS[i % 8]
        const idU = crypto.randomUUID()
        const idE = crypto.randomUUID()
        await db.prepare(
          'INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo, terminos_version) VALUES (?, NULL, ?, ?, ?, ?, 1, ?)'
        ).run(idU, bcrypt.hashSync(documento, 10), 'ESTUDIANTE', nombre, documento, 'v1.0-2026-10')
        await db.prepare(
          'INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(idE, idU, documento, documento, 'PPAL - TRIUNFO', 'MA\u00d1ANA', 11, curso)
        creados++
      }
    })()
    process.stdout.write('\rLote ' + Math.min(lote + 50, TOTAL) + '/' + TOTAL + ' listo')
  }
  console.log('')
  console.log('Creados:', creados, '\u00b7 ya exist\u00edan:', yaExistian)
  const enBD = await db.prepare("SELECT COUNT(*) c FROM usuarios WHERE documento LIKE '9900%'").get()
  console.log('Total en BD con prefijo 9900:', Number(enBD.c))
  console.log('\nContrase\u00f1a de todos: su documento \u00b7 ej: 99000001 / 99000001')
  await db.close()
})().catch(e => { console.error('FALLO:', e.message); process.exit(1) })
