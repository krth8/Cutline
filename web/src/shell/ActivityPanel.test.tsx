import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { ActivityPanel, dayGroup, type ActivityEvent } from './ActivityPanel';

let fake: FakePlatform;

function event(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: Math.random().toString(36).slice(2),
    projectId: 'p1',
    projectName: 'Project One',
    actorId: 'u2',
    actorName: 'rita',
    kind: 'task.created',
    title: 'Grade pass',
    detail: {},
    link: '/p/p1/pages?task=t1',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  fake = createFakePlatform({ projects: [{ id: 'p1', name: 'Project One', canTasks: true, isOwner: true }] });
  setPlatform(fake);
});

afterEach(() => {
  cleanup();
  setPlatform(null);
});

describe('ActivityPanel', () => {
  it('lists what concerns me, says what changed, and opens the thing on click', async () => {
    const user = userEvent.setup();
    const me = fake.user()!.username;
    fake.routes['/api/activity?scope=me'] = {
      events: [
        event({ kind: 'task.assigned', detail: { to: [me] } }),
        event({ kind: 'task.status', detail: { from: 'In progress', to: 'Done' } }),
        event({ kind: 'comment.added', title: 'shot_010', detail: { text: 'Too dark here', reply: true }, link: '/p/p1/review?clip=shot_010' }),
      ],
    };
    render(<ActivityPanel projectId={null} />);
    const rows = await screen.findAllByTestId('activity-event');
    expect(rows.map((r) => r.querySelector('.cl-activity__text')?.textContent)).toEqual([
      'rita assigned you to Grade pass',
      'rita changed Grade pass',
      'rita replied on shot_010',
    ]);
    expect(within(rows[1]!).getByText('In progress')).toBeTruthy();
    expect(within(rows[1]!).getByText('Done')).toBeTruthy();
    expect(within(rows[2]!).getByText('Too dark here')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    // no project is open: only "For me"
    expect(screen.queryByRole('tab', { name: 'This project' })).toBeNull();
    await user.click(rows[2]!.querySelector('a')!);
    expect(fake.navigations).toEqual(['/p/p1/review?clip=shot_010']);
  });

  it('shows the open project on its own tab and reloads when something happens', async () => {
    const user = userEvent.setup();
    fake.routes['/api/activity?scope=me'] = { events: [] };
    fake.routes['/api/activity?scope=project&projectId=p1'] = { events: [event({ kind: 'page.created', title: 'Brief' })] };
    render(<ActivityPanel projectId="p1" />);
    expect(await screen.findByText(/Nothing for you yet/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'This project' }));
    expect((await screen.findByTestId('activity-event')).textContent).toContain('rita created the page Brief');

    fake.routes['/api/activity?scope=project&projectId=p1'] = { events: [event({ title: 'New task' }), event({ kind: 'page.created', title: 'Brief' })] };
    act(() => fake.emit('task_created', { project: 'p1' }));
    await waitFor(() => expect(screen.getAllByTestId('activity-event')).toHaveLength(2), { timeout: 2000 });
  });

  it('groups by day', () => {
    const now = new Date(2026, 10, 16, 12, 0);
    expect(dayGroup(new Date(2026, 10, 16, 0, 5).toISOString(), now)).toBe('Today');
    expect(dayGroup(new Date(2026, 10, 15, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(dayGroup(new Date(2026, 10, 10, 9, 0).toISOString(), now)).toBe('Earlier');
  });
});
