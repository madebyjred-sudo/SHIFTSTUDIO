/**
 * hojaEditorRegistry — bridge between DOM-level selection capture and
 * TipTap Editor instances.
 *
 * The hoja toolbar/selection menus are mounted GLOBALLY (one per page)
 * and detect selections by walking up to the `.ProseMirror` element.
 * That decoupling is good — but it means the menus only have a DOM
 * handle, not the TipTap Editor. To route formatting through TipTap's
 * native chain commands (instead of the deprecated
 * `document.execCommand`, which behaves inconsistently across browsers
 * — Firefox `formatBlock`, Safari `insertHTML`/`createLink` etc.), we
 * need to recover the Editor instance from its DOM root.
 *
 * Each HojaNode registers its editor on mount and unregisters on
 * unmount. The menus call `getHojaEditor(promirrorEl)` to retrieve the
 * matching Editor.
 *
 * Memory safety: the map keys on the `.ProseMirror` HTMLElement, which
 * lives exactly as long as the editor itself. Registration is idempotent
 * — re-registering with the same DOM element overwrites cleanly.
 */
import type { Editor } from '@tiptap/react';

const registry = new WeakMap<HTMLElement, Editor>();

export function registerHojaEditor(dom: HTMLElement, editor: Editor): void {
  registry.set(dom, editor);
}

export function unregisterHojaEditor(dom: HTMLElement): void {
  registry.delete(dom);
}

export function getHojaEditor(dom: HTMLElement): Editor | null {
  return registry.get(dom) ?? null;
}
