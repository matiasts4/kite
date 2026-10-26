import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';
import { CloseIcon } from '../../ui';
import { SearchIcon } from './icons';
import { P1Block, P1Button, P1Pane, useAutoSize } from './primitives';
import { SelectMenu, type SelectMenuRow } from '../../../../components/ui/SelectMenu';

type OtpStatus = 'idle' | 'ok' | 'error';

const MODEL_ROWS: SelectMenuRow[] = [
  { id: 'kimi', title: 'Kimi K2', detail: '1M context' },
  { id: 'opus', title: 'Claude Opus 4.1', detail: '200K context' },
  { id: 'gpt', title: 'GPT-5', detail: '400K context' },
  { id: 'llama', title: 'Llama 4 Scout', detail: '128K context' },
];

const SEARCH_ITEMS = [
  'Refactor del transcript',
  'Contrato de movimiento',
  'Selector de modelos',
  'Ajustes del agente',
];

interface InputsPaneProps {
  mode: CompareVariant;
  name: string;
  onName: (value: string) => void;
  title: string;
  onTitle: (value: string) => void;
  email: string;
  onEmail: (value: string) => void;
  bio: string;
  onBio: (value: string) => void;
  search: string;
  onSearch: (value: string) => void;
  slider: number;
  onSlider: (value: number) => void;
  digits: string[];
  otpStatus: OtpStatus;
  onDigits: (digits: string[]) => void;
  onVerify: () => void;
  model: string;
  onSelect: (id: string) => void;
}

