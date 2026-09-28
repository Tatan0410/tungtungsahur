# Seguridad — Auditoría del Portal Académico Sagrado Corazón

Revisión honesta del código: qué está protegido, qué se corrigió, qué
riesgos quedan. Última revisión: **28 de septiembre de 2026**.

---

## 1. Controles implementados

### Autenticación
- Contraseñas con **bcrypt** (`salt` cost 10), nunca en texto plano.
- **JWT HS256** con `expiresIn: 8h` y `issuer`/`audience` fijos: un token
  emitido para otra app no es aceptado aquí.
- **Login bloqueado por documento**: 5 intentos fallidos → 15 minutos de
  bloqueo (`intentos_login`).
- **Login bloqueado por IP**: 30 intentos **fallidos**/minuto por memoria.
  Los éxitos no consumen el cupo, para no bloquear escuelas con muchas
  peticiones desde la misma IP (NAT).
- **Recuperación de contraseña** (solo docentes): código de 6 dígitos con
  expiración de 15 min, máximo 5 intentos fallidos, 10 solicitudes/min por
  IP y 3 correos/hora por correo destinatario. Los intentos fallidos
  (`INVALID-*`) **no** cuentan contra el cupo de envíos.
- Los códigos/registros de recuperación se purgan a las 24 h.

### Autorización
- `src/routes/admin.js` → `router.use(verificarTokenAdmin)`: **todas** las
  rutas admin exigen JWT con rol `ADMIN` (no una lista manual por ruta).
- `src/routes/notas.js` y `src/routes/docente.js` → `router.use(verificarToken)`
  + comprobación de rol en cada ruta sensible (p. ej. `observaciones-curso`
  exige `DOCENTE` con directoría del curso, o `ADMIN`).
- Las notas y observaciones se filtran por el `estudianteId`/`docenteId`
  del propio token, no por parámetros del cliente.

### Inyección SQL
- Toda consulta usa **parámetros posicionales** (`?`), nunca interpolación
  de valores.
- Los únicos identificadores dinámicos (nombres de columna que vienen del
  cliente en consultas de calificaciones) pasan por `col()` en
  `src/prisma.js`, que solo acepta `[A-Za-z_][A-Za-z0-9_]*`.

### XSS (frontend)
- Helpers `esc()` (HTML) y `escArg()` (argumentos de `onclick`/`onchange`)
  en `public/index.html`; se aplican a **toda** concatenación que incluye
  datos de la base (nombres, correos, textos de observaciones, cursos).
- `prompt()`/`confirm()` nativos reemplazados por modal propio
  (`pedirTexto`/`confirmarAccion`), cuyo texto se inyecta con `textContent`.

### Transporte y cabeceras
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `X-XSS-Protection`, `Referrer-Policy: strict-origin-when-cross-origin`.
- `express.json({ limit: '500kb' })`: payloads gigantes rechazados.
- CORS limitado a `ALLOWED_ORIGINS` cuando está definido.

### Datos
- `.env` y `prisma/dev.db` están en `.gitignore` y verificados como no
  trackeados. `.env.example` no contiene secretos.
- `JWT_SECRET` rotado el 2026-09-28 (antes era una frase predecible).

---

## 2. Hallazgos corregidos en esta auditoría

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 1 | Alta | XSS reflejado/almacenado: observaciones, nombres y cursos se concatenaban sin escapar en `innerHTML` | `esc()`/`escArg()` aplicados en todo el sweep |
| 2 | Media | Inyección de atributos vía `onclick="...'"` con nombres de usuario | `escArg()` en todos los argumentos de string |
| 3 | Media | Un modal usaba `getElementById` de un id inexistente y otra función inexistente (`guardarMiPerfil`) | rutas y handlers corregidos |
| 4 | Media | DoS/bloqueo: los intentos fallidos de código llenaban `password_resets` y **bloqueaban** la recuperación legítima | el conteo de 3 correos/hora excluye `INVALID-%` |
| 5 | Media | Sin rate limit de login por IP (fuerza bruta sobre muchos documentos) | 30 intentos/min por IP |
| 6 | Media | `req.ip` inútil detrás de proxy (los límites por IP no aplicarían) | `TRUST_PROXY=1` opt-in |
| 7 | Media | Contraseñas de docentes creadas por admin: largo mínimo solo en cliente | ≥ 6 caracteres validado en servidor (crear y cambiar) |
| 8 | Baja | `observaciones-curso` rechazaba al ADMIN | rol `ADMIN` permitido (el docente sigue exigiendo directoría) |
| 9 | Baja | Registros `password_resets` nunca purgados | limpieza a 24 h |
| 10 | Baja | Duplicación de `calcularReporteCorte()` en dos rutas (riesgo de divergencia) | extraído a `src/services/reporteCorte.js` |
| 11 | Baja | `prompt()`/`confirm()` nativos (diálogos bloqueantes) | modal propio |
| 12 | Baja | Id duplicado, `</div>` desbalanceados, `prompt()` en `innerHTML` | verificado: 0 ids duplicados, div balanceado 337/337 |

