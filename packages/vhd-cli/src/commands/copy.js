import { getSyncedHandler } from '@xen-orchestra/fs'
import { openVhd, VhdFile, VhdDirectory } from 'vhd-lib'
import Disposable from 'promise-toolbox/Disposable'
import getopts from 'getopts'
import { ConcurrencyPromise } from '../concurrencyPromise'

export default async rawArgs => {
  const { directory, help, _: args } = getopts(rawArgs, {
    alias: {
      directory: 'd',
      help: 'h'
    },
    boolean: ['directory', 'force'],
    default: {
      directory: false,
      help: false
    }
  })
  if (args.length < 4 || help) {
    return `Usage: index.js copy <sourceRemoteUrl> <source VHD> <destionationRemoteUrl> <destination> --directory`
  }
  const [sourceRemoteUrl, sourcePath, destRemoteUrl, destPath] = args

  await Disposable.use(async function*() {
    const sourceHandler = yield getSyncedHandler({ url: sourceRemoteUrl })
    const src = yield openVhd(sourceHandler, sourcePath)
    await src.readBlockAllocationTable()
    const destHandler = yield getSyncedHandler({ url: destRemoteUrl })
    const dest = yield directory ? VhdDirectory.create(destHandler, destPath) : VhdFile.create(destHandler, destPath)
    // copy data
    dest.header = src.header
    dest.footer = src.footer

    const cp = new ConcurrencyPromise({ maxConcurrency: 16 })
    for (let i = 0; i < src.header.maxTableEntries; i++) {
      if (src.containsBlock(i)) {
        await cp.add(async () => {
          const block = await src.readBlock(i)
          dest.writeEntireBlock(block)
        })
      }
    }
    await cp.done()
    // copy parent locators
    for (let parentLocatorId = 0; parentLocatorId < 8; parentLocatorId++) {
      const parentLocator = await src.readParentLocator(parentLocatorId)
      await dest.writeParentLocator(parentLocator)
    }
    await dest.writeFooter()
    await dest.writeHeader()
    await dest.writeBlockAllocationTable()
  })
}
