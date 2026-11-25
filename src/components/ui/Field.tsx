import React, { useId } from 'react';
import './primitives.css';

export type FieldSize = 'sm' | 'md' | 'lg';

export interface FieldLabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export const FieldLabel: React.FC<FieldLabelProps> = ({
  required = false,
  className = '',
  children,
  ...rest
}) => (
  <label className={['kite-field__label', className].filter(Boolean).join(' ')} {...rest}>
    {children}
    {required && (
      <span className="kite-field__required" aria-hidden="true">
        *
      </span>
    )}
  </label>
);

export interface FieldErrorProps extends React.HTMLAttributes<HTMLParagraphElement> {}

export const FieldError: React.FC<FieldErrorProps> = ({ className = '', children, ...rest }) => {
  if (!children) return null;
  return (
    <p role="alert" className={['kite-field__error', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </p>
  );
};

export interface InputFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  size?: FieldSize;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
  inputClassName?: string;
}

export const InputField = React.forwardRef<HTMLInputElement, InputFieldProps>(
  function InputField(
    {
      id,
      label,
      hint,
      error,
      size = 'md',
      leftAddon,
      rightAddon,
      required,
      disabled,
      className = '',
      inputClassName = '',
      'aria-describedby': ariaDescribedBy,
      ...rest
    },
    ref
  ) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const hintId = hint ? `${inputId}-hint` : undefined;
    const errorId = error ? `${inputId}-error` : undefined;
    const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(' ') || undefined;

    const controlClasses = [
      'kite-field__control',
      `kite-field__control--${size}`,
      error ? 'kite-field__control--error' : '',
      disabled ? 'kite-field__control--disabled' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={['kite-field', className].filter(Boolean).join(' ')}>
        {label && (
          <FieldLabel htmlFor={inputId} required={required}>
            {label}
          </FieldLabel>
        )}
        <div className={controlClasses}>
          {leftAddon && <span className="kite-field__addon">{leftAddon}</span>}
          <input
            ref={ref}
            id={inputId}
            required={required}
            disabled={disabled}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={describedBy}
            className={['kite-field__input', inputClassName].filter(Boolean).join(' ')}
            {...rest}
          />
          {rightAddon && <span className="kite-field__addon">{rightAddon}</span>}
        </div>
        {hint && (
          <p id={hintId} className="kite-field__hint">
            {hint}
          </p>
        )}
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    );
  }
);

const SearchIcon: React.FC = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const ClearIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export interface SearchFieldProps extends Omit<InputFieldProps, 'leftAddon' | 'rightAddon'> {
  shortcut?: string;
  onClear?: () => void;
  clearLabel?: string;
}

export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    { shortcut, onClear, clearLabel = 'Clear search', value, ...rest },
    ref
  ) {
    const hasValue = typeof value === 'string' ? value.length > 0 : false;
    const rightAddon =
      hasValue && onClear ? (
        <button
          type="button"
          className="kite-field__clear"
          onClick={onClear}
          aria-label={clearLabel}
        >
          <ClearIcon />
        </button>
      ) : shortcut ? (
        <kbd className="kite-field__kbd">{shortcut}</kbd>
      ) : undefined;

    return (
      <InputField
        ref={ref}
        type="search"
        value={value}
        leftAddon={<SearchIcon />}
        rightAddon={rightAddon}
        {...rest}
      />
    );
  }
);

export interface TextareaFieldProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  size?: FieldSize;
  textareaClassName?: string;
}

export const TextareaField = React.forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField(
    {
      id,
      label,
      hint,
      error,
      size = 'md',
      required,
      disabled,
      className = '',
      textareaClassName = '',
      'aria-describedby': ariaDescribedBy,
      ...rest
    },
    ref
  ) {
    const generatedId = useId();
    const textareaId = id ?? generatedId;
    const hintId = hint ? `${textareaId}-hint` : undefined;
    const errorId = error ? `${textareaId}-error` : undefined;
    const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(' ') || undefined;

    const controlClasses = [
      'kite-field__control',
      'kite-field__control--textarea',
      `kite-field__control--${size}`,
      error ? 'kite-field__control--error' : '',
      disabled ? 'kite-field__control--disabled' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={['kite-field', className].filter(Boolean).join(' ')}>
        {label && (
          <FieldLabel htmlFor={textareaId} required={required}>
            {label}
          </FieldLabel>
        )}
        <div className={controlClasses}>
          <textarea
            ref={ref}
            id={textareaId}
            required={required}
            disabled={disabled}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={describedBy}
            className={['kite-field__textarea', textareaClassName].filter(Boolean).join(' ')}
            {...rest}
          />
        </div>
        {hint && (
          <p id={hintId} className="kite-field__hint">
            {hint}
          </p>
        )}
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    );
  }
);
