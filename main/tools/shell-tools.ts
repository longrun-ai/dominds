import type { Team } from '../team';

export const SHELL_TOOL_NAMES = ['shell_cmd', 'stop_daemon', 'get_daemon_output'] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

export function isShellToolName(name: string): name is ShellToolName {
  return (SHELL_TOOL_NAMES as readonly string[]).includes(name);
}

export function listShellSpecialistMemberIds(team: Team): string[] {
  const out: string[] = [];
  for (const id of team.shellSpecialists) {
    const member = team.getMember(id);
    if (!member) continue;
    if (member.hidden === true) continue;
    out.push(id);
  }
  return out;
}
