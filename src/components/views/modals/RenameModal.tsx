import React, { useState, useEffect, useRef } from 'react';
import { Sheet } from '../../ui/Sheet';

export interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialValue?: string;
  title?: string;
  description?: string;
  placeholder?: string;
  onSave: (newName: string) => void | Promise<void>;
}

export const RenameModal: React.FC<RenameModalProps> = ({
  isOpen,
  onClose,
  initialValue = '',
  title = 'Rename',
  description = 'Enter a new title for this item.',
  placeholder = 'Name',
  onSave,
}) => {
  const [value, setValue] = useState<string>(initialValue);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(initialValue);
      setIsSubmitting(false);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  }, [isOpen, initialValue]);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed || isSubmitting) return;

    try {
      setIsSubmitting(true);
      await Promise.resolve(onSave(trimmed));
      onClose();
    } catch {
      // ignore
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet
      open={isOpen}
      title={title}
      description={description}
      width={420}
      onCancel={onClose}
      primary={{
        label: 'Save',
        onClick: handleSave,
        disabled: !value.trim() || isSubmitting,
        loading: isSubmitting,
      }}
      secondary={{
        label: 'Cancel',
        onClick: onClose,
        disabled: isSubmitting,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        disabled={isSubmitting}
        className="ui-field"
        style={{ width: '100%' }}
      />
    </Sheet>
  );
};

export default RenameModal;
