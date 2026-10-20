import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createOddTask,
  dispatchPlanToSubagentTerminal,
  listOddTasks,
  updateOddTaskStatus,
  getOddTaskContent,
  buildVerificationPrompt,
  parseMarkdownPlanToOdd,
} from './subagentDispatcher';
import * as ipc from './ipc';

vi.mock('./ipc', () => ({
  invokeCommand: vi.fn(),
}));

describe('subagentDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseMarkdownPlanToOdd', () => {
    it('correctly parses markdown with headers, objective, criteria, and steps', () => {
      const planMarkdown = `
# Autenticación con Cookies HttpOnly

## Objetivo
Reemplazar tokens en localStorage por cookies seguras httpOnly para prevenir robo XSS.

## Especificación técnica
Implementar endpoint /auth/refresh y setear Set-Cookie: token=...; HttpOnly; Secure; SameSite=Strict.

## Restricciones
- No romper retrocompatibilidad con la app móvil.
- Mantener expiración a 15 minutos.

## Pasos de verificación
1. Ejecutar cargo test auth
2. Probar con curl -c cookies.txt

## Criterios de aceptación
- [ ] Cookie httpOnly se emite tras login exitoso
- [ ] Peticiones protegidas rechazan peticiones sin cookie
`;

      const parsed = parseMarkdownPlanToOdd(planMarkdown);
      expect(parsed.title).toBe('Autenticación con Cookies HttpOnly');
      expect(parsed.objective).toContain('Reemplazar tokens en localStorage');
      expect(parsed.constraints.length).toBe(2);
      expect(parsed.constraints[0]).toBe('No romper retrocompatibilidad con la app móvil.');
      expect(parsed.verificationSteps.length).toBe(2);
      expect(parsed.verificationSteps[0]).toBe('Ejecutar cargo test auth');
      expect(parsed.acceptanceCriteria.length).toBe(2);
      expect(parsed.acceptanceCriteria[0]).toBe('Cookie httpOnly se emite tras login exitoso');
    });

    it('falls back to default title if none provided', () => {
      const parsed = parseMarkdownPlanToOdd('Solo texto sin encabezado');
      expect(parsed.title).toBe('Plan de desarrollo');
      expect(parsed.spec).toBe('Solo texto sin encabezado');
    });
  });

  describe('buildVerificationPrompt', () => {
    it('generates a prompt referencing the task file and acceptance checklist', () => {
      const prompt = buildVerificationPrompt('.kite/tasks/login-cookies.md');
      expect(prompt).toContain('.kite/tasks/login-cookies.md');
      expect(prompt).toContain('sección 4');
      expect(prompt).toContain('sección 5');
      expect(prompt).toContain('verified');
    });
  });

  describe('createOddTask', () => {
    it('calls invokeCommand with create_odd_task_file and returns result', async () => {
      const mockResult = {
        success: true,
        slug: 'login-cookies',
        taskFilePath: 'E:/kite/.kite/tasks/login-cookies.md',
        relativePath: '.kite/tasks/login-cookies.md',
        subagentPrompt: 'Desarrolla la tarea ODD...',
      };
      (ipc.invokeCommand as any).mockResolvedValueOnce(mockResult);

      const res = await createOddTask({
        title: 'Login Cookies',
        engine: 'grok',
        objective: 'Set up httpOnly cookies',
        spec: 'Detailed spec',
        constraints: ['No breaking changes'],
        verificationSteps: ['cargo test'],
        acceptanceCriteria: ['Cookies work'],
      });

      expect(ipc.invokeCommand).toHaveBeenCalledWith('create_odd_task_file', {
        title: 'Login Cookies',
        subagentEngine: 'grok',
        objective: 'Set up httpOnly cookies',
        spec: 'Detailed spec',
        constraints: ['No breaking changes'],
        verificationSteps: ['cargo test'],
        acceptanceCriteria: ['Cookies work'],
        slug: undefined,
        cwd: undefined,
      });
      expect(res).toEqual(mockResult);
    });

    it('handles errors gracefully without crashing', async () => {
      (ipc.invokeCommand as any).mockRejectedValueOnce(new Error('Disk full'));

      const res = await createOddTask({
        title: 'Failing Task',
        engine: 'codex',
        objective: '',
        spec: '',
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Disk full');
    });
  });

  describe('dispatchPlanToSubagentTerminal', () => {
    it('creates the task and dispatches the kite:spawn-agent-terminal event', async () => {
      const mockResult = {
        success: true,
        slug: 'subagent-task',
        taskFilePath: 'E:/kite/.kite/tasks/subagent-task.md',
        relativePath: '.kite/tasks/subagent-task.md',
        subagentPrompt: 'Desarrolla la tarea ODD especificada en .kite/tasks/subagent-task.md...',
      };
      (ipc.invokeCommand as any).mockResolvedValueOnce(mockResult);

      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      const res = await dispatchPlanToSubagentTerminal({
        title: 'Subagent Task',
        engine: 'grok',
        objective: 'Objective',
        spec: 'Spec',
        autoApprove: true,
      });

      expect(res.success).toBe(true);
      expect(res.sessionId).toBeDefined();
      expect(dispatchSpy).toHaveBeenCalledTimes(1);

      const dispatchedEvent = dispatchSpy.mock.calls[0][0] as CustomEvent;
      expect(dispatchedEvent.type).toBe('kite:spawn-agent-terminal');
      expect(dispatchedEvent.detail.engine).toBe('grok');
      expect(dispatchedEvent.detail.autoApprove).toBe(true);
      expect(dispatchedEvent.detail.initialPrompt).toContain('.kite/tasks/subagent-task.md');
      expect(dispatchedEvent.detail.taskSlug).toBe('subagent-task');
    });
  });

  describe('task operations: list, update, get', () => {
    it('listOddTasks returns task array', async () => {
      const tasks = [
        {
          slug: 'task-1',
          title: 'Task 1',
          status: 'pending',
          engine: 'grok',
          relative_path: '.kite/tasks/task-1.md',
          total_checks: 2,
          completed_checks: 1,
          modified_at_unix_ms: 1000,
        },
      ];
      (ipc.invokeCommand as any).mockResolvedValueOnce({ tasks });

      const res = await listOddTasks();
      expect(res).toEqual(tasks);
    });

    it('updateOddTaskStatus calls update_odd_task_status', async () => {
      (ipc.invokeCommand as any).mockResolvedValueOnce({
        success: true,
        slug: 'task-1',
        status: 'completed',
      });

      const res = await updateOddTaskStatus('task-1', 'completed');
      expect(res.success).toBe(true);
      expect(ipc.invokeCommand).toHaveBeenCalledWith('update_odd_task_status', {
        slug: 'task-1',
        status: 'completed',
        cwd: undefined,
      });
    });

    it('getOddTaskContent calls get_odd_task_content', async () => {
      (ipc.invokeCommand as any).mockResolvedValueOnce({
        success: true,
        slug: 'task-1',
        content: '# Task 1',
      });

      const res = await getOddTaskContent('task-1');
      expect(res.success).toBe(true);
      expect(res.content).toBe('# Task 1');
    });
  });
});
