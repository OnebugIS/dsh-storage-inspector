# dsh-storage-inspector

> **A safe local storage checkup for DSH.** Find what fills `~/.dsh`, inspect the largest files, and understand what may be reclaimed — without deleting or uploading anything.

[![Tests](https://img.shields.io/badge/tests-43%20passing-2ea44f?style=flat-square)](./test)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Read-only](https://img.shields.io/badge/design-read--only-8b5cf6?style=flat-square)](#safety-and-privacy)

> **V1 / read-only preview.** No delete, move, or upload operation is enabled. npm publishing and automatic cleanup are intentionally not enabled yet.

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [How it works](#how-it-works)
- [Safety and privacy](#safety-and-privacy)
- [Measurement units](#measurement-units)
- [Installation](#installation)
- [Usage](#usage)
- [Development and tests](#development-and-tests)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing and release](#contributing-and-release)

## Why this exists

DSH runtime files, sessions, caches, plugins, and logs can accumulate under `~/.dsh`. A directory listing alone does not answer three practical questions:

1. **How much disk space is actually used?** Finder, `du`, and logical file size can disagree;
2. **Where is the space?** You need module totals, cache classification, and largest files;
3. **What is safe to touch?** A large runtime or active configuration must not be deleted just because it looks large.

This plugin puts those rules in one scanner and exposes the same report through Settings and an Agent tool.

## Features

![Schematic storage dashboard](docs/storage-dashboard.svg)

> This is a **field-explanation schematic**, not a real machine screenshot; example values are illustrative.

| Capability | What it provides |
| --- | --- |
| Settings → Storage | Total usage, physical/logical units, module breakdown, top files, and tiered advice |
| `storage_report` | Ask in chat; `summary` by default, `detail=full` for the complete report |
| Explainable classification | `active`, `cache`, `runtime`, `sessions`, and `unknown` with reasons |
| Safety boundary | Read-only, offline, no symlink traversal, hard-link de-duplication, loopback endpoint |
| One source of truth | Settings and Agent tool share `lib/scan.js` |

## How it works

![Architecture: one scanner feeds the local DSH report to Settings and the Agent tool](docs/architecture.svg)

The scan pipeline:

1. Resolve `DSH_HOME`, falling back to `~/.dsh`;
2. Walk the tree and calculate physical-block and logical sizes;
3. Skip symlinks, de-duplicate hard links by inode, and continue past permission errors;
4. Classify modules, caches, and protected runtime directories;
5. Produce a top-files list and explainable `reclaimable / caution / forbidden` advice;
6. Serve the same report to Settings and `storage_report`.

## Safety and privacy

- **Read-only:** V1 never deletes, moves, renames, or writes into the scanned tree;
- **Local-only:** reads only the DSH directory (`~/.dsh` by default, or `DSH_HOME`);
- **Offline:** the scanner has no logic for uploading paths, filenames, or reports;
- **No symlink traversal:** prevents an accidental walk outside the DSH tree;
- **Least privilege:** permission-denied entries are skipped; no privilege escalation;
- **Loopback fence:** the Settings endpoint accepts local loopback requests only and rejects proxy headers and cross-site requests;
- **Runtime protection:** `dsh-runtimes/` is marked forbidden because it contains DSH's bundled Node/Python/pnpm;
- **Session boundary:** `sessions/` is measured but has no second delete path; use a dedicated session-archive tool;
- **Dependency isolation:** no `@deepseek-ai/*` runtime dependencies, avoiding a second core-package instance during `link:` installation.

## Measurement units

The primary number is **physical block usage**:

```text
physical bytes = st_blocks × 512
logical bytes  = sum of st_size for all files
```

Physical usage is closer to macOS Finder / `du`; logical usage is closer to the total file contents. A gap is normal, especially when many small files cause block-allocation overhead. The report shows both instead of hiding the difference.

## Compatibility and limitations

| Item | Current support / default |
| --- | --- |
| DSH | `>=0.2.1-rc.3` (declared in `package.json`) |
| Node.js | `>=20` |
| Platform | macOS local paths are covered by tests; validate filesystem-block semantics elsewhere |
| Scan boundary | DSH root only; never scans workspaces, project folders, or other system paths |
| Cache | 5 minutes by default (`cacheTtlMs=300000`) |
| Timeout | 10 seconds by default (`timeoutMs=10000`); returns scanned partial data and marks it incomplete |
| Permission errors | Entries are skipped; `complete=false` and `totals.skipped` increases |

When the cache is hit, the Settings “Rescan” action uses `force=1` to bypass it. A root fingerprint catches common changes; deep-file changes still fall back to the TTL, so force a rescan when freshness matters.

When `complete` is `false`, the numbers are **partial results**, not a complete disk inventory. The Settings page shows a scan-timeout/partial-result warning.

## Installation

### Quick start

1. Confirm the DSH and Node.js versions in the table above;
2. Install with the `link:` command below;
3. Restart DSH;
4. Start a new session and ask “How much disk space does DSH use?” to verify `storage_report`;
5. Open **Settings → Storage** for the visual report.

### From source (development / personal use)

Run this from the parent project and replace the path with your own:

```bash
dsh plugin --profile desktop add \
  "link:/absolute/path/to/DSH存储管理插件/2_dsh-storage-inspector"
```

Restart DSH afterwards. Without HMR, edited plugin code also requires a restart.

Remove it with:

```bash
dsh plugin --profile desktop remove dsh-storage-inspector
```

> This project follows “test first, explicit approval before installation”. Do not modify a desktop profile without the owner's permission.

### From GitHub

```bash
git clone https://github.com/OnebugIS/dsh-storage-inspector.git
cd dsh-storage-inspector
# then use the link: installation command above
```

### From npm (not available yet)

The planned command is:

```bash
dsh plugin --profile desktop add dsh-storage-inspector
```

`package.json` is still `private: true`; treat this as a future plan, not a currently available installation method.

## Usage

### Settings page

Open **Settings → Storage** in DSH to inspect:

- total physical usage and logical size;
- per-module totals and classifications;
- largest files;
- tiered advice for caches, active configuration, sessions, and runtimes;
- cache-hit and forced-refresh state.

### Agent tool

Ask in chat:

```text
How much disk space does DSH use?
```

The model can request a compact summary:

```json
{
  "name": "storage_report",
  "arguments": { "detail": "summary" }
}
```

For the largest-files list and full details:

```json
{
  "name": "storage_report",
  "arguments": { "detail": "full" }
}
```

`summary` omits the largest-files list and is better for everyday conversations; `full` includes detailed paths when you need them.

## Development and tests

Requirements: Node.js `>=20`.

```bash
npm test
npm run preflight
npm pack --dry-run
node --check lib/scan.js
node --check lib/index.js
node --check lib/client.js
```

The test suite covers:

- **White box:** fixtures, permissions, symlinks, hard links, physical/logical units, module tiers, caching, advice construction, and real `~/.dsh` integration;
- **Black box:** host-tool contract, HTTP loopback fence, Settings requests and 403 behaviour, disposer cleanup, and post-install tool/Settings visibility;
- **Release preflight:** manifest, patch insertion semantics, locales, icon, README, runtime files, and core dependency isolation.

Maintenance references: [deployment plan](../3_安装/上线部署方案.md), [test plan](../3_安装/测试方案.md), and [verification checklist](../3_安装/验证清单.md).

## Troubleshooting

### Settings says “local-only”

This is expected. Open Settings from DSH on the same machine; do not use a reverse proxy, remote port forward, or cross-site iframe.

### Numbers differ from Finder / `du`

Compare the same unit first. The primary number is physical block usage; logical size is shown separately. Filesystems, sparse files, hard links, and many small files can all create differences.

### Code changes are not visible

Confirm that the plugin is installed with `link:` and fully restart DSH. Without HMR, edited modules are not hot-reloaded.

### Can I delete `dsh-runtimes/` or `sessions/`?

Do not delete them directly. The former contains DSH's bundled runtimes; the latter belongs to session-archive tooling. V1 observes and explains but does not provide a delete button.

## Roadmap

- **V1 (current):** read-only scan, dual units, module breakdown, top files, explainable advice, Settings page + Agent tool;
- **V2 (planned):** dry-run cleanup preview, allow-list, trash, and undo log; `sessions/` remains with dedicated archive tooling;
- **V3 (principle):** no permanent-delete operation.

## Contributing and release

Issues and pull requests are welcome. Include:

- operating system and DSH version;
- `npm test` and `npm run preflight` results;
- reproduction steps and expected behaviour;
- whether paths, permissions, symlinks, or hard links are involved.

Never upload `.env` files, tokens, cookies, private keys, real session paths, or other sensitive data. Before release, pass tests, preflight, and `npm pack --dry-run`; confirm the tarball contains no `node_modules`, secrets, or workspace-specific absolute paths.

## License

MIT
