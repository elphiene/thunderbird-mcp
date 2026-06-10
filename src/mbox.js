import { createReadStream } from 'fs'

const NEWLINE = 0x0a // '\n'
const GT = 0x3e // '>'

// Thunderbird mbox message separator: a line starting with "From " followed by
// the sender and a date ending in a 4-digit year, e.g. "From - Tue Jun 09 ...2026"
const FROM_LINE_RE = /^From .*\d{4}$/

/**
 * Streams raw lines (including their line terminator) from a readable stream as
 * Buffers, tracking exact byte boundaries regardless of CRLF/LF mix.
 */
async function* linesFromStream(stream) {
  let leftover = Buffer.alloc(0)

  for await (const chunk of stream) {
    let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
    let start = 0
    while (true) {
      const idx = buf.indexOf(NEWLINE, start)
      if (idx === -1) break
      yield buf.subarray(start, idx + 1)
      start = idx + 1
    }
    leftover = buf.subarray(start)
  }

  if (leftover.length) yield leftover
}

function lineText(lineBuf) {
  return lineBuf.toString('utf-8').replace(/\r?\n$/, '')
}

// Body lines starting with "From " (mbox-quoted as ">From ", ">>From ", ...) have
// one leading ">" stripped to restore the original RFC822 content.
function unescapeFromLine(lineBuf) {
  let i = 0
  while (lineBuf[i] === GT) i++
  if (i > 0 && lineBuf.subarray(i, i + 5).toString('ascii') === 'From ') {
    return lineBuf.subarray(1)
  }
  return lineBuf
}

/**
 * Streams an mbox file and yields each message as { offset, length, raw }.
 * `offset` is the exact byte position of the message's "From " separator line
 * (usable with readMessageAt). `raw` is the message bytes with mbox ">From"
 * quoting undone and the separator line removed, ready for an RFC822 parser.
 */
export async function* iterateMboxMessages(filePath) {
  let offset = 0
  let messageStart = null
  let bodyLines = []

  for await (const lineBuf of linesFromStream(createReadStream(filePath))) {
    if (FROM_LINE_RE.test(lineText(lineBuf))) {
      if (messageStart !== null) {
        yield {
          offset: messageStart,
          length: offset - messageStart,
          raw: Buffer.concat(bodyLines),
        }
      }
      messageStart = offset
      bodyLines = []
    } else if (messageStart !== null) {
      bodyLines.push(unescapeFromLine(lineBuf))
    }

    offset += lineBuf.length
  }

  if (messageStart !== null) {
    yield {
      offset: messageStart,
      length: offset - messageStart,
      raw: Buffer.concat(bodyLines),
    }
  }
}

/**
 * Reads a single message's raw bytes from an mbox file given the byte offset of
 * its "From " separator line (as returned by iterateMboxMessages). Reads forward
 * until the next "From " separator line or end of file, undoing mbox ">From"
 * quoting and skipping the leading separator line.
 */
export async function readMessageAt(filePath, offset) {
  const stream = createReadStream(filePath, { start: offset })
  const bodyLines = []
  let skippedSeparator = false

  for await (const lineBuf of linesFromStream(stream)) {
    if (!skippedSeparator) {
      skippedSeparator = true
      continue
    }
    if (FROM_LINE_RE.test(lineText(lineBuf))) break
    bodyLines.push(unescapeFromLine(lineBuf))
  }

  return Buffer.concat(bodyLines)
}
