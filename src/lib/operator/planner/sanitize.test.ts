import { describe, it, expect } from 'vitest';
import { detectPromptEcho, sanitizeReply, isPredominantlyEnglish } from './sanitize';
import { ActionSchema, PlanSchema } from '../contract';

describe('Sanitize & Contract Tests', () => {
  describe('detectPromptEcho', () => {
    it('detects system prompt leak phrases', () => {
      expect(detectPromptEcho('REGLAS CRÍTICAS: Responde en español')).toBe(true);
      expect(detectPromptEcho('User request: abre dos terminales')).toBe(true);
      expect(detectPromptEcho('{"reply": "test", "actions": []}')).toBe(true);
      expect(detectPromptEcho('```json\n{"type": "open_terminals"}\n```')).toBe(true);
    });

    it('returns false for normal conversational Spanish responses', () => {
      expect(detectPromptEcho('Abriendo 2 terminales con Grok para ejecutar los test.')).toBe(false);
      expect(detectPromptEcho('Todas las terminales han sido cerradas correctamente.')).toBe(false);
    });
  });

  describe('isPredominantlyEnglish', () => {
    it('detects English conversational phrases', () => {
      expect(isPredominantlyEnglish('Sure, I have opened two terminals and running tests')).toBe(true);
      expect(isPredominantlyEnglish('Here are the results you requested')).toBe(true);
    });

    it('does not flag Spanish phrases', () => {
      expect(isPredominantlyEnglish('Abriendo 2 terminales con Grok')).toBe(false);
      expect(isPredominantlyEnglish('Listo, ejecuté la prueba en la terminal.')).toBe(false);
    });
  });

  describe('sanitizeReply', () => {
    it('strips code fences and json wrappers', () => {
      const raw = '```json\n{"reply": "Abriendo 2 terminales con Grok."}\n```';
      const clean = sanitizeReply(raw);
      expect(clean).toBe('Abriendo 2 terminales con Grok.');
    });

    it('falls back to template if response is English', () => {
      const english = 'Sure, I have opened two terminals for running tests';
      const clean = sanitizeReply(english, 'Abriendo 2 terminales.');
      expect(clean).toBe('Abriendo 2 terminales.');
    });

    it('falls back to template if response leaks prompt echo', () => {
      const echo = 'REGLAS CRÍTICAS DE OPERACIÓN: Responde SIEMPRE en ESPAÑOL neutro';
      const clean = sanitizeReply(echo, 'Comando procesado.');
      expect(clean).toBe('Comando procesado.');
    });

    it('enforces maximum length of 280 characters', () => {
      const longText = 'Esta es una respuesta muy larga en español. '.repeat(10);
      const clean = sanitizeReply(longText);
      expect(clean.length).toBeLessThanOrEqual(280);
      expect(clean.endsWith('...')).toBe(true);
    });
  });

  describe('Contract Zod Schemas', () => {
    it('validates open_terminals action correctly', () => {
      const action = ActionSchema.parse({
        type: 'open_terminals',
        count: 2,
        engine: 'grok',
        prompts: ['ejecutar test'],
      });
      expect(action.type).toBe('open_terminals');
      expect((action as any).count).toBe(2);
    });

    it('rejects invalid action count (e.g. 0 or 50)', () => {
      expect(() =>
        ActionSchema.parse({
          type: 'open_terminals',
          count: 0,
          engine: 'grok',
        })
      ).toThrow();

      expect(() =>
        ActionSchema.parse({
          type: 'open_terminals',
          count: 50,
          engine: 'grok',
        })
      ).toThrow();
    });

    it('validates complete plan with strategy', () => {
      const plan = PlanSchema.parse({
        strategy: 'llm',
        actions: [{ type: 'open_terminals', count: 1, engine: 'claude' }],
        reply: 'Abriendo 1 terminal con Claude.',
      });
      expect(plan.strategy).toBe('llm');
      expect(plan.actions).toHaveLength(1);
    });
  });
});
