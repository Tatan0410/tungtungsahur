// =====================================================
// scripts/remover-estudiantes-prueba.js
// Borra TODOS los estudiantes de prueba de la escalabilidad k6
// (documentos con prefijo 9900) y sus dependencias, en una
// transacción por lote. Imprime conteos antes/después.
//
//   node scripts/remover-estudiantes-prueba.js
//
// Nunca toca estudiantes reales: el prefijo 9900 se verificó
// libre de colisiones antes de generar.
// =====================================================
require('dotenv').config({ override: false })
const { crearCliente } = require('../src/db/cliente')

;(async () => {
  const db = crearCliente()
  console.log('Motor:', db.motor)

  const antes = {
    usuarios: Number((await db.prepare("SELECT COUNT(*) c FROM usuarios WHERE documento LIKE '9900%'").get()).c),
    estudiantes: Number((await db.prepare("SELECT COUNT(*) c FROM estudiantes WHERE documento LIKE '9900%'").get()).c),
  }
  const realesAntes = Number((await db.prepare("SELECT COUNT(*) c FROM usuarios WHERE rol = 'ESTUDIANTE' AND documento NOT LIKE '9900%'").get()).c)
  if (antes.usuarios === 0) {
    console.log('No hay estudiantes de prueba que remover.')
    await db.close()
    return
  }
  console.log('A remover:', antes.usuarios, 'usuarios /', antes.estudiantes, 'estudiantes')

  // Ids de los estudiantes de prueba (en lotes, por si el IN crece)
  let removidos = 0
  while (true) {
    const idsEst = (await db.prepare("SELECT id FROM estudiantes WHERE documento LIKE '9900%' LIMIT 100").all()).map(r => r.id)
    if (!idsEst.length) break
    await db.transaction(async () => {
      const marcas = idsEst.map(() => '?').join(',')
      // hijos primero (FKs); notas_items cae solo por FK cascade de calificaciones
      await db.prepare(`DELETE FROM observaciones WHERE estudianteId IN (${marcas})`).run(...idsEst)
      await db.prepare(`DELETE FROM informes WHERE estudianteId IN (${marcas})`).run(...idsEst)
      await db.prepare(`DELETE FROM consultas_estudiantes WHERE estudianteId IN (${marcas})`).run(...idsEst)
      await db.prepare(`DELETE FROM calificaciones WHERE estudianteId IN (${marcas})`).run(...idsEst)
      await db.prepare(`DELETE FROM estudiantes WHERE id IN (${marcas})`).run(...idsEst)
    })()
    removidos += idsEst.length
    process.stdout.write('\rEstudiantes removidos: ' + removidos)
  }
  console.log('')

  // usuarios + intentos de login de prueba (siempre por prefijo 9900)
  let usRemovidos = 0
  while (true) {
    const idsU = (await db.prepare("SELECT id FROM usuarios WHERE documento LIKE '9900%' LIMIT 100").all()).map(r => r.id)
    if (!idsU.length) break
    await db.transaction(async () => {
      const marcas = idsU.map(() => '?').join(',')
      await db.prepare(`DELETE FROM usuarios WHERE id IN (${marcas})`).run(...idsU)
    })()
    usRemovidos += idsU.length
    process.stdout.write('\rUsuarios removidos: ' + usRemovidos)
  }
  await db.prepare("DELETE FROM intentos_login WHERE documento LIKE '9900%'").run()
  console.log('')

  const despues = Number((await db.prepare("SELECT COUNT(*) c FROM usuarios WHERE documento LIKE '9900%'").get()).c)
  const realesDespues = Number((await db.prepare("SELECT COUNT(*) c FROM usuarios WHERE rol = 'ESTUDIANTE' AND documento NOT LIKE '9900%'").get()).c)
  console.log('\nQuedan con prefijo 9900:', despues, '(debe ser 0)')
  console.log('Estudiantes reales: antes', realesAntes, '\u2192 despu\u00e9s', realesDespues, '(id\u00e9nticos = limpieza limpia)')
  await db.close()
})().catch(e => { console.error('FALLO:', e.message); process.exit(1) })
