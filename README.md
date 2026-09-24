# Tablero PMO

Dashboard en vivo con el estado de **todos** los tableros de Monday de la PMO: avance de proyectos y mejoras, salud del portafolio, tareas detenidas o vencidas, entregables de cada miembro de la PMO, y la distribución de estados de cada tablero (solicitudes, riesgos, cambios, recursos, tareas personales y demás espacios de trabajo).

## Cómo funciona

1. Una GitHub Action (`.github/workflows/actualizar-dashboard.yml`) corre cada 5 minutos, todos los días. La dispara [cron-job.org](https://cron-job.org) por la API de GitHub (ver [Disparo cada 5 minutos](#disparo-cada-5-minutos)); el horario propio de GitHub queda solo de respaldo porque lo ejecuta de forma irregular. Para ver un cambio al instante: pestaña **Actions** → **Actualizar dashboard** → **Run workflow**.
2. `scripts/fetch-monday.mjs` lee por la API de Monday todos los tableros a los que tiene acceso el token y genera `site/data.json`.
3. `scripts/pdf.mjs` arma el reporte semanal (`site/reporte.html`) con los mismos datos y lo guarda como `site/reporte-semanal.pdf` usando Chrome.
4. La carpeta `site/` se publica en GitHub Pages. La página recarga los datos cada minuto, así que puede quedar abierta en una pantalla. Si pasan 30 minutos sin datos nuevos muestra un aviso.

Los tableros nuevos aparecen solos: no hay que registrarlos en ningún lado.

## Reporte semanal en PDF

El botón **Reporte semanal PDF** del tablero descarga un reporte de los últimos 7 días, generado en la misma actualización que los datos del tablero:

- Avance de los proyectos activos y cuánto cambió en la semana.
- Tareas completadas y creadas en la semana.
- Estado de cada proyecto o mejora activo (fase, salud, avance, alertas).
- Lista de lo completado, lo vencido, lo detenido y los proyectos sin movimiento.
- Lo que vence en los próximos 7 días y los entregables de cada persona.

La versión para ver en pantalla o imprimir está en `reporte.html`. Si el PDF no se pudo generar en alguna corrida, el botón abre esa versión.

Para generarlo en local (necesita Chrome o Edge instalado y un `site/data.json`):

```bash
npm install
npm run pdf
```

## Configuración inicial

La Action necesita un token de la API de Monday guardado como secreto del repositorio:

1. En Monday: foto de perfil → **Developers** → **My access tokens** → copiar el token.
2. En una terminal, dentro de esta carpeta:
   ```bash
   gh secret set MONDAY_API_TOKEN
   ```
   y pegar el token cuando lo pida.

El dashboard muestra lo que ve el dueño del token. Si alguien más debe mantenerlo, hay que cambiar el secreto por un token suyo.

## Disparo cada 5 minutos

GitHub no respeta los horarios cortos de sus Actions (a veces pasan horas entre corridas), así que el disparo lo hace un servicio externo gratuito:

1. **Token de GitHub** (solo puede disparar esta Action): GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token. Repository access: *Only select repositories* → `tablero-pmo`. Permissions → Repository → **Actions: Read and write**. Nada más.
2. **cron-job.org** → Create cronjob:
   - URL: `https://api.github.com/repos/rcardoze/tablero-pmo/actions/workflows/actualizar-dashboard.yml/dispatches`
   - Execution schedule: cada 5 minutos.
   - Advanced → Request method: **POST**. Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. Request body: `{"ref":"main"}`.
   - GitHub responde `204` cuando lo acepta.

Cuando el token venza, GitHub avisa por correo: se genera uno nuevo igual y se reemplaza en cron-job.org.

## Forzar una actualización

GitHub → pestaña **Actions** → **Actualizar dashboard** → **Run workflow**, o:

```bash
gh workflow run actualizar-dashboard.yml
```

## Cómo se calcula

- **Avance** = tareas completadas ÷ tareas totales, sin contar las canceladas. En tableros multinivel se cuentan las subtareas finales, no los elementos padre (igual que el resumen de Monday). Etiquetas tipo `50%` suman su porcentaje.
- Cada etiqueta de estado de Monday se agrupa en **Completado, En curso, Detenido, Sin iniciar o Cancelado** según su nombre (Listo/Done/Finalizado → Completado, Stuck/Bloqueado/En espera → Detenido, etc.). Al tocar un tablero en el dashboard se ve cómo quedó clasificada cada etiqueta.
- **Vencidas**: tareas no completadas cuya fecha de fin (columna Cronograma/Timeline o una fecha "límite/cierre/entrega") ya pasó.
- **Salud** y **fase** vienen del tablero *Portafolio 2026*; se enlazan con el tablero del proyecto cuando el nombre coincide.
- Un proyecto cuenta como **completado** si todas sus tareas están listas o si el portafolio lo marca como Completado.
- **Completadas en la semana**: tareas que hoy están completadas y cuyo estado cambió en los últimos 7 días (Monday guarda la fecha del último cambio de estado). El **avance de hace 7 días** se estima con esa misma fecha: lo que cambió en la semana se cuenta como no completado antes, y las tareas creadas en la semana no cuentan.
- **Entregables por persona**: cada tarea de los proyectos y tableros de tareas activos se asigna a quien figure en su columna de responsable (Responsable, Owner, People…; se ignoran columnas como "Reportado por" o "Aprobación"). Si una subtarea no tiene responsable, hereda el de su elemento padre. Las tareas abiertas sin nadie asignado aparecen en la tarjeta "Sin responsable".

## Ajustes (`config.json`)

- `sections`: reglas para agrupar tableros por carpeta, nombre o espacio de trabajo (se evalúan en orden; la primera que coincide gana). `mode: "progress"` muestra avance; `"distribution"` muestra el reparto de estados. `kpi: true` hace que la sección cuente en los números principales.
- `displayOrder`: orden en que se muestran las secciones.
- `exclude.privateBoards`: con `true` (por defecto) los tableros privados de Monday nunca se publican.
- `exclude.boardIds`: IDs de tableros a ocultar (el ID es el número en la URL del tablero).
- `statusColumnOverrides`: `{ "<id del tablero>": "<id de la columna>" }` si el script eligió la columna de estado equivocada.
- `peopleColumnOverrides`: igual que el anterior, para la columna de responsable.
- `displayNames`: `{ "<id de usuario>": "Nombre" }` para mostrar un nombre en lugar del correo con que aparece en Monday.
- `staleDays`: días sin cambios para marcar un proyecto activo como "sin movimiento".

Para probar cambios localmente:

```bash
node --test scripts/transform.test.mjs
```