function InputsPane({
  mode,
  name,
  onName,
  title,
  onTitle,
  email,
  onEmail,
  bio,
  onBio,
  search,
  onSearch,
  slider,
  onSlider,
  digits,
  otpStatus,
  onDigits,
  onVerify,
  model,
  onSelect,
}: InputsPaneProps) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const bioRef = useAutoSize(bio);
  const searchRef = useRef<HTMLInputElement>(null);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const fieldId = useId();
  const sliderId = `${fieldId}-slider`;
  const emailInvalid =
    email.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const results = search.trim()
    ? SEARCH_ITEMS.filter((item) =>
        item.toLowerCase().includes(search.trim().toLowerCase())
      )
    : SEARCH_ITEMS;

  const focusOtp = (index: number) => otpRefs.current[index]?.focus();

  const changeDigit = (index: number, raw: string) => {
    const digit = raw.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    onDigits(next);
    if (digit && index < digits.length - 1) focusOtp(index + 1);
  };

  const otpKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault();
      focusOtp(index - 1);
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusOtp(index - 1);
    }
    if (event.key === 'ArrowRight' && index < digits.length - 1) {
      event.preventDefault();
      focusOtp(index + 1);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onVerify();
    }
  };

  const pasteOtp = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, digits.length);
    if (!pasted) return;
    event.preventDefault();
    const next = Array.from({ length: digits.length }, (_, index) => pasted[index] ?? '');
    onDigits(next);
    focusOtp(Math.min(pasted.length, digits.length) - 1);
  };

  const clearSearch = () => {
    onSearch('');
    searchRef.current?.focus();
  };

  const clearButton =
    mode === 'kite' ? (
      <button
        type="button"
        className={`p1-search__clear${search ? ' is-visible' : ''}`}
        aria-label="Limpiar búsqueda"
        disabled={!search}
        onClick={clearSearch}
      >
        <CloseIcon size={12} />
      </button>
    ) : (
      <AnimatePresence initial={false}>
        {search && (
          <motion.button
            type="button"
            key="clear"
            className="p1-search__clear is-visible"
            aria-label="Limpiar búsqueda"
            onClick={clearSearch}
            initial={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.icon,
              filter: motionTokens.blur.icon,
            }}
            animate={{
              opacity: 1,
              scale: 1,
              filter: 'blur(0px)',
              transition: motionTokens.tweens.swap,
            }}
            exit={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.icon,
              filter: motionTokens.blur.icon,
              transition: motionTokens.tweens.swap,
            }}
          >
            <CloseIcon size={12} />
          </motion.button>
        )}
      </AnimatePresence>
    );

  const otpContent = (
    <>
      <legend className="p1-label">Código de verificación</legend>
      <div className="p1-otp__row">
        <div className="p1-otp__inputs">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => {
                otpRefs.current[index] = element;
              }}
              className="p1-otp__input"
              value={digit}
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              maxLength={1}
              aria-label={`Dígito ${index + 1} de ${digits.length}`}
              aria-invalid={otpStatus === 'error' || undefined}
              aria-describedby={otpStatus === 'error' ? `${fieldId}-otp-error` : undefined}
              onChange={(event) => changeDigit(index, event.target.value)}
              onKeyDown={(event) => otpKeyDown(index, event)}
              onPaste={pasteOtp}
            />
          ))}
        </div>
        <P1Button mode={mode} variant="secondary" size="sm" onClick={onVerify}>
          Verificar
        </P1Button>
      </div>
      {otpStatus === 'error' && (
        <span id={`${fieldId}-otp-error`} className="p1-error" role="alert">
          El código está incompleto. Probá de nuevo.
        </span>
      )}
      {otpStatus === 'ok' && (
        <span className="p1-ok" role="status">
          Código verificado correctamente.
        </span>
      )}
    </>
  );

  return (
    <P1Pane mode={mode}>
      <div className="p1-grid">
        {/* 1. Campos de texto reales de Kite */}
        <P1Block
          title="Campos de texto"
          hint=".ui-field (32px) · .ui-field--large (36px) · .ui-field--area"
        >
          {/* Default 32px */}
          <div className="p1-field">
            <label className="p1-label" htmlFor={`${fieldId}-name`}>
              Nombre (Default 32px)
            </label>
            <input
              id={`${fieldId}-name`}
              className="ui-field"
              value={name}
              placeholder="Nombre del usuario…"
              onChange={(event) => onName(event.target.value)}
            />
          </div>

          {/* Large 36px */}
          <div className="p1-field">
            <label className="p1-label" htmlFor={`${fieldId}-title`}>
              Título del hilo (Large 36px)
            </label>
            <input
              id={`${fieldId}-title`}
              className="ui-field ui-field--large"
              value={title}
              placeholder="Título destacado del hilo…"
              onChange={(event) => onTitle(event.target.value)}
            />
          </div>

          {/* Validated email with aria-invalid */}
          <div className="p1-field">
            <label className="p1-label" htmlFor={`${fieldId}-email`}>
              Correo con validación
            </label>
            <input
              id={`${fieldId}-email`}
              className="ui-field"
              value={email}
              aria-invalid={emailInvalid || undefined}
              aria-describedby={emailInvalid ? `${fieldId}-email-error` : undefined}
              onChange={(event) => onEmail(event.target.value)}
            />
            {emailInvalid && (
              <span id={`${fieldId}-email-error`} className="p1-error" role="alert">
                Ingresá un correo válido.
              </span>
            )}
          </div>

          {/* Disabled read-only field */}
          <div className="p1-field">
            <label className="p1-label" htmlFor={`${fieldId}-locked`}>
              Correo del workspace (Solo lectura)
            </label>
            <input
              id={`${fieldId}-locked`}
              className="ui-field"
              value="workspace@kite.dev"
              disabled
              readOnly
            />
          </div>

          {/* Area 90px+ */}
          <div className="p1-field">
            <label className="p1-label" htmlFor={`${fieldId}-bio`}>
              Notas (Textarea auto-expandible)
            </label>
            <textarea
              id={`${fieldId}-bio`}
              ref={bioRef}
              className="ui-field ui-field--area"
              value={bio}
              maxLength={240}
              placeholder="Escribí una nota…"
              onChange={(event) => onBio(event.target.value)}
            />
            <span className="p1-field__foot">
              <span>Crece automáticamente con el contenido</span>
              <span>{bio.length}/240</span>
            </span>
          </div>
        </P1Block>

        {/* 2. Búsqueda y rango */}
        <P1Block title="Búsqueda y rango" hint="limpiar · arrastre · teclado">
          <div className="p1-field">
            <label className="p1-label" htmlFor={`${fieldId}-search`}>
              Buscar en el proyecto
            </label>
            <div className="p1-search">
              <SearchIcon size={13} className="p1-search__icon" />
              <input
                id={`${fieldId}-search`}
                ref={searchRef}
                className="ui-field p1-search__input"
                type="search"
                value={search}
                placeholder="Archivo o hilo…"
                onChange={(event) => onSearch(event.target.value)}
              />
              {clearButton}
            </div>
            <ul className="p1-search__results" aria-label="Resultados de búsqueda">
              {results.length === 0 ? (
                <li className="p1-search__result is-empty">Sin coincidencias</li>
              ) : (
                results.map((item) => (
                  <li key={item} className="p1-search__result">
                    {item}
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="p1-field">
            <div className="p1-field__head">
              <label className="p1-label" htmlFor={sliderId}>
                Contexto reservado
              </label>
              <output className="p1-value" htmlFor={sliderId}>
                {slider}%
              </output>
            </div>
            <div className="p1-slider">
              <span className="p1-slider__track" aria-hidden="true" />
              {mode === 'animate' ? (
                <motion.span
                  className="p1-slider__fill"
                  style={{ transformOrigin: 'left' }}
                  initial={false}
                  animate={{ scaleX: slider / 100 }}
                  transition={motionTokens.springs.number}
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="p1-slider__fill"
                  style={{ transform: `scaleX(${slider / 100})` }}
                  aria-hidden="true"
                />
              )}
              <input
                id={sliderId}
                className="p1-slider__input"
                type="range"
                min={0}
                max={100}
                step={1}
                value={slider}
                aria-label="Contexto reservado"
                onChange={(event) => onSlider(Number(event.target.value))}
              />
            </div>
            <p className="p1-mini-note">
              Arrastrá o usá las flechas: el pulgar se estira mientras lo sostenés.
            </p>
          </div>
        </P1Block>

        {/* 3. Código OTP */}
        <P1Block title="Código OTP" hint="auto-avance · error con resorte">
          {mode === 'animate' ? (
            <motion.fieldset
              className={`p1-otp${otpStatus === 'error' ? ' is-error' : ''}`}
              animate={{
                x:
                  otpStatus === 'error' && !reduce
                    ? [
                        0,
                        -motionTokens.shift.shake,
                        motionTokens.shift.shake,
                        -motionTokens.shift.shake / 2,
                        0,
                      ]
                    : 0,
              }}
              transition={motionTokens.tweens.disclosure}
            >
              {otpContent}
            </motion.fieldset>
          ) : (
            <fieldset className={`p1-otp${otpStatus === 'error' ? ' is-error' : ''}`}>
              {otpContent}
            </fieldset>
          )}
        </P1Block>

        {/* 4. Selector real de Kite: SelectMenu */}
        <P1Block title="Selector de modelo" hint="componente real <SelectMenu>">
          <div className="p1-field">
            <label className="p1-label">Modelo activo</label>
            <SelectMenu
              label="Elegir modelo de lenguaje"
              value={model}
              rows={MODEL_ROWS}
              onSelect={onSelect}
              searchable
              searchPlaceholder="Filtrar modelos…"
              variant="field"
            />
          </div>
          <p className="p1-mini-note">
            Componente oficial <code>&lt;SelectMenu&gt;</code> de Kite: filtro en vivo, posicionamiento geométrico anclado, navegación accesible por teclado y transiciones fluidas.
          </p>
        </P1Block>
      </div>
    </P1Pane>
  );
}

export function InputsSection({ view }: { view: CompareView }) {
  const [name, setName] = useState('Ada Lovelace');
  const [title, setTitle] = useState('Refactorización del transcript en tiempo real');
  const [email, setEmail] = useState('ada@kite.dev');
  const [bio, setBio] = useState('Reviso el diff del transcript y anoto los cambios de contrato.');
  const [search, setSearch] = useState('');
  const [slider, setSlider] = useState(48);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [otpStatus, setOtpStatus] = useState<OtpStatus>('idle');
  const [model, setModel] = useState('opus');

  const updateDigits = (next: string[]) => {
    setDigits(next);
    setOtpStatus('idle');
  };

  const verifyOtp = () => {
    setOtpStatus(digits.every(Boolean) ? 'ok' : 'error');
  };

  return (
    <CompareScene
      index="04"
      title="Inputs y campos"
      target="TextField · AutoTextarea · SelectMenu · Slider"
      note="Qué mirar: campos fieles al visual language de Kite con .ui-field (32px), .ui-field--large (36px) y .ui-field--area (textarea autoexpandible), junto al componente de producción <SelectMenu>."
      view={view}
    >
      {(mode) => (
        <InputsPane
          mode={mode}
          name={name}
          onName={setName}
          title={title}
          onTitle={setTitle}
          email={email}
          onEmail={setEmail}
          bio={bio}
          onBio={setBio}
          search={search}
          onSearch={setSearch}
          slider={slider}
          onSlider={setSlider}
          digits={digits}
          otpStatus={otpStatus}
          onDigits={updateDigits}
          onVerify={verifyOtp}
          model={model}
          onSelect={setModel}
        />
      )}
    </CompareScene>
  );
}
