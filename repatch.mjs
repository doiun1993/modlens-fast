#!/usr/bin/env node
// repatch.mjs
// 给 modlens 插件打「按问题直答」补丁，升级后一键还原。
// 幂等：已打过的补丁会跳过；打完后自动跑 node --check 校验语法。
//
// 用法: node repatch.mjs [dsh/index.js 路径]
// 默认路径: ~/.dsh/profiles/web/node_modules/@liustack/modlens/dsh/index.js
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@liustack', 'modlens', 'dsh', 'index.js')

const fastCliAbs = join(__dirname, 'fast-cli.mjs')
const fastCliLiteral = fastCliAbs.replace(/\\/g, '\\\\')

// 每个补丁：id、是否已应用（guard）、应用函数（返回新文本，找不到 old 时抛错）。
const patches = [
  {
    id: 'fast-cli-constant',
    guard: (s) => s.includes('const FAST_CLI_PATH'),
    apply: (s) => replaceOnce(s,
      "const CLI_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url))",
      "const CLI_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url))\n" +
      "// 轻量「按问题直答」视觉桥：自动读图路径用它，视觉模型直接回答用户问题，\n" +
      "// 而非生成整套证据契约再丢弃大半。可用 MODLENS_FAST_CLI 环境变量覆盖。\n" +
      `const FAST_CLI_PATH = process.env.MODLENS_FAST_CLI || '${fastCliLiteral}'`),
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
    id: 'fast-cli-invocation',
    guard: (s) => s.includes('const fastArgs = [FAST_CLI_PATH'),
    apply: (s) => replaceOnce(s,
      "    const cli = process.env.MODLENS_DSH_CLI || CLI_PATH\n" +
      "    const { stdout, stderr, code } = await run(\n" +
      "      process.execPath,\n" +
      "      [cli, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],\n" +
      "      signal,\n" +
      "    )\n" +
      "    if (code !== 0) {",
      "    const fastArgs = [FAST_CLI_PATH, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)]\n" +
      "    const q = question?.trim()\n" +
      "    if (q) fastArgs.push('--prompt', q.slice(0, 1000))\n" +
      "    let { stdout, stderr, code } = await run(process.execPath, fastArgs, signal)\n" +
      "    if (code !== 0) {\n" +
      "      // 轻量桥不可用（引擎非 openai / 未配置 / 网络错）时，回退到完整证据 CLI。\n" +
      "      const slow = await run(\n" +
      "        process.execPath,\n" +
      "        [CLI_PATH, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],\n" +
      "        signal,\n" +
      "      )\n" +
      "      stdout = slow.stdout\n" +
      "      stderr = slow.stderr\n" +
      "      code = slow.code\n" +
      "    }\n" +
      "    if (code !== 0) {"),
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
    id: 'latest-user-helper',
    guard: (s) => s.includes('function latestUserHasImage(messages)'),
    apply: (s) => replaceOnce(s,
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
      "// 本轮「新」输入是否带图片：只看最新一条 user 消息，历史回放里的旧图不算。\n" +
      "// 有图时答案已由视觉模型直答给出，DeepSeek 无需思考，据此强制关推理。\n" +
      "function latestUserHasImage(messages) {\n" +
      "  if (!Array.isArray(messages)) return false\n" +
      "  for (let i = messages.length - 1; i >= 0; i--) {\n" +
      "    const m = messages[i]\n" +
      "    if (m?.role === 'user' && Array.isArray(m.content)) {\n" +
      "      return contentHasImage(m.content)\n" +
      "    }\n" +
      "  }\n" +
      "  return false\n" +
      "}"),
  },
  {
    id: 'stream-reasoning-off',
    guard: (s) => s.includes("delegated.reasoningEffort = 'off'"),
    apply: (s) => replaceOnce(s,
      "            const converted = await convertImagesToEvidence(ctx, options.messages, options.signal, self)\n" +
      "            const messages = restoreUpstreamSource(converted, providerId, upstream)\n" +
      "            yield* ctx.llm.stream({ ...options, provider: upstream, messages })",
      "            const converted = await convertImagesToEvidence(ctx, options.messages, options.signal, self)\n" +
      "            const messages = restoreUpstreamSource(converted, providerId, upstream)\n" +
      "            const delegated = { ...options, provider: upstream, messages }\n" +
      "            // 本轮有新图片输入时，答案已由视觉模型直答给出，DeepSeek 无需思考：\n" +
      "            // 强制关掉推理，省掉「deep dive」那段时间（仅对 deepseek 上游生效）。\n" +
      "            if (String(upstream).startsWith('deepseek') && latestUserHasImage(options.messages)) {\n" +
      "              delegated.reasoningEffort = 'off'\n" +
      "            }\n" +
      "            yield* ctx.llm.stream(delegated)"),
  },
  {
    id: 'repoint-fast-cli',
    guard: (s) => s.includes(`const FAST_CLI_PATH = process.env.MODLENS_FAST_CLI || '${fastCliLiteral}'`),
    apply: (s) => {
      // 包被移动后，重新把嵌入的 fast-cli 绝对路径指向当前位置（幂等）。
      const re = /const FAST_CLI_PATH = process\.env\.MODLENS_FAST_CLI \|\| '[^']*'/
      const m = s.match(re)
      if (!m) throw new Error(`未找到 FAST_CLI_PATH 行，modlens 版本可能已变化`)
      const line = `const FAST_CLI_PATH = process.env.MODLENS_FAST_CLI || '${fastCliLiteral}'`
      return s.slice(0, m.index) + line + s.slice(m.index + m[0].length)
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
