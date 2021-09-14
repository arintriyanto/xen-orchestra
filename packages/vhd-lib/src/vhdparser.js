import assert from 'assert'
import EventEmitter from 'events'
import emitAsync from '@xen-orchestra/emit-async'
import { readChunk } from '@vates/read-chunk'
import { SECTOR_SIZE, BLOCK_UNUSED } from './_constants'
import { fuHeader } from './_structs'
import { gunzip } from 'zlib'
import * as Cppzst from '@fstnetwork/cppzst'

const cappedBufferConcat = (buffers, maxSize) => {
  let buffer = Buffer.concat(buffers)
  if (buffer.length > maxSize) {
    buffer = buffer.slice(buffer.length - maxSize)
  }
  return buffer
}

class Parser extends EventEmitter {
  parse() {
    throw new TypeError('Not implemented')
  }
}

const uncompress = (buffer, extension) => {
  switch (extension) {
    case 'gz':
      return new Promise((resolve, reject) => {
        gunzip(buffer, (err, compressed) => {
          if (err) {
            reject(err)
          } else {
            resolve(compressed)
          }
        })
      })
    case 'zstd':
      return Cppzst.decompress(buffer)
    default:
      throw new Error(extension + ' inconnue')
  }
}

export class S3VhdParser extends Parser {
  constructor(opts = {}) {
    super(opts)
    const { s3, bucket, dir, compressed } = opts
    this.s3 = s3
    this.bucket = bucket
    this.prefix = dir
    this.compressed = compressed
    this.emitAsync = emitAsync
  }

  async getBuffer(fileId) {
    const response = await this.s3.getObject({
      Bucket: this.bucket,
      Key: fileId,
    })
    return response.Body
  }

  getStream(fileId) {
    return this.s3.getObject
      .raw({
        Bucket: this.bucket,
        Key: fileId,
      })
      .createReadStream()
  }
  async parse() {
    const params = {
      Bucket: this.bucket,
      Prefix: this.prefix,
    }
    do {
      const { NextContinuationToken, Contents } = await this.s3.listObjectsV2(params)
      params.ContinuationToken = NextContinuationToken
      for (const { Key } of Contents) {
        const path = Key.split('/')
        const [type, extension] = path.pop().split('.')
        const offset = parseInt(path.pop())
        let content = null
        content = await this.getBuffer(Key)
        if (extension) {
          content = await uncompress(content, extension)
        }
        await this.emitAsync(type, content, offset)
      }
    } while (params.ContinuationToken)
    await this.emitAsync('end')
  }
}
export class InputStreamVhdParser extends Parser {
  constructor(opts = {}) {
    super()
    const { stream, compress } = opts
    this.stream = stream
    this.compress = compress
    this.emitAsync = emitAsync
  }

  async parse() {
    const stream = this.stream
    const bufFooter = await readChunk(stream, SECTOR_SIZE)
    await this.emitAsync('footer', bufFooter, 0)

    const bufHeader = await readChunk(stream, 2 * SECTOR_SIZE)
    const header = fuHeader.unpack(bufHeader)

    await this.emitAsync('header', bufHeader, 512)

    const blockBitmapSize = Math.ceil(header.blockSize / SECTOR_SIZE / 8 / SECTOR_SIZE) * SECTOR_SIZE
    const blockSize = header.blockSize
    const blockAndBitmapSize = blockBitmapSize + blockSize

    const batOffset = header.tableOffset
    const batSize = Math.max(1, Math.ceil((header.maxTableEntries * 4) / SECTOR_SIZE)) * SECTOR_SIZE
    /**
     * the norm allows the BAT to be after some blocks or parent locator
     * we do not handle this case for now since we need the BAT to order the blocks/parent locator
     *
     * also there can be some free space between header and the start of BAT
     */

    await readChunk(stream, batOffset - 1024 - 512)

    const bat = await readChunk(stream, batSize)

    await this.emitAsync('bat', bat, batOffset)

    /**
     * blocks and parent locators  can be intervined
     *
     * we build a sorted index since we read the stream sequentially and
     * we need to know what is the the next element to read and its size
     * (parent locator size can vary)
     */

    const index = []
    for (let blockCounter = 0; blockCounter < header.maxTableEntries; blockCounter++) {
      const batEntrySector = bat.readUInt32BE(blockCounter * 4)
      // unallocated block, no need to export it
      if (batEntrySector === BLOCK_UNUSED) {
        continue
      }
      const batEntryBytes = batEntrySector * SECTOR_SIZE
      // ensure the block is not before the bat
      assert.ok(batEntryBytes >= batOffset + batSize)

      index.push({
        type: 'block',
        offset: batEntryBytes,
        size: blockAndBitmapSize,
      })
    }

    for (const parentLocatorEntry of header.parentLocatorEntry) {
      // empty parent locator entry, does not exist in the content
      if (parentLocatorEntry.platformDataSpace === 0) {
        continue
      }
      assert.ok(parentLocatorEntry.platformDataOffset * SECTOR_SIZE >= batOffset + batSize)

      index.push({
        type: 'parentLocator',
        offset: parentLocatorEntry.platformDataOffset * SECTOR_SIZE,
        size: parentLocatorEntry.platformDataSpace * SECTOR_SIZE,
      })
    }

    index.sort((a, b) => a.offset - b.offset)

    for (const { type, offset, size } of index) {
      const buffer = await await readChunk(stream, size)
      await this.emitAsync(type, buffer, offset, size)
    }
    /**
     * the second footer is at filesize - 512 , there can be empty spaces between last block
     * and the start of the footer
     *
     * we read till the end of the stream, and use the last 512 bytes as the footer
     */
    const bufFooterEnd = await this.readLastSector()
    assert(bufFooter.equals(bufFooterEnd), 'footer1 !== footer2')

    await this.emitAsync('end')
  }

  readLastSector(startingBuffer) {
    return new Promise(resolve => {
      let bufFooterEnd = Buffer.alloc(0)
      this.stream.on('data', chunk => {
        if (chunk) {
          bufFooterEnd = cappedBufferConcat([bufFooterEnd, chunk], SECTOR_SIZE)
        }
      })

      this.stream.on('end', chunk => {
        if (chunk) {
          bufFooterEnd = cappedBufferConcat([bufFooterEnd, chunk], SECTOR_SIZE)
        }
        resolve(bufFooterEnd)
      })
    })
  }
}

export const instantiateParser = (type, opts) => {
  switch (type) {
    case 'stream':
      return new InputStreamVhdParser(opts)
    case 's3':
      return new S3VhdParser(opts)
    default:
      throw new Error(`type ${type} is not supported in vhdparser`)
  }
}

export default { InputStreamVhdParser, S3VhdParser, instantiateParser }
