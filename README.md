# BitOS Notes

**BitOS Notes** is a cross-platform, local-first notes application designed for an Apple Notes–class user experience. It uses **Flutter** for a single codebase across macOS, iOS/iPadOS, Web, Windows, and Android, with **Nostr** as the decentralized sync and identity layer.

The goal is to build a private, fast, offline-capable note-taking app with optional public sharing and future collaboration features.

---

## Vision

BitOS Notes aims to provide:

- A polished, Apple Notes–style interface
- Local-first editing with instant access to notes
- End-to-end encrypted sync through Nostr relays
- No central backend or hosted account system
- Cross-platform support from one codebase
- Optional public note publishing and sharing
- Future support for collaborative notebooks and rich media

---

## Recommended Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | **Dart** | Single language, sound null-safety, AOT native builds, strong async model |
| UI framework | **Flutter** | One codebase for mobile, desktop, and web |
| Rich text editor | **`super_editor`** | Document model, selection, IME, markdown import/export |
| Sync protocol | **Nostr** | Decentralized identity and sync without a backend |
| Encryption | **NIP-44** + **NIP-49** | Authenticated encrypted content and encrypted key storage |
| Local database | **Isar** | Fast NoSQL local database for source-of-truth cache and index |
| State management | **Riverpod 2** | Type-safe, testable, repository-driven state |
| Routing | **`go_router`** | Declarative routing with web URL support |
| Secret storage | **`flutter_secure_storage`** | Store private key securely in the OS keychain/keystore |
| Files / blobs | **NIP-94 + Blossom** | Attachment references by URL and hash |

**Architecture summary:** Flutter UI → Riverpod state → repositories → Isar local database + Nostr sync service.

---

## Product Roadmap

### Tier 0 — MVP

The first shippable version focuses on a usable private note app that syncs across devices.

- Create, edit, and delete plain and markdown notes
- Nested notebooks / folders
- Pinned notes
- Local full-text search
- Onboarding with generated keypair: `nsec` and `npub`
- Nostr sync using NIP-44-encrypted parameterized replaceable events
- Local-first storage with background sync
- Multi-relay configuration
- Offline mode with automatic reconnect and backfill
- Light and dark themes

### Tier 1 — v1

Apple Notes parity and broader usability.

- Checklists and toggles
- Tags and tag sidebar
- Rich text formatting: bold, italic, headings, lists, code, quotes
- Image attachments
- Public note sharing through NIP-23 long-form events
- Import/export as `.md` or encrypted `.json` bundle
- Quick-capture flows
- Conflict handling with last-write-wins and manual diff recovery
- Multi-account / key switching

### Tier 2 — v2

Differentiating features.

- Real-time collaboration using encrypted group DMs as shared notebooks
- CRDT rich text with Yjs or Automerge
- Sketch/draw canvas for stylus input
- Web clipper
- End-to-end encrypted backups
- Public note feed and following other public notes
- Home screen and desktop widgets
- Reminders and due dates for checklist items

### Tier 3 — Nice to Have

Optional future enhancements.

- AI summarize / rewrite with user-provided key
- OCR for images
- Voice notes as audio blobs
- Local-only notebooks for sensitive content

---

## Architecture

```text
┌─────────────────────────────────────────────┐
│ UI Layer                                     │
│ Flutter widgets, super_editor, theme, layout │
└─────────────────────┬───────────────────────┘
                      │ Riverpod
┌─────────────────────▼───────────────────────┐
│ State / ViewModels                           │
│ NoteList, Editor, SyncState                  │
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│ Domain Repositories                          │
│ NoteRepository, NotebookRepository, Search   │
└───────────────┬──────────────────┬──────────┘
                │                  │
┌───────────────▼────────┐ ┌───────▼────────────────┐
│ Local Database: Isar    │ │ Nostr Layer             │
│ Source of truth cache   │ │ RelayPool, NIP-44, mappers │
└────────────────────────┘ └────────────────────────┘
```

The key design rule is:

> The UI never talks to Nostr directly. Repositories expose a single API and decide whether to serve from Isar instantly, then enqueue sync work in the background.

Isar is the device source of truth. Nostr is the eventually consistent transport layer.

---

## Nostr Sync Design

### Identity

On first launch, the app generates a secp256k1 keypair:

- `nsec`: private key, stored securely using OS keychain/keystore
- `npub`: public identity, shareable with the user

There is no email, password, or hosted account.

### Private Notes

Private notes are stored as Nostr kind `30078` parameterized replaceable events.

```jsonc
{
  "kind": 30078,
  "tags": [["d", "<note-uuid>"], ["client", "bitos-notes"]],
  "content": "<nip44-encrypted-json>",
  "created_at": 1718600000,
  "pubkey": "<hex>"
}
```

The `d` tag is the note UUID, making each note replaceable and editable in place. The encrypted content contains the note title, body, notebook ID, tags, updated timestamp, and attachments.

