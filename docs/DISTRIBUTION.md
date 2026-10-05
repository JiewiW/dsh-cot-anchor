# cot-anchor 插件分发方式（v0.1.0）

发布渠道选择：仅通过 GitHub Releases 拉 tarball，不走 npm。

理由：npm 2026 后引入的反钓鱼冷却 + 强制 2FA + 一次性批准 URL 设计，
对个人开源项目作者摩擦成本过高（详见 2026-10-05 工作日志）。

## 用户安装方式

一行命令：

```sh
dsh plugin --profile <你的 profile> add github:JiewiW/dsh-cot-anchor#v0.1.0
```

或先下载 tarball：

```sh
gh release download v0.1.0 --repo JiewiW/dsh-cot-anchor
dsh plugin --profile <你的 profile> add ./dsh-cot-anchor-0.1.0.tgz
```

或锁定某个 commit（推荐，用于自动化）：

```sh
dsh plugin --profile <你的 profile> add github:JiewiW/dsh-cot-anchor#<commit-sha>
```

## 用户发现路径

GitHub 仓库地址就是发现地址：

```
https://github.com/JiewiW/dsh-cot-anchor
```

任何能搜到 `dsh-cot-anchor` 的人都能找到。

## 后续如何被发现更多

- 在 DSH 社区、论坛、README 中被引用
- GitHub search、Topic 标签（`dsh`, `dsh-plugin`, `cot`）已设置
- 需要被 `dsh-web` 社区插件索引收录时，可在 https://github.com/JiewiW/dsh-web/issues
  提一个 PR 加进 `packages/dsh-community-plugins/community.json`（条目内容见本仓库
  当时的 `community-entry.json` 草案，按彼时格式调整即可）

## 不再追的旧路径（已弃）

- npm：不再维护 npm 分发路径，统一走 GitHub Releases。
- 旧索引条目保留作档案参考。
