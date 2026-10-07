// =====================================================
// scripts/importar-excel.js
// Importación anual de estudiantes desde un Excel .xlsx.
// Compara contra la BD actual y clasifica cada fila:
//   NUEVO / ACTUALIZADO / SIN_CAMBIOS / REACTIVAR / A_DESACTIVAR
//
//   node scripts/importar-excel.js archivo.xlsx             → dry-run (solo informe)
//   node scripts/importar-excel.js archivo.xlsx --aplicar   → pide CONFIRMAR y aplica
//
// La lógica de parseo y clasificación es la MISMA que usa el panel
// admin (src/services/importar-estudiantes.js): una sola fuente de verdad.
// =====================================================

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const rutaArchivo = args.find(a => !a.startsWith('--'))

if (!rutaArchivo) {
  console.error('Uso:')
  console.error('  node scripts/importar-excel.js <archivo.xlsx>            (dry-run: solo analiza)')
  console.error('  node scripts/importar-excel.js <archivo.xlsx> --aplicar (aplica de verdad)')
  process.exit(1)
}

const fs = require('node:fs')
const path = require('node:path')

if (!fs.existsSync(rutaArchivo)) {
  console.error(`\u2716 No se encontr\u00f3 el archivo: ${rutaArchivo}`)
  process.exit(1)
}
if (!rutaArchivo.toLowerCase().endsWith('.xlsx')) {
  console.error('\u2716 Solo se aceptan archivos .xlsx')
  process.exit(1)
}

const { crearCliente } = require('../src/db/cliente')
const { parsearExcel, analizarImportacion } = require('../src/services/importar-estudiantes')

