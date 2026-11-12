import { bringBackAllowed } from './childApprovals';

export function SideChatPane({
  question,
  parentRunning = false,
  onBringBack,
  onClose,
}: {
  question: string;
  parentRunning?: boolean;
  onBringBack: (text: string) => void;
  onClose: () => void;
}) {
  const allowBringBack = bringBackAllowed(parentRunning);
  return (
    <aside className="side-chat-pane rounded-card" aria-label="Side chat">
      <header>
        <strong>Side</strong>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <p>{question}</p>
      <button
        type="button"
        disabled={!allowBringBack}
        onClick={() => {
          if (!allowBringBack) return;
          onBringBack(question);
        }}
      >
        Bring back
      </button>
    </aside>
  );
}
