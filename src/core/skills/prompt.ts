import type { SessionSkillManifest } from './types.js';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function compactSkillTriggerSummary(description: string): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  const firstSentence = normalized.match(/^[\s\S]*?(?:[。！？]|[.!?](?=\s|$))/)?.[0];
  return firstSentence ?? normalized;
}

export function renderSkillCatalogBlock(
  manifest: SessionSkillManifest | null | undefined,
  opts: { compact?: boolean } = {},
): string {
  if (!manifest || manifest.prioritySkills.length === 0) return '';
  if (opts.compact) {
    const skills = manifest.prioritySkills.map((skill) => {
      const tags = skill.tags.length > 0 ? ` tags="${xmlEscape(skill.tags.join(','))}"` : '';
      const trigger = skill.description
        ? ` trigger="${xmlEscape(compactSkillTriggerSummary(skill.description))}"`
        : '';
      return `  <skill name="${xmlEscape(skill.name)}"${tags}${trigger} />`;
    });
    return [
      `<botmux_skills mode="${manifest.policyMode}">`,
      '  <instruction>Trigger index; run `botmux skill show <name>` before use.</instruction>',
      ...skills,
      '</botmux_skills>',
    ].join('\n');
  }
  const skills = manifest.prioritySkills.map((skill) => {
    const tags = skill.tags.length > 0 ? ` tags="${xmlEscape(skill.tags.join(','))}"` : '';
    const descriptionText = skill.description ?? '';
    const description = descriptionText
      ? `\n    <description>${xmlEscape(descriptionText)}</description>`
      : '';
    return `  <skill name="${xmlEscape(skill.name)}"${tags}>${description}\n    <read>botmux skill show ${xmlEscape(skill.name)}</read>\n  </skill>`;
  });
  return [
    `<botmux_skills mode="${manifest.policyMode}">`,
    '  <instruction>Before using any task tool, compare the request with every description below; you must read every matching skill entrypoint with `botmux skill show <name>`, follow its instructions, and use `botmux skill read <name> <relative-path>` for referenced files. Keep this preflight separate from task work and stop if a required read fails. Do not bulk-read unmatched skills.</instruction>',
    ...skills,
    '</botmux_skills>',
  ].join('\n');
}
