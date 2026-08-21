#!/usr/bin/env node
// repatch.mjs
// 给 modlens 插件打「按问题直答」补丁，升级后一键还原。
// 幂等：已打过的补丁会跳过；打完后自动跑 node --check 校验语法。
//
// 用法: node repatch.mjs [dsh/index.js 路径]
// 默认路径: ~/.dsh/profiles/web/node_modules/@liustack/modlens/dsh/index.js
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@liustack', 'modlens', 'dsh', 'index.js')

// fast-cli 会被复制进 modlens 包根目录，嵌入路径用「相对形式」：
// 本机安装与发布仓库之间没有任何绝对路径引用，完全解耦。
const FAST_CLI_LINE = "const FAST_CLI_PATH = process.env.MODLENS_FAST_CLI || fileURLToPath(new URL('../fast-cli.mjs', import.meta.url))"

// 每个补丁：id、是否已应用（guard）、应用函数（返回新文本，找不到 old 时抛错）。
const patches = [
  {
    id: 'fast-cli-constant',
    guard: (s) => s.includes(FAST_CLI_LINE),
    apply: (s) => {
      const existing = /const FAST_CLI_PATH = [^\n]+\n/.exec(s)
      if (existing) {
        // 已打过旧版（绝对路径行）→ 原地换成相对形式
        return s.slice(0, existing.index) + FAST_CLI_LINE + '\n' + s.slice(existing.index + existing[0].length)
      }
      // 未打过 → 在 CLI_PATH 行后插入
      const anchor = "const CLI_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url))"
      const i = s.indexOf(anchor)
      if (i === -1) throw new Error(`未找到 CLI_PATH 锚点，modlens 版本可能已变化`)
      const end = i + anchor.length
      return s.slice(0, end) + '\n' +
        '// 轻量「按问题直答」视觉桥：自动读图路径用它，视觉模型直接回答用户问题，\n' +
        '// 而非生成整套证据契约再丢弃大半。可用 MODLENS_FAST_CLI 环境变量覆盖。\n' +
        FAST_CLI_LINE + s.slice(end)
    },
  },
  {
    id: 'question-helper',
    guard: (s) => s.includes('function questionOfMessage(message)'),
    apply: (s) => replaceOnce(s,
      "function contentHasImage(blocks) {",
      "// 从一条消息里抽取用户文字问题：自动读图按它聚焦视觉模型输出，\n" +
      "// 也参与证据缓存键，避免同一张图被两个不同问题误命中。\n" +
      "function questionOfMessage(message) {\n" +
      "  if (!Array.isArray(message?.content)) return ''\n" +
      "  return message.content\n" +
      "    .filter((b) => b?.type === 'text' && typeof b.text === 'string')\n" +
      "    .map((b) => b.text)\n" +
      "    .join(' ')\n" +
      "    .trim()\n" +
      "}\n\n" +
      "function contentHasImage(blocks) {"),
  },
  {
    id: 'read-block-signature',
    guard: (s) => s.includes('async function readImageBlock(ctx, block, signal, question)'),
    apply: (s) => replaceOnce(s,
      "async function readImageBlock(ctx, block, signal) {",
      "async function readImageBlock(ctx, block, signal, question) {"),
  },
  {
    id: 'timeout-constants',
    guard: (s) => s.includes('const FAST_TIMEOUT_MS'),
    apply: (s) => replaceOnce(s,
      "const CLI_TIMEOUT_MS = 180_000",
      "const CLI_TIMEOUT_MS = 180_000\n" +
      "// 快速直答通道的硬超时：引擎卡住时最迟 20 秒放弃并回退，避免沉默数分钟。\n" +
      "const FAST_TIMEOUT_MS = 20_000\n" +
      "// 回退到完整证据 CLI 时的超时上限（同一引擎可能同样卡顿）。\n" +
      "const FALLBACK_TIMEOUT_MS = 60_000"),
  },
  {
    id: 'fast-cli-invocation',
    guard: (s) => s.includes('String(FALLBACK_TIMEOUT_MS)'),
    apply: (s) => {
      const V4_BLOCK =
        "    const fastArgs = [FAST_CLI_PATH, '-i', file, '--timeout', String(FAST_TIMEOUT_MS)]\n" +
        "    const q = question?.trim()\n" +
        "    if (q) fastArgs.push('--prompt', q.slice(0, 1000))\n" +
        "    let { stdout, stderr, code } = await run(process.execPath, fastArgs, signal)\n" +
        "    if (code !== 0) {\n" +
        "      // 轻量桥超时/不可用（引擎卡顿、非 openai、网络错）时，快速回退到完整证据 CLI。\n" +
        "      const slowArgs = [CLI_PATH, '-i', file, '--timeout', String(FALLBACK_TIMEOUT_MS)]\n" +
        "      if (q) slowArgs.push('--prompt', q.slice(0, 1000))\n" +
        "      const slow = await run(process.execPath, slowArgs, signal)\n" +
        "      stdout = slow.stdout\n" +
        "      stderr = slow.stderr\n" +
        "      code = slow.code\n" +
        "    }\n" +
        "    if (code !== 0) {"
      const PRISTINE =
        "    const cli = process.env.MODLENS_DSH_CLI || CLI_PATH\n" +
        "    const { stdout, stderr, code } = await run(\n" +
        "      process.execPath,\n" +
        "      [cli, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],\n" +
        "      signal,\n" +
        "    )\n" +
        "    if (code !== 0) {"
      if (s.includes(PRISTINE)) {
        return replaceOnce(s, PRISTINE, V4_BLOCK)
      }
      // 已打过旧版（fastArgs 用 CLI_TIMEOUT_MS）→ 整块替换为带短超时的 v4
      const region = /const fastArgs = \[FAST_CLI_PATH[\s\S]*?\n    \}\n    if \(code !== 0\) \{/
      const m = s.match(region)
      if (!m) throw new Error(`未找到 fastArgs 区域，modlens 版本可能已变化`)
      return s.slice(0, m.index) + V4_BLOCK + s.slice(m.index + m[0].length)
    },
  },
  {
    id: 'cache-signature',
    guard: (s) => s.includes('q: question?.trim() ?? \'\''),
    apply: (s) => replaceOnce(s,
      "function cachedEvidence(ctx, adapter, block, walk) {\n  const key = evidenceKey(block.attachment ?? block)",
      "function cachedEvidence(ctx, adapter, block, walk, question) {\n  const key = evidenceKey({ a: block.attachment ?? block, q: question?.trim() ?? '' })"),
  },
  {
    id: 'cache-read-call',
    guard: (s) => s.includes('readImageBlock(ctx, block, undefined, question)'),
    apply: (s) => replaceOnce(s,
      "const pending = readImageBlock(ctx, block, undefined).then(",
      "const pending = readImageBlock(ctx, block, undefined, question).then("),
  },
  {
    id: 'convert-call-site',
    guard: (s) => s.includes('abortableWait(cachedEvidence(ctx, adapter, block, walk, question)'),
    apply: (s) => replaceOnce(s,
      "      const content = await convertBlocks(message.content, (block) =>\n        abortableWait(cachedEvidence(ctx, adapter, block, walk), signal),\n      )",
      "      const question = questionOfMessage(message)\n      const content = await convertBlocks(message.content, (block) =>\n        abortableWait(cachedEvidence(ctx, adapter, block, walk, question), signal),\n      )"),
  },
  {
    id: 'autoread-call-site',
    guard: (s) => s.includes('abortableWait(cachedEvidence(ctx, { evidenceCache }, block, walk, question)'),
    apply: (s) => replaceOnce(s,
      "        const content = await convertBlocks(message.content, (block) =>\n" +
      "          // The same cache the wrapper routes use: auto-read used to re-read\n" +
      "          // every image on every step, healthy engine or not (issue #68).\n" +
      "          abortableWait(cachedEvidence(ctx, { evidenceCache }, block, walk), payload.signal),\n" +
      "        )",
      "        const question = questionOfMessage(message)\n" +
      "        const content = await convertBlocks(message.content, (block) =>\n" +
      "          // The same cache the wrapper routes use: auto-read used to re-read\n" +
      "          // every image on every step, healthy engine or not (issue #68).\n" +
      "          abortableWait(cachedEvidence(ctx, { evidenceCache }, block, walk, question), payload.signal),\n" +
      "        )"),
  },
  {
    id: 'image-question-helper',
    guard: (s) => s.includes('function lastMessageIsImageQuestion(messages)'),
    apply: (s) => {
      const NEW_HELPER =
        "// 本轮首条输入是否带图片：只看最后一条消息。图片问题得到直答后，模型继续\n" +
        "// 执行其他行动（工具调用等）时，最后一条消息不再是该图，推理档位自动回到\n" +
        "// 会话默认值。\n" +
        "function lastMessageIsImageQuestion(messages) {\n" +
        "  if (!Array.isArray(messages) || messages.length === 0) return false\n" +
        "  const last = messages[messages.length - 1]\n" +
        "  return last?.role === 'user' && contentHasImage(last.content)\n" +
        "}"
      // 旧版 helper（latestUserHasImage）→ 整块换成新 helper
      const oldRe = /\/\/ 本轮「新」输入是否带图片[\s\S]*?\n}\n/
      const m = s.match(oldRe)
      if (m) {
        return s.slice(0, m.index) + NEW_HELPER + '\n' + s.slice(m.index + m[0].length)
      }
      // 纯净文件 → 在 contentHasImage 之后插入
      return replaceOnce(s,
        "function contentHasImage(blocks) {\n" +
        "  return (\n" +
        "    Array.isArray(blocks) &&\n" +
        "    blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))\n" +
        "  )\n" +
        "}",
        "function contentHasImage(blocks) {\n" +
        "  return (\n" +
        "    Array.isArray(blocks) &&\n" +
        "    blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))\n" +
        "  )\n" +
        "}\n" +
        "\n" +
        NEW_HELPER)
    },
  },
  {
    id: 'stream-reasoning-scoped',
    guard: (s) => s.includes('lastMessageIsImageQuestion(options.messages)'),
    apply: (s) => {
      const HEAD =
        "            const converted = await convertImagesToEvidence(ctx, options.messages, options.signal, self)\n" +
        "            const messages = restoreUpstreamSource(converted, providerId, upstream)\n"
      const TAIL =
        "            const delegated = { ...options, provider: upstream, messages }\n" +
        "            // 图片问题的第一步：答案已由视觉模型直答给出，DeepSeek 无需深度思考，\n" +
        "            // 把 high/max 降到 low。随后模型继续执行其他行动（工具调用等）时，\n" +
        "            // 最后一条消息不再是图片问题，推理档位自动回到会话默认值。\n" +
        "            // 只降档不关思考（保留 reasoning_content 连续性，避免 INVALID_REQUEST）。\n" +
        "            if (String(upstream).startsWith('deepseek') && lastMessageIsImageQuestion(options.messages)) {\n" +
        "              const effort = options.reasoningEffort\n" +
        "              if (effort !== undefined && effort !== 'off' && effort !== 'low') {\n" +
        "                delegated.reasoningEffort = 'low'\n" +
        "              }\n" +
        "            }\n" +
        "            yield* ctx.llm.stream(delegated)"
      const PRISTINE = HEAD + "            yield* ctx.llm.stream({ ...options, provider: upstream, messages })"
      if (s.includes(PRISTINE)) {
        return replaceOnce(s, PRISTINE, HEAD + TAIL)
      }
      // 任一旧版（off / low+latestUserHasImage）→ 整块 delegated 区域换成 v3
      const region = /const delegated = \{ \.\.\.options, provider: upstream, messages \}[\s\S]*?yield\* ctx\.llm\.stream\(delegated\)/
      const m = s.match(region)
      if (!m) throw new Error(`未找到 delegated 区域，modlens 版本可能已变化`)
      return s.slice(0, m.index) + TAIL + s.slice(m.index + m[0].length)
    },
  },
]

