# BitOS Notes — Product & Engineering Plan

A cross-platform Notes app (Apple-Notes-class UX) built in **Flutter**, with **Nostr** as the sync/identity layer. One codebase → macOS, iOS/iPadOS, Web, Windows, Android.

---

## 1. Stack Recommendation (complete)

| Layer | Choice | Why |
|---|---|---|
| **Language** | **Dart** | Single language, sound null-safety, AOT for native, strong async model — ideal for a network-synced app. |
| **UI framework** | **Flutter** | You already know it. One codebase hits all 5 targets you picked. |
| **Rich text editor** | **`super_editor`** | Document model, selection, IME, markdown-in/out. `appflowy_editor` is the alt if you want block-based. |
| **Sync protocol** | **Nostr (NIPs)** | Decentralized, no backend to host, identity = keypair, works across all platforms, censorship-resistant. |
| **Encryption** | **NIP-44** (content) + **NIP-49** (key encrypt) | Modern, authenticated encryption for private notes at rest on relays. |
| **Local DB** | **Isar** (primary) or **Drift** (SQL) | Isar: fast NoSQL, query-by-object, great on all platforms incl. web (via WASM-ish). Drift if you prefer SQL + migrations. |
| **State management** | **Riverpod 2** | Type-safe, testable, no BuildContext coupling — best fit for a repository-driven app. |
| **Routing** | **`go_router`** | Declarative, deep-link friendly, web URL support. |
| **Key/secret storage** | **`flutter_secure_storage`** | Stores the user's `nsec` in OS keychain/keystore (not plain prefs). |
| **File/blobs** | **NIP-94 + Blossom servers** | Attachments referenced by URL + hash; uploaded to a Blossom/media relay. |
| **DI / app shell** | Riverpod providers | No extra framework needed. |

**Verdict:** Dart + Flutter + Nostr is the right and essentially complete answer for your targets. No backend to run.

---

## 2. Product scope — feature tiers

### Tier 0 — MVP (ship first, ~4–6 weeks solo)
Goal: a usable private note app that syncs across all your devices.

- [x] Create / edit / delete plain + markdown notes
- [ ] Notebooks (folders) with nesting (1–2 levels) _(flat folders shipped; nesting TBD)_
- [x] Pinned notes
- [x] Full-text search (local index)
- [x] Onboarding: generate keypair (nsec/npub), show npub, backup prompt
- [x] Nostr sync via NIP-44 encrypted parameterized-replaceable events
- [x] Local-first: read/write from Isar, sync in background
- [x] Multi-relay config (2–3 default relays, user-editable)
- [x] Offline mode + automatic reconnect/backfill
- [x] Dark / light theme

