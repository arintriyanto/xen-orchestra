import { openVhd } from 'vhd-lib'
import { getSyncedHandler } from '@xen-orchestra/fs'
import Disposable from 'promise-toolbox/Disposable'

const compareVhd = (src, dest, path) => {
  for (const key of Object.keys(src)) {
    let same = false
    if (typeof src[key] !== typeof dest[key]) {
      throw new Error(
        `Error checking header : key ${path + '/' + key} is of type *${src[key]}* in source and *${dest[key]}* in dest`
      )
    }

    if (typeof src[key] === 'object') {
      compareVhd(src[key], dest[key], path + '/' + key)
    } else {
      const srcValue = src[key]
      const destValue = dest[key]
      same =
        srcValue === destValue ||
        (Buffer.isBuffer(srcValue) && Buffer.isBuffer(destValue) && srcValue.equals(destValue))

      if (!same) {
        throw new Error(
          `Error checking header : key ${path + '/' + key} is *${src[key]}* in source and *${dest[key]}* in dest`
        )
      }
    }
  }
}

export default async args => {
  if (args.length < 4 || args.some(_ => _ === '-h' || _ === '--help')) {
    return `Usage: compare <sourceRemoteUrl> <source VHD> <destionationRemoteUrl> <destination> `
  }
  const [sourceRemoteUrl, sourcePath, destRemoteUrl, destPath] = args

  await Disposable.use(async function* () {
    const sourceHandler = yield getSyncedHandler({ url: sourceRemoteUrl })
    const src = yield openVhd(sourceHandler, sourcePath)
    const destHandler = yield getSyncedHandler({ url: destRemoteUrl })
    const dest = yield openVhd(destHandler, destPath)

    compareVhd(src.header, dest.header, 'header')
    compareVhd(src.footer, dest.footer, 'footer')

    await src.readBlockAllocationTable()
    await dest.readBlockAllocationTable()

    for (let i = 0; i < src.header.maxTableEntries; i++) {
      if (src.containsBlock(i)) {
        if (dest.containsBlock(i)) {
          const srcBlock = await src.readBlock(i)
          const destBlock = await dest.readBlock(i)

          if (!srcBlock.buffer.equals(destBlock.buffer)) {
            throw new Error(`Block  ${i} has different data in src and dest`)
          }
        } else {
          throw new Error(`Block  ${i} is present in source but not in dest `)
        }
      } else {
        if (dest.containsBlock(i)) {
          throw new Error(`Block  ${i} is present in dest but not in source `)
        }
      }
    }

    for (let parentLocatorId = 0; parentLocatorId < 8; parentLocatorId++) {
      const parentLocatorData = await src.readParentLocatorData(parentLocatorId)
      const destData = await dest.readParentLocatorData(parentLocatorId)
      if (parentLocatorData) {
        if (!destData || !parentLocatorData.equals(destData)) {
          throw new Error(`Parent Locator  ${parentLocatorId} has different data in src and dest`)
        }
      } else if (destData) {
        throw new Error(`Parent Locator  ${parentLocatorId} is present in dest but not in source `)
      }
    }
    console.log('there is no difference between theses vhd')
  })
}
