# @byted-codebase/tw-dashboard-installer

`tw-dashboard` 的一键安装包。把 dmg 直接打进 npm tarball,通过 bnpm 分发(byted 唯一不需要 SSO 的内网渠道)。

## 安装

```bash
npx -y --registry=https://bnpm.byted.org @byted-codebase/tw-dashboard-installer
```

如果 `~/.npmrc` 已经把 `@byted-codebase` scope 配到了 `https://bnpm.byted.org`,可以省掉 `--registry`:

```bash
npx -y @byted-codebase/tw-dashboard-installer
```

脚本流程:

1. 检测 macOS 架构(目前只发布 arm64)
2. 挂载内置 dmg
3. `ditto` 拷贝 `tw-dashboard.app` 到 `/Applications/`
4. `xattr -dr com.apple.quarantine` 去掉 macOS 隔离属性(**没有 codesign,这步必须**)
5. 卸载 dmg

完成后:

```bash
open -a tw-dashboard
```

## 主项目 / 源码

<https://code.byted.org/jiangyunong/tmux-worktree>(`app/` 目录)。
