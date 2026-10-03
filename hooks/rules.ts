// Reglas de task-planner. Este es el unico archivo que hay que editar para
// cambiar que se recomienda: la logica (planner.ts, register.ts) solo lo lee.
//
// Los patrones se prueban contra el prompt en minusculas y SIN tildes
// ("migración" llega como "migracion"), asi que se escriben sin tildes.
import type {
  TaskPlannerEffort as Effort,
  TaskPlannerModel as Model,
} from '../types'

export type TaskType = {
  id: string
  /** Nombre corto: sale en /tareas y es la etiqueta que ve el clasificador. */
  label: string
  /** Basta con que uno coincida. */
  patterns: readonly RegExp[]
  /** Si coincide, el tipo se descarta aunque un patron haya coincidido. */
  unless?: RegExp
  model: Model
  effort: Effort
  /** El motivo que acompana a la recomendacion. */
  reason: string
  /** Con que correr los subagentes cuando el trabajo es repartible. */
  subagents: { model: Model; effort: Effort }
}

/** `id` es lo que se manda en turn.step y agent.spawn; `match` reconoce el modelo de la sesion. */
export const MODELS: Record<Model, { id: string; label: string; match: RegExp }> = {
  opus: { id: 'claude-opus-5-5', label: 'Opus 5.5', match: /opus/i },
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', match: /sonnet/i },
}

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Modelo pequeno para los casos que las heuristicas dejan ambiguos. */
export const CLASSIFIER_MODEL = 'haiku'

const ACTION =
  /\b(arregla|corrige|implementa|crea|agrega|anade|cambia|escribe|construye|modifica|migra|renombra|refactor\w*|elimina|borra|actualiza|fix|add|build|implement)\b/

// En orden de prioridad: gana el primer tipo que coincide. Si ninguno
// coincide, decide el clasificador entre estas etiquetas y, si tampoco,
// queda DEFAULT_TYPE.
export const TASK_TYPES: readonly TaskType[] = [
  {
    id: 'autonoma',
    label: 'Tarea larga y autonoma de punta a punta',
    patterns: [
      /de punta a punta|end.to.end|de principio a fin/,
      /\bautonom/,
      /sin (preguntar|interrump)/,
      /no pares hasta|hasta que (termines|pasen|quede)/,
    ],
    model: 'opus',
    effort: 'max',
    reason: 'es una tarea larga que corre sola de punta a punta',
    subagents: { model: 'opus', effort: 'high' },
  },
  {
    id: 'lectura',
    label: 'Lectura, exploracion o preguntas sobre el codigo',
    patterns: [
      /^¿?(explica\w*|como (funciona|se)|que (hace|es|significa)|donde|por que|cual(es)?|muestrame|lista|describe|resume|lee|explora|investiga|busca|encuentra|cuentame|dime)\b/,
    ],
    unless: ACTION,
    model: 'sonnet',
    effort: 'low',
    reason: 'es lectura y exploracion, sin cambios en el codigo',
    subagents: { model: 'sonnet', effort: 'low' },
  },
  {
    id: 'critica',
    label: 'Seguridad, parsers, concurrencia, migraciones de datos o performance',
    patterns: [
      /segurid|security|vulnerab|autenticac|autorizac|oauth|\bjwt\b|\brls\b|inyeccion|\bxss\b|\bcsrf\b|cifra|encrypt/,
      /\bparsers?\b|parse[ao]r|tokeniz|lexer|gramatica/,
      /concurren|race condition|condicion(es)? de carrera|deadlock|\block(s|ing)?\b|\bhilos?\b|thread/,
      /migra\w* (de |los |las )*datos|backfill|alembic|migration/,
      /performance|rendimiento|optimiz|\blent[oa]s?\b|latencia|n\+1|memory leak|fuga de memoria/,
    ],
    model: 'opus',
    effort: 'xhigh',
    reason: 'toca seguridad, parsers, concurrencia, datos o performance, donde un error sale caro',
    subagents: { model: 'opus', effort: 'high' },
  },
  {
    id: 'mecanica',
    label: 'Edicion mecanica en muchos archivos',
    patterns: [
      /renombr|rename/,
      /buscar y reemplazar|find and replace|reemplaza\w* .*en todo/,
      /aplica\w* (el|este|un) (mismo )?patron|mismo cambio en|codemod|mecanic/,
      /actualiza\w* (todos )?los imports/,
    ],
    model: 'opus',
    effort: 'low',
    reason: 'es una edicion mecanica repetida en muchos archivos',
    subagents: { model: 'sonnet', effort: 'medium' },
  },
  {
    id: 'compleja',
    label: 'Codigo con edge cases o bug que toca varias capas',
    patterns: [
      /edge cases?|casos? (borde|limite|extremos?)/,
      /(varias|multiples|distintas|entre) capas|front\w* y (el )?back|back\w* y (el )?front/,
      /intermitente|flaky|no se reproduce|regresion/,
      /refactor/,
    ],
    model: 'opus',
    effort: 'high',
    reason: 'tiene edge cases o cruza varias capas del codigo existente',
    subagents: { model: 'opus', effort: 'high' },
  },
  {
    id: 'acotada',
    label: 'Codigo bien acotado con forma de verificarlo',
    patterns: [
      /bug puntual/,
      /(bug|error|falla|arregla|corrige|fix).*(tests?|pruebas?|pytest)\b/,
      /(tests?|pruebas?|pytest)\b.*(bug|error|falla|arregla|corrige|fix)/,
      /(pequen|puntual|simple|sencill|acotad)\w* .*(feature|cambio|funcion|endpoint|ajuste)/,
      /(feature|cambio|funcion|endpoint|ajuste)\w* (pequen|puntual|simple|sencill|acotad)/,
    ],
    model: 'sonnet',
    effort: 'medium',
    reason: 'esta bien acotada y hay forma de verificarla',
    subagents: { model: 'sonnet', effort: 'medium' },
  },
  {
    id: 'feature',
    label: 'Feature nueva normal',
    patterns: [
      /nueva (feature|funcionalidad)|feature nueva/,
      /(implementa|agrega|anade|crea|construye|desarrolla)\w* .*(feature|funcionalidad|endpoint|pantalla|modulo|componente|comando|vista|pagina|reporte)/,
    ],
    model: 'opus',
    effort: 'medium',
    reason: 'es una feature nueva de tamano normal',
    subagents: { model: 'sonnet', effort: 'medium' },
  },
]

