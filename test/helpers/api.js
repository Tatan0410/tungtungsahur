// Credenciales que existen en la base de datos de desarrollo (copia temporal)
const ADMIN = { documento: '99999999', password: 'Admin2025' }
const DOCENTE = { documento: '30010001', password: 'test123' }

function crearApi(base) {
  const call = metodo => async (ruta, { token, body } = {}) => {
    const res = await fetch(base + ruta, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data = null
    try { data = await res.json() } catch { /* sin body JSON */ }
    return { status: res.status, data }
  }
  return {
    get: call('GET'),
    post: call('POST'),
    put: call('PUT'),
    delete: call('DELETE'),
  }
}

async function login(api, documento, password) {
  const r = await api.post('/api/auth/login', { body: { documento, password } })
  if (r.status !== 200) {
    throw new Error(`Login falló (${r.status}): ${JSON.stringify(r.data)}`)
  }
  return r.data.token
}

module.exports = { crearApi, login, ADMIN, DOCENTE }
