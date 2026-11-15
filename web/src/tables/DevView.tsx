import { ViewShell } from './ViewShell';

/** One view full screen (route /dev/view/<viewId>), for development and the browser tests. */
export function DevView({ viewId }: { viewId: string }) {
  return (
    <main className="cl-devview" data-testid="dev-view">
      <ViewShell viewId={viewId} />
    </main>
  );
}
