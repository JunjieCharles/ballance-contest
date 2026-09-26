# 公开成绩页素材

仅用于公开成绩页；通过 `node scripts/build-public-score-assets.mjs` 生成内嵌资源清单，随服务构建复制到 dist。发布 HTML 不依赖额外素材请求、本机字体或目录。

- `Bank Gothic Medium BT.ttf`：用户提供的 `C:\Downloads\Bank Gothic Medium BT.ttf`，内部字体族 `BankGothic Md BT`，样式 Medium；不是 ModLoader 中内部名为 Event Horizon 的同名替代文件。
- `SmileySans-Oblique.ttf`：本机已安装的得意黑（atelierAnchor），用于统一比赛名的中英文与数字；SIL OFL 1.1 授权文本见 `SmileySans-LICENSE.txt`。`python scripts/build-public-title-font.py`（fonttools、brotli）生成按 Unicode 分组的 WOFF2 清单，只内嵌当前标题所需分组，支持任意受字体覆盖的比赛名，不依赖在线字体服务。
- `Sky_D_Front.bmp`：来自 `C:\Ballance\Textures\Sky`，用作天空背景。
- `Metal_stained.bmp`：来自 `C:\Ballance\Textures`，用于金属框架。
- `Player.ico`：从 `C:\Ballance\Bin\Player.exe` 的 RT_GROUP_ICON / RT_ICON 资源直接提取；`Player.png` 为其 64×64 原始图像，保留透明度，用作标题装饰。当前显示 50×50，无 AI 重绘或超分辨率。
- `Ball_Stone.bmp` 与对应 WebP 是上一版的石球纹理，保留供对照，当前页面不再打包使用。
- WebP 为对应 BMP 的浏览器优化副本（Pillow，quality=88）；原件保留供核对。字体使用原始 TTF。

上述游戏素材与字体由用户提供，其权利归各自权利人，不属于本项目原创代码授权范围。玩家名称使用 Arial / Microsoft YaHei 等系统字体以兼容中文与长名称。