### Public Notes

Public notes can be published as kind `30023` long-form events using NIP-23. These are public, indexable, and can be shared using `naddr` links.

### Sync Flow

1. App opens and subscribes to the user's kind `30078` events across configured relays.
2. Incoming encrypted events are decrypted and upserted into Isar.
3. Local edits are written to Isar immediately.
4. Sync service encrypts the note payload and publishes it to relays.
5. Deletion publishes both a NIP-09 deletion request and an empty replacement event.

### Conflict Resolution

The MVP uses last-write-wins based on `updated_at`. Later versions can add manual conflict review and diff recovery.

### Relays

Default relay candidates include:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.nostr.band`

The settings screen allows users to add, remove, order, enable/disable, and health-check relays.

---

## Data Model

### `Note`

```text
id: String              // UUID, also used as Nostr d tag
title: String
bodyMarkdown: String    // Canonical storage format
notebookId: String?
tags: List<String>
pinned: bool
createdAt: DateTime
updatedAt: DateTime
nostrEventId: String?
syncState: enum { synced, pending, error }
deleted: bool           // Soft delete tombstone
```

### `Notebook`

```text
id: String
name: String
parentId: String?
icon: String
order: int
```

### `Attachment`

```text
id: String
noteId: String
url: String
sha256: String
localPath: String?
mimeType: String
size: int
```

### `RelayConfig`

```text
url: String
read: bool
write: bool
enabled: bool
lastOk: DateTime?
```

---

## Proposed Project Structure

```text
notes/
├── lib/
│   ├── main.dart
│   ├── app.dart
│   ├── core/
│   │   ├── crypto/
│   │   ├── storage/
│   │   └── di.dart
│   ├── data/
│   │   ├── nostr/
│   │   │   ├── nostr_service.dart
│   │   │   ├── event_mapper.dart
│   │   │   └── relays.dart
│   │   ├── isar/
│   │   │   ├── collections/
│   │   │   └── daos/
│   │   └── repositories/
│   ├── domain/
│   ├── features/
│   │   ├── onboarding/
│   │   ├── notes/
│   │   ├── editor/
│   │   ├── notebooks/
│   │   ├── search/
│   │   ├── sync/
│   │   └── settings/
│   └── ui/
├── test/
├── assets/
└── pubspec.yaml
```

---

## Development Plan

### Sprint 0 — Foundation

1. Initialize Flutter project.
2. Configure macOS, iOS, Android, Web, and Windows targets.
3. Add dependencies:
   - `flutter_riverpod`
   - `go_router`
   - `isar`
   - `flutter_secure_storage`
   - `super_editor`
   - Nostr library
   - NIP-44 implementation
4. Set up formatting, linting, CI, and folder structure.
5. Implement theme system and adaptive scaffold.

### Sprint 1 — Identity and Storage

1. Generate and import `nsec` / `npub`.
2. Store private key securely.
3. Set up Isar schema and migrations.
4. Create `Note` and `Notebook` collections and DAOs.
5. Build onboarding flow.

### Sprint 2 — Local Notes

1. Implement local CRUD through `NoteRepository`.
2. Build notes list grouped by notebook with pinned section.
3. Integrate `super_editor` for markdown editing.
4. Add notebook sidebar and folder operations.
5. Implement local full-text search.

### Sprint 3 — Nostr Sync

1. Build `RelayPool` with connect, publish, subscribe, reconnect, and backoff.
2. Implement NIP-44 encryption/decryption with official test vectors.
3. Map notes to and from kind `30078` events.
4. Build background sync engine.
5. Add sync status indicator and manual retry.
6. Add relay settings screen.

### Sprint 4 — MVP Polish

1. Add offline queue and conflict handling.
2. Add deletion tombstones.
3. Improve empty states, loading states, and errors.
4. Add app icons, splash, and store screenshots.
5. Prepare beta builds for TestFlight, Android, and web.

---

## Key Risks and Decisions

| Risk | Mitigation |
|---|---|
| Relay uptime varies | Use multiple relays, write to several, read from many, never block UI on relay calls |
| User loses `nsec` | Strong backup prompt and encrypted export bundle |
| NIP-44 implementation bugs | Official test vectors and defensive local database updates |
| Rich text markdown round-trip loss | Store canonical markdown and treat editor as a view |
| Large attachments | Use Blossom/NIP-94, lazy loading, and thumbnail cache |
| Web crypto compatibility | Verify Nostr library works on web or use a Dart/JS fallback |

---

## Open Questions

1. Should public/social features be part of v1, or should the MVP be purely private?
2. Should shared notebooks and collaboration wait for v2?
3. Should the app be free, paid, or supported by a branded relay?
4. Should bitos run its own relay for reliability and UX?

---

## Current Status

This repository is in planning and foundation stage. The current plan defines the product roadmap, architecture, Nostr sync model, data model, and implementation milestones.
