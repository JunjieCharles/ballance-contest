# BallanceMMO MockClient 指令集与 Windows 服务端下载

本文依据 BallanceMMO `main` 分支的 `BallanceMMOServer/client.cpp` 与 `server.yml` 整理。`BallanceMMOMockClient.exe` 是一个无需启动 Ballance 游戏的协议测试客户端，可模拟玩家状态、聊天、比赛消息，也可充当飞行记录器；它不是 `BallanceMMOServer.exe` 的服务端控制台。

## 获取最新 `server-windows` 包

仓库附带的 PowerShell 脚本会：

1. 查询 `main` 分支 `server.yml` 的成功工作流；
2. 选择第一个未过期、名称以 `server-windows-` 开头的产物；
3. 校验 GitHub 提供的 SHA-256 摘要；
4. 将包内文件统一解压到项目的 `server-windows/`，并用清单清理旧版本遗留文件。

先查看将要获取的产物（无需登录）：

```powershell
.\scripts\Get-LatestBallanceMMOServer.ps1 -ListOnly | Format-List
```

下载 Actions 产物需要 GitHub 身份验证。建议使用只对该公共仓库授予 **Actions: Read** 的 fine-grained token：

```powershell
$env:GH_TOKEN = 'github_pat_...'
.\scripts\Get-LatestBallanceMMOServer.ps1
```

也支持 `GITHUB_TOKEN`、`-Token`，或已登录的 GitHub CLI（`gh auth login`）。常用选项：

```powershell
# 只保留 ZIP
.\scripts\Get-LatestBallanceMMOServer.ps1 -ArchiveOnly

# 解压并同时保留 ZIP；覆盖同名本地产物
.\scripts\Get-LatestBallanceMMOServer.ps1 -KeepArchive -Force

# 指定分支或输出位置
.\scripts\Get-LatestBallanceMMOServer.ps1 -Branch main -OutputDirectory D:\BMMO
```

默认目录中的 `.ballancemmo-artifact.json` 记录当前安装版本和文件清单。更新时只会替换产物文件，本文档 `server-windows/README.md` 会保留。以上命令均假定当前目录是项目根目录。

截至 2026-06-29，脚本查询到的是：

- `server-windows-3.6.8-beta18-bd9e5de`
- 工作流运行 `27454689169`，提交 `bd9e5de288b1c2a2f64d33ffb003e82f70631a3b`
- 产物 ID `7606848578`，过期时间 `2026-09-11 03:04:35 UTC`

脚本每次都会在线查询，因此这里的快照过期后不需要修改脚本。

## 启动方法

最简启动：

```powershell
.\BallanceMMOMockClient.exe
```

默认连接 `127.0.0.1:26676`，默认名称为 `MockClient`。常见例子：

```powershell
.\BallanceMMOMockClient.exe -s 127.0.0.1:26676 -n TestBot
.\BallanceMMOMockClient.exe -s example.org:26676 -n Recorder -l mock.log --auto-flush
.\BallanceMMOMockClient.exe -r --individual-packets --no-sound-files
```

UUID 未显式指定时，程序会先尝试读取共享的客户端外部配置，再读取当前目录的 `mock_uuid.cfg`；均不可用时会生成 UUID 并写入 `mock_uuid.cfg`。源码中 `--help` 所写的固定默认 UUID 与当前实际逻辑不一致。

### 启动参数

| 参数 | 作用 |
| --- | --- |
| `-s, --server <地址:端口>` | 指定服务器，默认 `127.0.0.1:26676` |
| `-n, --name <名称>` | 指定客户端名称，默认 `MockClient` |
| `-u, --uuid <UUID>` | 显式指定 UUID，可带连字符 |
| `-l, --log <路径>` | 在标准输出之外追加写入日志文件 |
| `--auto-flush` | 每条日志输出后立刻刷新文件 |
| `-d, --detail <0..2>` | 网络日志详细程度，`0` 最低、`2` 最高 |
| `-r` / `--recorder-mode` | 飞行记录模式，将收到的数据写入 `records/record_*.bin`；默认名称会变成 `*FlightRecorder` |
| `--individual-packets` | 在记录模式下把每个包另存一份，可能产生大量文件 |
| `--no-sound-files` | 不保存服务端发来的声音文件 |
| `-p, --print` | 持续打印玩家状态变化 |
| `-h, --help` | 显示启动帮助 |
| `-v, --version` | 显示版本与构建时间 |

注意：当前源码把长参数 `--recorder-mode` 误声明成“必须带值”，但代码并不使用该值；可靠写法是短参数 `-r`。如果一定使用长参数，需要写成类似 `--recorder-mode=1`。

## 交互指令约定

连接后在 `> ` 提示符输入命令；命令名不区分大小写，参数按空格切分，不支持引号转义。`Tab` 可补全命令和在线玩家，方向键可访问历史。

