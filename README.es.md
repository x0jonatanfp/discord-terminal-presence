# discord-terminal-presence

**Español** | [English](README.md)

Presencia enriquecida de Discord para el panel de tmux al que estás conectado en un host Linux remoto. Un pequeño vigilante corre en Windows, donde vive el named pipe local de Discord, y mantiene tu tarjeta de Discord sincronizada con el panel activo de tmux: qué agente de código está trabajando y en qué workspace. Nunca publica texto de la conversación.

## Qué problema resuelve

Cuando trabajas por SSH desde Windows dentro de tmux, Discord solo sabe que hay alguna aplicación abierta. Con varias pestañas y varios agentes (Claude, Codex, OpenCode, Freebuff) es imposible ver de un vistazo cuál está ocupado. Este proyecto lee metadatos de tmux y las últimas líneas del panel activo en el host remoto, clasifica el panel como trabajando o inactivo, y publica solo el nombre del agente, el nombre del workspace y una línea de estado.

La arquitectura tiene dos partes:

- **Vigilante (Windows).** Proceso Node.js sin dependencias. Mantiene una conexión SSH persistente por cada conjunto de pestañas abiertas, habla con Discord por el named pipe local y mantiene la actividad de Rich Presence.
- **Probe (host remoto).** `probe/state.mjs` lee tmux, `/proc`, `ps` y `git`, y escribe una línea JSON cada vez que cambia el estado del panel. No instala nada ni escribe ficheros en el host.

## Requisitos

- Windows 10 u 11 con **Node.js 22 o posterior** y **Discord Desktop** instalado y abierto.
- Un host Linux accesible por SSH con **autenticación por clave no interactiva** (el vigilante usa `BatchMode=yes`; no hay peticiones de contraseña).
- En el host: `tmux` con al menos un cliente conectado, `node` (el probe se ejecuta con él), `git` y `ps`. Las rutas por defecto de los binarios son `/usr/bin/tmux`, `/usr/bin/ps` y `/usr/bin/git`; se pueden cambiar en `infrastructure/probe-adapters.mjs` si tu distribución usa otras.
- Una copia de este repositorio en el host. El probe importa `application/read-panel-state.mjs` e `infrastructure/probe-adapters.mjs`, así que debe estar el árbol completo, no solo `probe/`.
- Sin dependencias npm y sin paso de compilación.

Todos los hosts, usuarios y rutas de este repositorio son placeholders (`your-server.example`, `example_user`, `/opt/discord-terminal-presence`). Sustitúyelos por tus valores.

## Instalación

1. Copia el repositorio a la máquina Windows, por ejemplo `C:\Users\<tú>\tools\discord-terminal-presence`.
2. Copia el mismo árbol a una ruta estable del host Linux, por ejemplo `/opt/discord-terminal-presence`.
3. Crea la configuración local:

   ```powershell
   Copy-Item config.example.json config.json
   ```

4. Edita `config.json` y define al menos `applicationId`, `ssh.host`, `ssh.port`, `ssh.user` y `probe.scriptPath`.
5. Comprueba que el comando SSH funciona desde una terminal de Windows sin pedir nada:

   ```powershell
   ssh -p 22 example_user@your-server.example "tmux list-clients"
   ```

6. Prueba el probe una vez, sin Discord:

   ```powershell
   node src/index.mjs --once
   ```

`--once` imprime el JSON del probe, incluido `{"ok":true,"idle":true}` cuando no hay clientes tmux. Sale con código 2 si falta la configuración o no es válida, y con código 1 si falla la consulta SSH.

## Crear la aplicación de Discord

