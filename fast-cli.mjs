#!/usr/bin/env node
// modlens-fast-cli.mjs
// 轻量「按问题直答」视觉桥：与 modlens 插件配套，替代自动读图路径里
// 「生成全套证据契约再丢弃大半」的原 CLI。读 ~/.modlens/config.json 的
// openai 路由，直接把用户问题连同图片发给视觉模型，返回一句聚焦答案。
//
// 用法: node modlens-fast-cli.mjs -i <image> [--prompt <question>] [--timeout <ms>]
// 输出: { "result": { "summary": <答案>, "ocr": {"full_text": ""}, "uncertainty": [] } }
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'

function parseArgs(argv) {
  const out = { input: '', prompt: '', timeout: 180000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-i' || a === '--input') out.input = argv[++i] ?? ''
    else if (a === '--prompt') out.prompt = argv[++i] ?? ''
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 180000
    else if (a.startsWith('--input=')) out.input = a.slice('--input='.length)
    else if (a.startsWith('--prompt=')) out.prompt = a.slice('--prompt='.length)
  }
  return out
}

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input) { console.error('missing --input'); process.exit(2) }

  const cfgPath = join(homedir(), '.modlens', 'config.json')
  let cfg
  try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')) } catch {
    console.error('cannot read ~/.modlens/config.json'); process.exit(78)
  }
  const oa = cfg?.providers?.openai
  if (!oa?.apiKey || !oa?.baseUrl || !oa?.model) {
    console.error('openai engine not configured in ~/.modlens/config.json'); process.exit(78)
  }

  const bytes = await readFile(args.input)
  const mediaType = MEDIA[extname(args.input).toLowerCase()] ?? 'image/png'
  const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`

  const question = (args.prompt ?? '').trim()
  const focus = question
    ? `The user asked: "${question}".\nAnswer that question directly and concisely, in the same language the user used. If the question asks for full transcription, exhaustive listing, or a detailed structured analysis of the image, provide that depth; otherwise give a brief, direct answer (for an identity question, just name the person and the one or two strongest reasons). Do not recite the OCR contract, layout regions, or semantics fields. If the question contains parts unrelated to the image (for example searching the web or writing code), answer ONLY the image-related part and ignore the rest; the text model will handle those tasks. If you cannot confidently identify the person, say so explicitly ("无法确定") and describe only distinctive features — never guess, never list multiple contradictory candidates, and never self-correct in circles.`
    : `Describe this image concisely: what it shows, the key text if any, and any notable details.`

  const base = oa.baseUrl.replace(/\/+$/, '')
  const url = base + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeout)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oa.apiKey}` },
      body: JSON.stringify({
        model: oa.model,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: focus },
        ] }],
        max_tokens: 600,
        stream: false,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`vision api error ${res.status}: ${body.slice(0, 300)}`); process.exit(1)
    }
    const data = await res.json()
    const answer = data?.choices?.[0]?.message?.content
    if (typeof answer !== 'string' || !answer.trim()) {
      console.error('vision api returned empty content'); process.exit(1)
    }
    process.stdout.write(JSON.stringify({ result: { summary: answer.trim(), ocr: { full_text: '' }, uncertainty: [] } }))
  } catch (e) {
    console.error(`vision api call failed: ${String(e?.message ?? e)}`); process.exit(1)
  } finally {
    clearTimeout(timer)
  }
}

main()
