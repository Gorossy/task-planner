import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Decision } from './planner'
import { MODELS, PLAN } from './rules'

type Option = { label: string }
type Question = { question: string; header: string; options: Option[] }
/** What the person does with one dialog: a label per question, or undefined to dismiss it. */
type Answerer = (questions: Question[]) => Record<string, string> | undefined

type World = {
  isInteractive?: boolean
  surfaces?: string[]
  model?: string
  answer?: Answerer
  classify?: (labels: readonly string[]) => string | undefined
  /** What the reasoning model replies; undefined leaves it without an answer. */
  complete?: (request: { prompt: string; system?: string; model: string }) => string | undefined
  messages?: { role: string; text: string }[]
}

const OPUS = MODELS.opus.id
const SONNET = MODELS.sonnet.id
const LONG =
  'en el modulo de reportes hay que revisar como se calcula el saldo de cada cuenta y dejar el resultado listo para que el contador lo valide manana temprano'

const firstOption: Answerer = questions => ({ [questions[0]!.question]: questions[0]!.options[0]!.label })
const option = (index: number): Answerer => questions => ({ [questions[0]!.question]: questions[0]!.options[index]!.label })

/** The engine beneath the plugin, answered from memory; what it saw is on the returned record. */
const world = (on: On, given: World = {}) => {
  const seen = {
    logs: [] as string[],
    asked: [] as Question[][],
    prompts: [] as { text: string; context?: readonly string[] }[],
    steps: [] as { model: string; effort?: string | number; agentId?: string }[],
    spawns: [] as { model?: string; permissionMode?: string }[],
    classified: [] as (readonly string[])[],
    completed: [] as { prompt: string; system?: string; model: string }[],
    fills: [] as { text: string; mode?: string }[],
    stored: () => [] as Decision[],
  }
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[(e as { key: string }).key] }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store[key] = JSON.parse(JSON.stringify(value))
    return { value: null as unknown as void }
  })
  seen.stored = () => (store.decisions as Decision[] | undefined) ?? []
  on('ui.log', (_, e) => {
    if (e.to !== 'debug') seen.logs.push(e.text)
    return { value: null as unknown as void }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.surfaces', () => ({ value: (given.surfaces ?? ['terminal']) as never }))
  on('session.model', () => ({ value: given.model ?? OPUS }))
  on('session.messages', () => ({ value: (given.messages ?? []) as never }))
  on('model.classify', (_, e) => {
    const { labels } = e as { labels: readonly string[] }
    seen.classified.push(labels)
    return { value: given.classify?.(labels) }
  })
  on('model.complete', (_, e) => {
    const request = e as unknown as { prompt: string; system?: string; model: string }
    seen.completed.push(request)
    const text = given.complete?.(request)
    return { value: (text === undefined ? { isAnswered: false, reason: 'empty-reply' } : { isAnswered: true, text }) as never }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const questions = e.questions as unknown as Question[]
    seen.asked.push(questions)
    const answers = (given.answer ?? firstOption)(questions)
    if (answers === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers } }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('turn.step', async function* (_, e) {
    seen.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('agent.spawn', (_, e) => {
    seen.spawns.push({ model: e.model, permissionMode: e.permissionMode })
    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.fill', (_, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  return seen
}

/**
 * Starts the session in the permission mode given. The suites written before
 * plan mode was recommended start in plan mode, where the chooser is as it was.
 */
const start = async ($: Engine, isInteractive = true, mode = 'plan') => {
  await $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive })
  await $.classic.SessionStart({ source: 'startup', permission_mode: mode })
}

const submit = ($: Engine, text: string, kind: 'composer' | 'sdk' | 'task-notification' = 'composer', turnId?: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind }, ...(turnId === undefined ? {} : { turnId }) })

const step = async ($: Engine, agentId?: string) => {
  const stream = $.turn.step({
    turnId: 't1',
    index: 0,
    model: OPUS,
    effort: 'high',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  for await (const _ of stream) void _
}

const spawn = ($: Engine, fork = false) =>
  $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'audita el servicio de bancos',
    description: 'auditar bancos',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: OPUS,
    permissionMode: 'auto',
    background: false,
    fork,
  } as never)

const run = ($: Engine, command: string, args = '') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

describe('cuando preguntar', () => {
  test('el primer prompt abre el chooser antes de que el prompt entre', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.asked).toHaveLength(1)
    expect(seen.asked[0]![0]!.question).toContain('explica como funciona la conciliacion bancaria')
    expect(seen.asked[0]![0]!.question).toContain('Recomiendo')
    expect(seen.prompts).toHaveLength(1)
  })

  test('las continuaciones no preguntan', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'implementa una nueva feature de exportar el reporte a excel')
    for (const text of ['si', 'continua', 'dale', 'arregla eso', 'ahora tambien agrega el filtro por fecha', 'ok, pero usa el otro formato']) {
      await submit($, text)
    }
    expect(seen.asked).toHaveLength(1)
    expect(seen.prompts).toHaveLength(7)
  })

  test('una respuesta a una pregunta de Claude no pregunta', async ($, on) => {
    const seen = world(on, { messages: [{ role: 'assistant', text: '¿Prefieres que lo haga con una migracion o a mano?' }] })
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    await submit($, `con una migracion, y ${LONG}`)
    expect(seen.asked).toHaveLength(1)
    expect(seen.classified).toHaveLength(0)
  })

  test('un trabajo nuevo anunciado vuelve a preguntar', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    await submit($, 'ahora quiero que implementes una nueva feature: un endpoint que exporte el libro diario a excel con filtros')
    expect(seen.asked).toHaveLength(2)
  })

  test('lo ambiguo va al modelo pequeno, y ante la duda no pregunta', async ($, on) => {
    const seen = world(on, { classify: () => undefined })
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    await submit($, LONG)
    expect(seen.classified).toHaveLength(1)
    expect(seen.classified[0]).toEqual(['tarea nueva', 'continuacion de lo anterior'])
    expect(seen.asked).toHaveLength(1)
  })

  test('lo ambiguo que el modelo pequeno llama tarea nueva si pregunta', async ($, on) => {
    const seen = world(on, { classify: labels => (labels.includes('tarea nueva') ? 'tarea nueva' : 'Feature nueva normal') })
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    await submit($, LONG)
    expect(seen.asked).toHaveLength(2)
  })

  test('/clear vuelve a preguntar', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    await submit($, 'dale')
    expect(seen.asked).toHaveLength(1)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await submit($, 'dale')
    expect(seen.asked).toHaveLength(2)
  })

  test('un prompt escrito sobre un turno en curso o una notificacion nunca pregunta', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona el modulo de bancos', 'composer', 'turn-9')
    await submit($, 'explica como funciona el modulo de bancos', 'task-notification')
    expect(seen.asked).toHaveLength(0)
    expect(seen.prompts).toHaveLength(2)
  })

  test('/tarea abre el chooser a mano y el prompt que sigue no vuelve a preguntar', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    const answer = await run($, 'tarea', 'renombra la funcion get_user en todos los archivos del backend')
    expect(seen.asked).toHaveLength(2)
    expect(seen.asked[1]![0]!.options[0]!.label).toBe('Opus 5.5 low con subagentes Sonnet 5.5 por archivo · $$$ (recomendado)')
    expect(answer.text).toContain('queda configurada')
    expect(answer.context?.[0]).toContain('subagente')
    await submit($, 'ahora quiero que implementes el renombrado de get_user en todos los archivos del backend')
    expect(seen.asked).toHaveLength(2)
  })

  test('la sesion no interactiva aplica la recomendacion sin preguntar y lo dice', async ($, on) => {
    const seen = world(on, { surfaces: [] })
    await start($, false)
    await submit($, 'explica como funciona el modulo de bancos', 'sdk')
    expect(seen.asked).toHaveLength(0)
    expect(seen.logs).toEqual(['Tarea en Sonnet 5.5 low (recomendacion aplicada sin preguntar) · cambia el modelo: el cache del prompt se reconstruye'])
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'low', agentId: undefined })
    expect(seen.stored()[0]!.how).toBe('automatica')
  })

  test('sin superficie donde dibujar el chooser, aplica la recomendacion', async ($, on) => {
    const seen = world(on, { surfaces: [] })
    await start($)
    await submit($, 'explica como funciona el modulo de bancos')
    expect(seen.asked).toHaveLength(0)
    expect(seen.stored()[0]!.how).toBe('automatica')
  })
})