1. Abre el [Discord Developer Portal](https://discord.com/developers/applications) y crea una aplicación. Su nombre es lo que Discord muestra como «Playing …»; este proyecto se diseñó en torno al nombre **`Terminal`**.
2. Copia su **Application ID** en `applicationId`. Es público y no es un secreto; no pongas nunca tokens ni contraseñas en la configuración.
3. Opcionalmente, en **Rich Presence → Art Assets**, sube una imagen grande con clave `terminal` y miniaturas para los agentes que uses: `claude`, `freebuff`, `opencode`, `codex`. Las claves distinguen mayúsculas y minúsculas. El código solo referencia claves; nunca descarga ni genera imágenes.

`assets` es opcional. Déjalo fuera en la primera prueba y añádelo cuando hayas subido las imágenes:

```json
"assets": {
  "largeImage": "terminal",
  "largeText": "Terminal",
  "agents": { "claude": "claude", "freebuff": "freebuff", "opencode": "opencode", "codex": "codex" }
}
```

## Configuración

`config.json` está ignorado por git. Todos los valores salvo `applicationId` y `ssh.*` son opcionales.

| Clave | Obligatoria | Por defecto | Descripción |
| --- | --- | --- | --- |
| `applicationId` | sí | — | Application ID de Discord (público). |
| `pollIntervalMs` | no | `2000` | Espera mínima entre comprobaciones del registro de sesiones, en milisegundos. Los valores por debajo de 2000 se elevan a 2000 con un aviso. Las actualizaciones de presencia llegan por el stream SSH; esto solo limita cada cuánto se revisa el registro. |
| `ssh.binary` | no | `ssh.exe` | Ejecutable SSH en Windows. |
| `ssh.host` | sí | — | Hostname o IP del host Linux. |
| `ssh.port` | sí | — | Puerto SSH, 1–65535. |
| `ssh.user` | sí | — | Usuario remoto. |
| `probe.node` | no | `node` | Ejecutable de Node.js en el host. |
| `probe.scriptPath` | no | `~/Development/extensions/discord-terminal-presence/probe/state.mjs` | Ruta absoluta al probe en el host. |
| `assets.largeImage` | no | — | Clave de la imagen grande de Rich Presence. |
| `assets.largeText` | no | `Terminal` | Tooltip de la imagen grande. |
| `assets.agents.<agente>` | no | — | Clave de la miniatura para `claude`, `freebuff`, `opencode` o `codex`. |
| `logDir` | no | `%LOCALAPPDATA%\discord-terminal-presence` | Directorio de `watcher.log`. |
| `sessionsDir` | no | `%LOCALAPPDATA%\discord-terminal-presence\sessions` | Directorio de los registros de sesión por pestaña. `%LOCALAPPDATA%` se expande. |

Ejemplo:

```json
{
  "applicationId": "YOUR_DISCORD_APPLICATION_ID",
  "pollIntervalMs": 2000,
  "ssh": {
    "binary": "ssh.exe",
    "host": "your-server.example",
    "port": 22,
    "user": "example_user"
  },
  "probe": {
    "node": "/usr/bin/node",
    "scriptPath": "/opt/discord-terminal-presence/probe/state.mjs"
  }
}
```

## Uso

Arranca el vigilante directamente solo para depurar; sin una sesión de terminal registrada termina en el primer ciclo. El punto de entrada normal es el wrapper de Windows Terminal que se describe más abajo.

```powershell
node src/index.mjs --once      # una consulta al probe, sin Discord
node src/index.mjs --verbose   # vigilante normal, log también por stdout
```

Opciones admitidas:

| Opción | Para qué sirve |
| --- | --- |
| `--once` | Consulta el probe una vez, imprime JSON y sale. No conecta con Discord. |
| `--verbose` | Escribe las líneas de log también en stdout. |
| `--sessions-dir <dir>` | Sobrescribe el directorio de sesiones en esta ejecución. |
| `--claim-lock-pid <pid>` | Interna: la usa el wrapper al ceder el lock al vigilante. |

La tarjeta tiene dos líneas: `<Agente> · <workspace>` (por ejemplo `Claude · mi-proyecto`) y `💻 Working..` o `💤 Idle`. El tiempo transcurrido sale de la fecha de creación de la sesión tmux. Un heartbeat reenvía la misma actividad cada 60 segundos.

## Arranque con Windows Terminal

El vigilante solo vive mientras haya abierta al menos una pestaña de un perfil dedicado de Windows Terminal. No se usa la carpeta Inicio ni autostart al iniciar sesión.

1. Configura `sessionsDir` en `config.json` o mantén el valor por defecto `%LOCALAPPDATA%\discord-terminal-presence\sessions`.
2. En Windows Terminal, duplica el perfil SSH que ya uses, conserva su icono y asigna al duplicado un GUID nuevo y el nombre **`presence`** (o el que quieras; es solo un ejemplo).
3. Establece el `commandline` del duplicado a:

   ```text
   "C:\Program Files\nodejs\node.exe" "C:\Users\<tú>\tools\discord-terminal-presence\windows\terminal-session.mjs"
   ```

4. Pon el GUID nuevo en `defaultProfile` si quieres que este perfil se abra por defecto. Mantén intacto el perfil SSH original.

Cómo se comporta:

- La primera pestaña registra su PID, reclama un lock de arranque y lanza un único vigilante oculto. El vigilante toma el lock y abre la presencia.
- Cada pestaña abre su propia sesión SSH interactiva con un `PRESENCE_ID` único; las demás reutilizan el vigilante existente.
- Al cerrar la última pestaña, el vigilante ve el registro de sesiones vacío en el siguiente ciclo (como máximo unos 2 segundos), limpia la actividad y termina.
- Si una pestaña muere abruptamente, su registro se descarta cuando el PID ya no existe.

`windows/start-hidden.vbs` es un helper opcional que arranca `src/index.mjs` sin ventana de consola cuando `node.exe` no está en `%ProgramFiles%\nodejs`; define `NODE_EXE` para cambiar el ejecutable. El perfil de Windows Terminal no lo necesita.

## Qué ve y qué no

El probe lee:

- `tmux list-clients`: nombre de sesión, PID del cliente, última actividad y marca de foco.
- `tmux display-message` del panel activo: id de panel, sesión, ventana, comando, título, directorio actual, PID del panel y fecha de creación de la sesión.
- `tmux capture-pane -p -S -12`: las últimas 12 líneas del panel activo, sin secuencias de escape ANSI.
- `/proc/<pid>/environ` solo para casar el `PRESENCE_ID` de la pestaña.
- `ps --ppid` para identificar agentes lanzados desde una shell.
- `git rev-parse --show-toplevel` y `git branch --show-current` en el directorio del panel.

El vigilante publica en Discord:

- `<Agente> · <workspace>` (etiqueta del agente y nombre del repositorio o directorio).
- `💻 Working..` o `💤 Idle`.
- Una marca de inicio basada en la sesión tmux.
- Las claves de imagen configuradas en `assets`, si las hay.

Nunca publica texto del panel, títulos, prompts, comandos, nombres de tools, rutas de ficheros, nombres de rama, PIDs, el host o usuario SSH, ni valores de `PRESENCE_ID`. Los logs y los ficheros de sesión se quedan en la máquina Windows.

## Limitaciones conocidas y falsos positivos

- **Detección heurística de actividad.** El clasificador busca palabras como `thinking`, `working`, `starting`, `connecting`, `initializing`, `loading`, `preparing`, `queued`, `waiting`, `generating` o `processing`, la frase `esc to interrupt` y caracteres spinner braille en las últimas 12 líneas o en el título del panel. Las mismas palabras en texto no relacionado de una TUI pueden producir un falso `💻 Working..`; al contrario, una tarea terminada puede quedarse en `Idle` hasta que el panel cambie.
- **Corte por `Worked for` / `Cooked for`.** La actividad anterior a la última línea de ese tipo se ignora, para no reportar como activa una tarea ya completada.
- **Solo el panel activo.** Los splits y paneles en segundo plano no se inspeccionan. Con varias pestañas, el probe prefiere la que está trabajando, después la enfocada y por último la de actividad más reciente.
- **Detección de foco.** Usa `client_flags` de tmux; activa `focus-events on` en tmux para que sea fiable. Sin información de foco recurre a la hora de actividad.
- **Un vigilante por directorio de sesiones.** Un lock obsoleto con un PID vivo impide arrancar un segundo vigilante; es intencionado.
- **Solo Windows y Discord Desktop.** El vigilante usa el named pipe de Windows de Discord. Los tests corren en Linux o Windows y no necesitan Discord, SSH ni tmux.
- **Los rate limits de Discord** pueden agrupar actualizaciones rápidas; el heartbeat de 60 segundos mantiene la tarjeta al día.
- **Sin daemon remoto.** Si cae la conexión SSH, el probe termina y el vigilante reintenta; tras tres fallos consecutivos detiene el stream e informa `💤 Idle`.

## Logs y diagnóstico

Por defecto el log es `%LOCALAPPDATA%\discord-terminal-presence\watcher.log` y rota a `watcher.log.1` al llegar a 1 MB. `watcher.lock` vive en el directorio padre de `sessions`, y cada pestaña escribe `<pid>.json`.

- **Discord cerrado / pipe no encontrado:** abre Discord Desktop. El vigilante registra cada cambio de conexión y reintenta en el siguiente ciclo.
- **SSH caído o clave no autorizada:** ejecuta `node src/index.mjs --once` y comprueba red, puerto, usuario y clave. Los errores de SSH aparecen en el log.
- **Sin clientes tmux en la pestaña actual:** la tarjeta muestra solo `💤 Idle`. Al cerrar la última pestaña, se limpia la actividad y el vigilante termina.
- **`Discord IPC ERROR`:** lee el código y el mensaje del log. Los errores de assets suelen indicar que la clave no existe en Art Assets.
- **La actividad no cambia:** el vigilante mantiene el stream abierto y actualiza cuando cambia el estado del panel. Debe existir al menos un fichero de sesión `<pid>.json` con el PID vivo.
- **Reiniciar:** cierra todas las pestañas `presence`, espera unos segundos y vuelve a abrir el perfil. No borres a mano un lock cuyo PID siga vivo.

## Desarrollo y tests

El proyecto es ESM puro, sin dependencias y sin paso de compilación.

```bash
npm test        # o: node --test
```

La suite usa `node:test` con dobles inyectados para tmux, `ps`, `git`, Discord y SSH, así que corre en Linux o Windows sin Discord, tmux ni un host remoto. Todos los tests deben pasar; la suite actual tiene 72 tests.

Estructura:

```text
application/    orquestación del estado del panel (agente, workspace, working)
domain/         parseo de tmux y clasificador Working/Idle
infrastructure/ adaptadores de tmux, ps, git y /proc
probe/          punto de entrada remoto (una consulta y --watch)
src/            vigilante, IPC de Discord, configuración, logger y registro de sesiones
windows/        wrapper de Windows Terminal y lanzador oculto opcional
test/           suite con node:test
```

## Licencia

MIT. Consulta [LICENSE](LICENSE).
