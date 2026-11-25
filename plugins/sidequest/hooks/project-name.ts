const TRAILING_SLASHES = /[\\/]+$/
const BARE_REPOSITORY_SUFFIX = /\.git$/

export const projectNameOf = (root: string): string | undefined => {
  const lastFolder = root.replace(TRAILING_SLASHES, '').split(/[\\/]/).pop() ?? ''
  const name = lastFolder.replace(BARE_REPOSITORY_SUFFIX, '')

  return name === '' ? undefined : name
}
