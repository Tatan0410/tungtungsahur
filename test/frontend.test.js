const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RAIZ = path.resolve(__dirname, '..')
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8')

// Extrae una función completa del HTML contando llaves, para poder probarla aislada
function extraerFuncion(nombre) {
  const inicio = HTML.indexOf(`function ${nombre}(`)
  assert.ok(inicio >= 0, `no se encontró la función ${nombre}`)
  let nivel = 0, fin = -1
  for (let i = HTML.indexOf('{', inicio); i < HTML.length; i++) {
    if (HTML[i] === '{') nivel++
    else if (HTML[i] === '}') { nivel--; if (nivel === 0) { fin = i; break } }
  }
  assert.ok(fin > inicio, `no se encontró el cierre de ${nombre}`)
  return HTML.slice(inicio, fin + 1)
}

test('el HTML tiene los <div> balanceados y sin ids duplicados', () => {
  const abre = (HTML.match(/<div[\s>]/gi) || []).length
  const cierra = (HTML.match(/<\/div>/gi) || []).length
  assert.equal(abre, cierra, `abren ${abre} y cierran ${cierra}`)

  const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
  const repetidos = ids.filter((v, i) => ids.indexOf(v) !== i)
  assert.deepEqual([...new Set(repetidos)], [], 'no puede haber ids duplicados')
})

test('el script principal compila sin errores de sintaxis', () => {
  const bloques = [...HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/src=/.test(m[1]))
    .map(m => m[2])
  assert.ok(bloques.length >= 1, 'debe haber al menos un script inline')
  for (const src of bloques) {
    assert.doesNotThrow(() => new Function(src), 'el script inline debe compilar')
  }
})

test('no quedan prompt() ni confirm() nativos', () => {
  assert.ok(!/[^.\w]prompt\('/.test(HTML), 'quedó un prompt() nativo')
  assert.ok(!/[^.\w]confirm\('/.test(HTML), 'quedó un confirm() nativo')
  assert.match(HTML, /function pedirTexto\(/, 'debe existir el modal propio')
  assert.match(HTML, /function confirmarAccion\(/, 'debe existir la confirmación propia')
})

test('están los elementos clave del panel', () => {
  const ids = [
    'modal-prompt', 'prompt-input', 'prompt-titulo',
    'btn-mi-cuenta', 'admin-asignaciones-section', 'admin-sel-curso-asign',
    'sec-informes-titulo', 'recuperar-link',
  ]
  for (const id of ids) {
    assert.ok(HTML.includes(`id="${id}"`), `falta el elemento #${id}`)
  }
  assert.match(HTML, /onclick="guardarMiCuenta\(\)"/, 'el modal Mi cuenta debe llamar a guardarMiCuenta')
  assert.ok(!HTML.includes('guardarMiPerfil'), 'no debe quedar la función inexistente guardarMiPerfil')
})

test('esc() neutraliza HTML y escArg() neutraliza argumentos', () => {
  const fn = new Function(`${extraerFuncion('esc')}\n${extraerFuncion('escArg')}\nreturn { esc, escArg }`)()
  assert.equal(fn.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(fn.esc('Pérez & "Gómez"'), 'Pérez &amp; &quot;Gómez&quot;')
  assert.equal(fn.esc(null), '')
  // El argumento de onclick debe quedar inofensivo incluso con comillas y paréntesis
  // Cada comilla simple se convierte en \', y el resto del texto se conserva
  const esperado = '\\' + "'" + '); alert(' + '\\' + "'" + 'x'
  assert.equal(fn.escArg("'); alert('x"), esperado)
  // Ninguna comilla simple queda "desnuda": siempre precedida por una barra
  assert.ok(!/(^|[^\\])'/.test(fn.escArg("'; alert('x")), 'las comillas deben escaparse')
})

test('el repo no trackea .env ni la base de datos', () => {
  const trackeados = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' }).split('\n')
  assert.ok(!trackeados.includes('.env'), '.env no debe estar versionado')
  assert.ok(!trackeados.some(f => f.startsWith('prisma/dev.db')), 'la BD no debe estar versionada')
  assert.ok(trackeados.includes('.env.example'), '.env.example sí va versionado')
})

test('.env.example no contiene secretos reales', () => {
  const ejemplo = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8')
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(ejemplo), 'hay un token de GitHub en .env.example')
  assert.ok(!/qwlt\s+\w+\s+\w+\s+\w+/.test(ejemplo), 'hay la contraseña de aplicación de Gmail')
  assert.match(ejemplo, /JWT_SECRET="cambia_esto_por_una_clave_segura"/)
  assert.match(ejemplo, /ALLOWED_ORIGINS/)
  assert.match(ejemplo, /TRUST_PROXY/)
})

test('package.json define start y test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts.start, 'falta scripts.start')
  assert.ok(pkg.scripts.test, 'falta scripts.test')
  assert.equal(pkg.scripts.start, 'node src/index.js')
})