describe('la recomendacion por tipo de tarea', () => {
  const cases: [string, string, string, string][] = [
    ['lectura', 'explica como funciona la conciliacion bancaria', 'Sonnet 5.5 low', '$'],
    ['acotada', 'arregla el bug del redondeo en el calculo del IVA, hay un test que falla', 'Sonnet 5.5 medium', '$'],
    ['mecanica', 'renombra la variable company_id a tenant_id', 'Opus 5.5 low', '$$'],
    ['feature', 'implementa un endpoint para exportar el libro diario', 'Opus 5.5 medium', '$$'],
    ['compleja', 'hay un bug en el cierre contable que toca varias capas y tiene edge cases', 'Opus 5.5 high', '$$$'],
    ['critica', 'revisa la seguridad del webhook de pagos y su verificacion de firma', 'Opus 5.5 xhigh', '$$$$'],
    ['critica', 'escribe la migracion de datos que pasa owner_id a company_members', 'Opus 5.5 xhigh', '$$$$'],
    ['autonoma', 'construye el modulo de inventario de punta a punta sin preguntar hasta que pasen los tests', 'Opus 5.5 max', '$$$$'],
  ]
  for (const [type, prompt, expected, price] of cases) {
    test(`${type}: ${expected}`, async ($, on) => {
      const seen = world(on)
      await start($)
      await submit($, prompt)
      expect(seen.asked[0]![0]!.options[0]!.label).toBe(`${expected} · ${price} (recomendado)`)
      expect(seen.stored()[0]!.type).toBe(type)
      expect(seen.classified).toHaveLength(0)
    })
  }

  test('lo que ninguna regla reconoce lo clasifica el modelo pequeno', async ($, on) => {
    const seen = world(on, { classify: () => 'Codigo con edge cases o bug que toca varias capas' })
    await start($)
    await submit($, 'el cierre mensual deja los saldos descuadrados')
    expect(seen.asked[0]![0]!.options[0]!.label).toBe('Opus 5.5 high · $$$ (recomendado)')
  })

  test('y si el modelo pequeno no decide, es una feature normal', async ($, on) => {
    const seen = world(on, { classify: () => undefined })
    await start($)
    await submit($, 'el cierre mensual deja los saldos descuadrados')
    expect(seen.asked[0]![0]!.options[0]!.label).toBe('Opus 5.5 medium · $$ (recomendado)')
  })

  test('con subagentes: auditoria repartible con tests', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'implementa una auditoria de dependencias en todos los servicios del backend, cada servicio tiene tests')
    const [question] = seen.asked[0]!
    const labels = question!.options.map(o => o.label)
    expect(labels[0]).toBe('Opus 5.5 medium con subagentes Sonnet 5.5 por servicio · $$$ (recomendado)')
    expect(question!.question).toContain('el trabajo se reparte en partes independientes y cada parte tiene tests')
    // One dearer, and the same without subagents.
    expect(labels[1]).toBe('Opus 5.5 high con subagentes Sonnet 5.5 · $$$$ · mas caro: mas effort')
    expect(labels[2]).toBe('Opus 5.5 medium · $$ · la misma configuracion sin subagentes')
    expect(labels[3]).toBe('Mas opciones: personalizar o dejar como esta (Esc)')
    expect(seen.prompts[0]!.context?.[0]).toContain('spec cerrada')
    expect(seen.logs).toEqual(['Tarea en Opus 5.5 medium, subagentes en Sonnet 5.5 (recomendado)'])
  })

  test('con subagentes Opus cuando las piezas piden juicio', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'audita la seguridad de todos los routers de la api')
    expect(seen.asked[0]![0]!.options[0]!.label).toBe('Opus 5.5 xhigh con subagentes Opus 5.5 por endpoint · $$$$ (recomendado)')
  })

  test('sin subagentes: tarea de un solo archivo', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'implementa un endpoint nuevo, es un solo archivo aunque lo usan todos los servicios')
    const labels = seen.asked[0]![0]!.options.map(o => o.label)
    expect(labels[0]).toBe('Opus 5.5 medium · $$ (recomendado)')
    expect(labels.some(label => label.includes('subagentes'))).toBeFalsy()
    expect(seen.prompts[0]!.context).toBeUndefined()
  })
})

