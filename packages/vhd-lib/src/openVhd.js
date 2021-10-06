import { VhdFile, VhdDirectory, VhdAlias } from './'

export const openVhd = async (handler, path) => {
  try {
    if (path.endsWith('.alias.vhd')) {
      return await VhdAlias.open(handler, path)
    } else {
      return await VhdFile.open(handler, path)
    }
  } catch (e) {
    if (e.code === 'EISDIR') {
      return await VhdDirectory.open(handler, path)
    } else {
      throw e
    }
  }
}
