/** What the sidebar remembers in this browser: whether it is collapsed. */
const COLLAPSED_KEY = 'cl-sidebar-collapsed';

export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable: the state just is not remembered */
  }
}
