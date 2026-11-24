export type HomeEnvironment = {
  CLAUDE_CONFIG_DIR?: string
  HOME?: string
  USERPROFILE?: string
}

export function homeDirectoryOf(environment: HomeEnvironment, fallbackHome?: string): string | undefined
export function configDirectoryOf(environment: HomeEnvironment, fallbackHome?: string): string | undefined
