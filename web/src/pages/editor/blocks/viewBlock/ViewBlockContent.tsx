import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { getPlatform } from '../../../../platform';
import { buildRoute, viewRoute } from '../../../../router';
import { ViewShell } from '../../../../tables/ViewShell';
import { Button } from '../../../../ui';
import { clampHeight, MAX_HEIGHT, MIN_HEIGHT, type PageContext } from './model';
import { confirmAndDeleteViewOf, createViewOnTable } from './viewApi';
import { useViewAccess } from './useViewAccess';
import { ViewPicker } from './ViewPicker';
import './viewBlock.css';

export interface ViewBlockContentProps {
  viewId: string | null;
  /** Set while a pasted copy is being made (by another client, or by this one a moment ago). */
  copying: boolean;
  height: number | null;
  /** The editor accepts changes: the block can be removed, resized and given another view. */
  editable: boolean;
  context: PageContext | null;
  /** Write block attributes (viewId, height) into the document. */
  setAttrs(attrs: { viewId?: string | null; height?: number | null }): void;
  /** Take the block out of the document (no questions asked). */
  removeBlock(): void;
}

/** The inside of a view block: header, the view itself, or the state that stands in for it. */
export function ViewBlockContent(props: ViewBlockContentProps) {
  const { viewId, copying, height, editable, context, setAttrs, removeBlock } = props;
  const access = useViewAccess(viewId);
  const [picking, setPicking] = useState(false);

  const remove = useCallback(async () => {
    if (await confirmAndDeleteViewOf(viewId, context)) removeBlock();
  }, [viewId, context, removeBlock]);

  const removeButton = editable ? (
    <Button size="sm" variant="ghost" onClick={() => void remove()} data-testid="viewblock-remove">
      Remove
    </Button>
  ) : null;

  let body: ReactNode;
  if (!viewId) {
    body = (
      <div className="cl-viewblock__state" data-testid="viewblock-empty">
        <p>{copying ? 'Copying the view...' : editable ? 'No view chosen yet.' : 'No view chosen.'}</p>
        {editable && !copying && (
          <Button size="sm" onClick={() => setPicking(true)} data-testid="viewblock-pick">
            Pick an existing view
          </Button>
        )}
        {removeButton}
      </div>
    );
  } else if (access.state === 'loading') {
    body = <div className="cl-viewblock__state">Loading...</div>;
  } else if (access.state === 'denied') {
    body = (
      <div className="cl-viewblock__state" data-testid="viewblock-denied">
        <p>You don't have access to this view.</p>
      </div>
    );
  } else if (access.state === 'gone') {
    body = (
      <div className="cl-viewblock__state" data-testid="viewblock-gone">
        <p>This view was deleted.</p>
        {editable && (
          <Button size="sm" onClick={removeBlock} data-testid="viewblock-remove-gone">
            Remove block
          </Button>
        )}
      </div>
    );
  } else if (access.state === 'error') {
    body = (
      <div className="cl-viewblock__state" data-testid="viewblock-error">
        <p>Could not load this view.</p>
        <Button size="sm" onClick={access.retry}>
          Try again
        </Button>
      </div>
    );
  } else {
    const view = access.view;
    body = (
      <>
        <ResizableBody height={height} editable={editable} onResize={(h) => setAttrs({ height: h })}>
          <ViewShell
            viewId={viewId}
            variant="embedded"
            editable={editable && view.canEdit !== false}
            className="cl-viewblock__shell"
            menuItems={[
              { id: 'open', label: 'Open full page', testId: 'viewblock-open', href: buildRoute(viewRoute(view.tableRef, viewId)), onSelect: () => {} },
              ...(editable ? [{ type: 'separator' as const }, { id: 'remove', label: 'Remove block', testId: 'viewblock-remove', danger: true, onSelect: () => void remove() }] : []),
            ]}
          />
        </ResizableBody>
      </>
    );
  }

  return (
    <div
      className="cl-viewblock"
      data-testid="view-block"
      data-view-id={viewId ?? ''}
      data-state={viewId ? access.state : 'empty'}
    >
      {body}
      <ViewPicker
        open={picking}
        onClose={() => setPicking(false)}
        context={context}
        onPick={(v) => {
          setPicking(false);
          setAttrs({ viewId: v.id });
        }}
        onPickTable={(table) => {
          setPicking(false);
          if (!context) return;
          createViewOnTable(table.ref, table.name, context).then(
            (v) => setAttrs({ viewId: v.id }),
            (e: unknown) => getPlatform().toast('error', e instanceof Error ? e.message : 'Could not create the view'),
          );
        }}
      />
    </div>
  );
}

/** The view area. With a height it scrolls inside; the bottom edge can be dragged to change it. */
function ResizableBody({
  height,
  editable,
  onResize,
  children,
}: {
  height: number | null;
  editable: boolean;
  onResize(height: number | null): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? height;

  function start(e: ReactPointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = el.getBoundingClientRect().height;
    let last = startHeight;
    const move = (ev: PointerEvent) => {
      last = clampHeight(startHeight + ev.clientY - startY) ?? startHeight;
      setLive(last);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      setLive(null);
      onResize(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowDown' ? 40 : e.key === 'ArrowUp' ? -40 : 0;
    if (!step) return;
    e.preventDefault();
    const current = shown ?? ref.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    onResize(clampHeight(current + step));
  }

  return (
    <div className="cl-viewblock__bodywrap">
      <div
        ref={ref}
        className="cl-viewblock__body"
        data-testid="viewblock-body"
        style={shown ? { height: shown, overflow: 'auto' } : undefined}
      >
        {children}
      </div>
      {editable && (
        <div
          className="cl-viewblock__resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the view"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          {...(shown ? { 'aria-valuenow': shown } : {})}
          tabIndex={0}
          data-testid="viewblock-resize"
          onPointerDown={start}
          onKeyDown={onKey}
          onDoubleClick={() => onResize(null)}
        />
      )}
    </div>
  );
}
