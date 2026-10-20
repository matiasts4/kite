import { SelectMenu } from '../../../ui/SelectMenu';
import { OpenCodeModelOption } from '../../../../lib/operator/operatorConfig';

export function formatCatalogStamp(iso: string | null): string {
  if (!iso) return 'Lista incluida. Actualiza cuando quieras el catálogo completo.';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Lista guardada de la última actualización.';
  const stamp = date.toLocaleString('es', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Guardada ${stamp}. Actualiza solo si quieres consultarla de nuevo.`;
}

export function ModelSearchField({
  label,
  models,
  value,
  savedAt,
  onSelect,
}: {
  label: string;
  models: OpenCodeModelOption[];
  value: string;
  savedAt: string | null;
  onSelect: (modelId: string) => void;
}) {
  const selected = models.find((model) => model.id === value);
  return (
    <div className="zed-model-picker">
      <div className="zed-model-picker__head">
        <span className="zed-settings__label">{label}</span>
        <span className="zed-model-picker__stamp">{formatCatalogStamp(savedAt)}</span>
      </div>
      <SelectMenu
        searchable
        variant="field"
        label={label}
        searchPlaceholder="Buscar por nombre o id…"
        searchLabel="Buscar modelo"
        emptyLabel="Ningún modelo coincide."
        value={value || null}
        rows={models.map((model) => ({
          id: model.id,
          title: model.label,
          detail: model.id,
          badge: model.badge,
        }))}
        onSelect={onSelect}
        triggerLabel={selected?.label || value || 'Elegir modelo'}
        triggerBadge={selected?.badge}
        className="zed-model-picker__trigger"
        panelTitle={label}
        panelDetail={`${models.length} modelos`}
      />
    </div>
  );
}
