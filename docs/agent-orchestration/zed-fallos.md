# Registro de fallos de Zed (operador)

Los malos turnos del asistente operador no deberían quedar solo en el chat. Este registro vive en `src/lib/operator/fixtures/failures.json` y se valida con Vitest junto al corpus de `utterances.es.json`.

## Protocolo

1. Tras un turno incorrecto, agrega **una fila** con `status: "open"`: capa (`oir` | `entender` | `hacer`), la frase exacta, qué debía pasar (`expected`), fecha (`recordedAt`) e id único en kebab-case. Si tienes `turnId` o ruta a un `.jsonl` de traza, ponla en `trace`.
2. Corre `npx vitest run src/lib/operator/fixtures/failures.test.ts` (o la suite de operador). La fila **open** deja la suite en **rojo** hasta que la cierres.
3. Para volver a verde, codifica el arreglo y cambia la fila a `status: "encoded"` con la evidencia que corresponda:

| Capa | Qué hacer antes de `encoded` |
|------|------------------------------|
| **entender** | Copia la misma `phrase` a `utterances.es.json` con el `expected` de acciones que ya usa ese archivo. El test de heuristic sobre utterances sigue siendo quien comprueba el plan. |
| **oir** | Completa `heard` (transcripción), `said` (lo que dijo la persona), `trace` no vacío. `phrase` debe ser igual a `heard`; `heard` y `said` deben ser distintos. |
| **hacer** | Completa `trace` y `observed` (qué pasó en la app, en español). No hace falta simular la UI en el test; basta la anotación con evidencia. |

## Ejemplo de fila open

```json
{
  "id": "spawn-voseo-mal-plan",
  "recordedAt": "2026-10-20",
  "layer": "entender",
  "phrase": "abrí dos terminales con claude y corré los tests",
  "expected": "open_terminals count 2 engine claude con prompt de tests",
  "trace": "turn-a1b2c3",
  "status": "open"
}
```

Cuando el planner heurístico pase con esa frase en utterances, cambia `"status"` a `"encoded"` (sin duplicar la frase en `failures.json` más allá de la anotación original).

## Tests

- `src/lib/operator/fixtures/failures.test.ts` — reglas del registro y filas en memoria.
- `src/lib/operator/planner/heuristic.test.ts` — recorre todo `utterances.es.json`.

Comando habitual:

```bash
npx vitest run src/lib/operator/fixtures/failures.test.ts src/lib/operator/planner/heuristic.test.ts
```