- `<玩家>`：玩家名或 `#数字ID`，可用 `list` 查看。
- `<地图>`：原版关卡写作 `level <0..13>`；自定义图写作 `<32位MD5> <0..13>`。后一个数字是关卡号。
- `<模式>`：`hs` 表示高分模式，其他值按竞速模式处理，建议明确写 `sr`。
- 多数管理操作只是向服务端发请求，最终是否执行由服务端权限决定；`remotecommand` 明确仅限 superuser。

### 基础、连接与查询

| 指令 | 作用 |
| --- | --- |
| `help` | 列出所有已注册命令及别名（只列名称，不显示参数说明） |
| `stop` | 断开并退出客户端 |
| `reconnect [地址:端口]` | 连接线程已经结束后，重新连接原地址或新地址；仍在线时调用可能等待当前连接结束 |
| `list` / `l` | 列出客户端 ID、名称、作弊状态和延迟 |
| `getinfo` | 显示 Ping、远端连接质量和待发可靠数据量 |
| `getinfo-detailed` | 每 500 ms 刷新底层连接详情；输入 `q` 返回 |
| `print` | 切换“持续打印玩家状态变化” |
| `getmap` | 列出各玩家所在地图与区段 |
| `listmap` | 列出已知自定义地图的 MD5 与名称 |
| `getpos` | 列出玩家坐标与球类型 |
| `getbulletin` | 显示当前永久公告 |
| `realtime` | 显示根据服务端时间同步消息计算出的当前时间 |
| `flushlog` | 立即刷新日志文件 |

### 模拟本地玩家状态

| 指令 | 作用 |
| --- | --- |
| `move [x y z [qx qy qz]]` | 设置并发送绝对位置/旋转；不提供数值时随机生成，四元数 `w` 自动计算 |
| `translate [dx dy dz [dqx dqy dqz]]` | 在当前状态上增加位移/旋转分量并发送 |
| `teleport <玩家>` | 把 MockClient 的位置与旋转设为目标玩家当前状态 |
| `balltype <0|1|2>` | 设置球类型：`0` 纸、`1` 石、`2` 木 |
| `setmap level <关卡号>` | 把自身状态设为进入某个原版关卡 |
| `setmap <MD5> <关卡号> [地图名...]` | 把自身状态设为进入某个自定义地图，并可公布地图名 |
| `setsector <区段>` | 设置自身当前区段 |
| `cheat-self [on|off]` | 设置自身作弊状态；不带参数时切换 |

### 聊天、公告与管理请求

| 指令 | 作用 |
| --- | --- |
| `say <文本...>` / `s <文本...>` | 发送公共聊天 |
| `whisper <玩家> <文本...>` | 私聊指定玩家 |
| `announce <文本...>` | 发送醒目的 Announcement |
| `notice <文本...>` | `announce` 的别名，但消息类型为 Notice |
| `bulletin <文本...>` | 设置永久公告；空文本可用于清空 |
| `kick <玩家名> [原因...]` | 请求踢出玩家 |
| `crash <玩家名> [原因...]` | `kick` 的别名，但请求客户端崩溃 |
| `cheat <on|off>` | 请求全局开启或关闭作弊模式 |
| `restartlevel <玩家>` | 请求让指定玩家重开关卡 |
| `remotecommand <服务端命令...>` / `rc ...` | 以 superuser 身份请求服务端执行命令，只返回成功/失败，不返回命令输出 |

当前上游实现的 `kick/crash #ID` 分支会错误地从下一个参数再次读取 ID；在该版本中请优先用玩家名，避免把原因误读成 ID。

### 比赛与成绩模拟

| 指令 | 作用 |
| --- | --- |
| `countdown <地图> [sr|hs] [类型]` / `cd ...` | 发倒计时；省略类型时依次发送 `3,2,1,0`，类型 `0`=Go、`4`=Get ready、`5`=Confirm ready |
| `forcenextrestart` | 切换“下一次 Go 强制所有人重开并清空排名”的标志 |
| `dnf <地图> <区段>` | 发送未完成记录 |
| `win <地图> <sr|hs> <分数> <生命> <耗时秒>` | 发送完成关卡记录 |
| `scores <sr|hs> [地图]` | 向服务端请求排行榜；省略地图时使用最近一次倒计时地图 |
| `scores local <sr|hs> [地图]` | 显示客户端先前收到并缓存的排行榜，不请求服务端 |

示例：

```text
list
say hello from MockClient
setmap level 1
setsector 3
countdown level 1 sr 4
countdown level 1 sr
win level 1 sr 1200 3 42.5
scores sr level 1
```

## 上游依据

- MockClient 启动参数与交互命令：<https://github.com/Swung0x48/BallanceMMO/blob/main/BallanceMMOServer/client.cpp>
- Windows 服务端构建及产物命名：<https://github.com/Swung0x48/BallanceMMO/blob/main/.github/workflows/server.yml>
- Actions：<https://github.com/Swung0x48/BallanceMMO/actions>
- GitHub Actions artifact API：<https://docs.github.com/en/rest/actions/artifacts>
