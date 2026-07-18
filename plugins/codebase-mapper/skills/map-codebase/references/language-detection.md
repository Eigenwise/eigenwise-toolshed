# Stack Detection

Signal files that reveal a project's language, package manager, and framework. Look for these at the
repo root (and in workspace subdirectories for monorepos). A project often matches several rows —
e.g. a TypeScript frontend plus a Python backend. Map each part you find.

## Languages & package managers

| Ecosystem | Signal files | Notes |
|-----------|--------------|-------|
| JavaScript / TypeScript | `package.json`, `tsconfig.json`, lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`) | Read `scripts`, `dependencies`, `devDependencies`, `"type"` |
| Python | `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `Pipfile`, `poetry.lock`, `uv.lock`, `environment.yml` | Tooling in `pyproject.toml` (`[tool.*]`) |
| Go | `go.mod`, `go.sum` | Module path on the first line of `go.mod` |
| Rust | `Cargo.toml`, `Cargo.lock` | `[workspace]` ⇒ multi-crate workspace |
| Java | `pom.xml` (Maven), `build.gradle`(`.kts`), `settings.gradle` | |
| Kotlin | `build.gradle.kts`, `*.kt` | Often Android or Spring |
| .NET (C#/F#/VB) | `*.sln`, `*.csproj`, `*.fsproj`, `Directory.Build.props`, `global.json` | |
| Ruby | `Gemfile`, `Gemfile.lock`, `*.gemspec` | Rails ⇒ `config/routes.rb`, `app/` |
| PHP | `composer.json`, `composer.lock` | Laravel/Symfony detectable from deps |
| Swift / Apple | `Package.swift`, `*.xcodeproj`, `*.xcworkspace`, `Podfile` | |
| Elixir / Erlang | `mix.exs`, `mix.lock`, `rebar.config` | Phoenix ⇒ `lib/*_web/` |
| C / C++ | `CMakeLists.txt`, `Makefile`, `meson.build`, `conanfile.txt`, `vcpkg.json` | |
| Dart / Flutter | `pubspec.yaml`, `pubspec.lock` | Flutter ⇒ `lib/`, `android/`, `ios/` |
| Scala | `build.sbt`, `project/` | |
| Clojure | `deps.edn`, `project.clj`, `bb.edn` | |
| Haskell | `*.cabal`, `stack.yaml` | |
| Zig | `build.zig` | |
| Nim | `*.nimble` | |
| Julia | `Project.toml`, `Manifest.toml` | |
| R | `DESCRIPTION`, `renv.lock` | |

## Monorepo / workspace markers

| Tool | Signal files |
|------|--------------|
| pnpm / yarn / npm workspaces | `pnpm-workspace.yaml`, `workspaces` in `package.json` |
| Nx | `nx.json` |
| Turborepo | `turbo.json` |
| Lerna | `lerna.json` |
| Rush | `rush.json` |
| Bazel | `WORKSPACE`, `MODULE.bazel`, `BUILD.bazel` |
| Cargo workspace | `[workspace]` in `Cargo.toml` |
| Go workspace | `go.work` |

When you see these, the real projects live under `apps/*`, `packages/*`, `services/*`, `libs/*`, or
similar — detect each one's stack individually.

## Framework hints (by ecosystem)

- **JS/TS:** `next.config.*` (Next.js), `nuxt.config.*` (Nuxt), `angular.json` (Angular),
  `vite.config.*` (Vite), `svelte.config.*` (Svelte/SvelteKit), `astro.config.*` (Astro),
  `remix.config.*` (Remix), `nest-cli.json` (NestJS), Express/Fastify/Koa in deps,
  `app.json`/`expo` (React Native/Expo).
- **Python:** Django (`manage.py`, `settings.py`), Flask/FastAPI/Starlette in deps,
  `alembic.ini` (migrations), `airflow`/`dagster`/`prefect` (data pipelines).
- **Ruby:** Rails (`config/routes.rb`, `bin/rails`), Sinatra in `Gemfile`.
- **PHP:** Laravel (`artisan`, `routes/`), Symfony (`symfony.lock`, `config/`).
- **Java/Kotlin:** Spring (`spring-boot-*` deps, `application.yml`), Micronaut, Quarkus.
- **.NET:** ASP.NET (`Program.cs` + `Microsoft.AspNetCore.*`), Blazor, MAUI.

## Cross-cutting signals

| Concern | Look for |
|---------|----------|
| Containers | `Dockerfile`, `docker-compose*.yml`, `compose.yaml`, `.dockerignore` |
| Orchestration | `k8s/`, `*.yaml` with `kind:`, `helm/`, `Chart.yaml`, `skaffold.yaml` |
| Infra as code | `*.tf` (Terraform), `pulumi.*`, `cdk.json`, `serverless.yml`, `template.yaml` (SAM) |
| CI/CD | `.github/*/`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile`, `.circleci/` |
| Lint/format | `.eslintrc*`, `biome.json`, `.prettierrc*`, `ruff.toml`, `.flake8`, `rustfmt.toml`, `.editorconfig`, `.golangci.yml` |
| Env/config | `.env.example`, `.env.*`, `config/`, `appsettings*.json` |
| Migrations | `migrations/`, `db/migrate/`, `prisma/migrations/`, `alembic/`, `*.sql` |
| Task runners | `Makefile`, `Justfile`, `Taskfile.yml`, `package.json` scripts, `tox.ini`, `noxfile.py` |
| Docs | `README*`, `docs/`, `CONTRIBUTING*`, `ADR`/`adr/`, `CHANGELOG*` |

## Tips

- `git ls-files` (in a git repo) gives a fast, ignore-aware file listing to scan for these signals.
- Prefer reading manifests over guessing from file extensions.
- Record which files you treated as the source of truth in `tech-landscape.md`.
