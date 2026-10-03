export type TaskPlannerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type TaskPlannerModel = 'opus' | 'sonnet'

/** What the mod applies to a task. A field left out stays as the session has it. */
export type TaskPlannerConfig = {
  model?: TaskPlannerModel
  effort?: TaskPlannerEffort
  sub?: { model: TaskPlannerModel; effort?: TaskPlannerEffort }
}

export type TaskPlannerSession = {
  /** True until the first prompt of the session, and again after a /clear. */
  fresh: boolean
  interactive: boolean
  /** Set by /tarea: the next prompt belongs to the task just configured. */
  skipNext: boolean
  /** The running task's choice; null leaves everything as the session has it. */
  active: TaskPlannerConfig | null
  decisionId: string | null
  /** The permission mode the engine last reported was `plan`. */
  planMode: boolean
  /** A prompt handed back to the box so the person can switch to plan mode and send it again. */
  pending: { text: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'task-planner': { session: TaskPlannerSession }
  }
}
