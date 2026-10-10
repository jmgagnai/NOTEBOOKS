import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  NOTEBOOK_ID,
  SIGNED_IN,
  doubleClick,
  participant,
  renderPanel,
  resetAppEvents,
  thread,
} from './chat-panel.spec-helpers';

/**
 * NBK-115: a Chat Thread is renamed in place from its row in the navigator —
 * by double-click, F2 or the "Rename" item of its "⋯" menu — by anyone, as
 * from the title above the conversation (ADR-0001).
 */
describe('Chat panel (ThreadNavigator + ThreadView) — renaming a Chat Thread from its row', () => {
  beforeEach(resetAppEvents);

  const MINE = thread({ id: 'thread-mine', title: 'My questions', author: SIGNED_IN });
  const THEIRS = thread({
    id: 'thread-theirs',
    title: 'Their questions',
    author: participant('alice@example.com'),
    createdAt: '2025-12-01T00:00:00.000Z',
  });

  const rowOf = (title: string) => screen.getByRole('button', { name: `Open ${title}` });
  const titleBox = () => screen.queryByLabelText('Chat Thread title') as HTMLInputElement | null;

  async function renderWithThreads() {
    const renameChatThread = vi
      .fn()
      .mockImplementation(({ threadId, body }: { threadId: string; body: { title: string } }) =>
        Promise.resolve({ ...(threadId === MINE['id'] ? MINE : THEIRS), title: body.title }),
      );
    await renderPanel({
      listChatThreads: vi.fn().mockResolvedValue([MINE, THEIRS]) as never,
      listChatMessages: vi.fn().mockResolvedValue([]) as never,
      renameChatThread: renameChatThread as never,
    });
    await screen.findByRole('button', { name: 'Open My questions' });
    return { renameChatThread };
  }

  it('renames a Chat Thread by double-clicking its row', async () => {
    const { renameChatThread } = await renderWithThreads();

    doubleClick(rowOf('My questions'));
    const box = titleBox()!;
    expect(box.value).toBe('My questions');
    expect(document.activeElement).toBe(box);
    fireEvent.input(box, { target: { value: 'Q3 revenue' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(renameChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-mine',
      body: { title: 'Q3 revenue' },
    });
    // The row and the open Chat Thread's heading both take the new title.
    expect(await screen.findByRole('button', { name: 'Open Q3 revenue' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Q3 revenue' })).toBeTruthy();
  });

  it('keeps the title on Escape, and gives the focus back to the row', async () => {
    const { renameChatThread } = await renderWithThreads();

    doubleClick(rowOf('My questions'));
    const box = titleBox()!;
    fireEvent.input(box, { target: { value: 'Q3 revenue' } });
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(titleBox()).toBeNull();
    expect(renameChatThread).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(rowOf('My questions')));
  });

  it('opens the title box with F2 on the row', async () => {
    await renderWithThreads();

    fireEvent.keyDown(rowOf('Their questions'), { key: 'F2' });

    expect(titleBox()?.value).toBe('Their questions');
  });

  it('offers Rename on every Chat Thread, Delete on its author’s only', async () => {
    const { renameChatThread } = await renderWithThreads();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Their questions' }));
    const rename = await screen.findByRole('menuitem', { name: 'Rename Their questions' });
    expect(screen.queryByRole('menuitem', { name: 'Delete Their questions' })).toBeNull();
    fireEvent.click(rename);

    const box = await waitFor(() => titleBox()!);
    fireEvent.input(box, { target: { value: 'Supply chain' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(renameChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-theirs',
      body: { title: 'Supply chain' },
    });
    expect(await screen.findByRole('button', { name: 'Open Supply chain' })).toBeTruthy();
  });

  it('opens the Chat Thread on a single click, as before', async () => {
    await renderWithThreads();

    fireEvent.click(rowOf('Their questions'));

    expect(titleBox()).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Their questions' })).toBeTruthy();
    expect(within(rowOf('Their questions').parentElement!).queryByRole('textbox')).toBeNull();
  });
});
