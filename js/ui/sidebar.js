/**
 * ui/sidebar.js
 * Renders the folders sidebar (SRP: rendering + DOM events only).
 * Reads from features/folders.js + features/notes.js; emits nothing — calls
 * app-provided callbacks via the bus.
 */

import { folders } from '../features/folders.js';
import { notes } from '../features/notes.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';
import { store } from '../core/store.js';

const $ = (id) => document.getElementById(id);
let active = 'all';

export const sidebar = {
  get active() { return active; },

  init() {
    active = store.getPrefs().lastFolder || 'all';
    $('folder-title').textContent = folders.name(folders.all().find(f => f.id === active) || folders.all()[0]);

    $('folder-list').addEventListener('click', this._onClick);
    $('new-folder-btn').addEventListener('click', this._onNewFolder);
    $('search-input').addEventListener('input', (e) => bus.emit('search:changed', e.target.value));

    bus.on('notes:changed',  () => this.render());
    bus.on('folders:changed', () => this.render());
    bus.on('locale:changed', () => this.render());
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
    $('folder-list').innerHTML = all.map(f => `
      <button class="folder-row ${f.system ? 'system' : ''} ${active === f.id ? 'active' : ''}" data-folder="${f.id}">
        <span class="emoji">${f.icon}</span>
        <span class="name">${folders.name(f)}</span>
        <span class="count">${folders.count(f.id, allNotes)}</span>
      </button>
    `).join('');
  },

  _onClick(e) {
    const row = e.target.closest('[data-folder]');
    if (!row) return;
    // right-click / long-press → rename/remove on user folders (basic)
    sidebar.select(row.dataset.folder);
  },

  async _onNewFolder() {
    const name = prompt(i18n.t('confirm.newFolder'), i18n.t('folders.defaultName'));
    if (!name) return;
    const f = folders.create(name);
    sidebar.select(f.id);
  },
};
