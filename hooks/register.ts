import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  TaskPlannerConfig as Config,
  TaskPlannerEffort as Effort,
  TaskPlannerModel as Model,
  TaskPlannerSession as Session,
} from '../types'
import {
  alternatives,
  applied,
  buildPlan,
  cost,
  describe,
  detectTask,
  emptyOutcome,
  matchType,
  modelFor,
  normalize,
  parseCustom,
  parseReasoned,
  report,
  summarize,
  typeByLabel,
} from './planner'
import { GUIDE, reasonPrompt } from './guide'
import type { Decision, How, Plan, Reasoned } from './planner'
import { CLASSIFIER_MODEL, EFFORTS, MODELS, NEW_TASK, PLAN, REASONER, SUBAGENTS, TASK_TYPES } from './rules'

type Engine = EngineInterface

/** `plan`: the person took the option that starts in plan mode. */
type Picked = { config: Config | null; how: How; plan?: boolean }

const session = atom({ plugin: 'task-planner', key: 'session' } as const, {
  fresh: true,
  interactive: true,
  skipNext: false,
  active: null,
  decisionId: null,
  planMode: false,
  pending: null,
} as Session)

const DECISIONS = 'decisions'
const KEPT = 300
const MORE = 'Mas opciones: personalizar o dejar como esta (Esc)'
const CUSTOM = 'Personalizar'
const KEEP = 'Dejar como esta'
const UNCHANGED = 'Sin cambio'
const NO_SUBAGENTS = 'Sin subagentes'
const KEEP_PICK: Picked = { config: null, how: 'sin cambios' }

const TAGS: Record<How, string> = {
  aceptada: 'recomendado',
  cambiada: 'alternativa',
  personalizada: 'personalizado',
  'sin cambios': 'dejar como esta',
  automatica: 'recomendacion aplicada sin preguntar',
}

/**
 * The engine's own dialog, which takes 2-4 labels and adds a free-text Other.
 * Undefined when the person dismissed it or nobody could be asked.
 */
