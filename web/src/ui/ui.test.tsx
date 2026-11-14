import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Avatar, Button, ColorDot, DatePicker, Dialog, Input, Menu, Popover, Tooltip, initials } from './index';

describe('Button', () => {
  it('clicks, and does nothing while loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveProperty('disabled', true);
  });
});

describe('Input commit', () => {
  it('commits on Enter and on blur, only when changed', async () => {
    const onCommit = vi.fn();
    render(<Input aria-label="t" defaultValue="a" onCommit={onCommit} />);
    const input = screen.getByLabelText('t');
    await userEvent.click(input);
    await userEvent.keyboard('b{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith('ab');
    await userEvent.keyboard('c');
    await userEvent.tab();
    expect(onCommit).toHaveBeenLastCalledWith('abc');
    expect(onCommit).toHaveBeenCalledTimes(2);
    await userEvent.click(input);
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('Escape reverts to the last committed value and cancels', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<Input aria-label="t" defaultValue="a" onCommit={onCommit} onCancel={onCancel} />);
    const input = screen.getByLabelText('t') as HTMLInputElement;
    await userEvent.type(input, 'xyz{Escape}');
    expect(input.value).toBe('a');
    expect(onCancel).toHaveBeenCalled();
  });
});

function PopoverHarness({ onOpenChange }: { onOpenChange?: (o: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button ref={ref} onClick={() => setOpen(true)}>
        trigger
      </button>
      <span>outside</span>
      <Popover
        open={open}
        anchorRef={ref}
        onOpenChange={(o) => {
          setOpen(o);
          onOpenChange?.(o);
        }}
      >
        <button>inside</button>
      </Popover>
    </div>
  );
}

describe('Popover', () => {
  it('opens, closes on Escape and returns focus to the trigger', async () => {
    render(<PopoverHarness />);
    const trigger = screen.getByText('trigger');
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a press outside but not inside', async () => {
    render(<PopoverHarness />);
    await userEvent.click(screen.getByText('trigger'));
    await userEvent.click(screen.getByText('inside'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

function MenuHarness({ onSelect }: { onSelect: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button ref={ref} onClick={() => setOpen(true)}>
        menu
      </button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={ref}
        items={[
          { id: 'a', label: 'Alpha', onSelect: () => onSelect('a') },
          { id: 'b', label: 'Beta', disabled: true, onSelect: () => onSelect('b') },
          { type: 'separator' },
          { id: 'c', label: 'Charlie', onSelect: () => onSelect('c') },
        ]}
      />
    </div>
  );
}

describe('Menu', () => {
  it('focuses the first item, moves with arrows (skipping disabled, wrapping) and selects with Enter', async () => {
    const onSelect = vi.fn();
    render(<MenuHarness onSelect={onSelect} />);
    await userEvent.click(screen.getByText('menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }));
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes and returns focus; typing jumps to a matching item', async () => {
    render(<MenuHarness onSelect={() => undefined} />);
    const trigger = screen.getByText('menu');
    await userEvent.click(trigger);
    await userEvent.keyboard('c');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not select disabled items', async () => {
    const onSelect = vi.fn();
    render(<MenuHarness onSelect={onSelect} />);
    await userEvent.click(screen.getByText('menu'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

function DialogHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      <Dialog
        open={open}
        title="Hello"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        footer={<button>Save</button>}
      >
        <input aria-label="field" />
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('is a labelled modal, focuses its field, traps Tab, closes on Escape and restores focus', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByText('open');
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Hello' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('field'));
    await userEvent.tab(); // Save
    await userEvent.tab(); // wraps to Close
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    await userEvent.tab({ shift: true }); // wraps back to Save
    expect(document.activeElement).toBe(screen.getByText('Save'));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes when the backdrop is pressed, not when the panel is', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    await userEvent.click(screen.getByText('open'));
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Tooltip', () => {
  it('shows on focus with aria-describedby and hides on blur', async () => {
    render(
      <Tooltip content="Helpful">
        <button>target</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.tab();
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Helpful');
    expect(screen.getByText('target').getAttribute('aria-describedby')).toBe(tip.id);
    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Escape hides it; hover shows it after the delay', async () => {
    render(
      <Tooltip content="Tip" delay={0}>
        <button>target</button>
      </Tooltip>,
    );
    await userEvent.hover(screen.getByText('target'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Avatar and ColorDot', () => {
  it('shows initials and falls back when the image fails', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace.hopper')).toBe('GH');
    expect(initials('linus')).toBe('LI');
    const { container } = render(<Avatar name="Ada Lovelace" src="/x.png" />);
    const img = container.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    return Promise.resolve().then(() => {
      expect(screen.getByRole('img', { name: 'Ada Lovelace' }).textContent).toBe('AL');
    });
  });

  it('ColorDot is a button only when clickable', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<ColorDot color="#f00" label="Red" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: 'Red' })).toBeTruthy();
    rerender(<ColorDot color="#f00" label="Red" onClick={onClick} selected />);
    await userEvent.click(screen.getByRole('button', { name: 'Red' }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('DatePicker', () => {
  it('shows the month of the value, selects a day by click', async () => {
    const onChange = vi.fn();
    render(<DatePicker value="2025-03-10" onChange={onChange} />);
    expect(screen.getByText('March 2025')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '15 March 2025' }));
    expect(onChange).toHaveBeenCalledWith('2025-03-15');
  });

  it('navigates months with the buttons', async () => {
    render(<DatePicker value="2025-01-31" onChange={() => undefined} />);
    await userEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('February 2025')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Previous month'));
    await userEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText('December 2024')).toBeTruthy();
  });

  it('moves the focused day with arrow keys and selects with Enter', async () => {
    const onChange = vi.fn();
    render(<DatePicker value="2025-03-10" onChange={onChange} />);
    const day = screen.getByRole('button', { name: '10 March 2025' });
    day.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '18 March 2025' }));
    await userEvent.keyboard('{PageDown}');
    expect(screen.getByText('April 2025')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '18 April 2025' }));
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('2025-04-18');
  });

  it('Clear sets null, Today sets today', async () => {
    const onChange = vi.fn();
    render(<DatePicker value="2025-03-10" onChange={onChange} />);
    await userEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByText('Today'));
    expect(onChange.mock.calls[onChange.mock.calls.length - 1]![0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
