# Tablero PMO

Dashboard en vivo con el estado de **todos** los tableros de Monday de la PMO: avance de proyectos y mejoras, salud del portafolio, tareas detenidas o vencidas, entregables de cada miembro de la PMO, y la distribución de estados de cada tablero (solicitudes, riesgos, cambios, recursos, tareas personales y demás espacios de trabajo).

## Cómo funciona

1. Una GitHub Action (`.github/workflows/actualizar-dashboard.yml`) corre cada 10 minutos de 6:00 a 19:00 (hora de Panamá, lunes a sábado) y cada hora el resto del tiempo.
2. `scripts/fetch-monday.mjs` lee por la API de Monday todos los tableros a los que tiene acceso el token y genera `site/data.json`.
3. La carpeta `site/` se publica en GitHub Pages. La página recarga los datos cada 5 minutos, así que puede quedar abierta en una pantalla.

Los tableros nuevos aparecen solos: no hay que registrarlos en ningún lado.

## Configuración inicial

La Action necesita un token de la API de Monday guardado como secreto del repositorio:

1. En Monday: foto de perfil → **Developers** → **My access tokens** → copiar el token.
2. En una terminal, dentro de esta carpeta:
   ```bash
   gh secret set MONDAY_API_TOKEN
   ```
   y pegar el token cuando lo pida.

El dashboard muestra lo que ve el dueño del token. Si alguien más debe mantenerlo, hay que cambiar el secreto por un token suyo.

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
- **Entregables por persona**: cada tarea de los proyectos y tableros de tareas activos se asigna a quien figure en su columna de responsable (Responsable, Owner, People…; se ignoran columnas como "Reportado por" o "Aprobación"). Si una subtarea no tiene responsable, hereda el de su elemento padre. Las tareas abiertas sin nadie asignado aparecen en la tarjeta "Sin responsable".

## Ajustes (`config.json`)

- `sections`: reglas para agrupar tableros por carpeta, nombre o espacio de trabajo (se evalúan en orden; la primera que coincide gana). `mode: "progress"` muestra avance; `"distribution"` muestra el reparto de estados. `kpi: true` hace que la sección cuente en los números principales.
- `displayOrder`: orden en que se muestran las secciones.
- `exclude.boardIds`: IDs de tableros a ocultar (el ID es el número en la URL del tablero).
- `statusColumnOverrides`: `{ "<id del tablero>": "<id de la columna>" }` si el script eligió la columna de estado equivocada.
- `peopleColumnOverrides`: igual que el anterior, para la columna de responsable.
- `displayNames`: `{ "<id de usuario>": "Nombre" }` para mostrar un nombre en lugar del correo con que aparece en Monday.
- `staleDays`: días sin cambios para marcar un proyecto activo como "sin movimiento".

Para probar cambios localmente:

```bash
node --test scripts/transform.test.mjs
```