describe('la eleccion', () => {
  const AUDIT = 'implementa una auditoria de dependencias en todos los servicios del backend, cada servicio tiene tests'

  test('aceptar aplica effort y modelo en el hilo principal y el modelo en los subagentes', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, AUDIT)
    await step($)
    expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'medium', agentId: undefined })
    const started = await spawn($)
    expect(seen.spawns[0]).toEqual({ model: SONNET, permissionMode: 'auto' })
    expect(started.model).toBe(SONNET)
    // The subagent's own requests take the effort the rules give subagents.
    await step($, 'agent-1')
    expect(seen.steps[1]).toEqual({ model: OPUS, effort: 'medium', agentId: 'agent-1' })
    await spawn($, true)
    expect(seen.spawns[1]!.model).toBeUndefined()
    expect(seen.stored()[0]).toMatchObject({ how: 'aceptada', type: 'feature', chosen: { model: 'opus', effort: 'medium', sub: { model: 'sonnet' } } })
    expect(seen.asked).toHaveLength(1)
  })

  test('escoger algo mas caro', async ($, on) => {
    const seen = world(on, { answer: option(1) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.asked[0]![0]!.options[1]!.label).toBe('Opus 5.5 low · $$ · mas caro: Opus en lugar de Sonnet')
    await step($)
    expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'low', agentId: undefined })
    expect(seen.logs).toEqual(['Tarea en Opus 5.5 low (alternativa)'])
    expect(seen.stored()[0]).toMatchObject({ how: 'cambiada', recommended: { model: 'sonnet', effort: 'low' }, chosen: { model: 'opus', effort: 'low' } })
  })

  test('la misma configuracion sin subagentes deja los subagentes como vengan', async ($, on) => {
    const seen = world(on, { answer: option(2) })
    await start($)
    await submit($, AUDIT)
    await spawn($)
    expect(seen.spawns[0]!.model).toBeUndefined()
    expect(seen.prompts[0]!.context).toBeUndefined()
    expect(seen.logs).toEqual(['Tarea en Opus 5.5 medium (alternativa)'])
  })

  test('cambiar de modelo lo dice en la linea de confirmacion', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.logs).toEqual(['Tarea en Sonnet 5.5 low (recomendado) · cambia el modelo: el cache del prompt se reconstruye'])
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'low', agentId: undefined })
  })

  test('personalizar escoge modelo, effort y subagentes por separado', async ($, on) => {
    const dialogs: Answerer[] = [
      option(3),
      questions => ({ [questions[0]!.question]: 'Personalizar' }),
      questions => ({ [questions[0]!.question]: 'Sonnet 5.5' }),
      questions => ({ [questions[0]!.question]: 'high' }),
      questions => ({ [questions[0]!.question]: 'Opus 5.5' }),
    ]
    const seen = world(on, { answer: questions => dialogs.shift()!(questions) })
    await start($)
    await submit($, 'implementa un endpoint para exportar el libro diario')
    expect(seen.asked).toHaveLength(5)
    expect(seen.asked[1]![0]!.options.map(o => o.label)).toEqual(['Personalizar', 'Dejar como esta'])
    expect(seen.asked.slice(2).map(q => q[0]!.header)).toEqual(['Modelo', 'Effort', 'Subagentes'])
    expect(seen.asked[2]![0]!.options.map(o => o.label)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Sin cambio'])
    expect(seen.asked[3]![0]!.options.map(o => o.label)).toEqual(['medium', 'low', 'high', 'xhigh'])
    expect(seen.asked[4]![0]!.options.map(o => o.label)).toEqual(['Sin subagentes', 'Opus 5.5', 'Sonnet 5.5'])
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'high', agentId: undefined })
    await spawn($)
    expect(seen.spawns[0]!.model).toBe(OPUS)
    expect(seen.logs).toEqual(['Tarea en Sonnet 5.5 high, subagentes en Opus 5.5 (personalizado) · cambia el modelo: el cache del prompt se reconstruye'])
    expect(seen.stored()[0]!.how).toBe('personalizada')
  })

  test('lo escrito en Other tambien personaliza', async ($, on) => {
    const seen = world(on, { answer: questions => ({ [questions[0]!.question]: 'opus xhigh sub sonnet' }) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.stored()[0]).toMatchObject({ how: 'personalizada', chosen: { model: 'opus', effort: 'xhigh', sub: { model: 'sonnet' } } })
  })

  for (const [name, dialogs] of [
    ['dejar como esta', [option(3), (questions: Question[]) => ({ [questions[0]!.question]: 'Dejar como esta' })]],
    ['cerrar el chooser con Esc', [() => undefined]],
  ] as [string, Answerer[]][]) {
    test(`${name} no cambia nada`, async ($, on) => {
      const seen = world(on, { answer: questions => dialogs.shift()!(questions) })
      await start($)
      await submit($, AUDIT)
      await step($)
      expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined })
      await spawn($)
      expect(seen.spawns[0]!.model).toBeUndefined()
      expect(seen.prompts[0]).toEqual({ text: AUDIT, context: undefined })
      expect(seen.logs).toEqual(['Tarea sin cambios de modelo ni effort (dejar como esta)'])
      expect(seen.stored()[0]).toMatchObject({ how: 'sin cambios', chosen: null })
    })
  }

  test('la eleccion sigue en las continuaciones, sin volver a preguntar', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await submit($, 'dale')
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'low', agentId: undefined })
    expect(seen.asked).toHaveLength(1)
    expect(seen.logs).toHaveLength(1)
  })
})

