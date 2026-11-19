# AGENTS.md · discord-terminal-presence

Guía para agentes de código que trabajan en este repositorio. Qué es, cómo se instala y cómo se usa está en el `README.md`.

## Qué es

Presencia enriquecida de Discord para el panel de tmux al que estás conectado en un host Linux remoto. Un pequeño vigilante corre en Windows, donde vive el named pipe local de Discord, y mantiene tu tarjeta de Discord sincronizada con el panel activo de tmux: qué agente de código está trabajando y en qué workspace. Nunca publica texto de la conversación.

## Estructura

- `application/`
- `domain/`
- `infrastructure/`
- `probe/`
- `src/`
- `test/`
- `windows/`
- `.gitignore`
- `.versionrc.json`
- `CHANGELOG.md`
- `README.es.md`
- `README.md`
- `config.example.json`
- `package.json`

## Comandos

Scripts de `package.json` (raíz):

| Comando | Ejecuta |
| --- | --- |
| `npm run test` | `node --test` |
| `npm run release` | `npx -y commit-and-tag-version@13.3.0` |

## Convenciones

- Tests en `test/`.
- Versión y `CHANGELOG.md` los genera la release (skill `my-commits`); no se editan a mano.

## Mantenimiento

- Este fichero y el `README.md` se actualizan en el mismo cambio que los deja obsoletos.
- Aquí solo va lo que puede ser público: nada de rutas locales, puertos de la máquina, IPs, perfiles de secretos ni datos personales.