function replaceOnce(s, from, to) {
  const i = s.indexOf(from)
  if (i === -1) throw new Error(`目标文本未找到，modlens 版本可能已变化`)
  return s.slice(0, i) + to + s.slice(i + from.length)
}

async function main() {
  console.log(`目标: ${target}`)
  let src
  try {
    src = await readFile(target, 'utf8')
  } catch (e) {
    console.error(`无法读取: ${String(e?.message ?? e)}`)
    process.exit(1)
  }

  let changed = false
  for (const p of patches) {
    if (p.guard(src)) {
      console.log(`[跳过] ${p.id}（已应用）`)
      continue
    }
    try {
      src = p.apply(src)
      changed = true
      console.log(`[应用] ${p.id}`)
    } catch (e) {
      console.error(`[失败] ${p.id}: ${e.message}`)
      process.exit(1)
    }
  }

  // 把本包的 fast-cli 复制进 modlens 包根目录，使其完全自包含、与本仓库解耦。
  const pkgRoot = dirname(dirname(target))
  const bridge = join(pkgRoot, 'fast-cli.mjs')
  await copyFile(join(__dirname, 'fast-cli.mjs'), bridge)
  console.log(`[复制] fast-cli.mjs -> ${bridge}`)

  if (!changed) {
    console.log('所有补丁已就位，无需修改。')
    return
  }

  await writeFile(target, src, 'utf8')
  const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error('语法校验失败：')
    console.error(check.stderr || check.stdout)
    process.exit(1)
  }
  console.log('已写入并通过 node --check 语法校验。')
  console.log('提示：重启 DSH 后生效。')
}

main()