describe('/tareas', () => {
  test('agrupa por tipo: recomendado, aceptadas, cambiadas y como terminaron', async ($, on) => {
    const dialogs: Answerer[] = [firstOption, option(1)]
    const seen = world(on, { answer: questions => dialogs.shift()!(questions) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await $.turn.complete({ answer: 'listo', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.turn.complete({ answer: '', durationMs: 60_000, isAborted: true, turnId: 't2', reason: 'aborted' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await submit($, 'explica como funciona el modulo de nomina')
    const { text } = await run($, 'tareas')
    expect(text).toContain('2 tareas registradas')
    expect(text).toContain('Lectura, exploracion o preguntas sobre el codigo (2)')
    expect(text).toContain('recomendado: Sonnet 5.5 low x2')
    expect(text).toContain('aceptadas: 1 · automaticas: 0 · cambiadas: 1')
    expect(text).toContain('cambiadas hacia: Opus 5.5 low x1')
    expect(text).toContain('1.0 turnos por tarea, 1 interrumpidos, 0 con error, 1.0 min por tarea')
    expect(seen.stored()[0]!.outcome).toMatchObject({ turns: 2, answered: 1, aborted: 1, durationMs: 120_000 })
  })
})

describe('los modos de userConfig', () => {
  test('preguntar es el modo por defecto', async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.asked).toHaveLength(1)
  })

  test('automatico aplica la recomendacion sin preguntar', { options: { mode: 'automatico' } }, async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.asked).toHaveLength(0)
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'low', agentId: undefined })
    expect(seen.stored()[0]!.how).toBe('automatica')
  })

  test('desactivado no hace nada', { options: { mode: 'desactivado' } }, async ($, on) => {
    const seen = world(on)
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await step($)
    await spawn($)
    expect(seen.asked).toHaveLength(0)
    expect(seen.logs).toHaveLength(0)
    expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined })
    expect(seen.spawns[0]!.model).toBeUndefined()
    expect(seen.stored()).toHaveLength(0)
  })
})

