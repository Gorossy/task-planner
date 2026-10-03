# task-planner

Al empezar una tarea nueva recomienda modelo, effort y subagentes. Aceptas o
escoges otra cosa una vez, y el mod aplica esa elección en silencio hasta la
siguiente tarea nueva. No toca permisos ni el modo de permisos: no engancha
`tool.check` ni `tool.call` (`claude plugin validate .` lista sus hooks).

Requiere Claude Code 2.1.287 o posterior.

## Instalar

```bash
claude plugin marketplace add Gorossy/task-planner
claude plugin install task-planner@gorossy-mods
```

Dentro de una sesión son `/plugin marketplace add Gorossy/task-planner` y
`/plugin install task-planner@gorossy-mods`.

Para probarlo sin instalar, clona el repo y corre
`claude --plugin-dir ./task-planner`.

## Privacidad

El mod no usa red, ni lee ni escribe archivos, ni lanza procesos. Guarda en el
store de Claude Code, en tu máquina, un historial de las últimas 300 decisiones
(tipo de tarea, un resumen corto del prompt, la elección y cómo terminó). Para ambiguos, el
prompt va a un modelo pequeño de la misma sesión (`CLASSIFIER_MODEL`).
## Uso

- **Tarea nueva** (primer prompt, primero después de `/clear`, o un prompt que
  describe un trabajo nuevo): se abre el chooser antes de que Claude empiece.
  Enter acepta la recomendación. Esc deja todo como está.
- **Continuaciones** ("sí", "dale", "arregla eso", respuestas a una pregunta de
  Claude, prompts cortos): no pregunta. Ante la duda, tampoco.
- `/tarea [descripción]`: abre el chooser a mano. Sin descripción usa tu último
  prompt.
- `/tareas`: resumen por tipo de tarea — qué se recomendó, cuántas aceptaste,
  cuántas cambiaste y hacia qué, y cómo terminaron (turnos, interrupciones,
  errores, minutos, subagentes).

El chooser es el diálogo del motor, que admite 4 opciones: la recomendación, dos
alternativas (una más cara; la misma sin subagentes si la recomendación los usa)
y "Más opciones", que lleva a Personalizar, Dejar como está y la alternativa
restante. En "Other" también puedes escribir `sonnet high`, `opus xhigh sub
sonnet` o `dejar`.

## Plan mode en tareas complejas

Si la tarea nueva es compleja (feature nueva, refactor, migración, cambio de
arquitectura, bug que cruza capas, varios módulos, o más de un enfoque
posible) y la sesión no está ya en plan mode, la recomendación lo incluye con
su motivo. La primera opción pasa a ser "… + plan mode (recomendado)" y la
segunda la misma configuración "sin plan mode".

- **Aceptas con plan mode:** el prompt no se envía. Vuelve a la caja tal como lo
  escribiste con el aviso "Cambia a plan mode con Shift+Tab y envía de nuevo".
  Al reenviarlo el mod no pregunta y aplica modelo, effort y subagentes.
- **Eliges una opción sin plan mode:** todo sigue como siempre.
- Nunca se recomienda en lectura, ediciones mecánicas, cambios de un solo
  archivo, continuaciones, `/tarea`, ni en modo `automatico` o sin terminal.
- `/tareas` cuenta por tipo cuántas veces se recomendó, cuántas lo aceptaste
  (reenviaste en plan mode) y cuántas lo ignoraste.

El mod nunca cambia el modo de permisos: solo lo lee, del `permission_mode` que
el motor reporta en sus eventos (`SessionStart`, `UserPromptSubmit`, `Stop`) y
del pie del prompt. Los criterios están en `PLAN`, en `hooks/rules.ts`. Lo
adjunto que no sea texto (imágenes pegadas) no vuelve a la caja.

## Modos (`/config` › task-planner › Modo)

| Modo | Qué hace |
| --- | --- |
| `preguntar` (por defecto) | Chooser en cada tarea nueva. |
| `automatico` | Nunca pregunta: aplica la recomendación y deja una línea. `/tarea` sigue abriendo el chooser. |
| `desactivado` | No registra nada: ni hooks ni comandos. |

En una sesión no interactiva (`claude -p`, Agent SDK) siempre se comporta como
`automatico`.

## Editar las reglas

Todo está en `hooks/rules.ts`; la lógica no hay que tocarla.

- `TASK_TYPES`: los tipos de tarea en orden de prioridad, cada uno con sus
  patrones, modelo, effort, motivo y con qué correr los subagentes. Gana el
  primero que coincide; si ninguno coincide decide un modelo pequeño entre las
  etiquetas, y si tampoco, queda `DEFAULT_TYPE`.
- `SUBAGENTS`: cuándo el trabajo es repartible (`when`), cuándo nunca (`never`),
  cuándo basta Sonnet (`closedSpec`) y la instrucción que recibe Claude.
- `PLAN`: cuándo recomendar plan mode — tipos que nunca (`neverTypes`), tipos
  complejos por sí mismos (`types`), señales en el prompt con su motivo
  (`signals`) y el texto del aviso (`notice`).
- `CONTINUATION` / `NEW_TASK`: qué cuenta como continuación y qué como tarea
  nueva.
- `MODELS`, `COST`, `CLASSIFIER_MODEL`: ids de modelo, la escala `$`–`$$$$` y el
  modelo del clasificador.

Los patrones se prueban contra el prompt en minúsculas y sin tildes. Después de
editar:

```bash
claude plugin test .
claude plugin validate . --strict
```

## Cómo aplica la elección

- Modelo y effort del hilo principal: reescribe cada petición del turno
  (`turn.step`). No cambia `/model` ni `/effort` de la sesión, así que "Dejar
  como está" es literalmente no hacer nada. El modelo solo cambia en el límite
  entre tareas, y la línea de confirmación lo avisa porque rompe el cache.
- Subagentes: el modelo se pone en `agent.spawn` (los forks heredan siempre) y
  el effort en las peticiones del propio subagente. Pisa el modelo de cualquier
  tipo de agente mientras la elección incluya subagentes.
- Las decisiones quedan en el store del mod (últimas 300).

## Licencia

MIT. Ver [LICENSE](LICENSE).
