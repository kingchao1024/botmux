import {
  DEFAULT_HUMAN_GATE_OPTIONS,
  type V3HumanGate,
  type V3WriteExecutionBinding,
} from './dag.js';

export interface NormalizedGatePolicy {
  prompt: string;
  options: string[];
  approveOptions: string[];
  approvers: string[];
  writeExecution?: V3WriteExecutionBinding;
}

function writeExecutionPrompt(gate: V3HumanGate): string {
  if (!gate.writeExecution) return gate.prompt;
  return `${gate.prompt}\n\nOne-time write execution (exact binding):\n\`\`\`json\n${JSON.stringify(gate.writeExecution, null, 2)}\n\`\`\``;
}

/** Normalize authored gate defaults without requiring a persistence adapter. */
export function normalizeGateWaitInput(gate: V3HumanGate): NormalizedGatePolicy {
  const options = gate.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  return {
    prompt: writeExecutionPrompt(gate),
    options,
    approveOptions: gate.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]),
    approvers: gate.approvers ?? [],
    ...(gate.writeExecution ? { writeExecution: gate.writeExecution } : {}),
  };
}

export function selectedResolution(
  wait: Pick<NormalizedGatePolicy, 'options' | 'approveOptions'>,
  selected: string,
): 'approved' | 'rejected' | undefined {
  if (!wait.options.includes(selected)) return undefined;
  return wait.approveOptions.includes(selected) ? 'approved' : 'rejected';
}

export function canResolveGateWait(
  wait: Pick<NormalizedGatePolicy, 'approvers'>,
  by: string | undefined,
): boolean {
  return wait.approvers.length === 0 || (!!by && wait.approvers.includes(by));
}