async function main() {
  require('dotenv').config({ override: false })
  const db = crearCliente()

  console.log(`Motor: ${db.motor}`)
  console.log(`Modo: ${APLICAR ? 'APLICAR (con confirmaci\u00f3n)' : 'DRY-RUN (solo informe)'}`)
  console.log(`Archivo: ${rutaArchivo}`)
  console.log('')

  // ─── Parsear el Excel ───
  const buffer = fs.readFileSync(rutaArchivo)
  const { estudiantes: filasExcel, errores } = parsearExcel(buffer)

  if (errores.length > 0) {
    console.error(`\u2716 El Excel tiene ${errores.length} fila(s) con problemas:`)
    errores.forEach(e => console.error(`  Fila ${e.fila}: ${e.mensaje}`))
    await db.close()
    process.exit(1)
  }
  if (!filasExcel.length) {
    console.error('\u2714 El Excel no tiene filas v\u00e1lidas')
    await db.close()
    return
  }
  console.log(`Filas v\u00e1lidas: ${filasExcel.length}`)

  // ─── Analizar contra la BD ───
  const analisis = await analizarImportacion(db, filasExcel)
  const r = analisis.resumen

  console.log('')
  console.log('=== RESUMEN ===')
  console.log(`  Nuevos:        ${r.nuevos}`)
  console.log(`  Actualizados:   ${r.actualizados}`)
  console.log(`  Sin cambios:    ${r.sinCambios}`)
  console.log(`  Reactivar:      ${r.reactivar}`)
  console.log(`  A desactivar:   ${r.aDesactivar}`)
  console.log(`  Total en Excel: ${r.totalExcel}`)
  console.log('')

  if (r.nuevos > 0) {
    console.log(`--- NUEVOS (${r.nuevos}) ---`)
    analisis.detalleNuevos.forEach(e => console.log(`  + ${e.nombre} (${e.documento}) \u2192 ${e.curso}`))
    console.log('')
  }
  if (r.actualizados > 0) {
    console.log(`--- ACTUALIZADOS (${r.actualizados}) ---`)
    analisis.detalleActualizados.forEach(e => {
      const cambios = e.cambios.map(c => `${c.campo}: ${c.viejo} \u2192 ${c.nuevo}`).join(', ')
      console.log(`  \u2192 ${e.nombre} (${e.documento}) ${cambios}`)
    })
    console.log('')
  }
  if (r.reactivar > 0) {
    console.log(`--- REACTIVAR (${r.reactivar}) ---`)
    analisis.detalleReactivar.forEach(e => console.log(`  \u21ba ${e.nombre} (${e.documento}) curso: ${e.cursoViejo} \u2192 ${e.cursoNuevo}`))
    console.log('')
  }
  if (r.aDesactivar > 0) {
    console.log(`--- A DESACTIVAR (${r.aDesactivar}) ---`)
    analisis.detalleADesactivar.forEach(e => console.log(`  \u26a0 ${e.nombre} (${e.documento}) curso: ${e.curso}`))
    console.log('')
  }

  // ─── Dry-run: terminar sin aplicar ───
  if (!APLICAR) {
    console.log('DRY-RUN: no se modific\u00f3 nada. Para aplicar:')
    console.log(`  node scripts/importar-excel.js "${rutaArchivo}" --aplicar`)
    await db.close()
    return
  }

  // ─── Pedir confirmación escrita ───
  const readline = require('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const preguntar = (q) => new Promise(resolve => rl.question(q, resolve))

  console.log('\u26a0 ESTA OPERACI\u00d3N MODIFICA LA BASE DE DATOS:')
  console.log(`  - Crear\u00e1 ${r.nuevos} estudiante(s) nuevo(s)`)
  console.log(`  - Actualizar\u00e1 ${r.actualizados} estudiante(s)`)
  console.log(`  - Reactivar\u00e1 ${r.reactivar} estudiante(s)`)
  console.log(`  - DESACTIVAR\u00c1 ${r.aDesactivar} estudiante(s) (no se borra nada)`)
  console.log('')

  const respuesta = await preguntar('Escribe CONFIRMAR para continuar: ')
  rl.close()

  if (respuesta.trim().toUpperCase() !== 'CONFIRMAR') {
    console.log('\u2716 Operaci\u00f3n cancelada. No se modific\u00f3 nada.')
    await db.close()
    return
  }

  // ─── Aplicar (transacción) ───
  const crypto = require('node:crypto')
  const bcrypt = require('bcryptjs')
  const nombreArchivo = path.basename(rutaArchivo)

  console.log('')
  console.log('Aplicando...')

  await db.transaction(async () => {
    // 1. NUEVOS
    for (const fila of filasExcel) {
      const yaExiste = await db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(fila.documento)
      if (yaExiste) continue
      const idUsuario = crypto.randomUUID()
      const idEstudiante = crypto.randomUUID()
      await db.prepare(
        'INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, ?, ?, ?, 1)'
      ).run(idUsuario, bcrypt.hashSync(fila.documento, 10), 'ESTUDIANTE', fila.nombre, fila.documento)
      await db.prepare(
        'INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(idEstudiante, idUsuario, fila.documento, fila.documento, fila.sede || 'PPAL - TRIUNFO', fila.jornada || 'MA\u00d1ANA', fila.grado, fila.curso)
    }

    // 2. ACTUALIZADOS + REACTIVAR
    for (const fila of filasExcel) {
      const actual = await db.prepare(
        'SELECT u.id AS "usuarioId", u.activo, e.id AS "estudianteId" FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE u.documento = ?'
      ).get(fila.documento)
      if (!actual) continue
      const cambios = []
      const params = []
      if (fila.curso) { cambios.push('curso = ?'); params.push(fila.curso) }
      if (fila.grado) { cambios.push('grado = ?'); params.push(fila.grado) }
      if (fila.sede) { cambios.push('sede = ?'); params.push(fila.sede) }
      if (fila.jornada) { cambios.push('jornada = ?'); params.push(fila.jornada) }
      if (cambios.length) {
        params.push(actual.estudianteId)
        await db.prepare(`UPDATE estudiantes SET ${cambios.join(', ')} WHERE id = ?`).run(...params)
      }
      if (!actual.activo) {
        await db.prepare('UPDATE usuarios SET activo = 1 WHERE id = ?').run(actual.usuarioId)
      }
    }

    // 3. A_DESACTIVAR
    const activos = await db.prepare(
      'SELECT u.id, u.documento FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE u.activo = 1'
    ).all()
    const docsEnExcel = new Set(filasExcel.map(f => f.documento))
    for (const act of activos) {
      if (!docsEnExcel.has(act.documento)) {
        await db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(act.id)
      }
    }

    // 4. Auditoría
    await db.prepare(
      'INSERT INTO importaciones_log (id, fecha, adminid, archivo_nombre, nuevos, actualizados, reactivados, desactivados) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), new Date().toISOString(), 'cli', nombreArchivo, r.nuevos, r.actualizados, r.reactivar, r.aDesactivar)
  })()

  console.log('')
  console.log('\u2714 IMPORTACI\u00d3N APLICADA')
  console.log(`  Nuevos: ${r.nuevos}`)
  console.log(`  Actualizados: ${r.actualizados}`)
  console.log(`  Reactivados: ${r.reactivar}`)
  console.log(`  Desactivados: ${r.aDesactivar}`)
  await db.close()
}

main().catch(e => { console.error('\u2716 FALLO:', e.message); process.exit(1) })