export const DEFAULT_TYPE = 'feature'

export const SUBAGENTS = {
  /** El trabajo se reparte en partes independientes: basta con que uno coincida. */
  when: [
    /(todos|todas|cada|muchos|muchas|varios|varias|multiples|\d+) (los |las |uno de los |una de las )?(servicios|modulos|archivos|paquetes|endpoints|componentes|routers|repos|apps|microservicios|importadores|migraciones)/,
    /por (servicio|modulo|archivo|paquete|componente)/,
    /cada (servicio|modulo|archivo|paquete|endpoint|componente|router)/,
    /(auditori\w*|audita\w*|review|revision) .*(todo el|toda la|completo|completa)/,
  ] as readonly RegExp[],
  /** Nunca, aunque `when` coincida: tareas pequenas, de un archivo o secuenciales. */
  never: /un solo archivo|este archivo|una (sola )?linea|paso a paso|secuencial|en orden estricto/,
  /** Piezas con spec cerrada y tests: Sonnet alcanza aunque el tipo pida Opus. */
  closedSpec: /\btests?\b|\bpruebas?\b|spec cerrada|pytest/,
  closedSpecEffort: 'medium' as Effort,
  /** Como se nombra la unidad de reparto en la recomendacion. */
  units: [
    { pattern: /microservicio|servicio/, label: 'por servicio' },
    { pattern: /modulo/, label: 'por modulo' },
    { pattern: /archivo/, label: 'por archivo' },
    { pattern: /paquete/, label: 'por paquete' },
    { pattern: /componente/, label: 'por componente' },
    { pattern: /endpoint|router/, label: 'por endpoint' },
  ] as readonly { pattern: RegExp; label: string }[],
  reason: 'el trabajo se reparte en partes independientes',
  closedSpecReason: 'cada parte tiene tests',
  /** Lo que lee Claude (no se muestra) cuando la eleccion incluye subagentes. */
  instruction: (model: string) =>
    [
      `task-planner: para esta tarea el usuario eligio repartir el trabajo en subagentes (${model}).`,
      'Divide el trabajo en partes independientes y lanza un subagente por parte con la herramienta Agent.',
      'Cada subagente recibe una spec cerrada: que hacer, que no tocar, su criterio de terminado y una forma concreta de verificarlo (el test o comando que debe pasar).',
      'Pide a cada subagente que devuelva la evidencia de esa verificacion y revisala antes de aceptar su resultado: lo que no traiga evidencia no se da por hecho.',
    ].join(' '),
}

