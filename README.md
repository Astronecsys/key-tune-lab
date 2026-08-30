# KEY//TUNE LAB

一个只包含实时乐器工作台的独立项目：电子琴/MIDI 输入、微分音律制、泛音合成、和弦关系与可视化放映。

这个仓库不包含 Manim 学习、研究笔记或视频渲染管线，因此可以直接打包、分享给需要体验网页乐器的人。

## 最简单的启动方式（Windows）

双击根目录的 `start-panel.cmd`。第一次运行会自动用 Conda 创建 `.panel-env`，之后直接启动：

```powershell
.\start-panel.cmd
```

面板地址：<http://127.0.0.1:8765/>

首次安装使用仓库中的 `requirements-panel.lock` 固定 Python 依赖版本；更新 `pyproject.toml` 后应使用 `pip-compile --extra dev --strip-extras --no-emit-index-url` 重新生成锁文件。

常用参数：

```powershell
.\start-panel.cmd --no-audio
.\start-panel.cmd --no-browser
.\start-panel.cmd --midi-port "Digital Keyboard"
```

服务已启动时再次运行脚本只会打开现有页面，不会重复占用端口。关闭启动窗口或按 `Ctrl+C` 停止服务。

## 电子琴与声音

- 先通过 USB/MIDI 连接电子琴；默认查找名称包含 `Digital Keyboard` 的输入端口。
- 如果设备名称不同，使用 `--midi-port "名称片段"`。
- 想只听软件合成音色时，关闭电子琴 Local Control 或将琴自身音量静音。
- 软件音量在 03 `MAPPING COMPILER` 面板中。

## 布局与放映

- 工作台有两个独立桌面：`D1 演奏桌面`默认容纳乐器与可视化面板，`D2 布局桌面`默认容纳布局控制面板。
- 顶栏可以点击 `D1` / `D2` 切换；键盘快捷键是 `Alt+1` / `Alt+2`。切换桌面不会重建音频、MIDI 或播放状态。
- 在布局面板展开“面板桌面分配”，可以把任意面板移动到任一桌面；位置与归属都会保存在浏览器中。
- 每个面板右上角的“全屏”按钮会暂时隐藏其他面板；按 `Esc` 退出，不影响 MIDI、音频和播放轴。
- `WORKSPACE / LAYOUTS` 中可以保存多个命名布局，使用 ↑/↓ 编排顺序。
- “开始放映”按每个布局自己的停留时间自动切换；切换只改变视图，不停止音乐。
- 布局快照包含面板位置、显隐状态和频谱/莉萨如等显示参数。
- 展开“场景动作（JSON）”可以为布局附加烟雾测试式动作；动作在进入布局时按顺序执行。

动作配置示例：

```json
[
  {"type":"switch_desktop","desktop_id":"desktop1"},
  {"type":"focus_panel","panel_id":"spectrumPanel"},
  {"type":"set_view","settings":{"spectrumHistory":true,"spectrumHistorySeconds":12}},
  {"type":"playback_start","track_id":"track-1"},
  {"type":"wait","seconds":8},
  {"type":"assert_state","path":"audio.running","equals":true},
  {"type":"toast","message":"频谱场景完成"}
]
```

当前支持 `switch_desktop`、`focus_panel`、`set_panel_visibility`、`set_view`、`playback_start`、`playback_stop`、`recording_start`、`recording_stop`、`clear_spectrum_history`、`chord_basis`、`wait`、`assert_state` 和 `toast`。浏览器页面也暴露了 `window.KEY_TUNE_PRESENTATION`，可用 `getDocument()`、`select(id)`、`start()`、`stop()`、`setActions(id, actions)` 编排配置；`window.KEY_TUNE_DESKTOPS` 提供 `list()`、`active()`、`switch(id)`、`assignments()` 与 `movePanel(panelId, desktopId)`。

布局、放映与浏览器自定义音色统一保存在版本化的 `KeyTuneProject` 文档中。控制台可调用 `window.KEY_TUNE_PROJECT.exportJson()` 导出，或调用 `importJson(json)` 导入并刷新工作台。首次升级会自动读取旧 Local Storage，且不会删除旧键。

## 开发与测试

```powershell
.\.panel-env\python.exe -m pytest -q
npm test
npm run test:e2e
```

主要代码：

```text
src/music_lab/instrument/   MIDI、合成器、律制与运行时
src/music_lab/web/          网页面板与布局放映
configs/tunings/            用户律制配置
tests/                      Python 与网页回归测试
```

### 架构边界

- `InstrumentRuntime` 是面向 HTTP/WebSocket 的兼容门面；事件、播放、附加轨道与输出分析分别由独立服务持有。
- `tuning`、`input_surface` 和 `mapping` 分别表示“有哪些音”“有哪些物理输入”“如何桥接两者”，不要把 MIDI 键号当成音高身份。
- 网页的网络请求、遥测节流、布局几何和放映动作注册表彼此独立；新增放映动作应注册处理器，不再扩充总控条件分支。
- 音频回调只负责发声和写入观察 tap；FFT、相图与诊断读取不会改变任何 voice。

### 开放配置库

内置定义与用户定义使用同一份 JSON schema 和校验器：

```text
src/music_lab/presets/tunings/          内置律制
src/music_lab/presets/timbres/          内置音色
src/music_lab/presets/input_surfaces/   内置实体表面
src/music_lab/presets/mappings/         内置映射预设
configs/<同名目录>/                     本机用户定义（默认不提交）
```

增加历史律制或实验音色通常只需要增加 JSON；只有出现新的生成方式时才需要修改 Python。网页布局数据保存在浏览器 Local Storage，不会写入 MIDI 或音频文件。
