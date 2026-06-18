/**
 * ui/sidebar.js
 * Renders the folders sidebar (SRP: rendering + DOM events only).
 * Reads from features/folders.js + features/notes.js; emits nothing — calls
 * app-provided callbacks via the bus.
 */

import { folders } from '../features/folders.js';
import { notes } from '../features/notes.js';
import { account } from '../features/account.js';
import { profile } from '../features/profile.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';
import { store } from '../core/store.js';
import * as popup from './popup.js';
import * as dialog from './dialog.js';
import { accountModal } from './account.js';

const $ = (id) => document.getElementById(id);
let active = 'all';

export const sidebar = {
  get active() { return active; },

  init() {
    active = store.getPrefs().lastFolder || 'all';
    $('folder-title').textContent = folders.name(folders.all().find(f => f.id === active) || folders.all()[0]);

    $('folder-list').addEventListener('click', this._onClick);
    $('folder-list').addEventListener('contextmenu', this._onContext);
    $('new-folder-btn').addEventListener('click', this._onNewFolder);
    $('folder-sort-btn').addEventListener('click', (e) => this._showSortMenu(e.currentTarget));
    $('search-input').addEventListener('input', (e) => bus.emit('search:changed', e.target.value));
    // Click on the account bar → manage (connected) or set up (not connected).
    $('account-bar').addEventListener('click', () => accountModal.open());

    bus.on('notes:changed',  () => this.render());
    bus.on('folders:changed', () => this.render());
    bus.on('locale:changed', () => this.render());
    bus.on('account:changed', () => this.renderAccount());
    bus.on('profile:changed', () => this.renderAccount());
  },

  renderAccount() {
    const acc = account.current();
    const label = $('account-label');
    const email = $('account-email');
    const avatar = $('account-avatar');
    const nip05Badge = $('account-nip05-badge');

    if (acc) {
      const p = profile.current();
      const name = (p && (p.displayName || p.name)) || acc.displayName || account.shortNpub(acc.npub || '');
      label.textContent = name;
      email.textContent = acc.npub ? account.shortNpub(acc.npub) : '—';
      // Avatar: picture if available, else the first letter.
      const picture = p && p.picture;
      if (picture) {
        avatar.innerHTML = `<img src="${picture}" alt="" onerror="this.parentNode.textContent='${(name || 'N').slice(0,1).toUpperCase()}'">`;
      } else {
        avatar.textContent = (name || 'N').slice(0, 1).toUpperCase();
      }
      avatar.style.background = 'linear-gradient(135deg, var(--notes-blue), #8b5cf6)';
      // NIP-05 verified badge.
      const verified = !!(p && p.nip05 && p.nip05Verified);
      nip05Badge.classList.toggle('hidden', !verified);
      if (verified) nip05Badge.title = (p && p.nip05) || '';
      return;
    }

    label.textContent = 'Nostr';                                 // the local placeholder until the user sets up a real Nostr key
    email.textContent = '-';
    avatar.textContent = 'N';
    avatar.style.background = '';                                 // keep default avatar background
    nip05Badge.classList.add('hidden');
  },

  /** Select a folder; persists + notifies the rest of the app. */
  select(id) {
    active = id;
    store.setPrefs({ lastFolder: id });
    const f = folders.all().find(x => x.id === id);
    $('folder-title').textContent = folders.name(f);
    this.render();
    bus.emit('folder:selected', id);
  },

  render() {
    const all = folders.all();
    const allNotes = notes.all();
    const caret = `<button class="folder-caret" type="button" aria-label="More"
        data-folder-menu aria-haspopup="true" tabindex="-1">
      <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
    </button>`;
    $('folder-list').innerHTML = all.map(f => `
      <div class="folder-row ${f.system ? 'system' : ''} ${active === f.id ? 'active' : ''}" data-folder="${f.id}" role="button" tabindex="0">
        <span class="emoji">${f.icon}</span>
        <span class="name">${folders.name(f)}</span>
        <span class="count">${folders.count(f.id, allNotes)}</span>
        ${f.system ? '' : caret}
      </div>
    `).join('');
  },

  _onClick(e) {
    const caret = e.target.closest('[data-folder-menu]');
    if (caret) {
      e.stopPropagation();
      e.preventDefault();
      const row = caret.closest('[data-folder]');
      sidebar._showFolderMenu(caret, row.dataset.folder);
      return;
    }
    const row = e.target.closest('[data-folder]');
    if (!row) return;
    sidebar.select(row.dataset.folder);
  },

  /** Right-click on a user folder → context menu (desktop, macOS-style). */
  _onContext(e) {
    const row = e.target.closest('[data-folder]');
    if (!row) return;
    const f = folders.all().find(x => x.id === row.dataset.folder);
    if (!f || f.system) return; // system folders have no rename/remove
    e.preventDefault();
    sidebar._showFolderMenuAt(e.clientX, e.clientY, f.id);
  },

  /** Show the folder Sort By menu (mirrors the notes one). */
  _showSortMenu(anchor) {
    const current = folders.sortMode;
    const opts = [
      { id: 'manual',  labelKey: 'folders.sortManual'  },
      { id: 'name',    labelKey: 'folders.sortName'    },
      { id: 'created', labelKey: 'folders.sortCreated' },
    ];
    const body = [
      popup.header(i18n.t('folders.sortMenu')),
      ...opts.map(o =>
        popup.item({ id: o.id, label: i18n.t(o.labelKey), checked: current === o.id })
      ),
    ];
    popup.open(anchor, body, (id) => {
      if (!opts.some(o => o.id === id) || id === current) return;
      folders.sortMode = id;                       // setter persists + emits folders:changed → render()
      const opt = opts.find(o => o.id === id);
      bus.emit('toast', i18n.t('folders.sortToast', { mode: i18n.t(opt.labelKey) }));
    });
  },

  /** Open the per-folder popup anchored to a caret button. */
  _showFolderMenu(anchor, folderId) {
    const r = anchor.getBoundingClientRect();
    sidebar._showFolderMenuAt(r.left, r.bottom, folderId);
  },

  _showFolderMenuAt(x, y, folderId) {
    const f = folders.all().find(x => x.id === folderId);
    if (!f || f.system) return;
    const body = [
      popup.header(i18n.t('folders.title')),
      popup.item({ id: 'rename', label: i18n.t('folders.rename') }),
      popup.separator(),
      popup.item({ id: 'remove', label: i18n.t('folders.remove'), danger: true }),
    ];
    // Use a synthetic anchor so positioning follows the cursor/caret.
    const ghost = document.createElement('div');
    ghost.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;`;
    document.body.appendChild(ghost);
    popup.open(ghost, body, (action) => {
      ghost.remove();
      if (action === 'rename') sidebar._renameFolder(folderId);
      else if (action === 'remove') sidebar._removeFolder(folderId);
    });
  },

  async _renameFolder(id) {
    const f = folders.all().find(x => x.id === id);
    if (!f) return;
    const name = await dialog.prompt({
      title: i18n.t('folders.rename'),
      message: i18n.t('folders.renamePrompt'),
      value: f.name,
      confirmText: i18n.t('dialog.rename'),
      validate: (v) => v.trim() ? null : i18n.t('folders.emptyName'),
    });
    if (name == null) return;
    if (!name.trim()) return;
    folders.rename(id, name);
    if (active === id) $('folder-title').textContent = folders.name(folders.all().find(x => x.id === id));
  },

  async _removeFolder(id) {
    const f = folders.all().find(x => x.id === id);
    if (!f) return;
    const count = (notes.all().filter(n => n.folder === id)).length;
    const ok = await dialog.confirm({
      kind: 'danger',
      destructiveDanger: true,
      title: i18n.t('folders.remove'),
      message: count > 0
        ? i18n.t('confirm.removeFolderWithNotes', { name: f.name, count })
        : i18n.t('confirm.removeFolder', { name: f.name }),
      detail: i18n.t('confirm.removeFolderDetail'),
      confirmText: i18n.t('folders.remove'),
    });
    if (!ok) return;
    folders.remove(id);
    // If the active folder is gone, fall back to "All Notes".
    if (active === id) sidebar.select('all');
    bus.emit('toast', i18n.t('toast.folderRemoved'));
  },

  async _onNewFolder() {
    const name = await dialog.prompt({
      title: i18n.t('folders.new'),
      message: i18n.t('confirm.newFolder'),
      value: i18n.t('folders.defaultName'),
      confirmText: i18n.t('dialog.create'),
      validate: (v) => v.trim() ? null : i18n.t('folders.emptyName'),
    });
    if (name == null || !name.trim()) return;
    const f = folders.create(name);
    sidebar.select(f.id);
  },
};
