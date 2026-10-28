import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ShortcutItem, SupportedPlatform, ShortcutValidationResult } from '../../lib/shortcuts/types';
import {
  eventToKeyCombination,
  validateShortcut,
  getPlatform,
  formatKeyCombination,
} from '../../lib/shortcuts/shortcutsRegistry';
import './shortcutModal.css';

export interface ShortcutRecordModalProps {
  isOpen: boolean;
  shortcut: ShortcutItem | null;
  onClose: () => void;
  onSave: (id: string, keys: string[]) => void;
  onReset: (id: string) => void;
  platform?: SupportedPlatform;
}

export const ShortcutRecordModal: React.FC<ShortcutRecordModalProps> = ({
  isOpen,
  shortcut,
  onClose,
  onSave,
  onReset,
  platform: propPlatform,
}) => {
  const platform = propPlatform || getPlatform();

  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [validation, setValidation] = useState<ShortcutValidationResult>({ valid: true });
  const [hasInteracted, setHasInteracted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize keys whenever modal opens for a shortcut
  useEffect(() => {
    if (shortcut && isOpen) {
      const initial = shortcut.customKeys || shortcut.defaultKeys;
      setRecordedKeys(initial);
      setValidation(validateShortcut(initial, shortcut.id, platform));
      setHasInteracted(false);
    }
  }, [shortcut, isOpen, platform]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen || !shortcut) return;

      // Allow Escape alone to dismiss modal if user hasn't pressed other keys
      // UNLESS the shortcut being configured is specifically 'back-esc'
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (shortcut.id !== 'back-esc') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();

      const combination = eventToKeyCombination(e, platform);
      if (combination.length === 0) return;

      setHasInteracted(true);
      setRecordedKeys(combination);
      const val = validateShortcut(combination, shortcut.id, platform);
      setValidation(val);
    },
    [isOpen, shortcut, platform, onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, handleKeyDown]);

  if (!isOpen || !shortcut) return null;

  const handleSaveClick = () => {
    if (!validation.valid || recordedKeys.length === 0) return;
    onSave(shortcut.id, recordedKeys);
    onClose();
  };

  const handleResetClick = () => {
    onReset(shortcut.id);
    onClose();
  };

  const isDefault =
    recordedKeys.length === shortcut.defaultKeys.length &&
    recordedKeys.every((k, i) => k.toLowerCase() === shortcut.defaultKeys[i]?.toLowerCase());

  return (
    <div
      className="shortcut-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-modal-title"
    >
      <div className="shortcut-modal-card" ref={containerRef}>
        <div className="shortcut-modal-header">
          <h2 id="shortcut-modal-title" className="shortcut-modal-header__title">
            Editar atajo de teclado
          </h2>
          <p className="shortcut-modal-header__description">
            {shortcut.action} — {shortcut.description}
          </p>
        </div>

        <div className="shortcut-modal-body">
          <div
            className="shortcut-recorder-box shortcut-recorder-box--active"
            tabIndex={0}
            aria-label="Grabador de atajo. Presiona las teclas deseadas en tu teclado."
          >
            <div className="shortcut-recorder-keys">
              {recordedKeys.length > 0 ? (
                recordedKeys.map((k, idx) => (
                  <React.Fragment key={idx}>
                    {idx > 0 && <span className="shortcut-key-plus">+</span>}
                    <kbd className="shortcut-key-badge">{k}</kbd>
                  </React.Fragment>
                ))
              ) : (
                <span className="shortcut-recorder-hint">Presiona teclas...</span>
              )}
            </div>

            <div className="shortcut-recorder-hint">
              <span className="shortcut-recorder-pulse" />
              <span>
                {hasInteracted
                  ? 'Presiona otra combinación para cambiarla'
                  : 'Presiona la combinación deseada en tu teclado'}
              </span>
            </div>
          </div>

          {/* Validation Feedback Banner */}
          {validation.valid ? (
            <div className="shortcut-validation-banner shortcut-validation-banner--valid">
              <span>✓ Combinación válida y lista para asignarse.</span>
            </div>
          ) : validation.isReservedByOs ? (
            <div className="shortcut-validation-banner shortcut-validation-banner--error">
              <div>
                <strong>Atajo reservado ({validation.osName}):</strong> {validation.error}
              </div>
            </div>
          ) : validation.conflictWith ? (
            <div className="shortcut-validation-banner shortcut-validation-banner--warning">
              <div>
                <strong>Conflicto detectado:</strong> {validation.error}
              </div>
            </div>
          ) : (
            <div className="shortcut-validation-banner shortcut-validation-banner--warning">
              <div>{validation.error}</div>
            </div>
          )}
        </div>

        <div className="shortcut-modal-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={handleResetClick}
            disabled={isDefault}
            title="Restablecer este atajo a su valor original"
          >
            Por defecto ({formatKeyCombination(shortcut.defaultKeys, platform)})
          </button>

          <div className="shortcut-modal-footer__actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleSaveClick}
              disabled={!validation.valid || recordedKeys.length === 0}
            >
              Guardar atajo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
