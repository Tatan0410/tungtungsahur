# Cloudflare para el portal Sagrado Corazón

## Por qué no se puede hoy

El sitio vive en `informes-sagracor.vercel.app` — un subdominio de
`vercel.app`, que es propiedad de Vercel. **Cloudflare exige un dominio
propio**: no puede proteger un subdominio de un dominio ajeno.

## Qué protege el sitio HOY (sin Cloudflare)

| Capa | Protección | Verificado |
|------|-----------|------------|
| **Vercel: Security Checkpoint** | Un IP que martillea recibe 403 en segundos (prueba de carga: ~300 peticiones seguidas lo activaron; se levanta solo tras ~3 min) | ✓ probado |
| **Login** | 5 intentos fallidos por documento → bloqueo 15 min · 30 fallos/min por IP · los éxitos NO cuentan (NAT del colegio segura) | ✓ testeado |
| **Recuperar contraseña** | 10 peticiones/min por IP (anti-spam de correos) | ✓ en el código |
| **Verificación de código** | 5 intentos por sesión de recuperación | ✓ testeado |
| **Endpoints de datos** | Todos exigen JWT válido (401/403 sin él) | ✓ testeado |

## Pasos cuando consigas un dominio (ej: sagracor.edu.co)

1. **Cloudflare** (dash.cloudflare.com) → Add a site → tu dominio →
   plan **Free** → Cloudflare te da 2 nameservers
2. **El registrador del dominio** (donde lo compraste) → cambia los
   nameservers a los de Cloudflare
3. **Vercel** → tu proyecto → Settings → Domains → Add → tu dominio
   (ej: `notas.sagracor.edu.co`) → Vercel te da el registro DNS
4. **Cloudflare** → DNS → agrega el CNAME que Vercel te dio →
   **Proxy: ON** (la nube naranja)
5. Espera la propagación (minutos a horas) → el dominio sirve la página

## Reglas de Cloudflare recomendadas (plan Free)

1. **Rate limiting** (Security → WAF → Rate limiting rules — 1 regla gratis):
   - Si: `http.request.uri.path contains "/api/auth"`
   - Acción: **Block** · 100 requests per 10 seconds per IP
   - (bloquea bruteforce de login a nivel global, antes de tocar tu app)
2. **Bot Fight Mode** (Security → Bots) → ON — bloquea bots maliciosos
3. **Under Attack Mode** (solo en emergencias) — desafío JS a todos
4. SSL/TLS → modo **Full (strict)** (Cloudflare → Vercel cifrado)

## Nota sobre los límites de Vercel Hobby

- La prueba de carga mostró que el cuello de botella NO es Vercel sino
  el costo por petición (bcrypt del login ~400ms; consultas a Supabase
  ~200ms). Con ~200 usuarios simultáneos reales el sistema responde
  bien; los IPs abusivos los corta el checkpoint de Vercel antes de
  saturar nada.
