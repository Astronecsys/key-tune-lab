# KEY//TUNE LAB 架构

本次拆分的原则是“保持声音、协议和界面行为不变，先建立可替换边界”。Python 仍是当前唯一的实时乐器后端；前端没有为了 GitHub Pages 而复制一套尚未验证的音律逻辑。

## 运行链路

```text
Web panel renderer
    ↓ selector / InstrumentStore
FastApiInstrumentClient（唯一网络边界）
    ↓ versioned HTTP + WebSocket contract
FastAPI app
    ↓
InstrumentRuntime（装配与兼容门面）
    ├─ ConfigurationService
    ├─ RecordingTrackService
    ├─ NoteRoutingService
    ├─ ChordAnalysisService
    ├─ InstrumentReadModelService
    ├─ PlaybackService / TrackService / EventBus
    └─ SynthPort → PolySynth → AudioOutputAdapter
```

## 修改功能时应去哪里

| 需求 | 首要模块 | 不应直接修改 |
|---|---|---|
| 新增/修改 API 请求 | `web/instrument-client.js`、`instrument/contracts.py`、`instrument/app.py` | 各面板中的裸 `fetch` |
| 新面板或面板绘制 | `web/panels/`、`panel-manifest.js` | `app.js` 中的大型绘制分支 |
| 新放映动作 | `presentation-actions.js` | 放映控制器中的条件链 |
| 律制、表面、映射配置 | `ConfigurationService` 与对应领域模块 | FastAPI 路由函数 |
| MIDI、虚拟键或播放轴发音 | `NoteRoutingService` | 分别维护三套 active-note 状态 |
| 录音或轨道生命周期 | `RecordingTrackService` / `TrackService` | 快照生成器 |
| 和弦 B 与关系分析 | `ChordAnalysisService` | DOM 渲染器 |
| HTTP/WebSocket 快照结构 | `InstrumentReadModelService`、`contracts.py` | 设备适配器 |
| DSP/消毛刺/voice | `synth.py` | `audio_output.py` |
| WASAPI、PortAudio、设备延迟 | `audio_output.py` | voice DSP |

`RuntimeServiceProxy` 是渐进重构期间共享同一运行时状态与锁的明确过渡层，不是新的全局状态。新增领域状态优先放入自己的 dataclass；不要继续扩大代理表面积。

## 合同与未来 TS 迁移

1. `schema_version` 是浏览器读模型的版本门槛；不兼容变更先升级合同和客户端验证。
2. 所有浏览器网络路径集中在 `FastApiInstrumentClient`，所以面板不会绑定 FastAPI 细节。
3. `tests/fixtures/domain/golden-v1.json` 保存音高表达式、EDO 编译和和弦关系等语言无关样例。
4. 若将来实现 TS 领域核心，先让它消费同一黄金向量，再在 `InstrumentClient` 后增加本地实现。
5. MIDI 与低延迟音频是否迁移，最后由浏览器 Web MIDI / Web Audio 的实测延迟、设备兼容性和离线需求决定；不影响前述面板模块。

## 验证门槛

每次跨边界修改至少运行：

```powershell
.\.panel-env\python.exe -m pytest -q
npm test
npm run test:e2e
```

音频路径还必须运行 `tests/test_audio_regression.py`。发布 wheel 前检查其中包含 `web/panels/*.js`，避免源码运行正常而安装包缺少面板模块。
