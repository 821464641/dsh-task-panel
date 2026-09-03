// Diagnostic: decompress multi-frame zstd session logs and find the target.
import { readFileSync, readdirSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { join } from 'node:path'

const root = 'C:\\Users\\Windows User\\.dsh\\sessions'
const target = process.argv[2] ?? '变形翼'

function decompress(file) {
  return new Promise((resolve, reject) => {
    const stream = createZstdDecompress({ chunkSize: 1 << 20 })
    const chunks = []
    stream.on('data', (c) => chunks.push(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.end(readFileSync(file))
  })
}

const hits = []
for (const ws of readdirSync(root, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  const wsPath = join(root, ws.name)
  let dirs = []
  try { dirs = readdirSync(wsPath, { withFileTypes: true }) } catch { continue }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const f = join(wsPath, d.name, 'session.jsonl.zstd')
    let text
    try { text = await decompress(f) } catch { continue }
    if (text.includes(target)) {
      const lines = text.split('\n')
      const firstUser = lines.find((l) => l.includes('user/message'))
      let snippet = ''
      try {
        const obj = JSON.parse(firstUser)
        const blocks = obj.data?.content ?? []
        snippet = blocks.map((b) => b.text ?? '').join('').slice(0, 200)
      } catch { snippet = String(firstUser).slice(0, 200) }
      hits.push({ file: f, lines: lines.length, firstUser: snippet })
    }
  }
}

console.log(JSON.stringify(hits, null, 2))
if (hits.length === 0) console.log('NO HITS for', target)
