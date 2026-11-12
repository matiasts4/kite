import type { AgentProfile } from '../../types';
import type {
  AgentMindSnapshot,
  LearnedSkillDocument,
  StarterSummary,
} from '../../components/views/agents/types';
import { invokeCommand } from './core';

export async function listAgents(): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('list_agent_profiles');
}

export async function setAgentPinned(agentId: string, pinned: boolean): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('set_agent_pinned', { agentId, pinned });
}

export async function moveAgent(agentId: string, toIndex: number): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('move_agent', { supportedSchemaVersion: 1, agentId, toIndex });
}

export async function deleteAgentProfile(agentId: string): Promise<void> {
  return invokeCommand<void>('delete_agent_profile', { supportedSchemaVersion: 1, agentId });
}

export async function updateAgentProfile(
  agentId: string,
  name: string,
  brief: string,
  engine?: string
): Promise<AgentProfile> {
  return invokeCommand<AgentProfile>('update_agent_profile', {
    agentId,
    name,
    brief,
    engine,
  });
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('list_agent_profiles');
}

export async function loadAgentMind(agentId: string): Promise<AgentMindSnapshot> {
  return invokeCommand<AgentMindSnapshot>('load_agent_mind', { agentId });
}

export async function writeAgentMemory(
  agentId: string,
  target: 'memory' | 'user',
  text: string,
  editKind = 'structured',
  expectedRevision: string | null = null,
  confirmedByBuilder = true
): Promise<AgentMindSnapshot> {
  return invokeCommand<AgentMindSnapshot>('write_agent_memory', {
    agentId,
    target,
    text,
    editKind,
    expectedRevision,
    confirmedByBuilder,
  });
}

export async function loadAgentSkill(agentId: string, skillId: string): Promise<LearnedSkillDocument> {
  return invokeCommand<LearnedSkillDocument>('load_agent_skill', { agentId, skillId });
}

export async function writeAgentSkill(
  agentId: string,
  skillId: string,
  source: string,
  expectedRevision: string,
  confirmedByBuilder = true
): Promise<AgentMindSnapshot> {
  return invokeCommand<AgentMindSnapshot>('write_agent_skill', {
    agentId,
    skillId,
    source,
    expectedRevision,
    confirmedByBuilder,
  });
}

export async function removeAgentSkill(
  agentId: string,
  skillId: string,
  expectedRevision: string,
  confirmedByBuilder = true
): Promise<{ removed: boolean; mind: AgentMindSnapshot }> {
  return invokeCommand<{ removed: boolean; mind: AgentMindSnapshot }>('remove_agent_skill', {
    agentId,
    skillId,
    expectedRevision,
    confirmedByBuilder,
  });
}

export async function listAgentStarters(supportedCatalogVersion = 1): Promise<StarterSummary[]> {
  return invokeCommand<StarterSummary[]>('list_agent_starters', { supportedCatalogVersion });
}

export async function installAgentStarter(
  agentId: string,
  starterId: string,
  confirmedByBuilder = true
): Promise<{ installed: boolean; mind: AgentMindSnapshot }> {
  return invokeCommand<{ installed: boolean; mind: AgentMindSnapshot }>('install_agent_starter', {
    agentId,
    starterId,
    confirmedByBuilder,
  });
}
