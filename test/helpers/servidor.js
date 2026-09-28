const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')

const RAIZ = path.resolve(__dirname, '..', '..')

function puertoLibre() {
  return new Promise((resolver, rechazar) => {
    const srv = net.createServer()
    srv.on('error', rechazar)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolver(p))
    })
  })
}

// Arranca el servidor real (src/index.js) contra una COPIA temporal de la BD.
// Se usa el backup online de SQLite (no un cp del archivo): el servidor en
// marcha retiene escrituras en el -wal, y copiar solo dev.db daría un
// snapshot viejo sin esas escrituras.
// SMTP queda vacío: dotenv no pisa variables ya definidas, así que el servidor
// entra en la rama "SMTP no configurado" y nunca intenta enviar correos.
// Con { dbPath } se arranca contra una BD propia (por ejemplo una recién
// migrada): en ese caso no se copia nada ni se borra esa carpeta al cerrar.
async function arrancarServidor(opciones = {}) {
  let dir = null
  let dbPath = opciones.dbPath
  if (!dbPath) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagrado-test-'))
    dbPath = path.join(dir, 'dev.db')
    const origen = new Database(path.join(RAIZ, 'prisma', 'dev.db'), { readonly: true })
    await origen.backup(dbPath)
    origen.close()
  }
  const puerto = await puertoLibre()

  const proc = spawn(process.execPath, ['src/index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      PORT: String(puerto),
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      TRUST_PROXY: '0',
      ALLOWED_ORIGINS: 'http://localhost:3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const logs = []
  proc.stdout.on('data', b => logs.push(String(b)))
  proc.stderr.on('data', b => logs.push(String(b)))

  const base = `http://127.0.0.1:${puerto}`
  const limite = Date.now() + 20000
  let listo = false
  while (Date.now() < limite) {
    if (proc.exitCode !== null) {
      throw new Error('El servidor terminó inesperadamente:\n' + logs.join(''))
    }
    try {
      const r = await fetch(base + '/api/ping')
      if (r.status === 200) { listo = true; break }
    } catch { /* aún no levanta */ }
    await new Promise(r => setTimeout(r, 100))
  }
  if (!listo) {
    proc.kill()
    throw new Error('Timeout esperando el servidor:\n' + logs.join(''))
  }

  return {
    base,
    dbPath,
    logs: () => logs.join(''),
    db: () => new Database(dbPath),
    async cerrar() {
      if (proc.exitCode === null) {
        proc.kill()
        await new Promise(r => setTimeout(r, 200))
      }
      if (!dir) return
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break }
        catch { await new Promise(r => setTimeout(r, 200)) }
      }
    },
  }
}

module.exports = { arrancarServidor, RAIZ }
