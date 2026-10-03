# task-planner

Un mod para [Claude Code](https://claude.com/claude-code). Cada vez que empiezas
una tarea, te dice qué modelo conviene, con cuánto esfuerzo, y si vale la pena
repartir el trabajo en subagentes. Aceptas con Enter o eliges otra cosa, y sigue
así hasta la siguiente tarea.

## Para qué sirve

Claude Code te deja escoger el modelo (Opus, Sonnet) y el nivel de esfuerzo
(de `low` a `max`). Casi nadie los cambia: se queda con lo mismo para todo.

- Con el modelo más potente al máximo para leer un archivo, gastas de más y
  esperas más.
- Con el más liviano para un cambio delicado, el resultado sale peor.

task-planner mira lo que escribiste y propone una combinación con su motivo.
Tú decides. Se ve más o menos así:

```text
Tarea: «arregla el cálculo de retenciones en el módulo de compras»
Tiene edge cases o cruza varias capas del código existente.

> Opus 5.5 high (recomendado)
  Opus 5.5 xhigh · $$$$ · más cuidado, más caro
  Sonnet 5.5 medium · $ · más rápido y barato
  Más opciones
```

Algunos ejemplos de lo que recomienda:

| Si la tarea es… | Recomienda |
| --- | --- |
| Leer o explorar, sin cambiar nada | Sonnet, esfuerzo `low` |
| Algo acotado y fácil de verificar | Sonnet, esfuerzo `medium` |
| Una función nueva de tamaño normal | Opus, esfuerzo `medium` |
| Un cambio que cruza varias partes del código | Opus, esfuerzo `high` |
| Seguridad, datos, concurrencia, rendimiento | Opus, esfuerzo `xhigh` |
| Una tarea larga que corre sola de principio a fin | Opus, esfuerzo `max` |

Solo recomienda: no te quita el control y no promete un ahorro concreto.

## Instalar

Necesitas Claude Code 2.1.287 o posterior. En la terminal:

```bash
claude plugin marketplace add Gorossy/task-planner
claude plugin install task-planner@gorossy-mods
```

O dentro de una sesión de Claude Code:

```text
/plugin marketplace add Gorossy/task-planner
/plugin install task-planner@gorossy-mods
```

## Cómo se usa

No hay que hacer nada especial. Escribe como siempre.

- **Cuando empiezas algo nuevo** (el primer mensaje, el primero después de
  `/clear`, o un mensaje que describe otro trabajo), aparece la pregunta antes
  de que Claude arranque. Enter acepta la recomendación. Esc deja todo como
  estaba.
- **Cuando sigues con lo mismo** («sí», «dale», «arregla eso», una respuesta
  corta), no pregunta. Si tiene dudas, tampoco: prefiere no interrumpir.
- **`/tarea [descripción]`** abre la pregunta cuando tú quieras.
- **`/tareas`** te muestra un resumen: qué te recomendó, cuántas veces
  aceptaste, cuántas cambiaste y cómo terminaron esas tareas.

Si no te convence ninguna opción, en «Other» puedes escribir lo que quieras:
`sonnet high`, `opus xhigh sub sonnet` o `dejar`.

### Tareas grandes: planear antes

Si la tarea es grande (un refactor, una migración, algo que toca varios módulos
o que se puede resolver de más de una forma), la recomendación incluye empezar
en *plan mode*, donde Claude primero propone un plan y espera tu aprobación.

Si aceptas, tu mensaje vuelve a la caja de texto con el aviso «Cambia a plan
mode con Shift+Tab y envía de nuevo». El mod nunca cambia ese modo por ti.

## Modos

Se cambia en `/config` › task-planner › Modo.

| Modo | Qué hace |
| --- | --- |
| `preguntar` (por defecto) | Pregunta en cada tarea nueva. |
| `automatico` | No pregunta: aplica la recomendación y te avisa con una línea. |
| `desactivado` | No hace nada. |

## Privacidad

- No se conecta a internet por su cuenta, no lee ni escribe archivos y no
  ejecuta programas.
- No toca los permisos de Claude Code.
- Guarda en tu máquina, dentro de Claude Code, un historial de las últimas 300
  decisiones: tipo de tarea, un resumen corto de lo que pediste, qué elegiste y
  cómo terminó. De ahí sale `/tareas`.
- Cuando no es claro qué tipo de tarea es, le pregunta a un modelo pequeño de
  tu misma sesión de Claude Code.

## En qué se basa

Los criterios de este mod salen de lo que aprendí leyendo el blog de
[claude.dev](https://claude.dev), que me pareció muy útil. Está hecho con los
artículos publicados **hasta el 3 de octubre de 2026**; lo que se publique
después no está reflejado aquí. Los que más pesaron:

- *Using Claude Code: Spending your effort*
- *What a task costs on Opus 5.5*
- *Building with Claude Sonnet 5.5*
- *Getting the most out of Opus 5.5 in Claude and Claude Code*
- *Getting started with Claude Code mods*

Es un proyecto personal e independiente: no es oficial ni está respaldado por
Anthropic. Las reglas son mi interpretación de esos artículos.

## Para quien quiera ajustarlo

Todas las reglas están en `hooks/rules.ts`; la lógica no hay que tocarla.

- `TASK_TYPES`: los tipos de tarea en orden de prioridad, cada uno con sus
  patrones, modelo, esfuerzo, motivo y con qué correr los subagentes. Gana el
  primero que coincide; si ninguno coincide decide un modelo pequeño, y si
  tampoco, queda `DEFAULT_TYPE`.
- `SUBAGENTS`: cuándo el trabajo se puede repartir y cuándo nunca.
- `PLAN`: cuándo recomendar plan mode.
- `CONTINUATION` / `NEW_TASK`: qué cuenta como continuación y qué como tarea
  nueva.
- `MODELS`, `COST`, `CLASSIFIER_MODEL`: los modelos, la escala `$`–`$$$$` y el
  modelo que clasifica.

Los patrones se prueban contra el mensaje en minúsculas y sin tildes. Después
de editar:

```bash
claude plugin test .
claude plugin validate . --strict
```

Para probar una copia local sin instalarla: `claude --plugin-dir ./task-planner`.

Cómo aplica la elección:

- Modelo y esfuerzo se ajustan en cada petición de la tarea. No cambia `/model`
  ni `/effort` de la sesión, así que «Dejar como está» es no hacer nada.
- El modelo solo cambia entre una tarea y otra, y te avisa cuando lo hace.
- En los subagentes pone el modelo al crearlos y el esfuerzo en sus peticiones.
- En una sesión no interactiva (`claude -p`, Agent SDK) se comporta como
  `automatico`.

## Licencia

MIT. Ver [LICENSE](LICENSE).
