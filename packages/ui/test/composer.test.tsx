import { Composer } from '@evu/harness-ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('Composer', () => {
  it('does not crash when the textarea is clicked', () => {
    render(
      <Composer
        menus={[]}
        fetchItems={vi.fn()}
        modes={['ask']}
        mode="ask"
        onModeChange={() => undefined}
        onSend={() => undefined}
      />,
    );

    const input = screen.getByRole('textbox');
    expect(() => fireEvent.click(input)).not.toThrow();
    expect(input).toBeTruthy();
  });
});