describe('permisos', () => {
  test('el mod no engancha tool.check ni cambia el modo de permisos', async ($, on) => {
    const seen = world(on)
    const checks: unknown[] = []
    on('tool.check', (_, e) => {
      checks.push(e)
      return { decision: 'ask', reason: 'sentinel' } as never
    })
    await start($)
    await submit($, 'implementa una auditoria de dependencias en todos los servicios del backend, cada servicio tiene tests')
    const asked = { tool: 'Bash', input: { command: 'rm -rf build' } }
    const verdict = await $.tool.check(asked as never)
    // The sentinel beneath the plugin received the call as made and its answer came back whole.
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject(asked)
    expect(verdict).toMatchObject({ decision: 'ask', reason: 'sentinel' })
    await spawn($)
    expect(seen.spawns[0]!.permissionMode).toBe('auto')
  })
})

describe('plan mode', () => {
  const COMPLEX = 'implementa un endpoint para exportar el libro diario, no se que enfoque conviene'
  const BASE = 'Opus 5.5 medium · $$'

  test('una tarea compleja lo recomienda con su motivo, y el resto del chooser sigue igual', async ($, on) => {
    const seen = world(on)
    await start($, true, 'default')
    await submit($, COMPLEX)
    const [question] = seen.asked[0]!
    expect(question!.question).toContain('Recomiendo empezar en plan mode: es una feature nueva y hay mas de un enfoque posible.')
    expect(question!.options.map(o => o.label)).toEqual([
      `${BASE} + plan mode (recomendado)`,
      `${BASE} · sin plan mode`,
      'Opus 5.5 high · $$$ · mas caro: mas effort',
      'Mas opciones: personalizar o dejar como esta (Esc)',
    ])
  })

  for (const [name, prompt] of [
    ['lectura', 'explica como funciona la conciliacion bancaria en el backend y el frontend'],
    ['edicion mecanica', 'renombra la variable company_id a tenant_id en todos los modulos'],
    ['un solo archivo', 'implementa un endpoint nuevo, es un solo archivo'],
    ['acotada', 'arregla el bug del redondeo en el calculo del IVA, hay un test que falla'],
  ] as const) {
    test(`una tarea simple no lo recomienda: ${name}`, async ($, on) => {
      const seen = world(on)
      await start($, true, 'default')
      await submit($, prompt)
      expect(seen.asked[0]![0]!.question).not.toContain('plan mode')
      expect(seen.asked[0]![0]!.options.some(o => o.label.includes('plan mode'))).toBeFalsy()
      expect(seen.stored()[0]!.plan).toBeUndefined()
    })
  }

  test('ya en plan mode no lo recomienda', async ($, on) => {
    const seen = world(on)
    await start($, true, 'plan')
    await submit($, COMPLEX)
    expect(seen.asked[0]![0]!.options[0]!.label).toBe(`${BASE} (recomendado)`)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.fills).toHaveLength(0)
  })

  test('el modo que el motor reporta despues tambien cuenta', async ($, on) => {
    const seen = world(on)
    await start($, true, 'default')
    await $.classic.Stop({ stop_hook_active: false, permission_mode: 'plan' } as never)
    await submit($, COMPLEX)
    expect(seen.asked[0]![0]!.options[0]!.label).toBe(`${BASE} (recomendado)`)
  })

  test('aceptar devuelve el prompt a la caja sin enviarlo', async ($, on) => {
    const seen = world(on)
    await start($, true, 'default')
    const answer = await submit($, COMPLEX)
    expect(answer.drop).toBe(PLAN.notice)
    expect(PLAN.notice).toBe('Cambia a plan mode con Shift+Tab y envía de nuevo')
    expect(seen.prompts).toHaveLength(0)
    expect(seen.fills).toEqual([{ text: COMPLEX, mode: 'replace' }])
    expect(seen.logs).toEqual(['Tarea en Opus 5.5 medium (recomendado) · empieza en plan mode'])
  })

  test('el reenvio en plan mode no vuelve a preguntar y aplica la eleccion', async ($, on) => {
    const seen = world(on)
    await start($, true, 'default')
    await submit($, COMPLEX)
    const answer = await submit($, COMPLEX)
    await $.classic.UserPromptSubmit({ prompt: COMPLEX, permission_mode: 'plan' })
    expect(answer.text).toBe(COMPLEX)
    expect(seen.asked).toHaveLength(1)
    expect(seen.prompts).toHaveLength(1)
    await step($)
    expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'medium', agentId: undefined })
    expect(seen.stored()).toHaveLength(1)
    expect(seen.stored()[0]).toMatchObject({ how: 'aceptada', plan: { chosen: true, entered: true } })
    // The task goes on as any other: continuations ask nothing.
    await submit($, 'dale')
    expect(seen.asked).toHaveLength(1)
    expect((await run($, 'tareas')).text).toContain('plan mode: recomendado 1 · aceptado 1 · ignorado 0')
  })

  test('reenviar sin cambiar a plan mode cuenta como ignorado', async ($, on) => {
    const seen = world(on)
    await start($, true, 'default')
    await submit($, COMPLEX)
    await submit($, COMPLEX)
    await $.classic.UserPromptSubmit({ prompt: COMPLEX, permission_mode: 'default' })
    expect(seen.asked).toHaveLength(1)
    expect(seen.stored()[0]!.plan).toEqual({ chosen: true, entered: false })
    expect((await run($, 'tareas')).text).toContain('plan mode: recomendado 1 · aceptado 0 · ignorado 1')
  })

  test('elegir sin plan mode sigue el flujo normal', async ($, on) => {
    const seen = world(on, { answer: option(1) })
    await start($, true, 'default')
    const answer = await submit($, COMPLEX)
    expect(answer.text).toBe(COMPLEX)
    expect(seen.fills).toHaveLength(0)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.logs).toEqual(['Tarea en Opus 5.5 medium (recomendado)'])
    await step($)
    expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'medium', agentId: undefined })
    expect(seen.stored()[0]).toMatchObject({ how: 'aceptada', plan: { chosen: false, entered: false } })
    expect((await run($, 'tareas')).text).toContain('plan mode: recomendado 1 · aceptado 0 · ignorado 1')
  })

  test('el modo automatico no devuelve el prompt', { options: { mode: 'automatico' } }, async ($, on) => {
    const seen = world(on)
    await start($, true, 'default')
    await submit($, COMPLEX)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.fills).toHaveLength(0)
    expect(seen.stored()[0]!.plan).toBeUndefined()
  })
})

