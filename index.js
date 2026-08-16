// @ts-check

import createDebug from 'debug'
import { createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import getStream from 'get-stream'
import * as path from 'node:path'
import * as stream from 'node:stream/promises'
import yauzl from 'yauzl'

const debug = createDebug('extract-zip')

/**
 * @typedef Options
 *
 * @property {string} dir
 *   The path to the directory where the extracted files are written
 *
 * @property {string} [defaultDirMode]
 *   Directory Mode (permissions), defaults to `"0o755"`
 *
 * @property {string} [defaultFileMode]
 *   File Mode (permissions), defaults to `"0o644"`
 *
 * @property {(entry: import("yauzl").Entry, zipfile?: import("yauzl").ZipFile) => void} [onEntry]
 *   If present, will be called with (entry, zipfile),
 *   entry is every entry from the zip file forwarded
 *   from the entry event from yauzl. zipfile is the
 *   yauzl instance
 */

class Extractor {
  /**
   * @param {string} zipPath
   * @param {Options} opts
   */
  constructor(zipPath, opts) {
    this.zipPath = zipPath
    this.opts = { defaultDirMode: '0o755', defaultFileMode: '0o644', ...opts }
  }

  /**
   * @returns {Promise<void>}
   */
  async extract() {
    debug('opening', this.zipPath, 'with opts', this.opts)

    this.zipfile = await yauzl.openPromise(this.zipPath, { lazyEntries: true })
    this.canceled = false

    return new Promise((resolve, reject) => {
      if (!this.zipfile) {
        reject(new Error('zipfile not opened'))
        return
      }

      this.zipfile.on('error', err => {
        this.canceled = true
        reject(err)
      })
      this.zipfile.readEntry()

      this.zipfile.on('close', () => {
        if (!this.canceled) {
          debug('zip extraction complete')
          resolve()
        }
      })

      this.zipfile.on('entry', async (/** @type {import("yauzl").Entry} */ entry) => {
        if (!this.zipfile) {
          reject(new Error('zipfile not opened'))
          return
        }

        /* istanbul ignore if */
        if (this.canceled) {
          debug('skipping entry', entry.fileName, { cancelled: this.canceled })
          return
        }

        debug('zipfile entry', entry.fileName)

        if (entry.fileName.startsWith('__MACOSX/')) {
          this.zipfile.readEntry()
          return
        }

        const destDir = path.dirname(path.join(this.opts.dir, entry.fileName))

        try {
          await fs.mkdir(destDir, { recursive: true })

          const canonicalDestDir = await fs.realpath(destDir)
          const relativeDestDir = path.relative(this.opts.dir, canonicalDestDir)

          if (relativeDestDir.split(path.sep).includes('..')) {
            throw new Error(`Out of bound path "${canonicalDestDir}" found while processing file ${entry.fileName}`)
          }

          await this.extractEntry(entry)
          debug('finished processing', entry.fileName)
          this.zipfile.readEntry()
        } catch (err) {
          this.canceled = true
          this.zipfile.close()
          reject(err)
        }
      })
    })
  }

  /**
   * @param {import("yauzl").Entry} entry
   * @returns {Promise<void>}
   */
  async extractEntry(entry) {
    if (!this.zipfile) {
      throw new Error('zipfile not opened')
    }

    /* istanbul ignore if */
    if (this.canceled) {
      debug('skipping entry extraction', entry.fileName, { cancelled: this.canceled })
      return
    }

    if (this.opts.onEntry) {
      this.opts.onEntry(entry, this.zipfile)
    }

    const dest = path.join(this.opts.dir, entry.fileName)

    // convert external file attr int into a fs stat mode int
    const mode = (entry.externalFileAttributes >> 16) & 0xffff
    // check if it's a symlink or dir (using stat mode constants)
    const IFMT = 61440
    const IFDIR = 16384
    const IFLNK = 40960
    const symlink = (mode & IFMT) === IFLNK
    let isDir = (mode & IFMT) === IFDIR

    // Failsafe, borrowed from jsZip
    if (!isDir && entry.fileName.endsWith('/')) {
      isDir = true
    }

    // check for windows weird way of specifying a directory
    // https://github.com/maxogden/extract-zip/issues/13#issuecomment-154494566
    const madeBy = entry.versionMadeBy >> 8
    if (!isDir) isDir = madeBy === 0 && entry.externalFileAttributes === 16

    debug('extracting entry', { filename: entry.fileName, isDir: isDir, isSymlink: symlink })

    const procMode = this.getExtractedMode(mode, isDir) & 0o777

    // always ensure folders are created
    const destDir = isDir ? dest : path.dirname(dest)

    /** @type {import("fs").MakeDirectoryOptions} */
    const mkdirOptions = { recursive: true }
    if (isDir) {
      mkdirOptions.mode = procMode
    }
    debug('mkdir', { dir: destDir, ...mkdirOptions })
    await fs.mkdir(destDir, mkdirOptions)
    if (isDir) return

    debug('opening read stream', dest)
    const readStream = await this.zipfile.openReadStreamPromise.bind(this.zipfile)(entry)

    if (symlink) {
      const link = await getStream(readStream)
      const linkTarget = path.resolve(path.dirname(dest), link)
      const relativeLinkTarget = path.relative(this.opts.dir, linkTarget)

      if (relativeLinkTarget.split(path.sep).includes('..') || path.isAbsolute(relativeLinkTarget)) {
        throw new Error(`Out of bound symlink target "${link}" found while processing file ${entry.fileName}`)
      }

      debug('creating symlink', link, dest)
      await fs.symlink(link, dest)
    } else {
      await stream.pipeline(readStream, createWriteStream(dest, { mode: procMode }))
    }
  }

  /**
   *
   * @param {number} entryMode
   * @param {boolean} isDir
   * @returns {number}
   */
  getExtractedMode(entryMode, isDir) {
    let mode = entryMode
    // Set defaults, if necessary
    if (mode === 0) {
      if (isDir) {
        if (this.opts.defaultDirMode) {
          mode = parseInt(this.opts.defaultDirMode, 10)
        }

        if (!mode) {
          mode = 0o755
        }
      } else {
        if (this.opts.defaultFileMode) {
          mode = parseInt(this.opts.defaultFileMode, 10)
        }

        if (!mode) {
          mode = 0o644
        }
      }
    }

    return mode
  }
}

/**
 * @param {string} zipPath
 * @param {Options} opts
 */
export default async function (zipPath, opts) {
  debug('creating target directory', opts.dir)

  if (!path.isAbsolute(opts.dir)) {
    throw new Error('Target directory is expected to be absolute')
  }

  await fs.mkdir(opts.dir, { recursive: true })
  opts.dir = await fs.realpath(opts.dir)
  return new Extractor(zipPath, opts).extract()
}
