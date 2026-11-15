/**
 * Route view for `home` (`/home`): the user's Home page, shown like any personal page (editor, title,
 * menu). The page id comes from the server, which makes "My dashboard" the first time. The URL stays
 * `/home`, so the address always means "whatever Home is now".
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui';
import { PageView } from '../PageView';
import { openHome, useHomePageId } from './homeStore';

export function HomeView() {
  const known = useHomePageId();
  const [state, setState] = useState<'loading' | 'error'>('loading');
  const [pageId, setPageId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    const id = await openHome();
    if (id) setPageId(id);
    else setState('error');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The pointer changed (set as home on another page, or the old one was archived): follow it
  useEffect(() => {
    if (known && known !== pageId) setPageId(known);
    if (known === null && pageId) void load();
  }, [known, pageId, load]);

  if (pageId) return <PageView route={{ kind: 'mePage', pageId }} />;
  if (state === 'error') {
    return (
      <div className="cl-page__state" role="alert">
        <h1 className="cl-page__state-title">Could not open Home</h1>
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  return (
    <div className="cl-page__skeleton" data-testid="home-loading" aria-busy="true" aria-label="Loading Home">
      <span className="cl-page__skeleton-title" />
      <span />
      <span className="cl-page__skeleton-short" />
    </div>
  );
}
