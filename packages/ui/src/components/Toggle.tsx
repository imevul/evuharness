export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. The control itself is a switch, not a labelled input. */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A binary switch.
 *
 * Style-free: hosts theme `[data-harness="toggle"]` (and `data-checked`) as an
 * iOS-style pill or whatever their system uses. The kit only ships the role and
 * the checked state.
 */
export function Toggle({ checked, onChange, label, disabled = false, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-harness="toggle"
      data-checked={checked}
      disabled={disabled}
      className={className}
      onClick={() => onChange(!checked)}
    />
  );
}
