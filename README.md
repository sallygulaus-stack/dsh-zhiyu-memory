# dsh-zhiyu-memory

DeepSeek Harness 的本地记忆插件。记忆条目可回溯到原始对话证据，支持跨会话召回、纠正和隐藏召回。

## 安装

在 DSH 的「设置 → 插件 → 添加插件」中输入
`git+https://github.com/sallygulaus-stack/dsh-zhiyu-memory.git#main`，也可以使用 CLI。

```sh
dsh plugin --profile web add 'git+https://github.com/sallygulaus-stack/dsh-zhiyu-memory.git#main'
```

记忆数据默认存放在 `$DSH_HOME/companion-memory`。可在 profile 的 `cordis.patch.yml` 中覆盖 `companion-memory` 的 `root`。如果之前使用 `file:` 安装旧包，先备份数据，记录当前 `root`，移除旧包后安装 GitHub 版本，并让新包使用同一个 `root`。

`companion_memory` 是插件注册的工具名。若宿主配置了工具白名单，须允许该工具。`purge` 的范围是单条记忆声明，原始对话、归档和备份会保留。

## 开发

使用 Node.js 22 或以上版本运行 `npm test`。插件入口为 `plugin/lib/index.js`，`src/` 包含参考内核与迁移工具。

许可证为 MIT。