describe('el modelo razona la recomendacion', () => {
  const reply = (fields: Record<string, unknown>) => () =>
    JSON.stringify({ nueva: true, tipo: 'critica', modelo: 'opus', effort: 'xhigh', subagentes: null, plan_mode: false, motivo_plan: '', motivo: 'toca el calculo de impuestos', ...fields })

  test('la recomendacion y su motivo salen del modelo, no de los patrones', async ($, on) => {
    // The patterns alone would call this reading: Sonnet low.
    const seen = world(on, { complete: reply({}) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.completed).toHaveLength(1)
    expect(seen.completed[0]!.prompt).toContain('explica como funciona la conciliacion bancaria')
    expect(seen.completed[0]!.system).toContain('lectura')
    expect(seen.asked[0]![0]!.question).toContain('toca el calculo de impuestos')
    await step($)
    expect(seen.steps[0]).toEqual({ model: OPUS, effort: 'xhigh', agentId: undefined })
    expect(seen.stored()[0]).toMatchObject({ how: 'aceptada', type: 'critica', recommended: { model: 'opus', effort: 'xhigh' } })
    expect(seen.classified).toHaveLength(0)
  })

  test('los subagentes que decide el modelo se aplican al crearlos', async ($, on) => {
    const seen = world(on, { complete: reply({ subagentes: { modelo: 'sonnet', effort: 'medium' } }) })
    await start($)
    await submit($, 'revisa el modulo de bancos')
    await spawn($)
    expect(seen.spawns[0]).toEqual({ model: SONNET, permissionMode: 'auto' })
  })

  test('en lo ambiguo el modelo decide si es tarea nueva', async ($, on) => {
    const seen = world(on, { complete: request => (request.prompt.includes(LONG) ? reply({ nueva: false })() : reply({})()) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await submit($, LONG)
    expect(seen.asked).toHaveLength(1)
    expect(seen.classified).toHaveLength(0)
  })

  test('una continuacion clara no gasta una llamada', async ($, on) => {
    const seen = world(on, { complete: reply({}) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await submit($, 'dale')
    expect(seen.completed).toHaveLength(1)
  })

  test('una respuesta que no se entiende cae a los patrones', async ($, on) => {
    const seen = world(on, { complete: () => 'no se' })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'low', agentId: undefined })
  })

  test('un modelo o effort que no existe cae a los patrones', async ($, on) => {
    const seen = world(on, { complete: reply({ modelo: 'gpt', effort: 'ultra' }) })
    await start($)
    await submit($, 'explica como funciona la conciliacion bancaria')
    await step($)
    expect(seen.steps[0]).toEqual({ model: SONNET, effort: 'low', agentId: undefined })
  })

  test('plan mode se ofrece cuando el modelo lo pide, con su motivo', async ($, on) => {
    const seen = world(on, { complete: reply({ plan_mode: true, motivo_plan: 'hay dos formas de resolverlo' }) })
    await start($, true, 'default')
    await submit($, 'explica como funciona la conciliacion bancaria')
    expect(seen.asked[0]![0]!.question).toContain('hay dos formas de resolverlo')
    expect(seen.asked[0]![0]!.options[0]!.label).toContain('plan mode')
  })
})
