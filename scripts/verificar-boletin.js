// Verificación visual del boletín: renderiza con Playwright a PDF carta,
// convierte a PNG y guarda en docs/verificacion/
// Uso: node scripts/verificar-boletin.js
const { chromium } = require('playwright')

const BASE = process.env.BASE || 'https://informes-sagracor.vercel.app'

async function loginYBoletin(page, documento, password, periodo) {
  // Login
  await page.goto(BASE)
  await page.fill('#doc-input', documento)
  await page.fill('#password', password)
  await page.click('#login-btn')
  await page.waitForSelector('#btn-boletin', { state: 'visible', timeout: 15000 })
  // Abrir boletín
  await page.click('#btn-boletin')
  await page.waitForSelector('#boletin-view.abierto', { timeout: 10000 })
  if (periodo) {
    await page.selectOption('#boletin-sel-periodo', String(periodo))
  }
  await page.waitForTimeout(2000) // esperar el render
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const docs = 'docs/verificacion'

  // 1. Boletín del estudiante de pruebas (CHAPARRO — 1104)
  console.log('Renderizando boletín P3 de CHAPARRO...')
  await loginYBoletin(page, '1139430973', '1139430973', 3)

  // PDF carta
  await page.emulateMedia({ media: 'print' })
  await page.pdf({
    path: docs + '/boletin-estudiante-p3.pdf',
    format: 'letter',
    printBackground: true,
  })
  console.log('PDF guardado:', docs + '/boletin-estudiante-p3.pdf')

  // Captura de pantalla de la vista (para comparar)
  await page.emulateMedia({ media: 'screen' })
  await page.screenshot({
    path: docs + '/boletin-estudiante-p3-pantalla.png',
    fullPage: true,
  })
  console.log('Screenshot guardado:', docs + '/boletin-estudiante-p3-pantalla.png')

  // Cerrar boletín y cambiar a P1
  await page.click('.boletin-controles button:last-child') // Cerrar
  await page.waitForTimeout(500)
  await page.click('#btn-boletin')
  await page.selectOption('#boletin-sel-periodo', '1')
  await page.waitForTimeout(2000)
  await page.emulateMedia({ media: 'print' })
  await page.pdf({
    path: docs + '/boletin-estudiante-p1.pdf',
    format: 'letter',
    printBackground: true,
  })
  console.log('PDF P1 guardado')

  await browser.close()
  console.log('\nVerificación visual completa. Revisa docs/verificacion/')
}

main().catch(e => { console.error('FALLO:', e.message); process.exit(1) })
