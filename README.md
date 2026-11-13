# av-sync-planner

JavaScript 音视频同步规划库，处理播放时钟、丢帧补偿、重复帧和连续性中断。

只做**规划**：根据音频采样位置（主时钟）和视频帧时间戳，决定下一批帧中哪些
显示（`display`）、丢弃（`drop`）、重复（`repeat`）或暂缓（`defer`）。
不做解码、不做播放器、不做界面，也不读取系统时间——相同输入序列必然得到
相同计划。

## 用法

```js
import { SyncPlanner } from 'av-sync-planner';

const planner = new SyncPlanner({ sampleRate: 48000, refreshRate: 60 });

// 每个播放节拍调用一次，传入音频设备已消耗的采样总数和待安排的帧
const { decisions } = planner.plan({
  audioSamplesPlayed: 96000,
  frames: [{ pts: 2.0, duration: 1 / 30 }, { pts: 2.033, duration: 1 / 30 }],
  audioBufferEmpty: false,
});
// decisions: [{ pts, action, reason, driftMs }, ...]

planner.notifySeek();          // seek 后进入重新同步阶段
planner.notifyDiscontinuity(); // 时间戳跳变
planner.setRefreshRate(144);   // 切到高刷新率显示器
```

每个决定都带有 `reason`（原因）和 `driftMs`（当前估算的音视频偏差，正数表示
视频领先音频）。

## 同步模型

- **音频为主时钟**：`audioSamplesPlayed / sampleRate` 是唯一时间基准，
  通过锚点 `{ audioSec, videoSec }` 映射到视频时间轴。
- **重新同步阶段**：开始播放、`notifySeek()`、`notifyDiscontinuity()`、
  `setRefreshRate()`、检测到音频时钟回退/大跳变、帧间隔超过 `longGapMs`
  时，丢弃全部内部状态进入 `resync`，以下一个有效帧重新锚定，不沿用旧队列。
- **小误差容忍**：|drift| ≤ `syncToleranceMs`（默认 40ms）直接显示。
- **可预测修正**：帧间隔与估计值（EMA）的偏差超过
  `durationToleranceRatio`（默认 50%）时，按估计值钳制后再参与调度
  （`duration-clamped`），而不是直接相信异常时间戳。
- **丢帧**：视频落后超过 `dropThresholdMs`（默认 120ms）时丢帧，锚点同步
  回退一个（钳制后的）帧长，让流追上时钟。
- **重复帧**：视频领先超过容忍度时重复上一帧（每帧最多 `maxRepeat` 次），
  且仅当音频时钟实际前进时才计入补偿。
- **空音频缓冲**：视频领先不允许超过 `maxVideoLeadMs`（默认 250ms），
  超出的帧返回 `defer`，由调用方稍后重新提交，不会无上限提前。
- **异常输入**：重复时间戳、乱序帧、零时长帧直接丢弃并给出原因；
  首帧晚到会被锚定并标记 `late-first-frame` 而不是丢弃。

## 测试

`node --test`：10 个测试全部通过（Node v22）。

- 可变帧率序列：帧顺序不反，无连续丢帧；
- 20 分钟持续时钟漂移（视频时基慢 0.1%）：丢帧 69 个（理论值 ≈72），
  偏差不累积；
- seek / 时间戳跳变 / 音频时钟回退：自动进入重新同步并重新锚定；
- 空音频缓冲：30 帧中仅显示 ≤9 帧，其余 defer，提前量被封顶；
- 60Hz → 144Hz 切换：重新锚定，无连续丢帧突发；
- 确定性：相同输入序列两次运行，计划完全一致（`deepStrictEqual`）。

## 算法限制

- 修正粒度是**整帧**（丢/重复），不做音频重采样或插帧，残余偏差在
  `syncToleranceMs` 以内。
- 假设 `audioSamplesPlayed` 单调且准确；音频时钟本身的漂移不在本库
  职责范围内。
- 帧时长估计使用 EMA，剧烈变化的 VFR 内容会被钳制到估计值附近调度，
  可能短暂偏离真实时间戳。
- `defer` 的帧不会被缓存，调用方必须自行保留并在后续 `plan()` 中重新
  提交。
- 刷新率需要调用方显式提供（`setRefreshRate`），本库不探测 vsync。
- 单视频流、单音频时钟；不支持多流切换或外部主时钟（如 PCIe PTP）。
