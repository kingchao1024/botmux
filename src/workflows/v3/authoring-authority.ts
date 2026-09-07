export const V3_SESSION_RUN_AUTHORING_MUTATIONS = [
  'spec-finalize', 'approve-spec', 'architect', 'approve-dag',
] as const;

export type V3SessionRunAuthoringMutation = typeof V3_SESSION_RUN_AUTHORING_MUTATIONS[number];
export type WorkflowAuthoringActorKind = 'human' | 'bot' | 'scheduled' | 'unknown';

export function isV3SessionRunAuthoringMutation(
  value: string,
): value is V3SessionRunAuthoringMutation {
  return (V3_SESSION_RUN_AUTHORING_MUTATIONS as readonly string[]).includes(value);
}

export function isHumanWorkflowAuthoringActor(kind: WorkflowAuthoringActorKind): boolean {
  return kind === 'human';
}
