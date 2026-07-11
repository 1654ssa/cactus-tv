# CactusStreamflow 仙人掌流式缓存

CactusStreamflow v0.8.0 使用 **Cloudflare Cache API**。它不需要 R2、Queue、信用卡或额外 Worker，只依赖原来的 Cloudflare Pages、Pages Functions 和 D1。

## 它怎么工作

播放 HLS 视频时，所有 m3u8、TS、M4S、初始化分片和密钥仍然经过 `/api/stream` 受控代理：

```text
播放器请求分片
  ↓
Pages Function 查询当前 Cloudflare 边缘节点缓存
  ├─ 命中：直接返回缓存内容
  └─ 未命中：访问片源，返回给播放器，并异步写入 Cache API
```

当观看位置达到总时长三分之一以后，浏览器每约 30 秒向 `/api/cache/heartbeat` 报告进度。Pages Function 会根据当前进度和“剩余时长的一半”计算目标区间，然后在一次请求允许的后台时间内，预取一小批尚未缓存的后续 HLS 对象。

页面隐藏或退出时，会再尝试预取最多 12 个对象。Cloudflare 对 HTTP 请求的 `waitUntil()` 只有有限的后台执行时间，因此本版本不会声称退出后一定能下载完整个剩余区间。

## 与旧 R2 版的区别

| 项目 | Cache API 版 | 旧 R2 版 |
|---|---|---|
| 信用卡 | 不需要 | 通常需要开通 R2 |
| 额外 Worker | 不需要 | 需要 |
| Queue | 不需要 | 需要 |
| 持久保存 | 不保证 | 可持久保存 |
| 跨地区共享 | 不保证 | 可以 |
| 退出后长时间下载 | 不支持 | 支持 |
| 播放过的分片加速 | 支持 | 支持 |
| 观看中预取 | 支持 | 支持 |
| 容量统计 | 不支持 | 支持 |

## 真实限制

Cloudflare Cache API 是临时边缘缓存，不是对象存储：

- 缓存只保存在处理当前请求的数据中心，不会自动复制到所有地区。
- 换网络、换城市或被调度到另一个 Cloudflare 节点后，可能重新回源。
- Cloudflare 可以随时淘汰不活跃对象，代码设置的 7 天 TTL 不是永久保存承诺。
- Cache API 不能列出全部对象，因此无法准确显示占用容量或分片数量。
- “重置边缘缓存”通过切换缓存代数实现；旧代数不再读取，旧对象由 Cloudflare 后续自动淘汰，并不是立即物理删除全球缓存。
- 只有经过受控代理的 HLS 点播能获得完整 Streamflow 功能。

## 支持范围

支持：

- HLS 点播 m3u8
- 主清单和多清晰度子清单
- TS 分片
- fMP4 / M4S 分片
- `EXT-X-MAP`
- AES-128 密钥
- HLS Byte Range
- 无 `.m3u8` 后缀但内容实际为 HLS 的地址

暂不进行智能预取：

- DASH / MPD
- 普通 MP4 的时间区间
- 直播 HLS
- DRM 视频
- 未开启播放代理的数据源

普通 MP4 和 DASH 仍可按原有播放器逻辑播放，只是不参与 CactusStreamflow 的 HLS 分片预取。

## 缓存规则

- 当前播放位置不足总时长三分之一：不预取。
- 达到三分之一：目标窗口从当前位置前约 18 秒开始，到“当前位置 + 剩余时长的一半”为止。
- 播放中每次心跳最多尝试缓存约 7 个对象。
- 暂停时最多尝试约 9 个对象。
- 页面隐藏或退出时最多尝试约 12 个对象。
- 实际播放请求本身也会把成功返回的分片写入边缘缓存。
- 视频分片默认缓存 TTL 为 7 天；密钥默认 6 小时，但都可能被 Cloudflare提前淘汰。

## 部署

v0.8.0 不新增任何 Cloudflare 资源。

保留原有：

```text
Cloudflare Pages
D1 binding: DB
ADMIN_TOKEN
其他现有环境变量
```

不需要：

```text
R2 Bucket
STREAMFLOW_R2
Queue
STREAMFLOW_QUEUE
streamflow-worker
0003_streamflow.sql
```

从 v0.7.0 R2 版升级时：

1. 用 v0.8.0 文件覆盖仓库。
2. 删除仓库里的 `streamflow-worker/`。
3. 删除 `migrations/0003_streamflow.sql`。
4. Cloudflare Pages 中可以删除 `STREAMFLOW_R2` 和 `STREAMFLOW_QUEUE` 绑定。
5. 如果此前创建过 R2、Queue 或独立 Worker，可以在确认不再使用后自行删除。
6. 保留原 D1 的 `DB` 绑定。
7. 重新部署 Pages。

旧版已经创建的 `streamflow_sessions`、`streamflow_objects`、`streamflow_hints` 三张 D1 表不会影响 v0.8.0。需要清理时可以在 D1 Console 手动执行：

```sql
DROP TABLE IF EXISTS streamflow_objects;
DROP TABLE IF EXISTS streamflow_hints;
DROP TABLE IF EXISTS streamflow_sessions;
```

这一步不是必须的。

## 数据源配置

进入 `/admin.html`，编辑正在使用的数据源：

1. 开启“播放代理”。
2. 把实际 m3u8、分片和密钥所在的 CDN 域名加入媒体域名白名单。
3. 域名只填写主机名，不写 `https://` 和路径。

例如：

```text
api.example.com
vod-cdn.example.net
segment.example-cdn.com
```

## 检查是否工作

打开：

```text
https://你的域名/api/health
```

应看到：

```json
{
  "streamflowReady": true,
  "streamflowEngine": "cache-api"
}
```

播放同一影片、同一集和同一线路时，视频分片响应头可能出现：

```text
x-cactus-streamflow: MISS
```

表示本次从片源读取，并已尝试写入边缘缓存。

再次命中时：

```text
x-cactus-streamflow: HIT
```

## 重置缓存

设置页点击“重置边缘缓存”后，D1 中的 `streamflow_cache_generation` 会变成一个新的数值。之后生成的播放地址使用新代数，旧代数对象不再命中。

这等同于逻辑清空，优点是不需要知道缓存中有哪些对象，也不需要 R2 的对象列表功能。

## 什么时候会明显加速

提升最明显的情况：

- 同一设备或同一地区第二次播放相同分片。
- 原片源跨境或偶尔抖动。
- 观看过程中预取速度高于实际播放消耗速度。
- 片源地址 Token 改变，但影片、集数、线路和分片序号保持一致。

提升不明显的情况：

- 第一次播放。
- 经常切换网络、地区或 Cloudflare 节点。
- Cloudflare 已淘汰缓存。
- 片源每次生成完全不同的分片结构。
- 视频不是 HLS 点播。
