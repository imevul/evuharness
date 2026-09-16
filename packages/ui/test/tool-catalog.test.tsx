import type { ToolCatalogEntry } from '@evu/harness-protocol';
import { ToolCatalogView } from '@evu/harness-ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const tools: ToolCatalogEntry[] = [
  {
    name: 'write_note',
    description: 'write',
    parameters: {},
    modes: [],
    mutates: true,
    approval: 'requires_approval',
    builtin: false,
    availableInMode: true,
  },
  {
    name: 'propose_plan',
    description: 'plan',
    parameters: {},
    modes: [],
    mutates: false,
    approval: 'always_allow',
    builtin: true,
    availableInMode: true,
  },
];

describe('ToolCatalogView', () => {
  it('edits approval policy for host tools and locks builtins', () => {
    const onApprovalChange = vi.fn();
    render(<ToolCatalogView mode="agent" tools={tools} onApprovalChange={onApprovalChange} />);

    const writeSelect = screen.getByLabelText('Approval policy for write_note');
    const builtinSelect = screen.getByLabelText('Approval policy for propose_plan');

    expect((writeSelect as HTMLSelectElement).disabled).toBe(false);
    expect((builtinSelect as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(writeSelect, { target: { value: 'always_allow' } });
    expect(onApprovalChange).toHaveBeenCalledWith('write_note', 'always_allow');
  });

  it('stays display-only without an editor callback', () => {
    render(<ToolCatalogView mode="ask" tools={tools} />);
    expect(screen.getByText('needs approval')).toBeTruthy();
    expect(document.querySelector('[data-harness="tool-approval-select"]')).toBeNull();
  });
});
