# KEY//TUNE LAB

一个只包含实时乐器工作台的独立项目：电子琴/MIDI 输入、微分音律制、泛音合成、和弦关系与可视化放映。

这个仓库不包含 Manim 学习、研究笔记或视频渲染管线，因此可以直接打包、分享给需要体验网页乐器的人。

## 最简单的启动方式（Windows）

双击根目录的 `start-panel.cmd`。第一次运行会自动用 Conda 创建 `.panel-env`，之后直接启动：

```powershell
.\start-panel.cmd
```

面板地址：<http://127.0.0.1:8765/>

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

- 每个面板右上角的“全屏”按钮会暂时隐藏其他面板；按 `Esc` 退出，不影响 MIDI、音频和播放轴。
- `WORKSPACE / LAYOUTS` 中可以保存多个命名布局，使用 ↑/↓ 编排顺序。
- “开始放映”按每个布局自己的停留时间自动切换；切换只改变视图，不停止音乐。
- 布局快照包含面板位置、显隐状态和频谱/莉萨如等显示参数。
- 展开“场景动作（JSON）”可以为布局附加烟雾测试式动作；动作在进入布局时按顺序执行。

动作配置示例：

```json
[
  {"type":"focus_panel","panel_id":"spectrumPanel"},
  {"type":"set_view","settings":{"spectrumHistory":true,"spectrumHistorySeconds":12}},
  {"type":"playback_start","track_id":"track-1"},
  {"type":"wait","seconds":8},
  {"type":"assert_state","path":"audio.running","equals":true},
  {"type":"toast","message":"频谱场景完成"}
]
```

当前支持 `focus_panel`、`set_panel_visibility`、`set_view`、`playback_start`、`playback_stop`、`recording_start`、`recording_stop`、`clear_spectrum_history`、`chord_basis`、`wait`、`assert_state` 和 `toast`。浏览器页面也暴露了 `window.KEY_TUNE_PRESENTATION`，可用 `getDocument()`、`select(id)`、`start()`、`stop()`、`setActions(id, actions)` 编排配置。

## 开发与测试

```powershell
.\.panel-env\python.exe -m pytest -q
npm test
```

主要代码：

```text
src/music_lab/instrument/   MIDI、合成器、律制与运行时
src/music_lab/web/          网页面板与布局放映
configs/tunings/            用户律制配置
tests/                      Python 与网页回归测试
```

网页布局数据保存在浏览器 Local Storage，不会写入 MIDI 或音频文件。
