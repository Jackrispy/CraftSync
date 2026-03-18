/**
 * CraftSync – Minecraft Direct Launcher
 *
 * Reads Modrinth's version JSON, builds the full Java command, and spawns MC.
 * Supports Fabric (and vanilla) on Windows x64.
 *
 * Usage:
 *   const { launchMinecraft } = require('./minecraft-launcher')
 *   const proc = await launchMinecraft({ profile, authInfo, onLog, onClose })
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ── Modrinth paths ──────────────────────────────────────────────────────────
const MODRINTH_BASE = path.join(
  process.env.APPDATA,
  'ModrinthApp'
)
const META_DIR      = path.join(MODRINTH_BASE, 'meta')
const VERSIONS_DIR  = path.join(META_DIR, 'versions')
const LIBRARIES_DIR = path.join(META_DIR, 'libraries')
const ASSETS_DIR    = path.join(META_DIR, 'assets')
const JAVA_DIR      = path.join(META_DIR, 'java_versions')
const PROFILES_DIR  = path.join(MODRINTH_BASE, 'profiles')

// ── Java component → folder prefix map ─────────────────────────────────────
// Modrinth names these folders with a prefix; we just pick the right major ver.
const JAVA_MAJOR_TO_PREFIX = {
  17: 'zulu17',
  21: 'zulu21',
}

/**
 * Find the javaw.exe for a given major version.
 */
function findJava(majorVersion) {
  const prefix = JAVA_MAJOR_TO_PREFIX[majorVersion]
  if (!prefix) throw new Error(`No Java prefix known for major version ${majorVersion}`)

  const entries = fs.readdirSync(JAVA_DIR)
  const match = entries.find(e => e.startsWith(prefix))
  if (!match) throw new Error(`Java ${majorVersion} not found in ${JAVA_DIR}`)

  return path.join(JAVA_DIR, match, 'bin', 'javaw.exe')
}

/**
 * Read and parse the version JSON for a given versionId (e.g. "1.21.10-0.18.4").
 */
