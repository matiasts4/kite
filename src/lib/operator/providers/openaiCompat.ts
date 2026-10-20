// Kite Code — OpenAI Compatible Planner Provider
// Handles OpenCode Multi-Model Gateway, Vercel AI, and custom OpenAI-compatible endpoints.

import { operatorHttpFetch } from '../operatorConfig';
import type { PlannerProvider, ProviderMessage, PlannerProviderResult } from './types';

export interface OpenAiCompatOptions {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class OpenAiCompatPlannerProvider implements PlannerProvider {
  public readonly id: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options: OpenAiCompatOptions) {
    this.id = options.id || 'opencode';
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0.0;
    this.maxTokens = options.maxTokens ?? 500;
  }

  public async plan(
    messages: ProviderMessage[],
    _options?: { timeoutSecs?: number }
  ): Promise<PlannerProviderResult> {
    const startTime = Date.now();
    const normalizedBase = this.baseUrl.replace(/\/+$/, '');
    const endpoint = normalizedBase.endsWith('/chat/completions')
      ? normalizedBase
      : `${normalizedBase}/chat/completions`;

    const response = await operatorHttpFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        response_format: { type: 'json_object' },
        messages,
      }),
    });

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errJson = await response.json();
        errorDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
      } catch {
        try {
          errorDetail = await response.text();
        } catch {
          // ignore
        }
      }
      throw new Error(
        `Error HTTP ${response.status} desde ${endpoint}${errorDetail ? `: ${errorDetail}` : ''}`
      );
    }

    const data = await response.json();
    const rawText: string = data?.choices?.[0]?.message?.content ?? '';
    const latencyMs = Date.now() - startTime;

    return {
      rawText,
      latencyMs,
      model: this.model,
    };
  }
}