### Tier 1 — v1 (Apple Notes parity, ~next 6–10 weeks)
- [x] Checklists / toggles
- [ ] Tags (#hashtag inline + tag sidebar)
- [x] Rich text: bold/italic/headings/lists/code/quotes (via super_editor)
- [ ] Image attachments (NIP-94 + Blossom upload)
- [ ] Note sharing: public note (publish kind 30023 NIP-23 long-form) → shareable link _(share button copies a mock link; no 30023 publish yet)_
- [x] Import/export (.md, .json bundle) _(JSON export/import shipped; .md TBD)_
- [ ] Quick-capture (share-sheet on iOS, menu-bar Quick Note on macOS)
- [ ] Conflict handling: last-write-wins with timestamp + manual diff view _(LWW shipped; manual diff view TBD)_
- [ ] Multi-account / key switching

### Tier 2 — v2 (differentiators)
- [ ] Real-time collaboration: NIP-17 encrypted group DMs as shared notebooks
- [ ] CRDT rich text (Yjs/Automerge) for true concurrent editing
- [x] Sketch/draw canvas (perfect freehand on Apple Pencil / stylus) _(vector shapes + freehand pen; stylus pressure TBD)_
- [ ] Web Clipper (browser extension → posts note event)
- [ ] End-to-end encrypted backups (export encrypted bundle to file/cloud)
- [ ] Public note publishing: Nostr long-form feed, follow others' public notes
- [ ] Widgets (iOS home screen, macOS, Android)
- [ ] Reminders / due dates on checklist items

### Tier 3 — nice-to-have
- [ ] AI summarize / rewrite (optional, BYO key)
- [ ] OCR for images
- [ ] Voice notes (audio blob via Blossom)
- [ ] Local-only notebooks (never sync) for sensitive stuff

---

## 3. Architecture

```
┌─────────────────────────────────────────────┐
│  UI Layer (Flutter widgets, super_editor)    │
│   screens, editor, theme, adaptive layout    │
└───────────────┬─────────────────────────────┘
                │ Riverpod (watch/read)
┌───────────────▼─────────────────────────────┐
│  State / ViewModels (notifiers)              │
│   NoteListNotifier, EditorNotifier, SyncState│
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  Domain repositories (pure Dart, testable)   │
│   NoteRepository, NotebookRepository,        │
│   AttachmentRepository, SearchRepository     │
└──────┬───────────────────────┬──────────────┘
       │                       │
┌──────▼─────────┐   ┌─────────▼──────────────┐
│ Local (Isar)    │   │ Nostr layer            │
│ source of truth │◄──┤ NostrService           │
│ cache + index   │   │  - RelayPool           │
└─────────────────┘   │  - NIP-44 encrypt      │
                      │  - Event <-> Note map  │
                      └────────────────────────┘
```

**Key rule:** UI never talks to Nostr directly. Repositories expose a single API and decide whether to serve from Isar (instant) + enqueue a sync op. Nostr is an *eventually-consistent transport*, Isar is the *source of truth on device*.

---

## 4. Nostr sync design (the important part)

### Identity
- On first launch: generate secp256k1 keypair → `nsec` (private, stored in secure storage) + `npub` (public, shareable).
- The npub is the user ID. No email, no password, no server account.

### Event model — private notes
- **Kind `30078`** (application-specific parameterized replaceable) — best home for app-private data.
- `d` tag = note UUID (makes it replaceable/editable in place).
- `client` tag = `BitOS-notes`.
- `content` = **NIP-44-encrypted** JSON payload (title, body, notebook id, tags, updated_at, attachments).
- Because it's replaceable (`d` + pubkey), edits overwrite cleanly and relays keep only the latest.

Example event:
```jsonc
{
  "kind": 30078,
  "tags": [["d","<note-uuid>"], ["client","BitOS-notes"]],
  "content": "<nip44-encrypted-json>",
  "created_at": 1718600000,
  "pubkey": "<hex>"
}
```

### Public notes (sharing)
- Publish as **kind `30023`** (NIP-23 long-form content) with markdown body. Public, indexable, gets a `naddr` share link.

### Sync flow
1. **App open** → subscribe to all kind 30078 events for own pubkey across relay pool (with `since` = last-seen timestamp).
2. Incoming events → decrypt → upsert into Isar (skip if local `updated_at` is newer).
3. **Local edit** → write Isar → encrypt → publish to all relays (replaceable event).
4. **Deletion** → publish NIP-09 deletion request *and* publish an empty replacement (belt + suspenders, since not all relays honor NIP-09).

### Conflict resolution (v0)
- Last-write-wins on `updated_at`. Each note keeps `updated_at`; the higher one wins. Diff view in Tier 1 lets users recover anything lost.

### Relays
- Defaults: pick 2–3 reliable relays (e.g. `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`).
- Settings: add/remove/order relays. Health check + latency display.

### Attachments
- Upload image to a Blossom server (NIP-96/`BLOS` auth) → get URL + sha256.
- Store URL in note JSON + cache file locally for offline.

---

## 5. Data model (Isar)

```
Note
  id: String (uuid)             // = Nostr 'd' tag
  title: String
  bodyMarkdown: String          // canonical storage = markdown
  notebookId: String?
  tags: List<String>
  pinned: bool
  createdAt, updatedAt: DateTime
  nostrEventId: String?         // last published event id
  syncState: enum {synced, pending, error}
  deleted: bool                 // soft delete for tombstone handling

Notebook
  id, name, parentId?, icon, order

Attachment
  id, noteId, url, sha256, localPath, mimeType, size

RelayConfig
  url, read, write, enabled, lastOk
```

---

## 6. Project / folder layout

```
notes/
├── lib/
│   ├── main.dart
│   ├── app.dart                      // MaterialApp, router, theme
│   ├── core/
│   │   ├── crypto/                   // NIP-44, NIP-49 wrappers
│   │   ├── storage/                  // Isar setup + secure storage
│   │   └── di.dart                   // Riverpod providers
│   ├── data/
│   │   ├── nostr/
│   │   │   ├── nostr_service.dart    // RelayPool, pub/sub
│   │   │   ├── event_mapper.dart     // Note <-> Nostr event
│   │   │   └── relays.dart
│   │   ├── isar/
│   │   │   ├── collections/          // @collection classes
│   │   │   └── daos/
│   │   └── repositories/             // NoteRepository, etc.
│   ├── domain/                       // entities, business rules (pure)
│   ├── features/
│   │   ├── onboarding/               // keypair gen
│   │   ├── notes/                    // list, detail, editor
│   │   ├── editor/                   // super_editor wrapper
│   │   ├── notebooks/
│   │   ├── search/
│   │   ├── sync/                     // sync status UI
│   │   └── settings/                 // relays, backup, theme
│   └── ui/                           // shared widgets, theme, adaptive
├── test/
├── assets/
└── pubspec.yaml
```

---

## 7. Task backlog (ordered, ready to work)

> **Note:** The shipped app is a web/PWA build (HTML/CSS/ES modules) rather than
> the original Flutter target. The feature intent below is unchanged; the
> implementation column reflects what exists in `web/`. Items marked ✅ are
> implemented, ⚠️ partial, and unchecked are still open.

**Sprint 0 — Foundation (week 1)** ✅
1. ✅ Init project, configure target (PWA: installable, offline-capable, manifest + SW).
2. ✅ Add deps: hand-rolled Nostr core (`core/nostr.js`), NIP-44 (`core/nip44.js`), WebCrypto, IndexedDB.
3. ✅ Set up lint, CI, folder structure (SRP modules: `core/` · `features/` · `ui/`).
4. ✅ Theme system (light/dark/system + accent picker), adaptive scaffold (responsive 3-pane / mobile stack).

**Sprint 1 — Identity & storage (week 2)**
5. ✅ Keypair generation, nsec/npub (bech32) encode/decode, secure storage.
6. ✅ IndexedDB schema + migration, `Note`/`Folder` collections + write-through cache (`core/db.js`, `core/store.js`).
7. ✅ Onboarding screen (generate or import key, backup nsec flow) — full account-setup wizard.

**Sprint 2 — Local notes (week 3)**
8. ✅ NoteRepository CRUD backed by IndexedDB (`features/notes.js`).
9. ✅ Notes list screen (grouped by date, pinned section, sort modes).
10. ✅ Rich-text editor: contenteditable + format toolbar, autosave (`features/editor.js`).
11. ✅ Notebook sidebar + create/move/rename/remove + folder sort (`features/folders.js`, `ui/sidebar.js`).
12. ✅ Local full-text search (title + body + checklist).

**Sprint 3 — Nostr sync (week 4–5)** ⭐
13. ✅ RelayPool: connect, publish, subscribe, reconnect/backoff (`core/sync.js`).
14. ✅ NIP-44 encrypt/decrypt (`core/nip44.js`).
15. ✅ Event mapper Note ↔ kind 30078 (`core/sync.js` `itemPayload`/`reconcile`).
16. ✅ Background sync engine: subscribe-on-open, publish-on-change (debounced flush).
17. ✅ Sync status indicator + manual sync / retry (`ui/sync.js`).
18. ✅ Relay settings screen (add/remove, read/write flags, health test) (`ui/settings.js`, `features/relays.js`).
    - ✅ Bonus: Nostr profile (kind-0) fetch/edit/publish + NIP-05 verification (`features/profile.js`).

**Sprint 4 — Polish & ship MVP (week 6)**
19. ✅ Offline queue + conflict (LWW) handling.
20. ⚠️ Deletion tombstones. _(NIP-09 deletion events are parsed but applied as a local no-op in v0; soft-delete + trash folder work end-to-end.)_
21. ✅ Empty states, error handling, loading skeletons.
22. ✅ App icons, splash, store screenshots (icon, manifest, PWA meta).
23. ⚠️ Beta on TestFlight + internal Android + web deploy. _(Web/PWA deploy ready; native stores not started.)_

**Then Tier 1 / Tier 2 per roadmap above.**

---

## 8. Key risks & decisions to lock early

| Risk | Mitigation |
|---|---|
| Relay uptime varies | Multi-relay pool, write to N≥3, read from many; never block UI on relay. |
| User loses nsec = loses everything | Aggressive backup prompt on onboarding + encrypted export bundle. |
| NIP-44 impl bugs corrupt notes | Extensive unit tests with official test vectors; never overwrite Isar before successful decrypt. |
| super_editor markdown round-trip loss | Canonical store = markdown; keep editor as view, re-parse on load. |
| Large attachments | Blossom/NIP-94, lazy-load, thumbnail cache. |
| Web platform + crypto | Verify chosen Nostr lib works on web (secp256k1 in JS); fallback `pointycastle`. |

---

## 9. Open questions for you

1. **Public notes** — do you want social/publish features (follow others, public feed) or purely private first?
2. **Collaboration timing** — is shared notebooks a v1 must-have or can it wait for v2?
3. **Monetization** — free + relay cost, or paid? (Affects whether you run a branded relay.)
4. **Brand relay** — run your own Nostr relay for reliability + UX, or rely on public ones at MVP?

---

**Bottom line:** Build in **Dart + Flutter**, store local-first in **Isar**, sync with **Nostr** using **NIP-44-encrypted kind-30078 replaceable events**, rich text via **super_editor**, state via **Riverpod**. This is the complete, production-viable stack for all five platforms with zero backend to operate.
