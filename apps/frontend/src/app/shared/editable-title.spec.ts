import { fireEvent, render, screen } from '@testing-library/angular';
import { EditableTitle } from './editable-title';

// NBK-41: the control is the seam — its inputs, its output and the
// accessible names it gives the two elements it swaps between. The pages
// that use it (the Notebook header today, the Notebook cards and the Chat
// Thread title next) only wire the committed text to their store.

/** The control showing `title`, with `titleChange` captured in `renamed`. */
async function renderTitle(title = 'Research') {
  const renamed = vi.fn();
  await render(EditableTitle, {
    inputs: { title, editLabel: 'Notebook title', tooltip: 'Rename Notebook' },
    on: { titleChange: renamed },
  });
  return renamed;
}

/** Activates the title and types `text` into the box that replaces it. */
function typeTitle(text: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Research' }));
  const input = screen.getByLabelText('Notebook title') as HTMLInputElement;
  fireEvent.input(input, { target: { value: text } });
  return input;
}

describe('EditableTitle', () => {
  it('reads as the title, and activating it opens a box prefilled with the title', async () => {
    await renderTitle();

    fireEvent.click(screen.getByRole('button', { name: 'Research' }));

    const input = screen.getByLabelText('Notebook title') as HTMLInputElement;
    expect(input.value).toBe('Research');
    expect(screen.queryByRole('button', { name: 'Research' })).toBeNull();
  });

  it('commits the typed title on Enter and reads as the title again', async () => {
    const renamed = await renderTitle();

    fireEvent.keyDown(typeTitle('Research 2026'), { key: 'Enter' });

    expect(renamed).toHaveBeenCalledWith('Research 2026');
    expect(screen.queryByLabelText('Notebook title')).toBeNull();
    // The owner has not re-bound the title yet, so the button reads the old one.
    expect(screen.getByRole('button', { name: 'Research' })).toBeTruthy();
  });

  it('commits when the box loses focus', async () => {
    const renamed = await renderTitle();

    fireEvent.blur(typeTitle('Archive'));

    expect(renamed).toHaveBeenCalledWith('Archive');
    expect(screen.queryByLabelText('Notebook title')).toBeNull();
  });

  it('commits once when Enter is followed by the blur of the closing box', async () => {
    const renamed = await renderTitle();
    const input = typeTitle('Archive');

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(renamed).toHaveBeenCalledTimes(1);
  });

  it('discards the edit on Escape and emits nothing', async () => {
    const renamed = await renderTitle();

    fireEvent.keyDown(typeTitle('Mistake'), { key: 'Escape' });

    expect(renamed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Research' })).toBeTruthy();
    expect(screen.queryByLabelText('Notebook title')).toBeNull();
  });

  it.each([
    ['the same title', 'Research'],
    ['the same title with spaces around it', '  Research  '],
    ['only whitespace', '   '],
  ])('emits nothing when the box is committed with %s', async (_case, text) => {
    const renamed = await renderTitle();

    fireEvent.keyDown(typeTitle(text), { key: 'Enter' });

    expect(renamed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Research' })).toBeTruthy();
  });

  it('trims the committed title', async () => {
    const renamed = await renderTitle();

    fireEvent.keyDown(typeTitle('  Archive '), { key: 'Enter' });

    expect(renamed).toHaveBeenCalledWith('Archive');
  });

  // NBK-56: a Notebook card starts the rename from its "…" menu rather than
  // from the title, so the owner can open the box itself.
  it('opens the box prefilled with the title when its owner calls edit()', async () => {
    const { fixture } = await render(EditableTitle, {
      inputs: { title: 'Research', editLabel: 'Notebook title' },
    });

    fixture.componentInstance.edit();
    fixture.detectChanges();

    const input = screen.getByLabelText('Notebook title') as HTMLInputElement;
    expect(input.value).toBe('Research');
  });

  it.each([
    ['committed', 'Enter'],
    ['discarded', 'Escape'],
  ])('tells its owner the box closed when the edit is %s', async (_case, key) => {
    const closed = vi.fn();
    await render(EditableTitle, {
      inputs: { title: 'Research', editLabel: 'Notebook title' },
      on: { editClosed: closed },
    });

    fireEvent.keyDown(typeTitle('Archive'), { key });

    expect(closed).toHaveBeenCalledTimes(1);
  });
});
