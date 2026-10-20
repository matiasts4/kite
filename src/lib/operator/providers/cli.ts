// Kite Code — CLI Subscription Planner Provider
// Invokes local AI subscription CLIs (Grok, Claude, Antigravity, OpenCode) through Tauri background process.

import { invokeCommand } from '../../ipc';
import type { PlannerProvider, ProviderMessage, PlannerProviderResult } from './types';

export interface CliProviderOptions {
  engine: string;
  model?: string;
  defaultTimeoutSecs?: number;
}

export class CliPlannerProvider implements PlannerProvider {
  public readonly id: string;
  private engine: string;
  private model?: string;
  private timeoutSecs: number;

  constructor(options: CliProviderOptions) {
    this.engine = options.engine;
    this.id = `cli-${options.engine}`;
    this.model = options.model;
    this.timeoutSecs = options.defaultTimeoutSecs ?? 30;
  }

  public async plan(
    messages: ProviderMessage[],
    options?: { timeoutSecs?: number }
  ): Promise<PlannerProviderResult> {
    const startTime = Date.now();
    const prompt = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');

    const res = await invokeCommand<{
      success?: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
      latencyMs?: number;
      model?: string;
    }>('query_operator_agent', {
      engine: this.engine,
      prompt,
      model: this.model,
      timeoutSecs: options?.timeoutSecs ?? this.timeoutSecs,
    });

    const latencyMs = res?.latencyMs ?? (Date.now() - startTime);

    if (!res || res.success === false) {
      throw new Error(
        res?.error || `CLI ${this.engine} falló sin devolver salida válida.`
      );
    }

    return {
      rawText: res.stdout || '',
      latencyMs,
      model: res.model || this.model || this.engine,
    };
  }
}
