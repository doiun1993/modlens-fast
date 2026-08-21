# modlens-fast

给 [ModLens](https://github.com/liustack/modlens)（DeepSeek Harness 的视觉插件）提速的**第三方补丁包**。

> ⚠️ 本项目不是 ModLens 官方的一部分，是社区修改。所有核心功能与荣耀归于 [@liustack/modlens](https://www.npmjs.com/package/@liustack/modlens)（MIT 协议）。

## 解决的问题

ModLens 默认策略是「识图模型产出**完整结构化证据契约**（摘要/OCR/版面/语义），再交给 DeepSeek 判断」。这带来两个开销：

1. **慢**：即使只问「这是谁」，识图模型也要生成整套证据（实测 ~10–13 秒），且其中大半内容被丢弃；
2. **二次思考**：DeepSeek 拿到证据后还要重新判断一遍，在高思考强度下再花 30 秒以上「deep dive」。

## 新策略（图片 + 问题直答）

- 识图模型**同时收到图片和用户问题**，直接输出**一句话答案**（如「雷军，小米创始人…」），不再生成整套证据；
- 答案作为既定事实交给 DeepSeek，**DeepSeek 不再二次思考图片**；
- 本轮消息带图时，DeepSeek 的推理档位被**自动置为 off**（后续纯文本追问不受影响）；
- **完整证据只在需要时提取**：`modlens_read_image` 工具仍保留原行为（转写全文、分析图表这类需求用它）。

实测：识图直答 **~2.5 秒**（原 ~10 秒+）。

## 安装

前置：已把 ModLens 装进 DSH 的 profile：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens@3.22.1
```

然后打补丁：

```sh
node modlens-fast-patch            # 默认补 web profile 下的 modlens
# 或指定其他 profile：
node modlens-fast-patch C:\Users\你\.dsh\profiles\<profile>\node_modules\@liustack\modlens\dsh\index.js
```

重启 DSH 生效。之后粘贴图片即可体验直答模式。

## 升级 ModLens 后

升级会覆盖补丁，重跑一次即可（脚本幂等，已打过会跳过）：

```sh
node modlens-fast-patch
```

## 兼容性

- 补丁目标版本：`@liustack/modlens@3.22.1`。
- 其他版本若代码结构变化，脚本会**报错退出**而不是静默打错。
- 轻量桥读取 `~/.modlens/config.json` 的 `openai` 引擎路由（baseUrl/apiKey/model）；非 openai 引擎时自动回退到 ModLens 原完整证据路径。

## 手动使用轻量桥

```sh
node modlens-fast -i <图片路径> --prompt "这是谁"
```

## 致谢与许可

- 基于 [ModLens](https://github.com/liustack/modlens)，作者 [Leon Liu (liustack)](https://github.com/liustack)。
- MIT 协议，见 [LICENSE](./LICENSE)。
- 本包与 ModLens 官方无关联，问题请提交到本仓库。
