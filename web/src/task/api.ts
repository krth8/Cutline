/**
 * REST calls of the task panel: the endpoints the old task detail uses (comments, checklist, linked
 * clips) plus the task page. Rows themselves go through the table API (api/tables.ts).
 */
import { requestJson } from '../api/http';

const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

export interface TaskComment {
  id: string;
  userId: string;
  userName: string;
  userProfileImage?: string | null;
  text: string;
  createdAt: string;
  /** Client only: shown but not confirmed by the server yet. */
  pending?: boolean;
}

export interface ChecklistItem {
  id: string;
  text: string;
  isChecked: boolean;
  pending?: boolean;
}

export interface LinkedClip {
  id: number;
  baseName: string;
  activeVersion: number;
  thumbnail?: string | null;
}

export const getTaskPage = (taskId: string) => requestJson<{ id: string; canEdit: boolean }>('GET', `${task(taskId)}/page`);

export const getComments = (taskId: string) =>
  requestJson<{ comments: TaskComment[] }>('GET', `${task(taskId)}/comments`).then((r) => r.comments ?? []);
export const addComment = (taskId: string, text: string) =>
  requestJson<{ comment: TaskComment }>('POST', `${task(taskId)}/comments`, { text }).then((r) => r.comment);
export const deleteComment = (taskId: string, commentId: string) =>
  requestJson<unknown>('DELETE', `${task(taskId)}/comments/${encodeURIComponent(commentId)}`);

export const getChecklist = (taskId: string) =>
  requestJson<{ items: ChecklistItem[] }>('GET', `${task(taskId)}/checklist`).then((r) => r.items ?? []);
export const addChecklistItem = (taskId: string, text: string) =>
  requestJson<{ item: ChecklistItem }>('POST', `${task(taskId)}/checklist`, { text }).then((r) => r.item);
export const setChecklistItem = (taskId: string, itemId: string, isChecked: boolean) =>
  requestJson<unknown>('PATCH', `${task(taskId)}/checklist/${encodeURIComponent(itemId)}`, { isChecked });
export const deleteChecklistItem = (taskId: string, itemId: string) =>
  requestJson<unknown>('DELETE', `${task(taskId)}/checklist/${encodeURIComponent(itemId)}`);

export const getClips = (taskId: string) =>
  requestJson<{ clips: LinkedClip[] }>('GET', `${task(taskId)}/clips`).then((r) => r.clips ?? []);
export const linkClip = (taskId: string, clipId: number | string) =>
  requestJson<unknown>('POST', `${task(taskId)}/clips`, { clipId });
export const unlinkClip = (taskId: string, clipId: number | string) =>
  requestJson<unknown>('DELETE', `${task(taskId)}/clips/${encodeURIComponent(String(clipId))}`);

/** A clip of a project as the project payload lists it (what the link picker offers). */
export interface ProjectClip {
  clipId: number;
  baseName: string;
  activeVersion: number;
  versions: number;
  thumbnail: string | null;
}

/** The clips of a project, from the same payload the review tab loads. Each clip is its active version's id. */
export async function getProjectClips(projectId: string): Promise<ProjectClip[]> {
  const data = await requestJson<{
    clips?: Record<
      string,
      {
        id?: number;
        activeVersion: number;
        versions?: Array<{ version: number; clipId?: number; thumbnail?: string | null }>;
      }
    >;
  }>('GET', `/api/projects/${encodeURIComponent(projectId)}`);
  const out: ProjectClip[] = [];
  for (const [baseName, clip] of Object.entries(data.clips ?? {})) {
    const active = clip.versions?.find((v) => v.version === clip.activeVersion);
    const clipId = active?.clipId ?? clip.id;
    if (clipId === undefined) continue;
    out.push({
      clipId,
      baseName,
      activeVersion: clip.activeVersion,
      versions: clip.versions?.length ?? 1,
      thumbnail: active?.thumbnail ?? null,
    });
  }
  return out;
}
