import { describe, it, expect } from 'vitest';
import {
  cleanDeveloperPhonetics,
  interpretAndEnrichPrompt,
} from './promptInterpreter';

describe('Prompt Interpreter & Task Enricher', () => {
  describe('cleanDeveloperPhonetics', () => {
    it('corrects "pugs" to "bugs"', () => {
      expect(cleanDeveloperPhonetics('cómo estamos haciendo los pugs')).toBe(
        'cómo estamos haciendo los bugs'
      );
      expect(cleanDeveloperPhonetics('revisa los pugs')).toBe('revisa los bugs');
    });

    it('corrects "sierra" to "cierra"', () => {
      expect(cleanDeveloperPhonetics('sierra la terminal')).toBe('cierra la terminal');
    });

    it('corrects "prs" to "pull requests"', () => {
      expect(cleanDeveloperPhonetics('revisa los prs')).toBe('revisa los pull requests');
    });
  });

  describe('interpretAndEnrichPrompt', () => {
    it('enriches user request about documentation and bugs (pugs)', () => {
      const res = interpretAndEnrichPrompt(
        'Revisa documentación para verificar cómo estamos haciendo los pugs'
      );
      expect(res.category).toBe('docs');
      expect(res.isEnriched).toBe(true);
      expect(res.enriched).toContain('docs/');
      expect(res.enriched).toContain('README');
      expect(res.enriched).toContain('bugs');
    });

    it('enriches short "revisa documentación" into actionable prompt', () => {
      const res = interpretAndEnrichPrompt('revisa documentación');
      expect(res.category).toBe('docs');
      expect(res.isEnriched).toBe(true);
      expect(res.enriched.length).toBeGreaterThan(50);
      expect(res.enriched).toContain('README');
    });

    it('enriches test and fix requests', () => {
      const res = interpretAndEnrichPrompt('ejecuta los test y arregla lo que falle');
      expect(res.category).toBe('tests');
      expect(res.isEnriched).toBe(true);
      expect(res.enriched).toContain('suite de pruebas');
      expect(res.enriched).toContain('correcciones necesarias');
    });

    it('enriches bug fixing requests', () => {
      const res = interpretAndEnrichPrompt('corrige los bugs');
      expect(res.category).toBe('bugs');
      expect(res.isEnriched).toBe(true);
      expect(res.enriched).toContain('Inspecciona el código');
    });

    it('enriches short arbitrary prompts with quality constraints', () => {
      const res = interpretAndEnrichPrompt('agrega un endpoint de perfiles');
      expect(res.category).toBe('general');
      expect(res.isEnriched).toBe(true);
      expect(res.enriched).toContain('agrega un endpoint de perfiles');
      expect(res.enriched).toContain('mejores prácticas');
    });

    it('preserves already detailed, multi-sentence prompts', () => {
      const detailed =
        'Primero revisa el archivo main.rs y localiza la función handle_request. ' +
        'Luego agrega un nuevo caso para procesar eventos JSON tipo telemetry y ' +
        'asegúrate de que los tests pasen ejecutando cargo test.';
      const res = interpretAndEnrichPrompt(detailed);
      expect(res.isEnriched).toBe(false);
      expect(res.enriched).toBe(detailed);
    });
  });
});
