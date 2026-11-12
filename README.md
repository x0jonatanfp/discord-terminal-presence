# discord-terminal-presence

Watcher para Windows que refleja en Discord Rich Presence el panel tmux activo en un host Linux remoto. El nombre visible de la aplicación en Discord debe ser **`Terminal`**, de modo que Discord presente «Playing Terminal». El watcher se ejecuta en Windows, donde está el named pipe IPC; un probe Node ESM sin dependencias consulta por SSH metadatos de tmux, procesos y Git. No lee ni transmite contenido de conversación y no necesita daemon en el host.

## Requisitos

- Windows con Node.js 22 o posterior, Discord Desktop instalado y abierto.
- SSH Windows→host remoto sin interacción, con una clave autorizada. El comando debe poder ejecutarse desde una terminal Windows (los valores son de ejemplo):
  `ssh -p 22 usuario@192.0.2.10 "tmux list-clients"`
- No hay dependencias npm ni paso de compilación.

## Crear la aplicación de Discord

1. Abre [Discord Developer Portal](https://discord.com/developers/applications) y crea una aplicación llamada **`Terminal`**; ese nombre forma el encabezado «Playing Terminal».
2. Copia su **Application ID**.
3. En **Rich Presence → Art Assets**, sube el logo grande con clave `terminal` y, si quieres iconos por agente, los pequeños `claude`, `freebuff`, `opencode` y `codex` (las claves distinguen mayúsculas y minúsculas).
4. El código solo referencia assets por clave; no descarga ni genera imágenes. Los assets son opcionales. El Application ID es público; no pongas tokens ni secretos en la configuración.

## Configuración

Copia `config.example.json` como `config.json` y sustituye `applicationId` por el ID de la aplicación. Revisa `ssh.host`, `ssh.port`, `ssh.user` y `ssh.binary`. Los valores de `config.example.json` son ficticios (`192.0.2.10` es una IP reservada para documentación); usa los de tu host. `probe.node` y `probe.scriptPath` indican el Node y el script remoto en el host; en el ejemplo, `/usr/bin/node /home/usuario/Development/extensions/discord-terminal-presence/probe/state.mjs`. El probe requiere `/usr/bin/tmux`, `/usr/bin/ps` y `/usr/bin/git` en el host. El watcher mantiene una conexión SSH persistente con `probe/state.mjs --watch`: el probe captura el panel tmux activo y emite una línea JSON cuando cambia su estado, sin repetir SSH cada ciclo. `pollIntervalMs` (mínimo 2000 ms) solo limita cuánto espera el watcher sin novedades antes de revisar las sesiones; la presencia se actualiza en tiempo real y mantiene un heartbeat cada 60 s. Opcionalmente, `logDir` cambia el directorio del log.

Para la primera prueba **no configures `assets`**: el bloque es opcional y el código lo omite. Cuando subas los logos al portal, añade:

```json
"assets": {
  "largeImage": "terminal",
  "agents": { "claude": "claude", "freebuff": "freebuff", "opencode": "opencode", "codex": "codex" }
}
```

No se usa `npm install`. Desde el directorio del proyecto:

```powershell
Copy-Item config.example.json config.json
# Edita config.json y añade el Application ID
node src/index.mjs --once
```

`--once` imprime el JSON del probe (incluido `{ "idle": true }` si no hay clientes), no necesita Discord y devuelve código 2 con un mensaje claro si falta la configuración. El watcher normal se lanza desde el perfil `presencia` (ver más abajo); ejecutar `node src/index.mjs` a mano sin ninguna sesión registrada termina en el primer ciclo. Para depurar, usa `--verbose` desde el wrapper o revisa el log.

## Copiar al PC Windows

Desde el entorno que contiene el proyecto, copia la carpeta a `C:\Users\<usuario>\tools\discord-terminal-presence` (sustituye `<usuario>` por tu usuario de Windows).

Por ejemplo, desde PowerShell en el PC Windows, descarga el código desde el host remoto al destino (SSH Windows→host por la LAN):

```powershell
scp -P 22 -r usuario@192.0.2.10:/home/usuario/Development/extensions/discord-terminal-presence C:/Users/<usuario>/tools/
```

Después crea `config.json` en el PC; no copies una configuración local que contenga datos propios de otra máquina. El comando es una instrucción para el despliegue manual, no se ejecuta durante esta tarea.

## Arranque atado a Windows Terminal

El watcher solo vive mientras haya abierta al menos una pestaña del perfil duplicado **`presencia`**. No se usa carpeta Inicio ni autostart al iniciar sesión.

1. Configura `sessionsDir` en `config.json` o usa el valor por defecto `%LOCALAPPDATA%\\discord-terminal-presence\\sessions`.
2. En Windows Terminal, duplica el perfil SSH que ya uses, conserva su icono y asigna al duplicado un GUID nuevo y el nombre `presencia`.
3. Establece el `commandline` del duplicado a (sustituye `<usuario>` y la ruta de Node si tu instalación está en otro sitio):

```text
"C:\Program Files\nodejs\node.exe" "C:\Users\<usuario>\tools\discord-terminal-presence\windows\terminal-session.mjs"
```

4. Pon el GUID nuevo en `defaultProfile`. Mantén intacto el perfil SSH original.

La primera pestaña registra su PID, reclama un lock de arranque y crea un único watcher oculto; ese watcher reclama el lock y abre la presencia. Cada pestaña abre SSH interactivo en su propio terminal y las demás reutilizan el watcher existente. Al salir la última pestaña, el watcher detecta el registro vacío en el siguiente ciclo (máximo ~2 s), limpia la actividad y termina. Si una pestaña muere abruptamente, el watcher descarta su registro cuando verifica que el PID ya no existe. Sin pestañas, no debe quedar watcher activo. No crees accesos directos en Inicio.

Diagnóstico: el log está en `%LOCALAPPDATA%\\discord-terminal-presence\\watcher.log`; `watcher.lock` vive en el directorio padre de `sessions`, y cada sesión es `<pid>.json`. Si SSH termina y el registro desaparece pero la presencia tarda, espera un ciclo de polling. Para reiniciar, cierra todas las pestañas `presencia`, espera unos segundos y vuelve a abrir el perfil. Un lock con PID vivo no se debe borrar manualmente.

## Probe y alcance de detección

El probe `probe/state.mjs` se ejecuta en el host remoto por SSH; no instala paquetes ni escribe archivos allí. El watcher lo lanza en modo `--watch`: consulta el panel tmux activo y emite solo cambios por stdout. La tarjeta mantiene dos líneas: `<agente> · <workspace>` (p. ej. `Claude · discord-terminal-presence`) y `💻 Working..` o `💤 Idle`. La detección usa `tmux capture-pane -p` sobre las últimas 12 líneas y el título del panel; no lee transcripciones, bases de datos de agentes ni publica nombres de tools, comandos o rutas.

Las señales de actividad son `thinking`, `working`, `esc to interrupt`, `esc interrupt`, `interrupt`, `Esc` y caracteres spinner braille. `Worked for` y `Cooked for` delimitan texto de trabajo ya completado: se ignoran las señales anteriores a la última línea de ese tipo. La captura incluye únicamente el panel activo del cliente tmux vinculado al `PRESENCE_ID` de esa pestaña. Sin cliente correspondiente, se informa `idle: true`. Se mantienen `ok`, `idle`, `session`, `agent`, `workspace`, `workspacePath`, `branch`, `title`, `createdSeconds`, `command` y `working`; en Discord solo se muestran agente, workspace, los dos estados y los assets gráficos configurados.

## Logs y diagnóstico

Por defecto, el log está en `%LOCALAPPDATA%\discord-terminal-presence\watcher.log`; al superar 1 MB se rota a `watcher.log.1`.

- **Discord cerrado / pipe no encontrado:** abre Discord Desktop. El watcher registra una vez cada cambio de conexión y reintenta en el siguiente ciclo.
- **SSH caído o sin clave autorizada:** ejecuta `node src/index.mjs --once` y comprueba red, puerto, usuario y clave. Los errores de SSH aparecen en el log; tras tres fallos consecutivos se limpia la presencia obsoleta.
- **No hay clientes tmux en la pestaña actual (pero sigue abierta):** la tarjeta muestra solo `💤 Idle`; al cerrar la última pestaña, el watcher limpia la actividad y termina.
- **Discord IPC ERROR:** revisa el mensaje/código del log; errores de assets suelen indicar que la clave no existe en Art Assets.
- **No cambia la actividad:** el watcher mantiene el stream abierto y actualiza cuando cambia la actividad del panel; si Discord aplica su rate limit, puede agrupar actualizaciones. Debe existir al menos un fichero de sesión `<pid>.json` cuyo PID siga vivo.
- **Estado de trabajo:** la segunda línea es `💻 Working..` cuando la captura reciente o el título indican actividad; en caso contrario es `💤 Idle`. El clasificador puede dar falsos positivos si esas palabras o spinners aparecen en otro contexto de la TUI.
- **Varias pestañas:** el probe vigila todas las pestañas `presencia` abiertas y muestra la que está en `Working..`; si varias trabajan, la que tiene el foco de tmux (`client_flags` con `focused`, requiere `focus-events on`); sin ninguna trabajando, la enfocada y, si no hay foco, la de actividad más reciente.
- **Tests en Linux o Windows:** `node --test` no necesita Discord ni Windows; el comportamiento del probe se prueba con dependencias de sistema inyectadas.
