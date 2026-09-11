import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Official JSONL backend: independently decodable checksummed frames. */
export function compressFrame(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return zstdCompressSync(buf, CHECKSUM_OPTIONS)
}

/**
 * Locate complete Zstandard frames (ported from dsh-session-persistence-jsonl).
 * Invalid complete structure throws; EOF inside the final frame is torn and omitted.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

export function isHeaderOnlyFrame(plaintext) {
  return plaintext.length > 0 && plaintext.indexOf(10) === plaintext.length - 1
}

export function decompressLog(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    const { frames } = scanZstdFrames(buf)
    let text = ''
    for (const f of frames) {
      try {
        text += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8')
      } catch {
        /* checksum/decode failure — skip */
      }
    }
    return text
  }
  const hits = []
  let pos = 0
  while ((pos = buf.indexOf(MAGIC, pos)) !== -1) {
    hits.push(pos)
    pos += 4
  }
  if (hits.length === 0) return buf.toString('utf8')
  let text = ''
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(hits[i], end)).toString('utf8')
    } catch {
      /* torn frame — skip */
    }
  }
  return text
}

export function parseEvents(text) {
  const events = []
  const lines = text.split('\n')
  for (const line of lines) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* skip torn */ }
  }
  return events
}

export function readSessionLog(path) {
  const buf = readFileSync(path)
  const text = decompressLog(buf)
  return { buf, text, events: parseEvents(text), frames: countFrames(buf) }
}

function countFrames(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    try { return scanZstdFrames(buf).frames.length } catch { /* fall through */ }
  }
  let n = 0
  let pos = 0
  while ((pos = buf.indexOf(MAGIC, pos)) !== -1) {
    n++
    pos += 4
  }
  return n
}

const EVENT_FRAME_LINES = 64

/**
 * Official encodeMaterialization: first frame is exactly one header line;
 * remaining events are independently decodable checksummed frames.
 * 0.1.5 refuses any first frame whose plaintext is not `header\\n`.
 */
export function writeSessionLog(path, events) {
  mkdirSync(dirname(path), { recursive: true })
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('refusing to write an empty session log')
  }
  const header = events.find((e) => e && e.type === 'session')
  if (!header) throw new Error('refusing to write a session log without a type:session header')
  const rest = events.filter((e) => e !== header)
  const headerLine = JSON.stringify(header) + '\n'
  const headerFrame = compressFrame(headerLine)
  const headerPlain = zstdDecompressSync(headerFrame)
  if (!isHeaderOnlyFrame(headerPlain)) {
    throw new Error('internal: header frame is not exactly one header line')
  }
  const parts = [headerFrame]
  for (let i = 0; i < rest.length; i += EVENT_FRAME_LINES) {
    const batch = rest.slice(i, i + EVENT_FRAME_LINES)
    const body = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
    parts.push(compressFrame(body))
  }
  const compressed = Buffer.concat(parts)
  writeFileSync(path, compressed)
  return { bytes: compressed.length, events: events.length, frames: parts.length }
}
