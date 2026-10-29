# dsh-storage-inspector

> DSH 的本地存储地图：看清 `~/.dsh` 哪个模块占空间、最大的文件在哪里、哪些内容可以清理，以及为什么不能随便删。

## 这是什么

`dsh-storage-inspector` 是一个面向 DSH 用户的插件，V1 提供两个入口：

- **设置 → 存储**：图形化查看总量、物理/逻辑双口径、模块占用、最大文件和三层建议；
- **Agent 工具 `storage_report`**：在对话里询问 DSH 存储占用，默认返回摘要，`detail=full` 返回完整报告。

两个入口共用 `lib/scan.js`，不维护两套扫描逻辑。

## 安全与隐私

- 只读取 DSH 目录，默认是 `~/.dsh`，也可由 `DSH_HOME` 指定；
- V1 **纯只读**：不删除、不移动、不写入扫描目录，不联网；
- 不跟随符号链接，权限拒绝会跳过；硬链接按 inode 去重；
- 设置页接口只接受本机 loopback 请求，并拒绝反向代理头与 cross-site 请求；
- `dsh-runtimes/` 会标记为「禁止」，因为它包含 DSH 自带的 Node/Python/pnpm 运行时；
- `sessions/` 不提供第二套删除入口，只显示体积并指向会话归档类插件；
- 包不依赖任何 `@deepseek-ai/*` 运行时包，避免 `link:` 安装时解析到第二份核心实例。

## 口径

设置页的主数字使用**物理块大小**（`st_blocks × 512`），与 macOS 的 Finder/`du` 更接近；同时显示**逻辑大小**（`st_size` 之和）。两者不同是正常现象：大量小文件会产生块分配放大。

## 从源码安装（开发/自用）

```bash
# 在 DSH 存储管理插件项目目录执行
# 绝对路径按你的工作区实际位置填写
dsh plugin --profile desktop add \
  "link:/path/to/DSH存储管理插件/2_dsh-storage-inspector"
```

安装后重启 DSH。没有启用 HMR 时，修改插件代码也需要重启才能加载新模块。

> 本项目当前阶段遵循「先完成白盒/黑盒测试，再由使用者授权安装」。不要在未经授权的情况下改写 desktop profile。

## 从 npm 包安装（发布后）

```bash
dsh plugin --profile desktop add dsh-storage-inspector
```

发布前需要把 `package.json` 的 `private` 去掉、补充 `repository` / `homepage`、确认兼容版本和 README 截图，再执行 `npm pack --dry-run` 检查包内文件。

## 工具示例

```text
DSH 占多少空间？
```

模型可以调用：

```json
{
  "name": "storage_report",
  "arguments": { "detail": "summary" }
}
```

完整报告：

```json
{
  "name": "storage_report",
  "arguments": { "detail": "full" }
}
```

## 开发测试

```bash
npm test
node --check lib/scan.js
node --check lib/index.js
node --check lib/client.js
```

测试分为：

- **白盒**：临时 fixture、权限/符号链接/硬链接口径、模块分级、缓存、建议构造、真实 `~/.dsh` 集成扫描；
- **黑盒**：Host 工具注册契约、HTTP 路由 loopback 栅栏、设置页请求与 403 行为、安装后新会话工具可见性和设置页入口。

详见项目目录下的 `3_安装/上线部署方案.md`、`3_安装/测试方案.md`、`3_安装/验证清单.md`。

## 发布前预检

源码维护者可运行：

```bash
npm test
npm run preflight
npm pack --dry-run
```

当前包仍是 `private: true`，真实安装黑盒和自用两周通过后才会公开发布。

## 版本计划

- **V1**：只读扫描、双口径、模块占用、Top 文件、可解释建议、设置页 + Agent 工具；
- **V2**：dry-run 清理预览、白名单、废纸篓、undo 日志；`sessions/` 继续交给专门的会话归档插件；
- **V3**：不做直接永久删除。

## License

MIT

