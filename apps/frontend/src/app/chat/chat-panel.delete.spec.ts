import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  ASK,
  NOTEBOOK_ID,
  SIGNED_IN,
  draftAQuestion,
  participant,
  questionBox,
  renderPanel,
  resetAppEvents,
  thread,
} from './chat-panel.spec-helpers';

/**
 * NBK-95: a Chat Thread's author deletes it from its row's "⋯" menu, after
 * confirming — there is no Undo — and no one else is offered the action
 * (GLOSSARY.md, ADR-0001 amendment).
 */
describe('Chat panel (ThreadNavigator + ThreadView) — deleting a Chat Thread', () => {
  beforeEach(resetAppEvents);

  const MINE = thread({ id: 'thread-mine', title: 'My questions', author: SIGNED_IN });
  const THEIRS = thread({
    id: 'thread-theirs',
    title: 'Their questions',
    author: participant('alice@example.com'),
    createdAt: '2025-12-01T00:00:00.000Z',
  });

  const actionsFor = (title: string) =>
    screen.queryByRole('button', { name: `Actions for ${title}` });

  async function renderWithThreads(overrides: Record<string, unknown> = {}) {
    const deleteChatThread = vi.fn().mockResolvedValue(null);
    await renderPanel({
      listChatThreads: vi.fn().mockResolvedValue([MINE, THEIRS]) as never,
      listChatMessages: vi.fn().mockResolvedValue([]) as never,
      deleteChatThread: deleteChatThread as never,
      ...overrides,
    });
    await screen.findByRole('button', { name: 'Open My questions' });
    return { deleteChatThread };
  }

  async function askToDelete(title: string) {
    fireEvent.click(actionsFor(title)!);
    fireEvent.click(await screen.findByRole('menuitem', { name: `Delete ${title}` }));
    return screen.findByRole('dialog');
  }

  it("offers Delete on its author's own Chat Threads only", async () => {
    await renderWithThreads();

    expect(actionsFor('My questions')).toBeTruthy();
    expect(actionsFor('Their questions')).toBeNull();
  });

  it('asks first, saying it cannot be undone, and Cancel deletes nothing', async () => {
    const { deleteChatThread } = await renderWithThreads();

    const dialog = await askToDelete('My questions');

    expect(within(dialog).getByText('Delete "My questions"?')).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Its messages will no longer be shown to anyone in this Notebook. This can't be undone.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteChatThread).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open My questions' })).toBeTruthy();
  });

  it('deletes the Chat Thread once confirmed, and closes it if it was open', async () => {
    const { deleteChatThread } = await renderWithThreads();
    // The newest, "My questions", opened by default (NBK-43).
    await screen.findByRole('heading', { name: 'My questions' });

    const dialog = await askToDelete('My questions');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open My questions' })).toBeNull(),
    );
    expect(deleteChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-mine',
    });
    // Closed: the Notebook landing, not the deleted Thread.
    expect(screen.queryByRole('heading', { name: 'My questions' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Notebook' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Their questions' })).toBeTruthy();
  });

  it('keeps the Chat Thread and says why when the deletion fails', async () => {
    await renderWithThreads({
      deleteChatThread: vi.fn().mockRejectedValue({
        error: { message: 'Only the user who started a Chat Thread may delete it.' },
      }),
    });

    const dialog = await askToDelete('My questions');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    const row = await screen.findByRole('alert');
    expect(
      within(row).getByText('Only the user who started a Chat Thread may delete it.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open My questions' })).toBeTruthy();
  });

  it('says so when a question is asked in a Chat Thread deleted meanwhile', async () => {
    await draftAQuestion({
      sendChatMessage: vi
        .fn()
        .mockRejectedValue({ error: { message: 'This Chat Thread was deleted.' } }),
    });

    fireEvent.keyDown(questionBox(), { key: 'Enter' });

    const row = await screen.findByRole('alert');
    expect(within(row).getByText('This Chat Thread was deleted.')).toBeTruthy();
    expect(questionBox().value).toBe(ASK);
  });
});
