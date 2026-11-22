# dsh-zhiyu-memory

DeepSeek Harness 的本地记忆插件。记忆条目可回溯到原始对话证据，支持跨会话召回、纠正和隐藏召回。

## 安装

在支持 Git 插件更新的 DSH（已验证 `0.2.2-rc.3`）中，打开「插件 → 实验性插件」，启用「自定义插件索引」。在「发现」中添加以下索引，再从搜索结果安装。

```text
https://raw.githubusercontent.com/sallygulaus-stack/dsh-zhiyu-memory/main/market-index.json
```

有新版时在「发现」页确认更新。索引将每个版本固定到其 Git 提交。此前通过分支地址安装的版本，可从索引重新安装一次，切换到固定提交来源。

也可以通过 CLI 安装分支版本。这个入口适用于没有 Git 更新按钮的宿主。

```sh
dsh plugin --profile web add 'git+https://github.com/sallygulaus-stack/dsh-zhiyu-memory.git#main'
```

记忆数据默认存放在 `$DSH_HOME/companion-memory`。可在 profile 的 `cordis.patch.yml` 中覆盖 `companion-memory` 的 `root`。如果之前使用 `file:` 安装旧包，先备份数据，记录当前 `root`，移除旧包后安装 GitHub 版本，并让新包使用同一个 `root`。

`companion_memory` 是插件注册的工具名。若宿主配置了工具白名单，须允许该工具。`purge` 的范围是单条记忆声明，原始对话、归档和备份会保留。

## 开发

使用 Node.js 22 或以上版本运行 `npm test`。插件入口为 `plugin/lib/index.js`，`src/` 包含参考内核与迁移工具。

发版时提升 `package.json` 版本并提交。给该提交打对应的 `v` 标签，将版本号、提交 SHA 和发布时间（Unix 秒）追加到 `market-index.json`，再推送索引和标签。

许可证为 MIT。
