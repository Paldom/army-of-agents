import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Markdown } from '@/components/Markdown';

describe('Markdown', () => {
  it('keeps a relative link inside the browser instead of leaving it', async () => {
    // This is the one feature that makes the file browser better than a static
    // index, so it gets the test.
    const onNavigate = vi.fn();
    render(<Markdown src="See [the architecture](../docs/ARCH.md) for detail." onNavigate={onNavigate} />);
    await userEvent.click(screen.getByText('the architecture'));
    expect(onNavigate).toHaveBeenCalledWith('../docs/ARCH.md');
  });

  it('sends absolute links out to the browser, not through the file tree', () => {
    const onNavigate = vi.fn();
    render(<Markdown src="[upstream](https://example.com/x)" onNavigate={onNavigate} />);
    const a = screen.getByText('upstream');
    expect(a).toHaveAttribute('href', 'https://example.com/x');
    expect(a).toHaveAttribute('target', '_blank');
  });

  it('escapes HTML in the source', () => {
    const { container } = render(<Markdown src={'<img src=x onerror=alert(1)>'} onNavigate={() => {}} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders headings, lists, tables and code', () => {
    const { container } = render(
      <Markdown
        src={'# Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```'}
        onNavigate={() => {}}
      />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('table tr')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent?.trim()).toBe('code');
  });
});
