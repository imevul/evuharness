import { StatusBar } from '@evu/harness-ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const usage = { promptTokensTotal: 12_400, completionTokensTotal: 10, lastPromptTokens: 12_400 };

describe('StatusBar', () => {
  it('omits the donut when no max is known', () => {
    render(<StatusBar provider={{ id: 'local', model: 'm' }} usage={usage} />);

    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText('m')).toBeTruthy();
    expect(document.querySelector('[data-harness="status-donut"]')).toBeNull();
  });

  it('shows a custom tooltip, not a native title', () => {
    render(
      <StatusBar
        provider={{ id: 'local', label: 'Local', model: 'm', contextWindow: 32_768 }}
        usage={usage}
      />,
    );

    const donut = screen.getByRole('button');
    expect(donut.getAttribute('title')).toBeNull();
    fireEvent.focus(donut);
    expect(screen.getByRole('tooltip').textContent).toMatch(
      /Context: 12[,.]?400 \/ 32[,.]?768 \(38%\)/,
    );
  });

  it('surfaces an effective effort override', () => {
    render(
      <StatusBar provider={{ id: 'local', model: 'm', effort: 'high' }} usage={usage} />,
    );
    expect(screen.getByText('high')).toBeTruthy();
  });
});