/** Costo relativo: base del modelo + effort (+ subagentes), acotado a $..$$$$. */
export const COST = {
  model: { sonnet: 1, opus: 2 } as Record<Model, number>,
  effort: { low: 0, medium: 0, high: 1, xhigh: 2, max: 2 } as Record<Effort, number>,
  subagents: 1,
}

// Cuando recomendar empezar en plan mode. Solo en tareas nuevas, y nunca si
// la sesion ya esta en plan mode.
export const PLAN = {
  /** Tipos que nunca lo recomiendan (ids de TASK_TYPES). */
  neverTypes: ['lectura', 'mecanica'] as readonly string[],
  /** Nunca, aunque algo coincida: cambios de un solo archivo. */
  never: /un solo archivo|este archivo|una (sola )?linea/,
  /** Tipos complejos por si mismos, con su motivo. */
  types: {
    feature: 'es una feature nueva',
    compleja: 'cruza varias capas o tiene edge cases',
  } as Record<string, string>,
  /** Senales en el prompt, con su motivo. Se muestran hasta `maxReasons`. */
  signals: [
    {
      pattern:
        /(varios|varias|multiples|muchos|muchas|todos|todas) (los |las )?(archivos|modulos|servicios|componentes|paquetes|routers|capas)|back\w* y (el )?front|front\w* y (el )?back/,
      reason: 'toca varios archivos o modulos',
    },
    { pattern: /refactor|migra|arquitectura|redisen|reestructura/, reason: 'es un refactor, una migracion o un cambio de arquitectura' },
    { pattern: /(bug|error|falla).*(varias|multiples|distintas|entre) capas/, reason: 'es un bug que cruza varias capas' },
    {
      pattern: /no se (como|cual|si)|no estoy segur|que enfoque|como deberia|propon|opciones|alternativas|la mejor forma|disena|decide (tu|como)/,
      reason: 'hay mas de un enfoque posible',
    },
  ] as readonly { pattern: RegExp; reason: string }[],
  maxReasons: 2,
  /** Como se reconoce plan mode en el pie del prompt. */
  footer: /plan mode/i,
  /** El aviso al devolver el prompt a la caja. */
  notice: 'Cambia a plan mode con Shift+Tab y envía de nuevo',
}

// Tarea nueva o continuacion. Ante la duda NO se pregunta.
export const CONTINUATION = {
  /** El prompt empieza asi: nunca es tarea nueva. */
  starts:
    /^(si|sip|no|ok|okay|vale|dale|listo|perfecto|gracias|genial|continua|sigue|adelante|hazlo|procede|correcto|exacto|bien|yes|yep|continue|go ahead|proceed|ahora tambien|tambien|y tambien|y ahora|ademas|arregla eso|corrige eso|cambia eso|mejor|quita|otra vez|de nuevo|intenta|prueba de nuevo|revierte|deshaz|falta|te falto|eso no|no funciona|sigue fallando|me sale|da error|fix that|also)\b/,
  /** Menciona lo que se acaba de hacer. */
  refs: /\b(eso|esto ultimo|lo anterior|lo que (acabas|hiciste)|es[ea] (error|cambio|archivo|funcion|test)|el mismo|lo de arriba)\b/,
  /** Con menos palabras que esto es continuacion. */
  maxShortWords: 12,
  /** Respuesta a una pregunta de Claude si tiene menos palabras que esto. */
  maxAnswerWords: 40,
}

export const NEW_TASK = {
  /** Anuncia un trabajo nuevo: se pregunta sin consultar al clasificador. */
  patterns: [
    /nueva tarea|tarea nueva|otra tarea|siguiente tarea|otra cosa|cambiando de tema|pasemos a/,
    /ahora quiero( que)?\b/,
    /(quiero|necesito) que (construyas|implementes|hagas|crees|audites|migres|revises|escribas|agregues)/,
  ] as readonly RegExp[],
  /** Desde esta cantidad de palabras, lo ambiguo va al clasificador; menos, es continuacion. */
  minWordsAmbiguous: 20,
  /** Etiquetas para $.model.classify. */
  labels: { new: 'tarea nueva', continuation: 'continuacion de lo anterior' },
}
