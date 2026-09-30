// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ShareButton } from './ShareButton';

describe('ShareButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders with default "Share this venue" tooltip and aria-label', () => {
    render(<ShareButton url="https://modsutd.tech/venues/2.507" />);
    const btn = screen.getByRole('button', { name: 'Share this venue' });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('data-tip')).toBe('Share this venue');
  });

  it('supports custom label prop', () => {
    render(<ShareButton url="https://modsutd.tech/venues/2.507" label="Custom share" />);
    const btn = screen.getByRole('button', { name: 'Custom share' });
    expect(btn.getAttribute('data-tip')).toBe('Custom share');
  });

  it('copies url and updates tooltip to "copied!" on click, then reverts after 1500ms', async () => {
    render(<ShareButton url="https://modsutd.tech/venues/2.507" />);
    const btn = screen.getByRole('button', { name: 'Share this venue' });

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://modsutd.tech/venues/2.507');
    expect(btn.getAttribute('data-tip')).toBe('copied!');
    expect(btn.getAttribute('aria-label')).toBe('copied!');
    expect(screen.getByText('Link copied to clipboard')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(btn.getAttribute('data-tip')).toBe('Share this venue');
    expect(btn.getAttribute('aria-label')).toBe('Share this venue');
  });

  it('falls back to execCommand when navigator.clipboard.writeText rejects', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('denied'),
    );
    const execMock = vi.fn().mockReturnValue(true);
    document.execCommand = execMock;

    render(<ShareButton url="https://modsutd.tech/venues/Antique%20House" />);
    const btn = screen.getByRole('button', { name: 'Share this venue' });

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(execMock).toHaveBeenCalledWith('copy');
    expect(btn.getAttribute('data-tip')).toBe('copied!');
  });

  it('supports custom data-act attribute and data-tip-side', () => {
    render(
      <ShareButton
        url="https://modsutd.tech/venues/2.507"
        data-act="share-venue-btn"
        data-tip-side="left"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Share this venue' });
    expect(btn.getAttribute('data-act')).toBe('share-venue-btn');
    expect(btn.getAttribute('data-tip-side')).toBe('left');
  });
});
