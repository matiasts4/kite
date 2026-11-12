const COMMANDS = ['/clear', '/compact', '/model', '/goal', '/side', '/btw'] as const;

export function ComposerCommandMenu({
  query,
  skills,
  onPick,
}: {
  query: string;
  skills: string[];
  onPick: (value: string) => void;
}) {
  const token = query.trim();
  const skillMode = token.startsWith('$');
  const needle = (skillMode ? token.slice(1) : token.slice(1)).toLowerCase();
  const commands = skillMode
    ? []
    : COMMANDS.filter((command) => command.slice(1).includes(needle));
  const skillRows = skills.filter((skill) => skill.toLowerCase().includes(needle));
  if (commands.length === 0 && skillRows.length === 0) return null;
  return (
    <div className="composer-command-menu rounded-card" role="listbox" aria-label={skillMode ? 'Skills' : 'Commands'}>
      {commands.map((command) => (
        <button key={command} type="button" role="option" onClick={() => onPick(command)}>
          {command}
        </button>
      ))}
      {skillRows.map((skill) => (
        <button key={skill} type="button" role="option" onClick={() => onPick(`$${skill}`)}>
          ${skill}
        </button>
      ))}
    </div>
  );
}