const ask = async ($: Engine, question: string, header: string, labels: readonly string[]): Promise<string | undefined> => {
  try {
    return await $.ui.ask(question, { options: labels, header })
  } catch (error) {
    $.ui.log(`task-planner: chooser: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

const modelByLabel = (label: string | undefined): Model | undefined =>
  (Object.keys(MODELS) as Model[]).find(key => MODELS[key].label === label)

const first = <T,>(preferred: T | undefined, all: readonly T[]): T[] =>
  preferred === undefined ? [...all] : [preferred, ...all.filter(item => item !== preferred)]

/** Model, effort and subagents, one dialog each; dismissing any leaves everything as it is. */
const customize = async ($: Engine, plan: Plan): Promise<Picked> => {
  const labels = (Object.keys(MODELS) as Model[]).map(key => MODELS[key].label)
  const model = await ask($, '¿En que modelo corre el hilo principal?', 'Modelo', [
    ...first(plan.rec.model && MODELS[plan.rec.model].label, labels),
    UNCHANGED,
  ])
  if (model === undefined) return KEEP_PICK
  const level = EFFORTS.indexOf(plan.rec.effort ?? 'medium')
  // Four options at most: the four levels nearest the recommendation; the fifth is typed.
  const efforts = level >= 3 ? EFFORTS.slice(1) : EFFORTS.slice(0, 4)
  const effort = await ask($, `¿Con que effort? (${EFFORTS.join(', ')}: el que no este se escribe)`, 'Effort', first(plan.rec.effort, efforts))
  if (effort === undefined) return KEEP_PICK
  const subagents = await ask(
    $,
    '¿Subagentes? Con ellos Claude reparte el trabajo en partes independientes.',
    'Subagentes',
    first(plan.rec.sub ? MODELS[plan.rec.sub.model].label : NO_SUBAGENTS, [NO_SUBAGENTS, ...labels]),
  )
  if (subagents === undefined) return KEEP_PICK
  const config: Config = {}
  const main = modelByLabel(model)
  if (main) config.model = main
  const picked = EFFORTS.find(e => e === effort.trim().toLowerCase())
  if (picked) config.effort = picked
  const sub = modelByLabel(subagents)
  if (sub) config.sub = { model: sub }
  return config.model || config.effort || config.sub ? { config, how: 'personalizada' } : KEEP_PICK
}

/** `offerPlan`: false where plan mode is already on or no prompt can be handed back. */
const choose = async ($: Engine, plan: Plan, offerPlan: boolean): Promise<Picked> => {
  const options = alternatives(plan.rec).map(a => ({ ...a, label: `${describe(a.config)} · ${cost(a.config)} · ${a.note}` }))
  const withPlan = offerPlan && plan.planReason !== null
  // The dialog takes four labels: with plan mode on offer, the same configuration without it takes one.
  const shown = options.slice(0, withPlan ? 1 : 2)
  const base = `${describe(plan.rec, plan.unit)} · ${cost(plan.rec)}`
  const recommended = withPlan ? `${base} + plan mode (recomendado)` : `${base} (recomendado)`
  const plain = `${base} · sin plan mode`
  const answer = await ask(
    $,
    `Tarea nueva: «${plan.summary}». Recomiendo ${describe(plan.rec, plan.unit)}: ${plan.reason}.${
      withPlan ? ` Recomiendo empezar en plan mode: ${plan.planReason}.` : ''
    } ¿Como la corro?`,
    'Tarea',
    [recommended, ...(withPlan ? [plain] : []), ...shown.map(a => a.label), MORE],
  )
  if (answer === undefined) return KEEP_PICK
  if (answer === recommended) return { config: plan.rec, how: 'aceptada', plan: withPlan }
  if (withPlan && answer === plain) return { config: plan.rec, how: 'aceptada' }
  const alternative = shown.find(a => a.label === answer)
  if (alternative) return { config: alternative.config, how: 'cambiada' }
  if (answer !== MORE) {
    const typed = parseCustom(answer)
    return typed ? { config: typed, how: 'personalizada' } : KEEP_PICK
  }
  const rest = options.slice(shown.length, shown.length + 2)
  const second = await ask($, `¿Que prefieres para «${plan.summary}»?`, 'Tarea', [CUSTOM, KEEP, ...rest.map(a => a.label)])
  if (second === CUSTOM) return customize($, plan)
  const extra = rest.find(a => a.label === second)
  return extra ? { config: extra.config, how: 'cambiada' } : KEEP_PICK
}

/** The model reads the task against the guide; undefined when it gave nothing usable. */
const reason = async ($: Engine, text: string, isFirst: boolean): Promise<Reasoned | undefined> => {
  try {
    const reply = await $.model.complete({
      model: REASONER.model,
      system: GUIDE,
      prompt: reasonPrompt(text, { isFirst }),
      effort: REASONER.effort,
      maxTokens: REASONER.maxTokens,
      timeoutMs: REASONER.timeoutMs,
    })
    return reply.isAnswered ? parseReasoned(reply.text, text) : undefined
  } catch {
    return undefined
  }
}

/** Where the model gave nothing: the patterns, then the classifier among their labels. */
const planByRules = async ($: Engine, text: string): Promise<Plan> => {
  const matched = matchType(text)
  if (matched) return buildPlan(text, matched)
  let label: string | undefined
  try {
    label = await $.model.classify(text, TASK_TYPES.map(t => t.label), { model: CLASSIFIER_MODEL })
  } catch {
    label = undefined
  }
  return buildPlan(text, typeByLabel(label))
}

const canAsk = async ($: Engine, state: Session): Promise<boolean> => {
  if (!state.interactive) return false
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return false
  }
}

const decisions = async ($: Engine): Promise<Decision[]> => {
  const stored = await $.store.get(DECISIONS)
  return Array.isArray(stored) ? (stored as Decision[]) : []
}

/** Whether the prompt handed back for plan mode came back in plan mode. */
const markEntered = async ($: Engine, id: string, entered: boolean): Promise<void> => {
  const all = await decisions($)
  const decision = all.find(d => d.id === id)
  if (!decision?.plan) return
  decision.plan.entered = entered
  await $.store.set(DECISIONS, all)
}

const noteMode = async ($: Engine, reported: string | undefined): Promise<void> => {
  if (reported !== undefined) await update($, session, s => ({ ...s, planMode: reported === 'plan' }))
}

/** Applies the pick to the session's task, records the decision, leaves the line. */
const settle = async ($: Engine, plan: Plan, picked: Picked, previous: Session, planOffered = false): Promise<void> => {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let current = ''
  try {
    current = await $.session.model()
  } catch {
    current = ''
  }
  const before = previous.active?.model ? MODELS[previous.active.model].id : current
  const modelChanged = before !== '' && modelFor(picked.config?.model, before) !== undefined
  await update($, session, s => ({ ...s, fresh: false, active: picked.config, decisionId: id }))
  const decision: Decision = {
    id,
    date: new Date().toISOString(),
    type: plan.type.id,
    summary: plan.summary,
    recommended: plan.rec,
    chosen: picked.config,
    how: picked.how,
    outcome: emptyOutcome(),
    ...(planOffered ? { plan: { chosen: picked.plan === true, entered: false } } : {}),
  }
  await $.store.set(DECISIONS, [...(await decisions($)), decision].slice(-KEPT))
  $.ui.log(applied(picked.config, TAGS[picked.how], modelChanged) + (picked.plan ? ' · empieza en plan mode' : ''))
}

const instructionFor = (config: Config | null): string | undefined =>
  config?.sub ? SUBAGENTS.instruction(MODELS[config.sub.model].label) : undefined

const answersQuestion = async ($: Engine): Promise<boolean> => {
  try {
    const messages = (await $.session.messages()) as readonly { role: string; text: string }[]
    const last = [...messages].reverse().find(m => m.role === 'assistant')
    return last !== undefined && last.text.trim().endsWith('?')
  } catch {
    return false
  }
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'preguntar')
  if (mode === 'desactivado') return

  /** Subagents whose model this mod set, and the effort their requests take. */
  const efforts = new Map<string, Effort>()
  let spawned = 0
  /** What the prompt footer last showed, once it has shown plan mode at all: it is live, the classic events are not. */
  let footerPlan: boolean | undefined
  const sawFooter = (text: string): void => {
    if (PLAN.footer.test(text)) footerPlan = true
    else if (footerPlan !== undefined) footerPlan = false
  }
  const inPlanMode = (state: Session): boolean => footerPlan ?? state.planMode
  /** The decision whose resent prompt is entering: its mode is read off the UserPromptSubmit that follows. */
  let resent: string | null = null

  // The engine reports the permission mode on its classic events; the mod only reads it.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.permission_mode !== undefined) footerPlan = undefined
    await noteMode($, e.permission_mode)
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    if (e.permission_mode !== undefined) footerPlan = undefined
    await noteMode($, e.permission_mode)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode !== undefined) footerPlan = undefined
    await noteMode($, e.permission_mode)
    if (resent !== null && e.permission_mode !== undefined) await markEntered($, resent, e.permission_mode === 'plan')
    resent = null
    return next(e)
  })
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    sawFooter(e.props.hint)
    return next(e)
  })
  on('ui.render', { component: 'SessionMode' }, ($, e, next) => {
    sawFooter(e.props.modes.join(' '))
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await update($, session, s => ({ ...s, interactive: e.isInteractive }))
    await $.command.register({
      name: 'tarea',
      description: 'Abre el chooser de task-planner: modelo, effort y subagentes para la tarea',
      argumentHint: '[descripcion de la tarea]',
    })
    await $.command.register({
      name: 'tareas',
      description: 'Resumen de task-planner por tipo de tarea: recomendado, aceptado, cambiado',
    })
    return next(e)
  })

  // A /clear ends the conversation with no session.start after it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      efforts.clear()
      await update($, session, s => ({ ...s, fresh: true, skipNext: false, active: null, decisionId: null, pending: null }))
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const text = e.text.trim()
    // Typed over a running turn, a notification, a schedule, another session
    // or a command: never a moment to ask.
    const isCandidate =
      e.turnId === undefined && (kind === 'composer' || kind === 'bridge' || kind === 'sdk') && text !== '' && !text.startsWith('/')
    if (!isCandidate) return next(e)

    let instruction: string | undefined
    try {
      const state = await read($, session)
      if (state.pending !== null) {
        await update($, session, s => ({ ...s, pending: null }))
        // The prompt handed back to the box, sent again: the choice is made, nothing is asked.
        if (normalize(state.pending.text) === normalize(text)) {
          if (state.decisionId !== null) {
            resent = state.decisionId
            await markEntered($, state.decisionId, inPlanMode(state))
          }
          const kept = instructionFor(state.active)
          return kept === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), kept] })
        }
      }
      if (state.skipNext) {
        await update($, session, s => ({ ...s, skipNext: false, fresh: false }))
        return next(e)
      }
      let verdict = detectTask(text, { fresh: state.fresh, answersQuestion: state.fresh ? false : await answersQuestion($) })
      if (verdict === 'continuation') return next(e)
      const reasoned = await reason($, text, state.fresh)
      if (verdict === 'ambiguous') {
        if (reasoned) {
          verdict = reasoned.isNew ? 'new' : 'continuation'
        } else {
          const label = await $.model.classify(text, [NEW_TASK.labels.new, NEW_TASK.labels.continuation], { model: CLASSIFIER_MODEL })
          verdict = label === NEW_TASK.labels.new ? 'new' : 'continuation'
        }
      }
      if (verdict !== 'new') return next(e)

      const plan = reasoned?.plan ?? (await planByRules($, text))
      const isAsked = mode === 'preguntar' && kind !== 'sdk' && (await canAsk($, state))
      const offerPlan = isAsked && !inPlanMode(state)
      const picked: Picked = isAsked ? await choose($, plan, offerPlan) : { config: plan.rec, how: 'automatica' }
      // The prompt goes back to the box only once the box holds it: nothing typed is ever lost.
      const isHandedBack = picked.plan === true && (await $.prompt.fill({ text: e.text, mode: 'replace' })).isFilled
      if (!isHandedBack) picked.plan = false
      await settle($, plan, picked, state, offerPlan && plan.planReason !== null)
      if (isHandedBack) {
        await update($, session, s => ({ ...s, pending: { text } }))
        return { drop: PLAN.notice }
      }
      instruction = instructionFor(picked.config)
    } catch (error) {
      // The prompt always goes through; a planner that failed changes nothing.
      $.ui.log(`task-planner: ${String(error)}`, { to: 'debug' })
    }
    return instruction === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), instruction] })
  })

  on('turn.step', async function* ($, e, next) {
    const { active } = await read($, session)
    if (e.agentId !== undefined) {
      const effort = efforts.get(e.agentId)
      return yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort })
    }
    if (active === null) return yield* next(e)
    const model = modelFor(active.model, e.model)
    const effort = active.effort !== undefined && active.effort !== e.effort ? active.effort : undefined
    if (model === undefined && effort === undefined) return yield* next(e)
    return yield* next({ ...e, model: model ?? e.model, effort: effort ?? e.effort })
  })

  on('agent.spawn', async ($, e, next) => {
    const { active } = await read($, session)
    // A fork inherits its parent's model whatever is asked.
    if (!active?.sub || e.fork) return next(e)
    const started = await next({ ...e, model: MODELS[active.sub.model].id })
    if (started.deny === undefined) {
      spawned += 1
      if (started.agentId !== undefined && active.sub.effort !== undefined) {
        efforts.set(started.agentId, active.sub.effort)
      }
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      efforts.delete(e.agentId)
      return next(e)
    }
    try {
      const { decisionId } = await read($, session)
      const all = await decisions($)
      const decision = all.find(d => d.id === decisionId)
      if (decision) {
        const o = decision.outcome
        o.turns += 1
        o.answered += e.reason === 'answer' ? 1 : 0
        o.aborted += e.reason === 'aborted' ? 1 : 0
        o.errors += e.reason === 'error' || e.reason === 'refusal' ? 1 : 0
        o.durationMs += e.durationMs
        o.outputTokens += e.usage?.output_tokens ?? 0
        o.subagents += spawned
        spawned = 0
        await $.store.set(DECISIONS, all)
      }
    } catch (error) {
      $.ui.log(`task-planner: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'tareas' }, async $ => ({ text: report(await decisions($)) }))

  on('command.run', { command: 'tarea' }, async ($, e) => {
    const state = await read($, session)
    let text = e.args.trim()
    if (text === '') {
      try {
        const messages = (await $.session.messages()) as readonly { role: string; text: string }[]
        text = [...messages].reverse().find(m => m.role === 'user' && m.text.trim() !== '')?.text.trim() ?? ''
      } catch {
        text = ''
      }
    }
    if (text === '') return { text: 'task-planner: escribe la tarea, /tarea <descripcion>.' }
    const plan = (await reason($, text, state.fresh))?.plan ?? (await planByRules($, text))
    const picked: Picked = (await canAsk($, state)) ? await choose($, plan, false) : { config: plan.rec, how: 'automatica' }
    await settle($, plan, picked, state)
    // With a description, the prompt that follows is this same task.
    if (e.args.trim() !== '') await update($, session, s => ({ ...s, skipNext: true }))
    const instruction = instructionFor(picked.config)
    return {
      text: `task-planner: «${summarize(text)}» queda configurada.`,
      ...(instruction === undefined ? {} : { context: [instruction] }),
    }
  })
}
