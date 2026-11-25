// A Chromium-family browser already on the machine, driven through its own command line: no package is installed
// for it. Without one, the pipeline still seeds and draws, and says which pictures it could not take.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type PictureSize = { width: number; height: number }

const INSTALL_FOLDERS = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe', 'Chromium/Application/chrome.exe']

const windowsPlaces = (): string[] =>
  [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .flatMap(root => (root === undefined ? [] : INSTALL_FOLDERS.map(folder => join(root, folder))))

const MAC_PLACES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

const COMMAND_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge']

const onThePath = (): string[] => {
  const folders = (process.env.PATH ?? '').split(delimiter).filter(folder => folder !== '')
  const endings = process.platform === 'win32' ? ['.exe'] : ['']

  return folders.flatMap(folder => COMMAND_NAMES.flatMap(name => endings.map(ending => join(folder, `${name}${ending}`))))
}

export const findBrowser = (): string | undefined => [...windowsPlaces(), ...MAC_PLACES, ...onThePath()].find(place => existsSync(place))

export type Browser = { command: string; profileFolder: string }

const commonFlags = (browser: Browser): string[] => [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=2',
  // A page that follows the system's light or dark setting draws dark on every machine, as the other pictures do.
  '--blink-settings=preferredColorScheme=0',
  // Around the drawn window the picture is see-through, so it sits on the docs page in either theme.
  '--default-background-color=00000000',
  `--user-data-dir=${browser.profileFolder}`,
]

const run = (browser: Browser, flags: readonly string[], pageFile: string): string => {
  const ran = spawnSync(browser.command, [...commonFlags(browser), ...flags, pathToFileURL(pageFile).href], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' },
  })
  if (ran.error) throw new Error(`${browser.command} did not run: ${ran.error.message}`)
  if (ran.status !== 0) throw new Error(`${browser.command} exited ${ran.status}: ${ran.stderr.slice(-400)}`)

  return ran.stdout
}

// The page writes its own drawn size into its title, so the window is cut to it.
export const measuredSize = (browser: Browser, pageFile: string): PictureSize => {
  const dom = run(browser, ['--window-size=2400,6000', '--dump-dom'], pageFile)
  const size = /<title>(\d+)x(\d+)<\/title>/.exec(dom)
  if (!size) throw new Error(`${pageFile} did not report its size`)

  return { width: Number(size[1]), height: Number(size[2]) }
}

// A page that redraws on a timer after load (the usage page redraws its chart 120 ms after a resize) was shot before
// the redraw on some runs and after it on others. A virtual time budget runs every timer before the shot.
const SETTLED = '--virtual-time-budget=5000'

export const takePicture = (browser: Browser, pageFile: string, size: PictureSize, pictureFile: string): void => {
  run(browser, [`--window-size=${size.width},${size.height}`, SETTLED, `--screenshot=${pictureFile}`], pageFile)
  if (!existsSync(pictureFile)) throw new Error(`${browser.command} wrote no picture for ${pageFile}`)
}