---

## 3. Riesgos residuales conocidos

Estos **no** están resueltos; están documentados a propósito.

1. **`npm audit`: 5 vulnerabilidades altas restantes**
   - `xlsx@0.18.5` (prototype pollution + ReDoS, **sin fix en npm**): solo
     se usa en `admin.js`, el CLI offline de importación de matrícula, y
     solo con archivos entregados por el colegio. Riesgo bajo pero real si
     alguien importa un archivo malicioso. Alternativas: `exceljs` o el
     build oficial de SheetJS fuera de npm.
   - Cadena de `prisma` en `devDependencies` (hono, mysql2, deepmerge-ts):
     es **tooling de desarrollo**, no corre en el servidor de producción.
   - El resto de hallazgos (`body-parser`, `qs`, `fast-uri`) se corrigió
     con `npm audit fix` sin cambios de API.
2. **CORS abierto si `ALLOWED_ORIGINS` está vacío.** En `.env` local ya
   está definido; en producción debe apuntar al dominio real.
3. **Rate limits en memoria**: válidos por proceso. Con N réplicas cada una
   tiene su propio contador (2×N de permisivo). Para producción real usar
   Postgres o Redis/Upstash.
4. **No hay revocación de tokens.** `logout` es solo del lado cliente; un
   token robado vive hasta 8 h. Mitigación opcional: tabla de revocación o
   un `jti` en lista negra consultado en cada request.
5. **Sin 2FA ni captcha.** Un administrador con contraseña filtrada tiene
   acceso total. Se recomienda 2FA para el rol ADMIN.
6. **Sin Content-Security-Policy.** El frontend usa scripts inline por
   diseño; añadir CSP requiere `nonce` o migrar a archivo externo.
7. **Sin auditoría de cambios.** No queda registro de quién modificó una
   nota u observación ni el valor anterior. Recomendado para un sistema de
   calificaciones (y suele ser requisito normativo).
8. **Sin cifrado ni backups automatizados de la BD.** `prisma/dev.db` es un
   archivo plano. En producción debe vivir en Postgres gestionado (Supabase)
   con PITR.
9. **Datos personales de menores.** El tratamiento de notas y documentos
   está sujeto a la Ley 1581 de 2012 y a la política del colegio: fijar
   retención/exportación/borrado y firmar tratamiento de datos si aplica.
10. **Credenciales de prueba en la documentación** (`Admin2025`, `test123`).
    Cambiar antes de exponer el sistema a internet. El CLI offline
    (`admin.js crear-profesor`) usa el mismo documento como contraseña por
    defecto: pasar la contraseña explícitamente o cambiarla después.

---

## 4. Cómo reproducir las pruebas

```bash
npm start
# 200 en la raíz y en /api/ping
# login con 30 intentos malos desde la misma IP → 429
# 6 verificaciones de código incorrecto → 429 "Demasiados intentos fallidos"
# con 3 códigos INVALID-* previos, POST /api/auth/recuperar sigue respondiendo 200
# GET /api/notas/observaciones-curso?curso=301 sin token → 401; con rol ADMIN → 200
```

## 5. Reporte de vulnerabilidades

Reporta hallazgos al responsable del proyecto del colegio. No publiques
exploits sin dar tiempo de corrección.
