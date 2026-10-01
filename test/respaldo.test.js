const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RAIZ = path.resolve(__dirname, '..')

let dir, rutaCopia

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagrado-respaldo-'))
  rutaCopia = path.join(dir, 'dev.db')
  const D = require('better-sqlite3')
  const origen = new D(path.join(RAIZ, 'prisma', 'dev.db'), { readonly: true })
  await origen.backup(rutaCopia)
  origen.close()
})

after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ya borrado */ }
})

test('respaldar.js exporta las 15 tablas con los conteos correctos', () => {
  const out = execFileSync(process.execPath, ['scripts/respaldar.js', '--db', rutaCopia], { cwd: RAIZ, encoding: 'utf8' })
  assert.match(out, /Respaldo completo/)

  const coincidencia = out.match(/respaldo-local-\d{4}-\d{2}-\d{2}\.json/)
  assert.ok(coincidencia, 'debe imprimir el nombre del archivo')
  const archivo = coincidencia[0]

  const paquete = JSON.parse(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'))
  assert.equal(paquete.tablas.length, 15, 'debe incluir las 15 tablas')
  assert.equal(paquete.motor, 'sqlite')
  for (const t of paquete.tablas) {
    assert.ok(Array.isArray(paquete.datos[t]), `la tabla ${t} debe venir en el paquete`)
    assert.equal(paquete.datos[t].length, paquete.conteos[t], `el conteo de ${t} debe coincidir`)
  }
  assert.ok(paquete.conteos.usuarios >= 700, 'debe traer la matrícula real')
  fs.unlinkSync(path.join(RAIZ, archivo))
})

test('restaurar.js sin --confirmo es dry-run: no modifica nada', () => {
  // Genera un respaldo de la copia
  execFileSync(process.execPath, ['scripts/respaldar.js', '--db', rutaCopia], { cwd: RAIZ, encoding: 'utf8' })
  const archivo = path.join(RAIZ, fs.readdirSync(RAIZ).find(f => /^respaldo-local-\d{4}-\d{2}-\d{2}\.json$/.test(f)))
  fs.renameSync(archivo, archivo.replace('respaldo-local', 'respaldo-test'))
  const rutaTest = archivo.replace('respaldo-local', 'respaldo-test')

  const out = execFileSync(process.execPath, ['scripts/restaurar.js', path.relative(RAIZ, rutaTest)], { cwd: RAIZ, encoding: 'utf8' })
  assert.match(out, /DRY-RUN/, 'sin --confirmo debe ser dry-run')
  assert.match(out, /No se modificó nada/)

  // La copia sigue intacta
  const D = require('better-sqlite3')
  const db = new D(rutaCopia, { readonly: true })
  assert.ok(db.prepare('SELECT COUNT(*) c FROM usuarios').get().c >= 700, 'la BD no se tocó')
  db.close()
  fs.unlinkSync(rutaTest)
})

test('el repo no versiona los respaldos (contienen hashes y correos)', () => {
  const trackeados = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' }).split('\n')
  assert.ok(!trackeados.some(f => f.startsWith('respaldo-')), 'ningún respaldo-*.json debe estar versionado')
  const gitignore = fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf8')
  assert.match(gitignore, /respaldo-\*\.json/, '.gitignore debe excluir los respaldos')
})
