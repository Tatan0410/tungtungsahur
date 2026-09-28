# Portal Académico — I.E. Técnica Sagrado Corazón

Sistema de calificaciones y observaciones para un colegio colombiano:
estudiantes, docentes (con rol director de grupo) y administración.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js + Express 5 |
| Base de datos | SQLite (`better-sqlite3`) — ver [GUIA_PRODUCCION.md](GUIA_PRODUCCION.md) para producción |
| Autenticación | JWT (HS256, 8 h, issuer/audience fijos) + bcrypt |
| Frontend | HTML/CSS/JS plano (`public/index.html`), sin build |
| Correo | nodemailer (Gmail SMTP) para recuperación de contraseña |
| Zona horaria | Fijada a `America/Bogota` en todo el servidor |

## Ejecutar en local

```bash
npm install
cp .env.example .env      # llena JWT_SECRET y SMTP_*
npm start                 # http://localhost:3000
```

### Credenciales de prueba (base de datos `prisma/dev.db`)

| Rol | Documento | Contraseña |
|---|---|---|
| Admin | `99999999` | `Admin2025` |
| Docente | `30010001` | `test123` |
| Estudiante | matrícula del estudiante | la que se le asigne |

## Estructura

```
src/
  index.js            Arranque, middlewares globales, CORS, TZ, rutas
  prisma.js           Acceso a SQLite + validador de identificadores `col()`
  services/
    reporteCorte.js   Reporte de corte (compartido admin/docente)
  routes/
    auth.js           Login, perfil, recuperación de contraseña
    notas.js          Calificaciones, columnas, observaciones, reporte
    docente.js        Cursos y materias del docente
    admin.js          Panel admin: usuarios, asignaciones, períodos, reportes
admin.js              CLI offline: importar Excel de matrícula por año
public/index.html     Toda la interfaz (una sola página)
prisma/schema.prisma  Esquema de referencia + migración inicial SQLite
test/                 Pruebas de API, reglas de negocio y frontend (node:test)
```

## Comandos útiles

```bash
npm start                     # servidor
npm run dev                   # con --watch (reinicia al guardar)
npm test                      # suite completa de pruebas
npm run test:watch            # reejecuta las pruebas al guardar
node admin.js importar-excel RUTA.xlsx --anio 2026   # importar matrícula (offline)
node admin.js                 # lista todos los comandos del CLI
```

## Pruebas

`npm test` corre con el runner de `node:test` (sin dependencias extra). Cada archivo
arranca su propio servidor en un puerto libre con una **copia temporal** de
`prisma/dev.db` (backup con `better-sqlite3`), así que nunca toca la base real.

| Archivo | Qué cubre |
| --- | --- |
| `test/auth.test.js` | login, JWT (iss/aud), rate limit por fallos, bloqueo por IP |
| `test/recuperacion.test.js` | flujo de código por correo, 5 intentos, anti-DoS `INVALID-` |
| `test/roles.test.js` | permisos por rol (ESTUDIANTE/DOCENTE/ADMIN) |
| `test/admin.test.js` | CRUD de profesores y asignaciones, validaciones |
| `test/periodos.test.js` | cierre/reapertura de período y bloqueo de notas |
| `test/reporteCorte.test.js` | reglas de `RIESGO`/`PENDIENTE` del reporte |
| `test/frontend.test.js` | XSS (`esc`/`escArg`), HTML, ids, `.env` no trackeado |

## Documentación

- [SECURITY.md](SECURITY.md) — auditoría de seguridad, controles y riesgos residuales.
- [GUIA_PRODUCCION.md](GUIA_PRODUCCION.md) — despliegue (Supabase/Vercel) y escala a 10 000 usuarios.
