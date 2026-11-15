/**
 * The text of the warning shown before a page moves to another space: who will be able to see it
 * and who will lose access. Pure, so the wording is testable.
 */
import type { MovePreview } from '../../api/pageTree';

export interface MoveWarningInput {
  preview: MovePreview;
  /** Name of the space the page goes to ("Personal space" or a project name). */
  destinationName: string;
  /** Name of the space it leaves. */
  sourceName: string;
  destinationIsPersonal: boolean;
  sourceIsPersonal: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function nameList(who: { count: number; names: string[] }): string {
  const shown = who.names.filter(Boolean);
  const more = who.count - shown.length;
  if (shown.length === 0) return '';
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** The sentences of the warning, in reading order. */
export function moveWarning(input: MoveWarningInput): string[] {
  const { preview, destinationName, sourceName, destinationIsPersonal, sourceIsPersonal } = input;
  const what = preview.subPages === 0 ? 'this page' : `this page and its ${plural(preview.subPages, 'sub-page', 'sub-pages')}`;
  const lines: string[] = [];

  if (destinationIsPersonal) {
    lines.push(`Only you will be able to see ${what}.`);
  } else {
    lines.push(`Everyone in ${destinationName} will be able to see ${what}.`);
    if (preview.gain.count > 0) {
      lines.push(`${plural(preview.gain.count, 'person', 'people')} who cannot see it now will gain access: ${nameList(preview.gain)}.`);
    } else {
      lines.push('Nobody who cannot see it now gains access.');
    }
  }

  if (!sourceIsPersonal) {
    if (preview.lose.count > 0) {
      lines.push(
        `${plural(preview.lose.count, 'person', 'people')} in ${sourceName} will lose access: ${nameList(preview.lose)}. ` +
          'If they have it open, it closes for them.',
      );
    } else {
      lines.push(`Nobody loses access.`);
    }
  }

  for (const v of preview.limitedViews) {
    lines.push(
      `${plural(v.viewCount, 'view', 'views')} on ${what === 'this page' ? 'it' : 'these pages'} show${v.viewCount === 1 ? 's' : ''} tasks of ` +
        `${v.projectName || 'another project'}; ${plural(v.readersWithoutAccess, 'person', 'people')} in ${destinationName} ` +
        'cannot see those tasks and will see no rows.',
    );
  }
  return lines;
}
