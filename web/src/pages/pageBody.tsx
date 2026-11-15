/**
 * Puts the collaborative editor into the page view. Imported once at start-up.
 */
import { registerPageBody, type PageBodyProps } from './PageView';
import { CollabEditor } from './sync';

function PageBody({ pageId, editable, onSync }: PageBodyProps) {
  return (
    <CollabEditor
      pageId={pageId}
      readOnly={!editable}
      placeholder="Write something, or type / for blocks"
      // The page header shows the sync status
      hideStatusBar
      {...(onSync ? { onSync } : {})}
    />
  );
}

registerPageBody(PageBody);
