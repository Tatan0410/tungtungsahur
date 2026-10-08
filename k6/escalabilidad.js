// =====================================================
// k6/escalabilidad.js — Prueba de escalabilidad del portal del estudiante
//
// Perfiles (K6_PERFIL):
//   sostenido — 4 estudiantes/seg durante ~9 min (~240 req/min: POR DEBAJO
//               del checkpoint de Vercel ~300 req/IP). Mide la capacidad
//               real del sistema (pool, pooler, queries batcheadas).
//   rafaga    — 800 VUs simultáneos durante 3 min: la ráfaga del "revisen
//               sus notas AHORA". Incluye el muro del checkpoint de
//               Vercel Hobby (~300 req/min/IP) — sus 403 son esperables.
//
// Uso:
//   $env:K6_PERFIL='sostenido'; k6 run k6/escalabilidad.js
//   $env:K6_PERFIL='rafaga';    k6 run k6/escalabilidad.js
//
// Estudiantes: 99000001..99000800 (password = documento), creados con
// scripts/generar-estudiantes-prueba.js. k6 reparte los 800 entre los VUs.
// =====================================================
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.K6_BASE_URL || 'https://informes-sagracor.vercel.app'
const PERFIL = __ENV.K6_PERFIL || 'sostenido'
const FLUJO = __ENV.K6_FLUJO || 'individual' // 'individual' (5 requests/estudiante) | 'bootstrap' (2: login+bootstrap)
const TOTAL_PRUEBA = parseInt(__ENV.K6_ESTUDIANTES || '800')
const ANIO = new Date().getFullYear()

const escenario =
  PERFIL === 'rafaga'
    ? {
        // RÁFAGA: los 800 entran UNA sola vez cada uno (login + pass del
        // portal) — el "revisen sus notas AHORA" real
        executor: 'per-vu-iterations',
        vus: TOTAL_PRUEBA,
        iterations: 1,
        maxDuration: '5m',
        startTime: '0s',
      }
    : {
        // SOSTENIDO: llegadas continuas a 4/seg (bajo el checkpoint de
        // Vercel ~300 req/min/IP) — cada llegada hace su pass completo
        executor: 'ramping-arrival-rate',
        preAllocatedVUs: 50,
        maxVUs: 100,
        stages: [
          { duration: '1m', target: 4 },
          { duration: '8m', target: 4 },
          { duration: '1m', target: 0 },
        ],
        gracefulStop: '30s',
      }

export const options = {
  scenarios: { portal_estudiantes: escenario },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'http_req_duration{endpoint:mis-notas}': ['p(95)<3000'],
    'http_req_duration{endpoint:login}': ['p(95)<3000'],
  },
}

const docDe = (vu) => String(99000000 + (((vu - 1) % TOTAL_PRUEBA) + 1))

// El token persiste por VU: cada estudiante se loguea UNA vez y las
// siguientes iteraciones solo hacen las lecturas del portal
let token = null

export default function () {
  if (!token) {
    const doc = docDe(__VU)
    const r = http.post(
      `${BASE}/api/auth/login`,
      JSON.stringify({ documento: doc, password: doc, aceptaTerminos: true }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login' } }
    )
    check(r, { 'login 200': (res) => res.status === 200 })
    if (r.status !== 200) return
    token = r.json('token')
  }

  const auth = { headers: { Authorization: `Bearer ${token}` } }

  if (FLUJO === 'bootstrap') {
    // Flujo nuevo: TODO el portal en una llamada (login + bootstrap = 2 requests)
    const boot = http.get(`${BASE}/api/notas/mi-bootstrap?anio=${ANIO}`,
      { ...auth, tags: { endpoint: 'bootstrap' } })
    check(boot, { 'bootstrap 200': (r) => r.status === 200 })
    return
  }

  // Flujo clásico: notas, áreas, estado del corte y períodos por separado
  const notas = http.get(`${BASE}/api/notas/mis-notas?periodo=1&anio=${ANIO}`,
    { ...auth, tags: { endpoint: 'mis-notas' } })
  check(notas, { 'mis-notas 200': (r) => r.status === 200 })

  http.get(`${BASE}/api/notas/mis-areas?periodo=1&anio=${ANIO}`,
    { ...auth, tags: { endpoint: 'mis-areas' } })
  http.get(`${BASE}/api/notas/mi-reporte-corte?periodo=1&anio=${ANIO}`,
    { ...auth, tags: { endpoint: 'reporte' } })
  http.get(`${BASE}/api/config/periodos?anio=${ANIO}`,
    { tags: { endpoint: 'config' } })

  // En ráfaga cada estudiante hace UN pass y termina (per-vu-iterations=1).
  // En sostenido, el sleep simula el tiempo de lectura antes del siguiente pass.
  if (PERFIL !== 'rafaga') sleep(3)
}
