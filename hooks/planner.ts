// Logica pura de task-planner: no llama al motor. Todo lo que decide sale de
// rules.ts; register.ts le pone alrededor los hooks y el chooser.
import type {
  TaskPlannerConfig as Config,
  TaskPlannerEffort as Effort,
  TaskPlannerModel as Model,
} from '../types'
import {
  CONTINUATION,
  COST,
  DEFAULT_TYPE,
  EFFORTS,
  MODELS,
  NEW_TASK,
  PLAN,
  SUBAGENTS,
  TASK_TYPES,
} from './rules'
import type { TaskType } from './rules'

export type Plan = {
  type: TaskType
  summary: string
  rec: Config
  reason: string
  /** "por servicio", "por modulo"... o "" */
  unit: string
  /** Por que conviene empezar en plan mode; null cuando no conviene. */
  planReason: string | null
}

export type Alternative = { config: Config; note: string }

export type How = 'aceptada' | 'cambiada' | 'personalizada' | 'sin cambios' | 'automatica'

export type Outcome = {
  turns: number
  answered: number
  aborted: number
  errors: number
  durationMs: number
  outputTokens: number
  subagents: number
}

export type Decision = {
  id: string
  date: string
  type: string
  summary: string
  recommended: Config
  /** null: "Dejar como esta". */
  chosen: Config | null
  how: How
  outcome: Outcome
  /** Solo cuando el chooser recomendo plan mode: si se eligio y si el prompt volvio en plan mode. */
  plan?: { chosen: boolean; entered: boolean }
}

export const emptyOutcome = (): Outcome => ({
  turns: 0,
  answered: 0,
  aborted: 0,
  errors: 0,
  durationMs: 0,
  outputTokens: 0,
  subagents: 0,
})

export const normalize = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const words = (text: string): number => (text === '' ? 0 : text.split(' ').length)

export const summarize = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export type Verdict = 'new' | 'continuation' | 'ambiguous'

/** Tarea nueva, continuacion, o ambiguo (lo decide el clasificador). */
export const detectTask = (
  text: string,
  context: { fresh: boolean; answersQuestion: boolean },
): Verdict => {
  if (context.fresh) return 'new'
  const n = normalize(text)
  const count = words(n)
  if (CONTINUATION.starts.test(n)) return 'continuation'
  if (context.answersQuestion && count < CONTINUATION.maxAnswerWords) return 'continuation'
  if (count < CONTINUATION.maxShortWords) return 'continuation'
  if (NEW_TASK.patterns.some(p => p.test(n))) return 'new'
  if (CONTINUATION.refs.test(n)) return 'continuation'
  return count >= NEW_TASK.minWordsAmbiguous ? 'ambiguous' : 'continuation'
}

/** El tipo que las reglas reconocen, o undefined cuando ninguna coincide. */
export const matchType = (text: string): TaskType | undefined => {
  const n = normalize(text)
  return TASK_TYPES.find(t => t.patterns.some(p => p.test(n)) && !t.unless?.test(n))
}

export const typeByLabel = (label: string | undefined): TaskType =>
  TASK_TYPES.find(t => t.label === label) ??
  TASK_TYPES.find(t => t.id === DEFAULT_TYPE) ??
  TASK_TYPES[0]!

/** El motivo para empezar en plan mode, o null cuando la tarea no es compleja. */
export const planReason = (text: string, type: TaskType): string | null => {
  const n = normalize(text)
  if (PLAN.neverTypes.includes(type.id) || PLAN.never.test(n)) return null
  const reasons = PLAN.signals.filter(s => s.pattern.test(n)).map(s => s.reason)
  const own = PLAN.types[type.id]
  if (own !== undefined && reasons.length < PLAN.maxReasons) reasons.unshift(own)
  return reasons.length === 0 ? null : reasons.slice(0, PLAN.maxReasons).join(' y ')
}

export const buildPlan = (text: string, type: TaskType): Plan => {
  const n = normalize(text)
  const rec: Config = { model: type.model, effort: type.effort }
  let reason = type.reason
  let unit = ''
  if (SUBAGENTS.when.some(p => p.test(n)) && !SUBAGENTS.never.test(n)) {
    const closed = SUBAGENTS.closedSpec.test(n)
    rec.sub =
      closed && type.subagents.model !== 'sonnet'
        ? { model: 'sonnet', effort: SUBAGENTS.closedSpecEffort }
        : { ...type.subagents }
    unit = SUBAGENTS.units.find(u => u.pattern.test(n))?.label ?? ''
    reason += `; ${SUBAGENTS.reason}${closed ? ` y ${SUBAGENTS.closedSpecReason}` : ''}`
  }
  return { type, summary: summarize(text), rec, reason, unit, planReason: planReason(text, type) }
}

