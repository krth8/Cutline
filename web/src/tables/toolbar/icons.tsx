import type { ReactNode } from 'react';

/** Small 16px line icons for the view bar (layouts, search, options). They take their colour from the text. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="cl-viewbar__icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const LAYOUT_ICONS: Record<string, ReactNode> = {
  table: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5V13" />
    </>
  ),
  board: (
    <>
      <rect x="2" y="3" width="3.2" height="10" rx="1" />
      <rect x="6.4" y="3" width="3.2" height="6.5" rx="1" />
      <rect x="10.8" y="3" width="3.2" height="8" rx="1" />
    </>
  ),
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  calendar: (
    <>
      <rect x="2" y="3" width="12" height="10.5" rx="1.5" />
      <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" />
    </>
  ),
  gallery: (
    <>
      <rect x="2" y="2.5" width="5.2" height="5.2" rx="1.2" />
      <rect x="8.8" y="2.5" width="5.2" height="5.2" rx="1.2" />
      <rect x="2" y="9.3" width="5.2" height="4.2" rx="1.2" />
      <rect x="8.8" y="9.3" width="5.2" height="4.2" rx="1.2" />
    </>
  ),
  gantt: <path d="M2.5 4h5M5.5 8h6M8.5 12h5" strokeWidth="2.2" />,
};

/** The icon of a layout by its name; unknown layouts get a plain square. */
export function LayoutIcon({ name }: { name: string }) {
  return <Icon>{LAYOUT_ICONS[name] ?? <rect x="3" y="3" width="10" height="10" rx="2" />}</Icon>;
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L13.5 13.5" />
    </Icon>
  );
}

export function MoreIcon() {
  return (
    <Icon>
      <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  );
}

export function ChevronIcon() {
  return (
    <Icon>
      <path d="M4.5 6.5L8 10l3.5-3.5" />
    </Icon>
  );
}
