# AGENTS.md · discord-terminal-presence

Guía para agentes de código. Qué es, cómo se instala y cómo se configura está en `README.md` (y `README.es.md`).

## Qué es

Presencia de Discord (Rich Presence) para el panel de tmux al que estás conectado en un host Linux remoto. Un watcher en Windows, donde vive el named pipe local de Discord, mantiene la tarjeta sincronizada con el panel activo: qué agente de código trabaja y en qué workspace (`Claude · mi-proyecto`, `💻 Working..` o `💤 Idle`). **Nunca publica texto de la conversación**, ni rutas, comandos, PIDs ni el host.

Proyecto ESM en JavaScript puro: sin dependencias de npm y sin build.

## Arquitectura

Dos mitades que corren en máquinas distintas:

- **Watcher (Windows).** `src/index.mjs` es el punto de entrada. Mantiene una conexión SSH persistente por conjunto de pestañas, habla con Discord por IPC (`src/discord-ipc.mjs`, named pipe) y construye la actividad (`src/presence.mjs`). `src/probe-client.mjs` lanza el probe por SSH (`buildProbeCommand`, `runProbe`, `startProbeStream`). `src/sessions.mjs` gestiona el registro de sesiones por pestaña (`<pid>.json`) y el lock del watcher. `src/config.mjs` carga `config.json`. `src/logger.mjs` escribe el log.
- **Probe (host remoto).** `probe/state.mjs` es el punto de entrada remoto (modo una vez o `--watch`). Lee tmux, `/proc`, `ps` y `git`, y emite una línea JSON cuando cambia el estado. No instala nada ni escribe en el host.
- **Capas compartidas**, que usa el probe:
  - `domain/panel-state.mjs`: parseo de `tmux list-clients`/panel activo, detección de agente y del estado Working/Idle (funciones puras).
  - `application/read-panel-state.mjs`: `readPanelState`, orquesta el estado del panel.
  - `infrastructure/probe-adapters.mjs`: adaptadores que ejecutan tmux, `ps`, `git` y leen `/proc`.

Dependencias: `domain/` y `application/` no importan de `infrastructure/` (comprobado con grep). Los adaptadores se inyectan desde `probe/state.mjs` (`createProbeAdapters`).

**Importante:** el probe importa `application/` e `infrastructure/`, así que en el host tiene que existir el árbol completo del repo, no solo `probe/`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm test` (o `node --test`) | Ejecuta el suite con `node:test`. |
| `node src/index.mjs --once` | Lanza una consulta al probe, imprime el JSON y sale. No conecta con Discord. Sale con 2 si falta o es inválida la configuración, y con 1 si falla SSH. |
| `node src/index.mjs --verbose` | Watcher normal, con el log también en stdout. Úsalo solo para depurar. |
| `npm run release` | `commit-and-tag-version` (versión, CHANGELOG y etiqueta). |

Flags de `src/index.mjs`: `--once`, `--verbose`, `--sessions-dir <dir>` y `--claim-lock-pid <pid>` (interno, lo usa el wrapper de Windows Terminal). Cualquier otro flag `--` se rechaza.

## Cómo probar un cambio

- Tests en `test/*.test.mjs`, con `node:test`. Cubren configuración, sesiones, IPC de Discord, probe, cliente del probe, panel, presencia y el wrapper de Windows Terminal.
- Los tests usan fakes inyectados para tmux, `ps`, `git`, Discord y SSH. No necesitan Discord, tmux ni un host remoto, y corren en Linux o Windows.
- Un solo fichero: `node --test test/presence.test.mjs`.
- Antes de dar un cambio por bueno: `npm test` completo. Todos los tests deben pasar.
- Cada comportamiento nuevo o bug corregido lleva su test en el mismo cambio. Los clasificadores (`detectWorking`, `detectAgent`) son el sitio donde más se regresa: añade casos positivos y negativos.

## Convenciones

- JavaScript ESM (`"type": "module"`), sin TypeScript ni build. Imports con extensión `.mjs`.
- Nombres de código en inglés. Documentación: `README.md` en inglés y `README.es.md` en español (el código no tiene comentarios de idioma fijado).
- Versión y `CHANGELOG.md` los genera `commit-and-tag-version` (`.versionrc.json`) con `npm run release`. **No se editan a mano.**
- Commits en Conventional Commits, en el estilo del historial.
- `config.json` (no versionado) a partir de `config.example.json`. El `applicationId` de Discord es público, pero nunca se ponen tokens ni contraseñas en la configuración.

## Decisiones y trampas

- **Solo metadatos y estado.** El probe nunca envía texto de la pantalla, títulos, prompts, comandos, nombres de herramientas, rutas, ramas, PIDs, el host ni el usuario de SSH. Cualquier cambio que amplíe lo publicado en Discord debe tratarse como cambio de privacidad.
- **Detección heurística.** `detectWorking` busca palabras clave (`thinking`, `working`, `generating`...), `esc to interrupt` y caracteres de spinner en las últimas 12 líneas o en el título. Produce falsos positivos y puede dejar un estado `Idle` tras una tarea acabada. Está documentado en el README.
- **`Worked for` / `Cooked for`.** La actividad anterior a la última de esas líneas se ignora, para no marcar como trabajando una tarea terminada.
- **Solo el panel activo.** Si hay varias pestañas, el probe prefiere la que trabaja, luego la enfocada y luego la más reciente.
- **Enfoque.** Se usa `client_flags` de tmux; sin `focus-events on` cae al tiempo de actividad.
- **Un watcher por directorio de sesiones.** Un lock obsoleto con PID vivo bloquea un segundo watcher, a propósito. No borres un lock cuyo PID siga vivo.
- **Sin demonio remoto.** Si SSH se cae, el probe sale y el watcher reintenta; tras tres fallos consecutivos para el stream y muestra `Idle`.
- **Discord solo en Windows.** El IPC usa el named pipe de Windows. Los tests no lo necesitan.
- **Heartbeat.** Re-envía la misma actividad cada 60 segundos, y el mínimo de `pollIntervalMs` es 2000 ms (valores menores se suben con aviso).
- **Límite de longitud.** `presence.mjs` trunca los textos a 128 bytes UTF-8; respeta ese límite al añadir campos.
- **Assets.** El código solo referencia claves de imagen; nunca descarga ni genera imágenes. Las claves distinguen mayúsculas.

## Mantenimiento

- Este fichero y el `README.md` se actualizan en el mismo cambio que los deja obsoletos.
- Aquí solo va lo que puede ser público: nada de rutas locales, puertos de la máquina, IPs, perfiles de secretos ni datos personales.
