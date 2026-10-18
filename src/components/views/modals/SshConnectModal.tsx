import React from 'react';
import { SshWorkspaceModal, type SshWorkspaceModalProps, type SavedSshEndpoint } from './SshWorkspaceModal';

export type SshConnectModalProps = SshWorkspaceModalProps;
export type { SavedSshEndpoint };

export const SshConnectModal: React.FC<SshConnectModalProps> = (props) => {
  return <SshWorkspaceModal {...props} />;
};
