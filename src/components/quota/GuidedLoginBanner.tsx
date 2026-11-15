import React from 'react';
import {
  guidedLoginCoordinator,
  useGuidedLoginState,
} from '../../lib/accounts/guidedLoginCoordinator';
import './GuidedLoginBanner.css';

export const GuidedLoginBanner: React.FC = () => {
  const state = useGuidedLoginState(true);

  if (state.phase === 'idle') {
    return null;
  }

  let tone: 'info' | 'ok' | 'warn' | 'error' = 'info';
  let title = '';
  let sub: string | null = null;

  switch (state.phase) {
    case 'preparing':
      title = 'Preparando inicio de sesión guiado…';
      break;
    case 'waiting':
      if (state.timedOut) {
        tone = 'warn';
        title =
          state.notice ||
          'No se completó el inicio de sesión en 120s. Puedes reintentar o cancelar y restaurar tu sesión anterior.';
      } else {
        title = `Esperando inicio de sesión (${state.loginCommand || 'agy acp --login'})...`;
        sub = state.notice;
      }
      break;
    case 'saving':
      title = 'Autenticación detectada. Guardando credenciales en la bóveda…';
      break;
    case 'done':
      tone = 'ok';
      title = state.notice || 'Cuenta autenticada y guardada en la bóveda.';
      break;
    case 'cancelled':
      tone = 'info';
      title = state.notice || 'Inicio de sesión cancelado.';
      break;
    case 'error':
      tone = 'error';
      title = state.error || 'No se pudo completar el inicio de sesión.';
      break;
  }

  return (
    <div
      className="guided-login-banner"
      data-tone={tone}
      role="status"
      aria-live="polite"
    >
      <div className="guided-login-banner__body">
        <div className="guided-login-banner__title">{title}</div>
        {sub ? <div className="guided-login-banner__sub">{sub}</div> : null}
      </div>

      <div className="guided-login-banner__actions">
        {state.phase === 'waiting' && state.timedOut && state.provider ? (
          <button
            type="button"
            className="guided-login-banner__btn guided-login-banner__btn--primary"
            onClick={() => void guidedLoginCoordinator.retryWaiting()}
          >
            Reintentar
          </button>
        ) : null}

        {state.phase === 'waiting' ? (
          <button
            type="button"
            className="guided-login-banner__btn"
            onClick={() => void guidedLoginCoordinator.cancelAndRestore()}
          >
            Cancelar y restaurar
          </button>
        ) : null}

        {state.phase === 'error' && state.canCloseProcesses && state.provider ? (
          <button
            type="button"
            disabled={state.closingProcesses}
            className="guided-login-banner__btn guided-login-banner__btn--primary"
            onClick={() => void guidedLoginCoordinator.closeResidualProcessesAndRetry(state.provider!)}
          >
            {state.closingProcesses ? 'Cerrando procesos…' : 'Cerrar procesos Antigravity'}
          </button>
        ) : null}

        {state.phase === 'error' && state.canForceStart && state.provider ? (
          <button
            type="button"
            className="guided-login-banner__btn guided-login-banner__btn--primary"
            onClick={() => void guidedLoginCoordinator.start(state.provider!, { force: true })}
          >
            Forzar y continuar
          </button>
        ) : null}

        {state.phase === 'done' || state.phase === 'cancelled' || state.phase === 'error' ? (
          <button
            type="button"
            className="guided-login-banner__btn"
            onClick={() => guidedLoginCoordinator.dismiss()}
          >
            Cerrar
          </button>
        ) : null}
      </div>
    </div>
  );
};
