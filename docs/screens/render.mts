// npm run screens (from docs/): seeds a scratch project with made-up work, draws each screen with the plugins' own
// view code, and takes its picture with a browser already on the machine. The pictures and their captions land in
// src/assets/screens/, or in the folder after --into. Without a browser it says which pictures it skipped and still
// exits 0.
process.env.TZ = 'UTC'

const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const { installElementFactory } = await import('./host-drawing.mts')
installElementFactory()
const { findBrowser, measuredSize, takePicture } = await import('./browser.mts')
const { makeScratchFolder, removeScratchFolder, writeText } = await import('./scratch-project.mts')
const { pageOf } = await import('./pages.mts')
const { picturesOf } = await import('./pictures.mts')
type Picture = Awaited<ReturnType<typeof picturesOf>>[number]
type Browser = { command: string; profileFolder: string }

const DEFAULT_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'screens')

const folderAfterInto = (commandLine: readonly string[]): string => {
  const at = commandLine.indexOf('--into')
  const named = at === -1 ? undefined : commandLine[at + 1]

  return named === undefined ? DEFAULT_FOLDER : resolve(named)
}

const SCREENS_FOLDER = folderAfterInto(process.argv.slice(2))
const CAPTIONS_FILE = join(SCREENS_FOLDER, 'captions.json')

const scratchFolder = makeScratchFolder()
const browserCommand = findBrowser()

const captionsOf = (pictures: readonly Picture[]): string =>
  `${JSON.stringify(Object.fromEntries(pictures.map(picture => [picture.file, { alt: picture.alt, caption: picture.caption, drawnBy: picture.drawnBy }])), null, 2)}\n`

// Only what the last run wrote is removed: a screenshot taken in the app sits in the same folder and stays.
const picturesOfTheLastRun = (): string[] => {
  if (!existsSync(CAPTIONS_FILE)) return []
  const captions: unknown = JSON.parse(readFileSync(CAPTIONS_FILE, 'utf8'))

  return typeof captions === 'object' && captions !== null ? Object.keys(captions) : []
}

const sayWhatWasSkipped = (pictures: readonly Picture[]): void => {
  console.log('No Chrome, Edge or Chromium found on this machine, so no picture was taken.')
  console.log(`Skipped: ${pictures.map(picture => picture.file).join(', ')}`)
  console.log(`The pictures and captions already in ${SCREENS_FOLDER} are left as they are.`)
}

const takeOne = (browser: Browser, picture: Picture): void => {
  const pageFile = `${scratchFolder}/pages/${picture.file.replace(/\.png$/, '.html')}`
  writeText(pageFile, picture.isWholePage === true ? picture.html : pageOf(picture.html))
  const size = picture.windowSize ?? measuredSize(browser, pageFile)
  const shot = `${scratchFolder}/pictures/${picture.file}`
  mkdirSync(`${scratchFolder}/pictures`, { recursive: true })
  takePicture(browser, pageFile, size, shot)
  copyFileSync(shot, join(SCREENS_FOLDER, picture.file))
  console.log(`  ${picture.file}  ${size.width}x${size.height}`)
}

const takeAll = (command: string, pictures: readonly Picture[]): void => {
  mkdirSync(SCREENS_FOLDER, { recursive: true })
  for (const old of picturesOfTheLastRun()) rmSync(join(SCREENS_FOLDER, old), { force: true })
  writeText(CAPTIONS_FILE, captionsOf(pictures))
  console.log(`Taking pictures with ${command} into ${SCREENS_FOLDER}`)
  for (const picture of pictures) takeOne({ command, profileFolder: `${scratchFolder}/browser-profile` }, picture)
}

try {
  const pictures = await picturesOf(scratchFolder)
  if (browserCommand === undefined) sayWhatWasSkipped(pictures)
  else takeAll(browserCommand, pictures)
} finally {
  removeScratchFolder(scratchFolder)
}
