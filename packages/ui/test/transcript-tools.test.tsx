import type { TranscriptRow } from '@evu/harness-protocol';
import {
  formatWorkedDuration,
  formatWorkedFor,
  progressNoteText,
  summarizeToolTrace,
  Transcript,
} from '@evu/harness-ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('summarizeToolTrace', () => {
  it('groups by name in first-seen order', () => {
    expect(
      summarizeToolTrace([
        { name: 'search_memory', arguments: {}, result: '' },
        { name: 'web_search', arguments: {}, result: '' },
        { name: 'web_search', arguments: {}, result: '' },
      ]),
    ).toBe('1 memory search, 2 searches');
  });

  it('falls back to the tool name for unknown tools', () => {
    expect(
      summarizeToolTrace([
        { name: 'restart_service', arguments: {}, result: '' },
        { name: 'restart_service', arguments: {}, result: '' },
      ]),
    ).toBe('2× restart_service');
  });

  it('skips report_progress notes', () => {
    expect(
      summarizeToolTrace([
        { name: 'report_progress', arguments: { text: 'Looking that up.' }, result: 'Noted.' },
        { name: 'web_search', arguments: {}, result: '' },
      ]),
    ).toBe('1 search');
  });
});

describe('progressNoteText', () => {
  it('reads a non-empty text argument', () => {
    expect(
      progressNoteText({
        name: 'report_progress',
        arguments: { text: '  Checking the census.  ' },
        result: 'Noted.',
      }),
    ).toBe('Checking the census.');
  });

  it('ignores other tools and empty notes', () => {
    expect(progressNoteText({ name: 'web_search', arguments: { text: 'x' }, result: '' })).toBe(
      undefined,
    );
    expect(
      progressNoteText({ name: 'report_progress', arguments: { text: '  ' }, result: '' }),
    ).toBe(undefined);
  });
});

describe('formatWorkedFor', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatWorkedDuration(12_400)).toBe('12s');
    expect(formatWorkedDuration(60_000)).toBe('1m');
    expect(formatWorkedDuration(83_000)).toBe('1m 23s');
    expect(formatWorkedDuration(3_600_000)).toBe('1h');
    expect(formatWorkedDuration(3_720_000)).toBe('1h 2m');
  });

  it('omits the duration when timestamps are missing', () => {
    expect(formatWorkedFor(undefined)).toBe('Worked');
    expect(formatWorkedFor(12_000)).toBe('Worked for 12s');
  });
});

describe('Transcript work trace', () => {
  const older: TranscriptRow = {
    kind: 'assistant',
    text: 'Sundsvall has about 99,000 people.',
    reasoning: 'Looked it up.',
    tools: [
      { name: 'search_memory', arguments: { query: 'sundsvall' }, result: 'none' },
      { name: 'web_search', arguments: { query: 'Sundsvall population' }, result: '99k' },
    ],
    startedAt: '2026-09-17T01:00:00.000Z',
    createdAt: '2026-09-17T01:00:12.000Z',
  };
  const latest: TranscriptRow = {
    kind: 'assistant',
    text: 'Anything else?',
    tools: [{ name: 'web_search', arguments: { query: 'follow up' }, result: 'ok' }],
  };

  it('opens Worked for on the latest turn and shows per-tool details', () => {
    const { container } = render(
      <Transcript
        rows={[
          {
            kind: 'assistant',
            text: 'Sundsvall has about 99,000 people.',
            tools: [
              { name: 'search_memory', arguments: { query: 'sundsvall' }, result: 'none' },
              { name: 'web_search', arguments: { query: 'Sundsvall population' }, result: '99k' },
            ],
          },
        ]}
      />,
    );

    const work = container.querySelector('[data-harness="work-trace"]');
    expect(work).not.toBeNull();
    expect(work?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Worked')).toBeTruthy();
    expect(container.querySelector('[data-harness="tool-trace"]')).toBeNull();
    expect(screen.getByText('search_memory')).toBeTruthy();
    expect(screen.getByText('web_search')).toBeTruthy();
  });

  it('keeps older turns collapsed and the latest Worked for open', () => {
    const { container } = render(<Transcript rows={[older, latest]} />);
    const traces = container.querySelectorAll('[data-harness="work-trace"]');

    expect(traces).toHaveLength(2);
    expect(traces[0]?.hasAttribute('open')).toBe(false);
    expect(traces[1]?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Worked for 12s')).toBeTruthy();
    expect(screen.getByText('Worked')).toBeTruthy();

    fireEvent.click(screen.getByText('Worked for 12s'));
    expect(traces[0]?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Looked it up.')).toBeTruthy();
    expect(traces[0]?.querySelectorAll('[data-harness="tool"]')).toHaveLength(2);
  });

  it('renders report_progress as an inline note inside Worked for', () => {
    const { container } = render(
      <Transcript
        rows={[
          {
            kind: 'assistant',
            text: 'About 99,000.',
            tools: [
              {
                name: 'report_progress',
                arguments: { text: 'Checking the latest census figures.' },
                result: 'Noted.',
              },
              { name: 'web_search', arguments: { query: 'Sundsvall' }, result: '99k' },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText('Checking the latest census figures.')).toBeTruthy();
    expect(container.querySelector('[data-harness="progress-note"]')).not.toBeNull();
    expect(screen.queryByText('report_progress')).toBeNull();
    expect(screen.getByText('web_search')).toBeTruthy();
  });

  it('shows Working while a live turn has tools or thinking', () => {
    const { container } = render(
      <Transcript
        rows={[older]}
        turn={{
          phase: 'tools',
          content: '',
          reasoning: 'working',
          tools: [
            {
              name: 'report_progress',
              arguments: { text: 'Looking that up now.' },
              result: 'Noted.',
            },
            { name: 'web_search', arguments: { query: 'now' }, result: 'ok' },
          ],
          mode: 'agent',
        }}
      />,
    );

    const traces = container.querySelectorAll('[data-harness="work-trace"]');
    expect(traces).toHaveLength(2);
    expect(traces[0]?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('Worked for 12s')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(traces[1]?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('working')).toBeTruthy();
    expect(screen.getByText('Looking that up now.')).toBeTruthy();
    expect(traces[1]?.querySelector('[data-harness="tool"]')?.textContent).toContain('web_search');
  });

  it('falls back to the previous user timestamp', () => {
    render(
      <Transcript
        rows={[
          { kind: 'user', text: 'hi', createdAt: '2026-09-17T01:00:00.000Z' },
          {
            kind: 'assistant',
            text: 'older',
            tools: [{ name: 'web_search', arguments: {}, result: 'ok' }],
            createdAt: '2026-09-17T01:00:08.000Z',
          },
          { kind: 'assistant', text: 'latest' },
        ]}
      />,
    );

    expect(screen.getByText('Worked for 8s')).toBeTruthy();
  });

  it('omits work chrome when a turn has no thinking, tools, or notes', () => {
    const { container } = render(
      <Transcript
        rows={[
          { kind: 'assistant', text: 'plain reply' },
          { kind: 'assistant', text: 'also plain' },
        ]}
      />,
    );

    expect(container.querySelector('[data-harness="work-trace"]')).toBeNull();
  });
});
