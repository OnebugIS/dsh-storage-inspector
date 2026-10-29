# dsh-storage-inspector

> A local storage map for DSH: see which part of `~/.dsh` takes the space, the largest files, what is safe to clean up — and why.

## What it does

`dsh-storage-inspector` is a DSH plugin. V1 ships two entry points that share one scanner:

- **Settings → Storage**: total usage in both physical and logical units, per-module breakdown, largest files, and three-tier advice;
- **Agent tool `storage_report`**: ask in chat; `summary` by default, `full` for the complete report.

Both read the same `lib/scan.js`, so there is exactly one implementation of the measuring rules.

## Safety and privacy

- Reads the DSH directory only (`~/.dsh` by default, `DSH_HOME` overrides);
- **Read-only in V1**: no delete, no move, no writes into the scanned tree, no network access;
- Never follows symbolic links; permission errors are skipped; hard links are de-duplicated by inode;
- The settings endpoint accepts loopback requests only, and rejects proxy headers and cross-site requests;
- `dsh-runtimes/` is marked **forbidden** because it holds DSH's bundled Node/Python/pnpm runtimes;
- `sessions/` gets no second delete path: it shows size and points to session-archive plugins;
- No `@deepseek-ai/*` runtime dependencies, so a `link:` install cannot resolve a second copy of the core packages.

## Units

The primary number is **disk-block usage** (`st_blocks × 512`), which matches Finder/`du` more closely. The logical size (`st_size` sum) is shown alongside it. A gap between them is normal: many small files inflate block usage.

## Install from source (development / personal use)

```bash
dsh plugin --profile desktop add \
  "link:/absolute/path/to/2_dsh-storage-inspector"
```

Restart DSH afterwards. Without HMR, edited plugin code also needs a restart.

> This project is still in the "test first, install only when the owner approves" phase. Do not modify a desktop profile without explicit permission.

## Install from npm (after publishing)

```bash
dsh plugin --profile desktop add dsh-storage-inspector
```

Before publishing: drop `private`, add `repository` / `homepage`, confirm the supported DSH versions, add screenshots, and check the tarball with `npm pack --dry-run`.

## Tool examples

```text
How much disk space does DSH use?
```

```json
{ "name": "storage_report", "arguments": { "detail": "summary" } }
```

```json
{ "name": "storage_report", "arguments": { "detail": "full" } }
```

## Development and tests

```bash
npm test
node --check lib/scan.js
node --check lib/index.js
node --check lib/client.js
```

Test layers:

- **White box**: fixture trees, permission/symlink/hard-link accounting, module classification, caching, advice construction, real `~/.dsh` integration;
- **Black box**: host tool contract, HTTP route loopback fence, settings-page request and 403 behaviour, post-install tool visibility and settings entry.

See `3_安装/上线部署方案.md`, `3_安装/测试方案.md` and `3_安装/验证清单.md` in the project folder.

## Release preflight

Maintainers can run:

```bash
npm test
npm run preflight
npm pack --dry-run
```

The package still declares `private: true`; it is published only after the real-install black-box pass and a two-week self-use period.

## Roadmap

- **V1**: read-only scan, dual units, module breakdown, top files, explainable advice, settings page + agent tool;
- **V2**: dry-run cleanup preview, allow-list, trash, undo log; `sessions/` stays with the dedicated archive plugins;
- **V3**: no permanent delete.

## License

MIT
