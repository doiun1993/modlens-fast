#!/usr/bin/env node
// fast-cli.mjs
// 轻量「按问题直答」视觉桥：与 modlens 插件配套，替代自动读图路径里
// 「生成全套证据契约再丢弃大半」的原 CLI。读 ~/.modlens/config.json，
// 直接把用户问题连同图片发给视觉模型，返回一句聚焦答案。
// 多引擎兜底：主引擎（openai 活跃槽）失败/卡顿自动切备用槽（saved.openai.glm），
// 每引擎两次尝试，避免厂商间歇性卡顿导致长时间静默。
//
// 用法: node fast-cli.mjs -i <image> [--prompt <question>] [--timeout <ms>]
// 输出: { "result": { "summary": <答案>, "ocr": {"full_text": ""}, "uncertainty": [] } }
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'

function parseArgs(argv) {
  const out = { input: '', prompt: '', timeout: 36000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-i' || a === '--input') out.input = argv[++i] ?? ''
    else if (a === '--prompt') out.prompt = argv[++i] ?? ''
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 36000
    else if (a.startsWith('--input=')) out.input = a.slice('--input='.length)
    else if (a.startsWith('--prompt=')) out.prompt = a.slice('--prompt='.length)
  }
  return out
}

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

// 引擎列表：openai 活跃槽在前，saved.openai.glm 作为跨厂商备用（若与活跃槽不同）。
function engineList(cfg) {
  const list = []
  const active = cfg?.providers?.openai
  if (active?.apiKey && active?.baseUrl && active?.model) {
    list.push({ tag: 'primary', baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model })
  }
  const glm = cfg?.saved?.openai?.glm
  if (glm?.apiKey && glm?.baseUrl && glm?.model) {
    const same = glm.baseUrl === active?.baseUrl && glm.model === active?.model
    if (!same) list.push({ tag: 'glm', baseUrl: glm.baseUrl, apiKey: glm.apiKey, model: glm.model })
  }
  return list
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input) { console.error('missing --input'); process.exit(2) }

  const cfgPath = join(homedir(), '.modlens', 'config.json')
  let cfg
  try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')) } catch {
    console.error('cannot read ~/.modlens/config.json'); process.exit(78)
  }
  const engines = engineList(cfg)
  if (engines.length === 0) {
    console.error('no vision engine configured in ~/.modlens/config.json'); process.exit(78)
  }

  const bytes = await readFile(args.input)
  const mediaType = MEDIA[extname(args.input).toLowerCase()] ?? 'image/png'
  const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`

  const question = (args.prompt ?? '').trim()
  const focus = question
    ? `The user asked: "${question}".\nAnswer that question directly and concisely, in the same language the user used. If the question asks for full transcription, exhaustive listing, or a detailed structured analysis of the image, provide that depth; otherwise give a brief, direct answer (for an identity question, just name the person and the one or two strongest reasons). Do not recite the OCR contract, layout regions, or semantics fields. If the question contains parts unrelated to the image (for example searching the web or writing code), answer ONLY the image-related part and ignore the rest; the text model will handle those tasks. If you cannot confidently identify the person, say so explicitly ("无法确定") and describe only distinctive features — never guess, never list multiple contradictory candidates, and never self-correct in circles.`
    : `Describe this image concisely: what it shows, the key text if any, and any notable details.`

  // 每引擎两次尝试；总预算至少 36 秒，避免引擎池级卡顿时长时间静默。
  const attemptsPerEngine = 2
  const attemptMs = Math.max(9000, Math.floor(Math.max(args.timeout, 36000) / (engines.length * attemptsPerEngine)))
  const lastErrors = []

  for (const engine of engines) {
    const url = engine.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const body = JSON.stringify({
      model: engine.model,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: focus },
      ] }],
      max_tokens: 600,
      stream: false,
    })
    for (let attempt = 1; attempt <= attemptsPerEngine; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), attemptMs)
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
          body,
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          throw new Error(`api ${res.status}: ${errBody.slice(0, 200)}`)
        }
        const data = await res.json()
        const answer = data?.choices?.[0]?.message?.content
        if (typeof answer !== 'string' || !answer.trim()) {
          throw new Error('empty content')
        }
        const uncertainty = engine.tag === 'glm' ? [`由备用引擎 ${engine.model} 回答`] : []
        process.stdout.write(JSON.stringify({ result: { summary: answer.trim(), ocr: { full_text: '' }, uncertainty } }))
        clearTimeout(timer)
        return
      } catch (e) {
        lastErrors.push(`${engine.tag} #${attempt}: ${String(e?.message ?? e)}`)
        if (attempt < attemptsPerEngine) continue
      } finally {
        clearTimeout(timer)
      }
    }
  }

  console.error(`vision api failed on all engines:\n${lastErrors.slice(-4).join('\n')}`)
  process.exit(1)
}

main()
