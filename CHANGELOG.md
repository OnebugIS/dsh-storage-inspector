# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-29

### 新增

- 只读扫描 `~/.dsh` 的物理块大小与逻辑大小。
- 按模块、缓存、运行时、会话和未知目录分类展示占用。
- 提供 `storage_report` Agent 工具与设置页存储面板。
- 提供最大文件榜和分级建议：可回收、谨慎处理、禁止触碰。
- 默认不删除、不移动、不联网、不跟随符号链接，并对硬链接去重。
- 支持 macOS 本机路径、扫描超时、权限跳过、缓存与强制刷新。

### 发布准备

- npm 包公开发布前移除 `private` 限制。
- 将 README 使用的 `docs/` 图示纳入发布包。
