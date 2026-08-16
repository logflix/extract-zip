import { Entry, ZipFile } from 'yauzl'
import { default as extract, type Options } from './index.js'

const zip = '/path/to/zip'
const dir = '/path/to/dir'
const defaultFileMode = 0o600

let options: Options = {
  dir
}
options = {
  dir,
  defaultDirMode: 0o700,
  defaultFileMode,
  onEntry: (entry: Entry, zipfile: ZipFile): void => {
    console.log(entry)
    console.log(zipfile)
  }
}

try {
  await extract(zip, options)
  console.log('done')
} catch (err) {
  console.error(err)
}