function readVersionJson(versionId) {
  const jsonPath = path.join(VERSIONS_DIR, versionId, `${versionId}.json`)
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Version JSON not found: ${jsonPath}`)
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
}

/**
 * Resolve the path to a library JAR from its Maven name.
 * For libraries with a `downloads.artifact.path`, use that.
 * For Modrinth-hosted libs (fabric-loader etc.), derive the Maven path.
 */
function resolveLibraryPath(lib) {
  // Has an explicit artifact path?
  if (lib.downloads?.artifact?.path) {
    return path.join(LIBRARIES_DIR, lib.downloads.artifact.path)
  }

  // Modrinth-hosted: derive from Maven coordinates
  // name format: "group:artifact:version" or "group:artifact:version:classifier"
  const parts = lib.name.split(':')
  const [group, artifact, version] = parts
  const groupPath = group.replace(/\./g, '/')
  const jar = `${artifact}-${version}.jar`
  return path.join(LIBRARIES_DIR, groupPath, artifact, version, jar)
}

/**
 * Determine if a library's OS rules allow it on Windows x64.
 */
function libraryAllowedOnWindows(lib) {
  if (!lib.rules) return true
  // We only care about "allow" rules with os.name; deny everything else
  for (const rule of lib.rules) {
    if (rule.action === 'allow' && rule.os) {
      if (rule.os.name === 'windows') return true
      if (rule.os.name === 'windows-arm64') return false // not arm64
      // Other OS rules (osx, linux) → don't include on windows
      return false
    }
    if (rule.action === 'allow' && !rule.os) return true
    if (rule.action === 'disallow' && rule.os?.name === 'windows') return false
  }
  return true
}

/**
 * Build the classpath from the library list + the client JAR.
 */
function buildClasspath(versionJson, versionId) {
  const jars = []

  for (const lib of versionJson.libraries) {
    if (!lib.include_in_classpath) continue
    if (!libraryAllowedOnWindows(lib)) continue

    const p = resolveLibraryPath(lib)
    if (fs.existsSync(p)) {
      jars.push(p)
    }
    // If the jar doesn't exist on disk yet, skip — Modrinth should have
    // downloaded all required libs when it first ran the profile.
  }

  // Add the client JAR itself
  const clientJar = path.join(VERSIONS_DIR, versionId, `${versionId}.jar`)
  if (fs.existsSync(clientJar)) {
    jars.push(clientJar)
  }

  return jars.join(';') // Windows path separator
}

/**
 * Expand a JVM or game argument token, substituting ${variable} placeholders.
 */
function expandToken(token, vars) {
  if (typeof token !== 'string') return token
  return token.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return vars[key] !== undefined ? vars[key] : `\${${key}}`
  })
}

/**
 * Process the arguments array from the version JSON:
 * - Plain strings → include (after var substitution)
 * - Objects with rules → only include if features match (we skip optional features)
 */
function processArgs(argList, vars, enabledFeatures = {}) {
  const result = []

  for (const arg of argList) {
    if (typeof arg === 'string') {
      result.push(expandToken(arg, vars))
    } else if (arg.rules) {
      // Check if ALL rules pass
      const allowed = arg.rules.every(rule => {
        if (rule.action === 'allow') {
          if (rule.os) {
            const osName = rule.os.name
            const osArch = rule.os.arch
            if (osName && osName !== 'windows') return false
            if (osArch && osArch !== 'x64' && osArch !== 'x86_64') return false
            return true
          }
          if (rule.features) {
            // Only allow if all listed features are enabled and non-null
            return Object.entries(rule.features).every(([feat, val]) => {
              if (val === null) return true // null means "not quick_play_realms" etc — treat as pass
              return enabledFeatures[feat] === val
            })
          }
          return true
        }
        return false
      })

      if (allowed) {
        const values = Array.isArray(arg.value) ? arg.value : [arg.value]
        for (const v of values) result.push(expandToken(v, vars))
      }
    }
  }

  return result
}

/**
 * Main launch function.
 *
 * @param {object} opts
 * @param {object} opts.profile         - Modrinth profile object { name, folderName, gameVersion, ... }
 * @param {string} opts.versionId       - e.g. "1.21.10-0.18.4"
 * @param {object} opts.authInfo        - { username, uuid, accessToken, xuid, clientId, userType }
 * @param {string} [opts.gameDir]       - Override game directory (defaults to profile folder)
 * @param {number} [opts.maxMemoryMb]   - Max heap in MB (default 4096)
 * @param {function} [opts.onLog]       - Callback for stdout/stderr lines
 * @param {function} [opts.onClose]     - Callback when MC exits: (code) => void
 * @returns {ChildProcess}
 */
function launchMinecraft({
  versionId,
  authInfo,
  gameDir,
  maxMemoryMb = 4096,
  onLog,
  onClose,
}) {
  if (!versionId) throw new Error('versionId is required')

  const versionJson = readVersionJson(versionId)
  const javaPath = findJava(versionJson.javaVersion.majorVersion)
  const classpath = buildClasspath(versionJson, versionId)
  const nativesDir = path.join(VERSIONS_DIR, versionId, 'natives')
  const assetsIndexId = versionJson.assets // e.g. "27"
  const logConfigPath = path.join(
    VERSIONS_DIR, versionId,
    versionJson.logging?.client?.file?.id ?? 'client-1.12.xml'
  )

  // Resolve gameDir: either passed in explicitly, or default to profile dir
  const resolvedGameDir = gameDir || path.join(PROFILES_DIR, versionId)

  // Variable substitution map
  const vars = {
    // Auth
    auth_player_name:  authInfo.username,
    auth_uuid:         authInfo.uuid,
    auth_access_token: authInfo.accessToken,
    auth_xuid:         authInfo.xuid         || '',
    clientid:          authInfo.clientId      || '',
    user_type:         authInfo.userType      || 'msa',

    // Version / launch
    version_name:      versionId,
    version_type:      'release',
    game_directory:    resolvedGameDir,

    // Assets
    assets_root:       ASSETS_DIR,
    assets_index_name: assetsIndexId,

    // Natives & classpath
    natives_directory: nativesDir,
    classpath:         classpath,

    // Forge-specific
    library_directory:  LIBRARIES_DIR,
    classpath_separator: ';',  // Windows path separator

    // Launcher branding
    launcher_name:    'CraftSync',
    launcher_version: '1.0.0',

    // Logging
    path: logConfigPath,
  }

  // ── Build JVM args ────────────────────────────────────────────────────────
  const jvmArgs = [
    `-Xmx${maxMemoryMb}m`,
    `-Xms512m`,
    ...processArgs(versionJson.arguments.jvm, vars),
  ]

  // Add log4j config arg if logging section present
  if (versionJson.logging?.client?.argument) {
    jvmArgs.push(expandToken(versionJson.logging.client.argument, vars))
  }

  // ── Build game args ───────────────────────────────────────────────────────
  const gameArgs = processArgs(versionJson.arguments.game, vars)

  // ── Full command ──────────────────────────────────────────────────────────
  const allArgs = [
    ...jvmArgs,
    versionJson.mainClass,
    ...gameArgs,
  ]

  if (onLog) {
    onLog(`[CraftSync] Launching: ${javaPath}`)
    onLog(`[CraftSync] Version: ${versionId}`)
    onLog(`[CraftSync] GameDir: ${resolvedGameDir}`)
    onLog(`[CraftSync] Java: Java ${versionJson.javaVersion.majorVersion}`)
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const proc = spawn(javaPath, allArgs, {
    cwd: resolvedGameDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (onLog) {
    proc.stdout.on('data', d => onLog(`[MC] ${d.toString().trimEnd()}`))
    proc.stderr.on('data', d => onLog(`[MC] ${d.toString().trimEnd()}`))
  }

  proc.on('close', code => {
    if (onLog) onLog(`[CraftSync] Minecraft exited with code ${code}`)
    if (onClose) onClose(code)
  })

  proc.on('error', err => {
    if (onLog) onLog(`[CraftSync] Launch error: ${err.message}`)
    if (onClose) onClose(-1)
  })

  return proc
}

module.exports = { launchMinecraft, findJava, readVersionJson }
