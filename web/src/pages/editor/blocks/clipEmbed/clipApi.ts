/** What the clip block asks the server. Runs in the main bundle (the editor chunk reaches it through host.ts). */
import { requestJson } from '../../../../api/http';
import { getPage } from '../../../../api/pageTree';
import { getPlatform } from '../../../../platform';
import type { ClipSummary } from './model';

/** One clip as card data. Fails with ApiError 403 (no review access) or 404 (the clip is gone). */
export function getClipSummary(projectId: string, baseName: string, version: number | null): Promise<ClipSummary> {
  const q = version !== null ? `?version=${version}` : '';
  return requestJson<ClipSummary>('GET', `/api/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(baseName)}/summary${q}`);
}

/** Every clip of a project as card data. Fails with 403 when the caller may not review the project. */
export async function listClipSummaries(projectId: string): Promise<ClipSummary[]> {
  const body = await requestJson<{ clips: ClipSummary[] }>('GET', `/api/projects/${encodeURIComponent(projectId)}/clip-summaries`);
  return body.clips;
}

export interface PickerProject {
  id: string;
  name: string;
  clips: ClipSummary[];
}

/**
 * The clips to choose from: the project of the page first (a personal page has none), then the other
 * projects the user can open. Projects the user may not review, and projects without clips, are left out.
 */
export async function loadPickerProjects(pageId: string | null): Promise<PickerProject[]> {
  let pageProject: string | null = null;
  if (pageId) {
    try {
      const space = (await getPage(pageId)).space;
      if (space.startsWith('p:')) pageProject = space.slice(2);
    } catch {
      /* the page's space is unknown: the projects are listed in their usual order */
    }
  }
  const projects = [...getPlatform().projects()];
  projects.sort((a, b) => Number(b.id === pageProject) - Number(a.id === pageProject));
  const loaded = await Promise.all(
    projects.map(async (p): Promise<PickerProject | null> => {
      try {
        return { id: p.id, name: p.name, clips: await listClipSummaries(p.id) };
      } catch {
        return null;
      }
    }),
  );
  return loaded.filter((p): p is PickerProject => p !== null && p.clips.length > 0);
}
