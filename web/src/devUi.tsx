import { useRef, useState, type ReactNode } from 'react';
import { getPlatform } from './platform';
import { Avatar, Button, ColorDot, DatePicker, Dialog, Input, Menu, Popover, Tooltip } from './ui';
import './devUi.css';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cl-demo__section">
      <h2>{title}</h2>
      <div className="cl-demo__row">{children}</div>
    </section>
  );
}

/** Every UI primitive on one page (route /dev/ui, admins only). */
export function DevUi() {
  const platform = getPlatform();
  const menuRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLButtonElement>(null);
  const dateRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [committed, setCommitted] = useState('');

  return (
    <main className="cl-demo" data-testid="dev-ui">
      <h1>Cutline UI primitives</h1>
      <p className="cl-demo__hint">Follows the active theme (light, dark or custom). Switch it in Settings and reload.</p>

      <Section title="Button">
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button size="sm">Small</Button>
        <Button loading>Loading</Button>
        <Button disabled>Disabled</Button>
      </Section>

      <Section title="Input">
        <Input placeholder="Plain input" aria-label="Plain input" />
        <Input placeholder="Invalid" invalid aria-label="Invalid input" />
        <Input placeholder="Enter commits, Esc reverts" aria-label="Commit input" onCommit={setCommitted} />
        <span className="cl-demo__muted">Committed: {committed || '(nothing yet)'}</span>
      </Section>

      <Section title="Tooltip">
        <Tooltip content="Hover or focus me">
          <Button>With tooltip</Button>
        </Tooltip>
      </Section>

      <Section title="Popover">
        <Button ref={popRef} onClick={() => setPopOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={popOpen}>
          Open popover
        </Button>
        <Popover open={popOpen} onOpenChange={setPopOpen} anchorRef={popRef} aria-label="Demo popover">
          <div style={{ padding: 8, maxWidth: 220 }}>Popovers close on Escape or a click outside.</div>
        </Popover>
      </Section>

      <Section title="Menu">
        <Button ref={menuRef} onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>
          Open menu
        </Button>
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchorRef={menuRef}
          aria-label="Demo menu"
          items={[
            { id: 'rename', label: 'Rename', onSelect: () => platform.toast('info', 'Rename') },
            { id: 'duplicate', label: 'Duplicate', onSelect: () => platform.toast('success', 'Duplicated') },
            { id: 'archive', label: 'Archive (disabled)', disabled: true, onSelect: () => undefined },
            { type: 'separator' },
            { id: 'delete', label: 'Delete', danger: true, onSelect: () => platform.toast('error', 'Deleted') },
          ]}
        />
      </Section>

      <Section title="Dialog">
        <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="Demo dialog"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>
                Save
              </Button>
            </>
          }
        >
          <Input placeholder="Name" aria-label="Name" style={{ width: '100%' }} />
        </Dialog>
      </Section>

      <Section title="Avatar">
        <Avatar name="Ada Lovelace" />
        <Avatar name="grace.hopper" size={36} />
        <Avatar name="Linus" size={44} />
        <Avatar name="Broken image" src="/static/does-not-exist.png" />
      </Section>

      <Section title="ColorDot">
        <ColorDot color="#22c55e" label="Done" />
        <ColorDot color="#3b82f6" size={14} label="In progress" />
        <ColorDot color="#f59e0b" size={18} />
        <ColorDot color="#ef4444" size={14} label="Selected" onClick={() => undefined} selected />
      </Section>

      <Section title="DatePicker">
        <Button ref={dateRef} onClick={() => setDateOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={dateOpen}>
          {date ?? 'Pick a date'}
        </Button>
        <Popover open={dateOpen} onOpenChange={setDateOpen} anchorRef={dateRef} aria-label="Choose a date">
          <DatePicker
            value={date}
            onChange={(v) => {
              setDate(v);
              setDateOpen(false);
            }}
          />
        </Popover>
        <div className="cl-demo__inline">
          <DatePicker value={date} onChange={setDate} />
        </div>
      </Section>
    </main>
  );
}
