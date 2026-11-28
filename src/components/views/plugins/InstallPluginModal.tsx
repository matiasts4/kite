import React, { useEffect, useState } from 'react';
import {
  pickPluginInstallPath,
  type PluginRecordDto,
} from '../../../lib/ipc/pluginRuntime';
import { Modal } from '../../ui/Modal';
import { Tabs, type TabItem } from '../../ui/Tabs';

export type InstallSourceTab = 'folder' | 'git' | 'archive';

export interface InstallPluginModalProps {
  open: boolean;
  onClose: () => void;
  onInstallFolder: (path: string) => Promise<PluginRecordDto | unknown>;
  onInstallGit: (
    repoUrl: string,
    opts?: { gitRef?: string; subdir?: string }
  ) => Promise<PluginRecordDto | unknown>;
  onInstallArchive: (path: string) => Promise<PluginRecordDto | unknown>;
}

const TAB_ITEMS: TabItem[] = [
  { id: 'folder', label: 'Carpeta local' },
  { id: 'git', label: 'Repositorio Git' },
  { id: 'archive', label: 'Archivo .zip' },
];

function formatInstallError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'No se pudo completar la instalación de la extensión.';
}

export const InstallPluginModal: React.FC<InstallPluginModalProps> = ({
  open,
  onClose,
  onInstallFolder,
  onInstallGit,
  onInstallArchive,
}) => {
  const [activeTab, setActiveTab] = useState<InstallSourceTab>('folder');
  const [folderPath, setFolderPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [subdir, setSubdir] = useState('');
  const [archivePath, setArchivePath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setActiveTab('folder');
      setFolderPath('');
      setRepoUrl('');
      setGitRef('');
      setSubdir('');
      setArchivePath('');
      setSubmitting(false);
      setPicking(false);
      setError(null);
    }
  }, [open]);

  const handleBrowse = async (mode: 'folder' | 'archive') => {
    if (picking || submitting) return;
    setError(null);
    setPicking(true);
    try {
      const picked = await pickPluginInstallPath(mode);
      if (picked) {
        if (mode === 'folder') {
          setFolderPath(picked);
        } else {
          setArchivePath(picked);
        }
      }
    } catch (err) {
      setError(formatInstallError(err));
    } finally {
      setPicking(false);
    }
  };

  const handleInstall = async () => {
    if (submitting) return;
    setError(null);

    if (activeTab === 'folder') {
      const trimmed = folderPath.trim();
      if (!trimmed) {
        setError('Ingresa o selecciona una carpeta local válida.');
        return;
      }
      setSubmitting(true);
      try {
        await onInstallFolder(trimmed);
        onClose();
      } catch (err) {
        setError(formatInstallError(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (activeTab === 'git') {
      const trimmedUrl = repoUrl.trim();
      if (!trimmedUrl) {
        setError('Ingresa la URL del repositorio Git.');
        return;
      }
      setSubmitting(true);
      try {
        await onInstallGit(trimmedUrl, {
          gitRef: gitRef.trim() || undefined,
          subdir: subdir.trim() || undefined,
        });
        onClose();
      } catch (err) {
        setError(formatInstallError(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const trimmedArchive = archivePath.trim();
    if (!trimmedArchive) {
      setError('Ingresa o selecciona un archivo .zip válido.');
      return;
    }
    setSubmitting(true);
    try {
      await onInstallArchive(trimmedArchive);
      onClose();
    } catch (err) {
      setError(formatInstallError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitForm = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleInstall();
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Instalar extensión"
      description="Agrega un plugin bundle local, desde Git o desde un paquete .zip al runtime de Kite."
      closeLabel="Cerrar diálogo de instalación"
      size="md"
      footer={
        <>
          <button
            type="button"
            className="secondary-button install-plugin-modal__footer-btn"
            disabled={submitting}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="primary-button install-plugin-modal__footer-btn"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => void handleInstall()}
          >
            {submitting ? 'Instalando...' : 'Instalar extensión'}
          </button>
        </>
      }
    >
      <div className="install-plugin-modal">
        <Tabs
          items={TAB_ITEMS}
          value={activeTab}
          onChange={(id) => {
            setActiveTab(id as InstallSourceTab);
            setError(null);
          }}
          ariaLabel="Método de instalación"
          size="sm"
        />

        {error ? (
          <div role="alert" className="install-plugin-modal__error">
            <span>{error}</span>
          </div>
        ) : null}

        <form className="install-plugin-modal__form" onSubmit={handleSubmitForm}>
          {activeTab === 'folder' ? (
            <div className="install-plugin-modal__field">
              <label
                className="install-plugin-modal__label"
                htmlFor="install-plugin-folder"
              >
                Ruta de la carpeta local
              </label>
              <div className="install-plugin-modal__picker-row">
                <input
                  id="install-plugin-folder"
                  type="text"
                  className="install-plugin-modal__input"
                  placeholder="C:\ruta\a\mi-extension"
                  value={folderPath}
                  disabled={submitting}
                  onChange={(e) => {
                    setFolderPath(e.currentTarget.value);
                    if (error) setError(null);
                  }}
                />
                <button
                  type="button"
                  className="secondary-button install-plugin-modal__browse-btn"
                  disabled={picking || submitting}
                  onClick={() => void handleBrowse('folder')}
                >
                  {picking ? 'Abriendo...' : 'Examinar...'}
                </button>
              </div>
              <p className="install-plugin-modal__hint">
                La carpeta debe incluir un manifiesto compatible y será copiada al almacenamiento administrado de Kite.
              </p>
            </div>
          ) : null}

          {activeTab === 'git' ? (
            <div className="install-plugin-modal__git-fields">
              <div className="install-plugin-modal__field">
                <label
                  className="install-plugin-modal__label"
                  htmlFor="install-plugin-git-url"
                >
                  URL del repositorio Git
                </label>
                <input
                  id="install-plugin-git-url"
                  type="text"
                  className="install-plugin-modal__input"
                  placeholder="https://github.com/usuario/mi-extension.git"
                  value={repoUrl}
                  disabled={submitting}
                  onChange={(e) => {
                    setRepoUrl(e.currentTarget.value);
                    if (error) setError(null);
                  }}
                />
              </div>

              <div className="install-plugin-modal__two-col">
                <div className="install-plugin-modal__field">
                  <label
                    className="install-plugin-modal__label"
                    htmlFor="install-plugin-git-ref"
                  >
                    Rama o tag (opcional)
                  </label>
                  <input
                    id="install-plugin-git-ref"
                    type="text"
                    className="install-plugin-modal__input"
                    placeholder="main"
                    value={gitRef}
                    disabled={submitting}
                    onChange={(e) => setGitRef(e.currentTarget.value)}
                  />
                </div>

                <div className="install-plugin-modal__field">
                  <label
                    className="install-plugin-modal__label"
                    htmlFor="install-plugin-git-subdir"
                  >
                    Subcarpeta (opcional)
                  </label>
                  <input
                    id="install-plugin-git-subdir"
                    type="text"
                    className="install-plugin-modal__input"
                    placeholder="plugins/android-cli"
                    value={subdir}
                    disabled={submitting}
                    onChange={(e) => setSubdir(e.currentTarget.value)}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'archive' ? (
            <div className="install-plugin-modal__field">
              <label
                className="install-plugin-modal__label"
                htmlFor="install-plugin-archive"
              >
                Ruta del archivo .zip
              </label>
              <div className="install-plugin-modal__picker-row">
                <input
                  id="install-plugin-archive"
                  type="text"
                  className="install-plugin-modal__input"
                  placeholder="C:\ruta\a\extension.zip"
                  value={archivePath}
                  disabled={submitting}
                  onChange={(e) => {
                    setArchivePath(e.currentTarget.value);
                    if (error) setError(null);
                  }}
                />
                <button
                  type="button"
                  className="secondary-button install-plugin-modal__browse-btn"
                  disabled={picking || submitting}
                  onClick={() => void handleBrowse('archive')}
                >
                  {picking ? 'Abriendo...' : 'Examinar...'}
                </button>
              </div>
              <p className="install-plugin-modal__hint">
                Selecciona un paquete comprimido .zip que contenga la extensión en la raíz o en una subcarpeta única.
              </p>
            </div>
          ) : null}
        </form>
      </div>
    </Modal>
  );
};