export type Reasoned = { isNew: boolean; plan: Plan }

const asModel = (value: unknown): Model | undefined =>
  (Object.keys(MODELS) as Model[]).find(key => key === value)

const asEffort = (value: unknown): Effort | undefined => EFFORTS.find(e => e === value)

/** La respuesta del modelo que razona (guide.ts), o undefined si no se entiende. */
export const parseReasoned = (reply: string, text: string): Reasoned | undefined => {
  const from = reply.indexOf('{')
  const to = reply.lastIndexOf('}')
  if (from < 0 || to <= from) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(reply.slice(from, to + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const model = asModel(raw.modelo)
  const effort = asEffort(raw.effort)
  const reason = typeof raw.motivo === 'string' ? raw.motivo.trim().replace(/\.$/, '') : ''
  if (!model || !effort || reason === '') return undefined
  const rec: Config = { model, effort }
  const sub = raw.subagentes as Record<string, unknown> | null | undefined
  const subModel = sub ? asModel(sub.modelo) : undefined
  if (subModel) {
    const subEffort = asEffort(sub?.effort)
    rec.sub = subEffort ? { model: subModel, effort: subEffort } : { model: subModel }
  }
  const planReason = typeof raw.motivo_plan === 'string' ? raw.motivo_plan.trim().replace(/\.$/, '') : ''
  const n = normalize(text)
  return {
    isNew: raw.nueva === true,
    plan: {
      type: TASK_TYPES.find(t => t.id === raw.tipo) ?? typeByLabel(undefined),
      summary: summarize(text),
      rec,
      reason,
      unit: rec.sub ? (SUBAGENTS.units.find(u => u.pattern.test(n))?.label ?? '') : '',
      planReason: raw.plan_mode === true ? planReason || 'la tarea es grande o admite mas de un enfoque' : null,
    },
  }
}

export const describe = (config: Config | null, unit = ''): string => {
  if (config === null) return 'sin cambios'
  const main = [config.model ? MODELS[config.model].label : 'modelo actual', config.effort ?? 'effort actual'].join(' ')
  if (!config.sub) return main
  return `${main} con subagentes ${MODELS[config.sub.model].label}${unit ? ` ${unit}` : ''}`
}

/** La linea que queda en la transcripcion. */
export const applied = (config: Config | null, tag: string, modelChanged: boolean): string => {
  if (config === null) return `Tarea sin cambios de modelo ni effort (${tag})`
  const main = [config.model ? MODELS[config.model].label : 'modelo actual', config.effort ?? 'effort actual'].join(' ')
  const sub = config.sub ? `, subagentes en ${MODELS[config.sub.model].label}` : ''
  const note = modelChanged ? ' · cambia el modelo: el cache del prompt se reconstruye' : ''
  return `Tarea en ${main}${sub} (${tag})${note}`
}

export const cost = (config: Config): string => {
  const level =
    COST.model[config.model ?? 'opus'] +
    COST.effort[config.effort ?? 'medium'] +
    (config.sub ? COST.subagents : 0)
  return '$'.repeat(Math.min(4, Math.max(1, level)))
}

const same = (a: Config, b: Config): boolean =>
  a.model === b.model && a.effort === b.effort && a.sub?.model === b.sub?.model

/** Mas cara primero; la misma sin subagentes cuando la recomendacion los usa; luego mas barata. */
export const alternatives = (rec: Config): Alternative[] => {
  const level = EFFORTS.indexOf(rec.effort ?? 'medium')
  const found: Alternative[] = []
  if (rec.model === 'sonnet') {
    found.push({ config: { ...rec, model: 'opus' }, note: 'mas caro: Opus en lugar de Sonnet' })
  } else if (level < EFFORTS.length - 1) {
    found.push({ config: { ...rec, effort: EFFORTS[level + 1] }, note: 'mas caro: mas effort' })
  }
  if (rec.sub) {
    found.push({ config: { model: rec.model, effort: rec.effort }, note: 'la misma configuracion sin subagentes' })
  }
  if (level > 0) {
    found.push({ config: { ...rec, effort: EFFORTS[level - 1] }, note: 'mas barato: menos effort' })
  } else if (rec.model === 'opus') {
    found.push({ config: { ...rec, model: 'sonnet', effort: 'medium' }, note: 'mas barato: Sonnet en lugar de Opus' })
  }
  return found.filter((a, i) => !same(a.config, rec) && found.findIndex(b => same(a.config, b.config)) === i)
}

const modelIn = (text: string): Model | undefined =>
  (Object.keys(MODELS) as Model[]).find(key => text.includes(key))

/**
 * Lo que la persona escribe en "Other": "sonnet high", "opus xhigh sub sonnet",
 * "dejar". null es dejar como esta; undefined, no se entendio.
 */
export const parseCustom = (text: string): Config | null | undefined => {
  const n = normalize(text)
  if (/^(dejar|nada|ninguno|igual|sin cambio)/.test(n)) return null
  const subMatch = /(sin )?sub\w*( en| con)? ?(\w+)?/.exec(n)
  const main = subMatch ? n.replace(subMatch[0], ' ') : n
  const config: Config = {}
  const model = modelIn(main)
  if (model) config.model = model
  const effort = EFFORTS.find(e => new RegExp(`\\b${e}\\b`).test(main))
  if (effort) config.effort = effort
  if (subMatch && !subMatch[1]) {
    const sub = modelIn(subMatch[3] ?? '')
    if (sub) config.sub = { model: sub }
  }
  return config.model || config.effort || config.sub ? config : undefined
}

/** El modelo que hay que nombrar en la peticion, o undefined si ya corre en esa familia. */
export const modelFor = (wanted: Model | undefined, current: string): string | undefined =>
  wanted === undefined || MODELS[wanted].match.test(current) ? undefined : MODELS[wanted].id

const count = <T,>(items: readonly T[], key: (item: T) => string): [string, number][] => {
  const tally = new Map<string, number>()
  for (const item of items) tally.set(key(item), (tally.get(key(item)) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1])
}

/** El resumen de /tareas. */
export const report = (decisions: readonly Decision[]): string => {
  if (decisions.length === 0) return 'task-planner: todavia no hay tareas registradas.'
  const lines = [`task-planner: ${decisions.length} tareas registradas`, '']
  for (const [type] of count(decisions, d => d.type)) {
    const group = decisions.filter(d => d.type === type)
    const label = TASK_TYPES.find(t => t.id === type)?.label ?? type
    const accepted = group.filter(d => d.how === 'aceptada').length
    const automatic = group.filter(d => d.how === 'automatica').length
    const changed = group.filter(d => d.how !== 'aceptada' && d.how !== 'automatica')
    const turns = group.reduce((sum, d) => sum + d.outcome.turns, 0)
    const aborted = group.reduce((sum, d) => sum + d.outcome.aborted, 0)
    const errors = group.reduce((sum, d) => sum + d.outcome.errors, 0)
    const minutes = group.reduce((sum, d) => sum + d.outcome.durationMs, 0) / 60000
    const subagents = group.reduce((sum, d) => sum + d.outcome.subagents, 0)
    lines.push(`${label} (${group.length})`)
    lines.push(`  recomendado: ${count(group, d => describe(d.recommended)).map(([k, n]) => `${k} x${n}`).join(', ')}`)
    lines.push(`  aceptadas: ${accepted} · automaticas: ${automatic} · cambiadas: ${changed.length}`)
    if (changed.length > 0) {
      lines.push(`  cambiadas hacia: ${count(changed, d => describe(d.chosen)).map(([k, n]) => `${k} x${n}`).join(', ')}`)
    }
    const planned = group.filter(d => d.plan !== undefined)
    const entered = planned.filter(d => d.plan?.chosen && d.plan.entered).length
    lines.push(`  plan mode: recomendado ${planned.length} · aceptado ${entered} · ignorado ${planned.length - entered}`)
    lines.push(
      `  como terminaron: ${(turns / group.length).toFixed(1)} turnos por tarea, ${aborted} interrumpidos, ${errors} con error, ${(minutes / group.length).toFixed(1)} min por tarea, ${subagents} subagentes`,
    )
    lines.push('')
  }
  lines.push('Lo que no se mide: si el resultado fue correcto. Interrupciones y turnos por tarea son la senal mas cercana.')
  return lines.join('\n')
}
