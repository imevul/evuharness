import type {
  CompactionSettings as CompactionConfig,
  HarnessSettingsUpdate,
} from '@evu/harness-protocol';

export interface CompactionSettingsProps {
  value: CompactionConfig;
  onChange: (update: HarnessSettingsUpdate) => Promise<void> | void;
  className?: string;
}

export function CompactionSettingsPanel({ value, onChange, className }: CompactionSettingsProps) {
  return (
    <section className={className} data-harness="compaction-settings">
      <header data-harness="provider-settings-header">
        <div>
          <h2>Compaction</h2>
          <p data-harness="provider-settings-hint">
            Older turns can be summarized or dropped so a long chat stays inside the model window.
            Stored messages are never rewritten.
          </p>
        </div>
      </header>

      <div data-harness="settings-form">
        <label>
          Strategy
          <select
            value={value.strategy}
            onChange={(event) =>
              void onChange({
                compaction: { strategy: event.target.value as CompactionConfig['strategy'] },
              })
            }
          >
            <option value="rolling">Rolling summary</option>
            <option value="drop">Drop oldest</option>
            <option value="off">Off</option>
          </select>
        </label>

        <label>
          Target percent of context
          <input
            type="number"
            min={1}
            max={100}
            value={value.targetPercent}
            onChange={(event) =>
              void onChange({
                compaction: { targetPercent: Number.parseInt(event.target.value, 10) },
              })
            }
          />
        </label>

        <label>
          Keep recent messages
          <input
            type="number"
            min={1}
            value={value.keepRecent}
            onChange={(event) =>
              void onChange({
                compaction: { keepRecent: Number.parseInt(event.target.value, 10) },
              })
            }
          />
        </label>
      </div>
    </section>
  );
}
