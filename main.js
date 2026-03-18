const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const { PublicClientApplication } = require('@azure/msal-node')
const { launchMinecraft } = require('./src/minecraft-launcher')

if (app.isPackaged) {
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
}

let minecraftProcess = null  // track running MC process

// ── SQLITE3 PATH ──────────────────────────────────────────────
// Use bundled sqlite3.exe so friends don't need it installed
function getSqlite3Path() {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'resources', 'sqlite3.exe')
  }
  // In dev, check assets folder first, fall back to system sqlite3
  const assetPath = path.join(__dirname, 'assets', 'sqlite3.exe')
  return fs.existsSync(assetPath) ? assetPath : 'sqlite3'
}

// ── PROGRESS REPORTING ───────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes) return '0 KB'
  const mb = bytes / 1024 / 1024
  const gb = mb / 1024
  const tb = gb / 1024
  if (tb >= 1)  return `${tb.toFixed(2)} TB`
  if (gb >= 1)  return `${gb.toFixed(2)} GB`
  if (mb >= 1)  return `${mb.toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function sendProgress(step, detail = '', pct = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress:update', { step, detail, pct })
  }
}

// ── OPERATION CANCEL ─────────────────────────────────────────
let cancelController = null

function newCancelController() {
  cancelController = { cancelled: false }
  return cancelController
}

function checkCancelled() {
  if (cancelController?.cancelled) {
    throw new Error('OPERATION_CANCELLED')
  }
}

ipcMain.handle('operation:cancel', () => {
  if (cancelController) cancelController.cancelled = true
  return { success: true }
})

// ── PORTABLE DATA DIR ────────────────────────────────────────
let DATA_DIR = null

function getDataDir() {
  if (!DATA_DIR) {
    DATA_DIR = app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'CraftSync-data')
      : path.join(__dirname, 'CraftSync-data')
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  return DATA_DIR
}

// ── CONFIG ──────────────────────────────────────────────────
const CLIENT_ID = ['f2c9acab', '29c8', '43df', 'ad46', '800fbcd6fb1c'].join('-')
const AUTHORITY = 'https://login.microsoftonline.com/common'
const SCOPES = ['Files.ReadWrite', 'User.Read']
const ONEDRIVE_FOLDER = 'CraftSync'

// ── MSAL SETUP ──────────────────────────────────────────────
const msalConfig = {
  auth: { clientId: CLIENT_ID, authority: AUTHORITY },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        try {
          const data = fs.readFileSync(cachePath(), 'utf8')
          ctx.tokenCache.deserialize(data)
        } catch {}
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) {
          fs.writeFileSync(cachePath(), ctx.tokenCache.serialize())
        }
      }
    }
  }
}

function cachePath() {
  return path.join(getDataDir(), 'token_cache.json')
}

const pca = new PublicClientApplication(msalConfig)

let mainWindow = null
let accessToken = null
let currentUser = null  // tracks logged-in user for offline status on close

// ── WINDOW ──────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0a0c0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// Mark user offline when app is force-closed (X button)
app.on('before-quit', async (e) => {
  if (currentUser && accessToken) {
    e.preventDefault()
    try { await setMemberStatus(null, 'offline') } catch {}
    app.exit(0)
  }
})

// ── AUTH ────────────────────────────────────────────────────
ipcMain.handle('auth:login', async () => {
  try {
    // Try silent first (cached token)
    const accounts = await pca.getTokenCache().getAllAccounts()
    if (accounts.length > 0) {
      const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] })
      accessToken = result.accessToken
      return { success: true, account: { name: result.account.name, username: result.account.username } }
    }
  } catch {}

  // Interactive login via popup window
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 520,
      height: 680,
      parent: mainWindow,
      modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: 'Sign in to Microsoft',
      autoHideMenuBar: true,
    })

    const authUrl =
      `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` +
      `?client_id=${CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=http%3A%2F%2Flocalhost` +
      `&response_mode=query` +
      `&scope=Files.ReadWrite%20User.Read%20offline_access` +
      `&prompt=select_account`

    authWin.loadURL(authUrl)

    let handled = false

    async function handleRedirect(url) {
      if (handled) return
      if (!url.startsWith('http://localhost')) return
      handled = true
      try { authWin.close() } catch {}

      const code = new URL(url).searchParams.get('code')
      if (!code) { resolve({ success: false, error: 'No auth code received' }); return }

      try {
        const tokenRes = await axios.post(
          `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
          new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'http://localhost',
            scope: 'Files.ReadWrite User.Read offline_access',
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        )
        accessToken = tokenRes.data.access_token
        fs.writeFileSync(cachePath(), JSON.stringify({
          refresh_token: tokenRes.data.refresh_token
        }))
        const userRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        })
        resolve({
          success: true,
          account: {
            name: userRes.data.displayName,
            username: userRes.data.userPrincipalName || userRes.data.mail
          }
        })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    }

    // Listen on all redirect events — packaged vs dev Electron behaves differently
    authWin.webContents.on('will-redirect', (event, url) => {
      if (url.startsWith('http://localhost')) { event.preventDefault(); handleRedirect(url) }
    })
    authWin.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('http://localhost')) { event.preventDefault(); handleRedirect(url) }
    })
    authWin.webContents.on('did-navigate', (_, url) => {
      if (url.startsWith('http://localhost')) { handleRedirect(url) }
    })
    authWin.on('closed', () => {
      if (!handled) resolve({ success: false, error: 'Window closed' })
    })
  })
})

ipcMain.handle('auth:logout', async () => {
  try {
    // Mark offline before logging out
    try { await setMemberStatus(null, 'offline') } catch {}
    try { fs.unlinkSync(cachePath()) } catch {}
    accessToken = null
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('auth:check', async () => {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
    if (!cache.refresh_token) return { success: false }

    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: cache.refresh_token,
        scope: 'Files.ReadWrite User.Read offline_access',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )

    accessToken = tokenRes.data.access_token
    fs.writeFileSync(cachePath(), JSON.stringify({
      refresh_token: tokenRes.data.refresh_token || cache.refresh_token
    }))

    const userRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    return {
      success: true,
      account: {
        name: userRes.data.displayName,
        username: userRes.data.userPrincipalName || userRes.data.mail
      }
    }
  } catch {
    return { success: false }
  }
})

// ── ONEDRIVE HELPERS ─────────────────────────────────────────
function apiHeaders() {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

async function refreshAccessToken() {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
    if (!cache.refresh_token) throw new Error('No refresh token')
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: cache.refresh_token,
        scope: 'Files.ReadWrite User.Read offline_access',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    accessToken = tokenRes.data.access_token
    fs.writeFileSync(cachePath(), JSON.stringify({
      refresh_token: tokenRes.data.refresh_token || cache.refresh_token
    }))
  } catch (err) {
    throw new Error('Session expired — please sign in again')
  }
}

async function ensureFolder(folderName, parentId = 'root', driveId = null) {
  try {
    const url = parentId === 'root'
      ? `${driveBase(driveId)}/root:/${folderName}`
      : `${driveBase(driveId)}/items/${parentId}:/${folderName}`
    const res = await axios.get(url, { headers: apiHeaders() })
    return res.data.id
  } catch {
    const url = parentId === 'root'
      ? `${driveBase(driveId)}/root/children`
      : `${driveBase(driveId)}/items/${parentId}/children`
    const res = await axios.post(url, {
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename'
    }, { headers: apiHeaders() })
    return res.data.id
  }
}

async function readJson(filePath, driveId = null) {
  try {
    const url = `${driveBase(driveId)}/root:/${filePath}:/content`
    const res = await axios.get(url, { headers: apiHeaders(), responseType: 'text' })
    return JSON.parse(res.data)
  } catch {
    return null
  }
}

async function writeJson(filePath, data, driveId = null) {
  const content = JSON.stringify(data, null, 2)
  const url = `${driveBase(driveId)}/root:/${filePath}:/content`
  await axios.put(url, content, {
    headers: { ...apiHeaders(), 'Content-Type': 'application/json' }
  })
}

// ── MINECRAFT AUTH ───────────────────────────────────────────
// Reads the active Minecraft token directly from Modrinth's app.db.
// Modrinth handles token refresh, so this is always fresh as long as
// the user has opened Modrinth at least once.
async function getMinecraftAuth() {
  const { execSync } = require('child_process')
  const DB_PATH = path.join(process.env.APPDATA, 'ModrinthApp', 'app.db')

  const sql = 'SELECT uuid, username, access_token, expires FROM minecraft_users WHERE active = 1 LIMIT 1;'
  const result = execSync(`"${getSqlite3Path()}" "${DB_PATH}" "${sql}"`, { encoding: 'utf8', timeout: 5000 }).trim()

  if (!result) throw new Error('No active Minecraft account found in Modrinth. Please open Modrinth and sign in first.')

  const [uuid, username, access_token, expires] = result.split('|')

  // Warn if token is expired (Modrinth should have refreshed it, but just in case)
  const expiresMs = parseInt(expires) * 1000
  if (Date.now() > expiresMs) {
    throw new Error('Minecraft token is expired. Please open Modrinth once to refresh it.')
  }

  // Extract xuid from the JWT payload
  let xuid = ''
  try {
    const payload = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64').toString())
    xuid = payload.xuid || ''
  } catch {}

  return {
    accessToken: access_token,
    uuid,
    username,
    xuid,
    userType: 'msa',
    clientId: CLIENT_ID,
  }
}
// members.json structure: { members: { "email": { name, email, status } } }

async function setMemberStatus(account, status) {
  await ensureFolder(ONEDRIVE_FOLDER)
  const data = await readJson(`${ONEDRIVE_FOLDER}/members.json`) || { members: {} }
  if (!data.members) data.members = {}

  if (status === 'offline' && currentUser) {
    data.members[currentUser.username] = {
      name: currentUser.name,
      email: currentUser.username,
      status: 'offline',
    }
  } else if (account) {
    data.members[account.username] = {
      name: account.name,
      email: account.username,
      status: 'online',
    }
  }
  await writeJson(`${ONEDRIVE_FOLDER}/members.json`, data)
}

ipcMain.handle('members:setOnline', async (_, { account }) => {
  try {
    currentUser = account
    await setMemberStatus(account, 'online')
    return { success: true }
  } catch { return { success: false } }
})

ipcMain.handle('members:setOffline', async () => {
  try {
    await setMemberStatus(null, 'offline')
    currentUser = null
    return { success: true }
  } catch { return { success: false } }
})

ipcMain.handle('members:list', async () => {
  try {
    const data = await readJson(`${ONEDRIVE_FOLDER}/members.json`)
    return { success: true, members: data?.members || {} }
  } catch { return { success: true, members: {} } }
})

// ── OWNER DRIVE ID ───────────────────────────────────────────
// bootstrap.json is shipped with the app and contains the owner's OneDrive drive ID.
// This lets friends' Graph API calls target the owner's drive instead of their own.
function getBootstrapPath() {
  return app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'bootstrap.json')
    : path.join(__dirname, 'bootstrap.json')
}

function getOwnerDriveId() {
  try {
    const data = JSON.parse(fs.readFileSync(getBootstrapPath(), 'utf8'))
    return data.driveId || null
  } catch { return null }
}

// Returns the base URL — uses provided driveId, then bootstrap, then /me/drive
function driveBase(driveId = null) {
  const id = driveId || getOwnerDriveId()
  return id
    ? `https://graph.microsoft.com/v1.0/drives/${id}`
    : `https://graph.microsoft.com/v1.0/me/drive`
}

ipcMain.handle('owner:get-drive-id', async () => {
  try {
    const res = await axios.get('https://graph.microsoft.com/v1.0/me/drive', {
      headers: apiHeaders()
    })
    return { success: true, driveId: res.data.id }
  } catch (err) { return { success: false, error: err.message } }
})

ipcMain.handle('storage:get-quota', async () => {
  try {
    await refreshAccessToken()
    const res = await axios.get('https://graph.microsoft.com/v1.0/me/drive', {
      headers: apiHeaders()
    })
    const quota = res.data.quota
    const used = quota.used || 0
    const total = quota.total || 0
    const remaining = quota.remaining || (total - used)
    const isFreeAccount = total > 0 && total <= 5.5 * 1024 * 1024 * 1024

    // Also get CraftSync folder size specifically
    let craftSyncUsed = 0
    try {
      const folderRes = await axios.get(
        `${driveBase()}/root:/${ONEDRIVE_FOLDER}`,
        { headers: apiHeaders() }
      )
      craftSyncUsed = folderRes.data.size || 0
    } catch {}

    return { success: true, used, total, remaining, isFreeAccount, craftSyncUsed }
  } catch (err) { return { success: false, error: err.message } }
})
ipcMain.handle('worlds:list', async () => {
  try {
    await refreshAccessToken()

    // Fetch own worlds
    await ensureFolder(ONEDRIVE_FOLDER)
    const myDriveRes = await axios.get('https://graph.microsoft.com/v1.0/me/drive', { headers: apiHeaders() })
    const myDriveId = myDriveRes.data.id
    const meRes = await axios.get('https://graph.microsoft.com/v1.0/me', { headers: apiHeaders() })
    const myName = meRes.data.displayName || meRes.data.userPrincipalName

    const myData = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, null)
    const myWorlds = (myData?.worlds || []).map(w => ({
      ...w,
      _driveId: myDriveId,
      _ownerName: myName,
      _isOwn: true,
    }))

    // Fetch friends' worlds
    const friends = readLocalFriends()
    const friendWorlds = []

    for (const friend of friends) {
      try {
        const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, friend.driveId)
        const worlds = (data?.worlds || []).map(w => ({
          ...w,
          _driveId: friend.driveId,
          _ownerName: friend.name,
          _isOwn: false,
        }))
        friendWorlds.push(...worlds)
      } catch (e) {
        console.log(`Could not fetch worlds for friend ${friend.name}:`, e.message)
      }
    }

    return { success: true, worlds: myWorlds, friendWorlds }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── CONFIG & FRIENDS ─────────────────────────────────────────
// config.json stores the owner email and is created on first launch by the owner.
// friends.json stores the list of added friends.

ipcMain.handle('config:get', async () => {
  try {
    const data = await readJson(`${ONEDRIVE_FOLDER}/config.json`)
    return { success: true, config: data }
  } catch { return { success: true, config: null } }
})

ipcMain.handle('config:init', async (_, { ownerEmail }) => {
  try {
    await ensureFolder(ONEDRIVE_FOLDER)
    const existing = await readJson(`${ONEDRIVE_FOLDER}/config.json`)
    if (existing) return { success: true, config: existing } // already initialised
    const config = { ownerEmail, createdAt: new Date().toISOString() }
    await writeJson(`${ONEDRIVE_FOLDER}/config.json`, config)
    return { success: true, config }
  } catch (err) { return { success: false, error: err.message } }
})

ipcMain.handle('friends:list', async () => {
  try {
    const data = await readJson(`${ONEDRIVE_FOLDER}/friends.json`)
    return { success: true, friends: data?.friends || [] }
  } catch { return { success: true, friends: [] } }
})

ipcMain.handle('friends:add', async (_, { email }) => {
  try {
    await refreshAccessToken()

    // Get the CraftSync folder item ID
    const folderRes = await axios.get(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${ONEDRIVE_FOLDER}`,
      { headers: apiHeaders() }
    )
    const folderId = folderRes.data.id

    // Share the folder with write permissions
    await axios.post(
      `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/invite`,
      {
        recipients: [{ email }],
        message: "You've been added to a CraftSync group! Install CraftSync to sync Minecraft worlds.",
        requireSignIn: true,
        sendInvitation: true,
        roles: ['write'],
      },
      { headers: apiHeaders() }
    )

    // Save to friends.json
    const data = await readJson(`${ONEDRIVE_FOLDER}/friends.json`) || { friends: [] }
    if (!data.friends.find(f => f.email === email)) {
      data.friends.push({ email, addedAt: new Date().toISOString() })
      await writeJson(`${ONEDRIVE_FOLDER}/friends.json`, data)
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('friends:remove', async (_, { email }) => {
  try {
    await refreshAccessToken()
    const data = await readJson(`${ONEDRIVE_FOLDER}/friends.json`) || { friends: [] }
    data.friends = data.friends.filter(f => f.email !== email)
    await writeJson(`${ONEDRIVE_FOLDER}/friends.json`, data)
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
})

ipcMain.handle('worlds:add', async (_, { name, localPath, mrpackPath, userName }) => {
  newCancelController()
  try {
    sendProgress('Preparing', 'Setting up OneDrive folder...', 5)
    await ensureFolder(ONEDRIVE_FOLDER)
    await ensureFolder(name, await ensureFolder(ONEDRIVE_FOLDER))

    // Upload world save — stream zip directly to OneDrive, no temp file
    sendProgress('Uploading world', 'Streaming world save to OneDrive...', 5)
    await uploadFolderStreaming(localPath, `${ONEDRIVE_FOLDER}/${name}/world.zip`, null, (pct) => {
      sendProgress('Uploading world', `Streaming world save... ${pct}%`, 5 + Math.round(pct * 0.3))
    })

    let modpack = null
    if (mrpackPath) {
      const mrpackName = path.basename(mrpackPath)

      sendProgress('Uploading modpack', `Uploading ${mrpackName}...`, 40)
      await uploadFile(mrpackPath, `${ONEDRIVE_FOLDER}/${name}/${mrpackName}`)

      const OVERRIDE_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks']
      const uploadedFolders = []
      const profileDir = path.dirname(path.dirname(localPath))
      const folderCount = OVERRIDE_FOLDERS.filter(f => fs.existsSync(path.join(profileDir, f))).length
      let foldersDone = 0

      for (const folder of OVERRIDE_FOLDERS) {
        const folderPath = path.join(profileDir, folder)
        if (!fs.existsSync(folderPath)) continue
        const files = fs.readdirSync(folderPath)
        if (files.length === 0) continue
        const pct = 50 + Math.round((foldersDone / Math.max(folderCount, 1)) * 35)
        sendProgress(`Uploading ${folder}`, `${files.length} files...`, pct)
        await uploadFolderStreaming(folderPath, `${ONEDRIVE_FOLDER}/${name}/overrides_${folder}.zip`, null, (p) => {
          sendProgress(`Uploading ${folder}`, `${files.length} files — ${p}%`, pct + Math.round(p * 0.08))
        })
        uploadedFolders.push(folder)
        foldersDone++
      }

      // Save modlist.json
      try {
        const modsDir = path.join(profileDir, 'mods')
        if (fs.existsSync(modsDir)) {
          sendProgress('Saving modlist', 'Saving mod list for verification...', 88)
          const mods = fs.readdirSync(modsDir)
            .filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
            .sort()
          const modlistPath = path.join(app.getPath('temp'), `modlist_${name}.json`)
          fs.writeFileSync(modlistPath, JSON.stringify({ mods, updatedAt: new Date().toISOString() }, null, 2))
          await uploadFile(modlistPath, `${ONEDRIVE_FOLDER}/${name}/modlist.json`)
          fs.unlinkSync(modlistPath)
        }
      } catch (e) { console.log('modlist save failed:', e.message) }

      modpack = {
        name: mrpackName.replace('.mrpack', ''),
        filename: mrpackName,
        updatedAt: new Date().toISOString(),
        overrideFolders: uploadedFolders,
      }
    }

    // Update worlds.json
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, null) || { worlds: [] }
    // Extract the actual folder name from the path
    const folderName = localPath.split('\\').pop() || localPath.split('/').pop()

    // Detect version from the local Modrinth profile by scanning saves folders
    let gameVersion = null, loaderVersion = null
    try {
      const { execSync } = require('child_process')
      const DB_PATH = path.join(process.env.APPDATA, 'ModrinthApp', 'app.db')
      const MODRINTH_PROFILES = path.join(process.env.APPDATA, 'ModrinthApp', 'profiles')
      const allProfiles = execSync(
        `"${getSqlite3Path()}" "${DB_PATH}" "SELECT path, game_version, mod_loader_version FROM profiles ORDER BY last_played DESC;"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim()
      for (const row of allProfiles.split('\n').filter(Boolean)) {
        const [pPath, gv, mlv] = row.split('|')
        const savesPath = path.join(MODRINTH_PROFILES, pPath?.trim(), 'saves', folderName)
        if (fs.existsSync(savesPath)) {
          gameVersion = gv?.trim()
          loaderVersion = mlv?.trim()
          break
        }
      }
    } catch (e) {
      console.log('Version detection failed (non-fatal):', e.message)
    }

    const newWorld = {
      id: `w_${Date.now()}`,
      name,
      folderName,
      theme: ['grass', 'nether', 'sky'][data.worlds.length % 3],
      createdBy: userName || null,
      gameVersion,
      loaderVersion,
      lastPlayer: null,
      lastPlayedAt: null,
      lockedBy: null,
      lockedAt: null,
      modpack,
      hasModlist: modpack?.overrideFolders?.includes('mods') || false,
      createdAt: new Date().toISOString(),
    }
    data.worlds.push(newWorld)
    sendProgress('Saving', 'Saving world list...', 95)
    await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, null)

    // Build and save manifest so first Play skips the full zip download
    sendProgress('Saving manifest', 'Recording file state...', 97)
    try {
      const manifest = { ...buildManifest(localPath), updatedAt: new Date().toISOString(), updatedBy: userName }
      const manifestTmp = path.join(app.getPath('temp'), `manifest_${newWorld.id}.json`)
      fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2))
      await uploadFile(manifestTmp, `${ONEDRIVE_FOLDER}/${name}/manifest.json`, null)
      fs.unlinkSync(manifestTmp)
      writeLocalManifest(newWorld.id, manifest)
      console.log(`Manifest saved — ${Object.keys(manifest.files).length} files recorded`)
    } catch (e) {
      console.log('Manifest save failed (non-fatal):', e.message)
    }

    sendProgress('Done', 'World uploaded successfully!', 100)

    // Store the saves folder (parent of the world folder) not the world folder itself
    const savesPath = path.dirname(localPath)
    const paths = readLocalSavesPaths()
    paths[newWorld.id] = savesPath
    writeLocalSavesPaths(paths)

    return { success: true, world: newWorld, localSavesPath: savesPath }
  } catch (err) {
    if (err.message === 'OPERATION_CANCELLED') return { success: false, cancelled: true, error: 'Upload cancelled.' }
    console.error('worlds:add error:', err)
    return { success: false, error: err.message }
  }
})

// ── MODRINTH PROFILE RESOLVER ────────────────────────────────
// Finds the best matching Modrinth profile and versionId for a given world.
// worldFolder: the save folder name to match against (can be null for join flow)
// modrinthProfile: optional hint stored on the world object
async function resolveModrinthProfile(worldFolder, modrinthProfile, gameVersion, loaderVersion, worldModlist = []) {
  const { execSync } = require('child_process')
  const MODRINTH_BASE_DIR = path.join(process.env.APPDATA, 'ModrinthApp')
  const MODRINTH_PROFILES = path.join(MODRINTH_BASE_DIR, 'profiles')
  const DB_PATH = path.join(MODRINTH_BASE_DIR, 'app.db')

  const sql = 'SELECT path, game_version, mod_loader_version, last_played FROM profiles ORDER BY last_played DESC;'
  const result = execSync(`"${getSqlite3Path()}" "${DB_PATH}" "${sql}"`, { encoding: 'utf8', timeout: 5000 }).trim()
  const rows = result.split('\n').filter(Boolean).map(line => {
    const [p, gv, mlv] = line.split('|')
    return { path: p?.trim(), game_version: gv?.trim(), mod_loader_version: mlv?.trim() }
  })

  let gameDir = null
  let resolvedVersionId = null

  const makeVersionId = (row) => row.mod_loader_version
    ? `${row.game_version}-${row.mod_loader_version}`
    : row.game_version

  // Strategy 1: find profile whose saves/<worldFolder> exists on disk
  if (worldFolder) {
    for (const row of rows) {
      if (!row.path) continue
      const profilePath = path.join(MODRINTH_PROFILES, row.path)
      if (fs.existsSync(path.join(profilePath, 'saves', worldFolder))) {
        gameDir = profilePath
        resolvedVersionId = makeVersionId(row)
        break
      }
    }
  }

  // Strategy 2: match by stored modrinthProfile name
  if (!gameDir && modrinthProfile) {
    const row = rows.find(r => r.path === modrinthProfile)
    if (row) {
      gameDir = path.join(MODRINTH_PROFILES, row.path)
      resolvedVersionId = makeVersionId(row)
    }
  }

  // Strategy 2.5: exact match by game_version + mod_loader_version stored on the world
  if (!gameDir && gameVersion) {
    const matching = rows.filter(r =>
      r.game_version === gameVersion &&
      (!loaderVersion || r.mod_loader_version === loaderVersion)
    )

    if (matching.length === 1) {
      gameDir = path.join(MODRINTH_PROFILES, matching[0].path)
      resolvedVersionId = makeVersionId(matching[0])
    } else if (matching.length > 1) {
      // Multiple profiles with same version — use modlist to pick the best one
      if (worldModlist && worldModlist.length > 0) {
        let bestMatch = null
        let bestScore = -1
        for (const row of matching) {
          const modsDir = path.join(MODRINTH_PROFILES, row.path, 'mods')
          if (!fs.existsSync(modsDir)) continue
          const localMods = fs.readdirSync(modsDir)
            .filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
          const matches = worldModlist.filter(m => localMods.includes(m)).length
          if (matches > bestScore) {
            bestScore = matches
            bestMatch = row
          }
        }
        const picked = bestMatch || matching[0]
        gameDir = path.join(MODRINTH_PROFILES, picked.path)
        resolvedVersionId = makeVersionId(picked)
      } else {
        // No modlist — pick most recently played of matching profiles
        gameDir = path.join(MODRINTH_PROFILES, matching[0].path)
        resolvedVersionId = makeVersionId(matching[0])
      }
    }
  }

  // Strategy 3: no match found — do NOT fall back to wrong version
  if (!gameDir && gameVersion) {
    return {
      gameDir: null,
      resolvedVersionId: null,
      MODRINTH_PROFILES,
      noMatchError: `No Modrinth profile found for Minecraft ${gameVersion}${loaderVersion ? ` with Fabric/Forge ${loaderVersion}` : ''}. Please install this version in Modrinth first.`
    }
  }

  // Strategy 3: no version info stored — fall back to most recently played
  if (!gameDir && rows.length > 0) {
    const row = rows[0]
    gameDir = path.join(MODRINTH_PROFILES, row.path)
    resolvedVersionId = makeVersionId(row)
  }

  return { gameDir, resolvedVersionId, MODRINTH_PROFILES }
}

ipcMain.handle('worlds:play', async (_, { worldId, localSavesPath, userName, versionId, authInfo, forceOverwrite, driveId = null }) => {
  try {
    // Ensure we have a fresh token before any OneDrive calls
    await refreshAccessToken()

    // Bail if MC is already running
    if (minecraftProcess && !minecraftProcess.killed) {
      return { success: false, error: 'Minecraft is already running' }
    }

    // Lock the world
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    if (!data || !data.worlds) return { success: false, error: 'Could not read worlds.json from OneDrive. Are you signed in?' }
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }
    if (world.lockedBy && world.lockedBy !== userName) {
      return { success: false, error: `World is locked by ${world.lockedBy}` }
    }

    world.lockedBy = userName
    world.lockedAt = new Date().toISOString()
    await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)

    // ── Check if local world was modified outside CraftSync ───
    const worldFolder = world.folderName || world.name
    const destPath = path.join(localSavesPath, worldFolder)

    if (!forceOverwrite && fs.existsSync(destPath) && world.lastUploadedAt) {
      const lastUploadMs = new Date(world.lastUploadedAt).getTime()
      const localNewestMs = getNewestMtime(destPath)
      // If local folder has files newer than the last upload, warn the user
      if (localNewestMs > lastUploadMs + 5000) {
        // Unlock the world before returning — user hasn't started playing
        world.lockedBy = null
        world.lockedAt = null
        await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)

        const localDate = new Date(localNewestMs).toLocaleString()
        const uploadDate = new Date(lastUploadMs).toLocaleString()
        return {
          success: false,
          modifiedWarning: true,
          error: `Your local copy of "${world.name}" was modified after the last sync.\n\nLocal: ${localDate}\nLast synced: ${uploadDate}\n\nThis may mean you played outside CraftSync. Continuing will overwrite your local changes with the OneDrive version.`,
        }
      }
    }

    // ── Download world — delta if possible, full zip if first time ──
    const oneDriveManifest = await readJson(`${ONEDRIVE_FOLDER}/${world.name}/manifest.json`, driveId)
    const localManifest = readLocalManifest(worldId)
    const hasLocalWorld = fs.existsSync(destPath) && Object.keys(localManifest.files).length > 0

    console.log(`[Play] World: "${world.name}"`)
    console.log(`[Play] OneDrive manifest: ${oneDriveManifest ? `${Object.keys(oneDriveManifest.files).length} files` : 'NONE'}`)
    console.log(`[Play] Local manifest: ${hasLocalWorld ? `${Object.keys(localManifest.files).length} files` : 'NONE — will do full download'}`)

    if (!oneDriveManifest || !hasLocalWorld) {
      // ── First time or no manifest — full zip download ──────────
      console.log(`[Download] Mode: FULL ZIP`)
      sendProgress('Downloading world', `Fetching "${world.name}" (first time)...`, 20)
      console.log(`[Download] Getting download URL...`)
      const zipUrl = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/world.zip`, driveId)
      const zipPath = path.join(app.getPath('temp'), `${world.name}.zip`)
      console.log(`[Download] Downloading zip to temp...`)
      await downloadFile(zipUrl, zipPath, (received, total) => {
        const pct = Math.round((received / total) * 30) // 20-50% range
        sendProgress('Downloading world', `${fmtSize(received)} / ${fmtSize(total)}`, 20 + pct)
      })
      console.log(`[Download] Zip received: ${fmtSize(fs.statSync(zipPath).size)} — extracting...`)

      sendProgress('Extracting world', 'Unpacking world save...', 52)
      const PRESERVE_DIRS = ['voxy', 'distant_horizons']
      if (fs.existsSync(destPath)) {
        for (const entry of fs.readdirSync(destPath)) {
          if (PRESERVE_DIRS.includes(entry.toLowerCase())) continue
          fs.rmSync(path.join(destPath, entry), { recursive: true, force: true })
        }
      } else {
        fs.mkdirSync(destPath, { recursive: true })
      }
      await unzipTo(zipPath, destPath)
      fs.unlinkSync(zipPath)
      console.log(`[Download] Extraction complete`)

      // Save local manifest from what OneDrive has
      if (oneDriveManifest) {
        writeLocalManifest(worldId, { files: oneDriveManifest.files })
      } else {
        writeLocalManifest(worldId, buildManifest(destPath))
      }
      console.log(`[Download] Local manifest saved`)

    } else {
      // ── Delta download — only fetch what changed ────────────────
      console.log(`[Download] Mode: DELTA`)
      const remoteFiles = oneDriveManifest.files
      const localFiles = localManifest.files

      // Files that differ between OneDrive manifest and our local manifest
      const toDownload = []
      for (const [relPath, remoteInfo] of Object.entries(remoteFiles)) {
        const local = localFiles[relPath]
        if (!local || local.size !== remoteInfo.size || local.mtime !== remoteInfo.mtime) {
          toDownload.push(relPath)
        }
      }

      // Files deleted on OneDrive since our last sync
      const toDelete = Object.keys(localFiles).filter(f => !remoteFiles[f])

      // Also check deletions recorded explicitly in manifest
      if (oneDriveManifest.deletions) {
        for (const f of oneDriveManifest.deletions) {
          if (!toDelete.includes(f)) toDelete.push(f)
        }
      }

      console.log(`Delta download: ${toDownload.length} to fetch, ${toDelete.length} to delete`)

      if (toDownload.length === 0 && toDelete.length === 0) {
        sendProgress('Up to date', 'World is already up to date', 100)
      } else {
        const totalBytes = toDownload.reduce((sum, f) => sum + (remoteFiles[f]?.size || 0), 0)
        
        // Check if any files to download exist in delta/ — probe the first missing one
        // Files only appear in delta/ after at least one delta upload session
        // Files from the initial zip upload are NOT in delta/
        let hasDeltaFiles = true
        if (toDownload.length > 0) {
          try {
            await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/delta/${toDownload[0]}`, driveId)
          } catch {
            hasDeltaFiles = false
          }
        }

        if (!hasDeltaFiles) {
          // Delta folder doesn't have these files — they're from the original zip
          // Fall back to full zip download
          sendProgress('Downloading world', `Missing files not in delta — downloading full world.zip...`, 20)
          const zipUrl = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/world.zip`, driveId)
          const zipPath = path.join(app.getPath('temp'), `${world.name}.zip`)
          await downloadFile(zipUrl, zipPath, (received, total) => {
            const pct = Math.round((received / total) * 30)
            sendProgress('Downloading world', `${fmtSize(received)} / ${fmtSize(total)}`, 20 + pct)
          })

          sendProgress('Extracting world', 'Unpacking world save...', 52)
          const PRESERVE_DIRS = ['voxy', 'distant_horizons']
          if (fs.existsSync(destPath)) {
            for (const entry of fs.readdirSync(destPath)) {
              if (PRESERVE_DIRS.includes(entry.toLowerCase())) continue
              fs.rmSync(path.join(destPath, entry), { recursive: true, force: true })
            }
          } else {
            fs.mkdirSync(destPath, { recursive: true })
          }
          await unzipTo(zipPath, destPath)
          fs.unlinkSync(zipPath)
          writeLocalManifest(worldId, { files: remoteFiles })

        } else {
          // Download changed files from delta/ folder
          let done = 0
          for (const relPath of toDownload) {
            const pct = 20 + Math.round((done / toDownload.length) * 35)
            sendProgress('Downloading changes', `${relPath} (${done + 1}/${toDownload.length}) — ${fmtSize(totalBytes)} total`, pct)

            const localDest = path.join(destPath, relPath.replace(/\//g, path.sep))
            fs.mkdirSync(path.dirname(localDest), { recursive: true })

            try {
              const url = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/delta/${relPath}`, driveId)
              await downloadFile(url, localDest)
            } catch {
              console.log(`${relPath} not in delta/, skipping`)
            }
            done++
          }

          // Delete removed files
          for (const relPath of toDelete) {
            const localDest = path.join(destPath, relPath.replace(/\//g, path.sep))
            try { fs.unlinkSync(localDest) } catch {}
          }

          // Update local manifest
          writeLocalManifest(worldId, { files: remoteFiles })
        }
      }
    }

    sendProgress('Checking mods', 'Verifying mod list...', 75)

    // ── Resolve Modrinth profile & versionId ─────────────────
    let gameDir, resolvedVersionId, noMatchError
    try {
      // Fetch modlist from OneDrive to help pick the right profile
      let worldModlist = []
      if (world.hasModlist) {
        try {
          const modlistData = await readJson(`${ONEDRIVE_FOLDER}/${world.name}/modlist.json`)
          worldModlist = modlistData?.mods || []
        } catch {}
      }
      ;({ gameDir, resolvedVersionId, noMatchError } = await resolveModrinthProfile(worldFolder, world.modrinthProfile, world.gameVersion, world.loaderVersion, worldModlist))
    } catch (dbErr) {
      return { success: false, error: `Could not read Modrinth database: ${dbErr.message}` }
    }

    if (noMatchError) {
      // Unlock before returning
      world.lockedBy = null; world.lockedAt = null
      await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)
      return { success: false, error: noMatchError }
    }
    if (!resolvedVersionId) {
      return { success: false, error: 'Could not detect Minecraft version. Please play this world in Modrinth at least once first.' }
    }
    if (!gameDir) {
      gameDir = path.dirname(localSavesPath)
    }

    // Auto-update gameVersion/loaderVersion on the world if not already set
    if (resolvedVersionId && (!world.gameVersion || !world.loaderVersion)) {
      const parts = resolvedVersionId.split('-')
      if (parts.length >= 2) {
        world.gameVersion = parts[0]
        world.loaderVersion = parts.slice(1).join('-')
        try { await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId) } catch {}
      }
    }

    // ── Verify mods match modlist.json ────────────────────────
    if (world.hasModlist) {
      try {
        const modlistData = await readJson(`${ONEDRIVE_FOLDER}/${world.name}/modlist.json`)
        if (modlistData?.mods) {
          const localModsDir = path.join(gameDir, 'mods')
          if (fs.existsSync(localModsDir)) {
            const localMods = fs.readdirSync(localModsDir)
              .filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
              .sort()
            const requiredMods = modlistData.mods
            const missing = requiredMods.filter(m => !localMods.includes(m))
            const extra = localMods.filter(m => !requiredMods.includes(m))

            if (missing.length > 0 || extra.length > 0) {
              // Unlock world before returning
              world.lockedBy = null
              world.lockedAt = null
              await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)

              return {
                success: false,
                modMismatch: true,
                missing,
                extra,
                error: `Your mods don't match the world's modlist.`,
              }
            }
          }
        }
      } catch (modCheckErr) {
        console.log('Mod check failed (non-fatal):', modCheckErr.message)
      }
    }

    // ── Get real Minecraft auth ───────────────────────────────
    let mcAuth
    try {
      mcAuth = await getMinecraftAuth()
    } catch (authErr) {
      return { success: false, error: `Minecraft auth failed: ${authErr.message}` }
    }

    sendProgress('Launching', 'Starting Minecraft...', 98)
    minecraftProcess = launchMinecraft({
      versionId: resolvedVersionId,
      authInfo: mcAuth,
      gameDir,
      maxMemoryMb: 4096,
      onLog: (line) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mc:log', line)
        }
      },
      onClose: async (code) => {
        minecraftProcess = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mc:closed', { code, worldId })
        }
        // Auto-upload world after MC closes — use delta if manifest exists
        try {
          await refreshAccessToken()
          const refreshed = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
          const w = refreshed.worlds.find(x => x.id === worldId)
          if (w && w.lockedBy === userName) {
            const wf = w.folderName || w.name
            const wp = path.join(localSavesPath, wf)

            const oneDriveManifest = await readJson(`${ONEDRIVE_FOLDER}/${w.name}/manifest.json`, driveId)
            const localManifest = readLocalManifest(worldId)
            const hasManifest = !!oneDriveManifest && Object.keys(localManifest.files).length > 0

            if (!hasManifest) {
              // First upload
              sendProgress('Uploading world', `Full upload (first time)...`, 5)
              await uploadFolderStreaming(wp, `${ONEDRIVE_FOLDER}/${w.name}/world.zip`, driveId, (pct) => {
                sendProgress('Uploading world', `Full upload... ${pct}%`, 5 + Math.round(pct * 0.7))
              })
              const manifest = { ...buildManifest(wp), updatedAt: new Date().toISOString(), updatedBy: userName }
              const mp = path.join(require('os').tmpdir(), `manifest_${worldId}.json`)
              fs.writeFileSync(mp, JSON.stringify(manifest, null, 2))
              await uploadFile(mp, `${ONEDRIVE_FOLDER}/${w.name}/manifest.json`, driveId)
              fs.unlinkSync(mp)
              writeLocalManifest(worldId, manifest)
            } else {
              // Delta upload
              const localFiles = buildManifest(wp)
              const changed = Object.entries(localFiles.files)
                .filter(([rel, info]) => {
                  const prev = localManifest.files[rel]
                  return !prev || prev.size !== info.size || prev.mtime !== info.mtime
                })
                .map(([rel]) => rel)
              const deleted = Object.keys(oneDriveManifest.files).filter(f => !localFiles.files[f])

              sendProgress('Uploading changes', `${changed.length} files changed...`, 10)
              let done = 0
              for (const relPath of changed) {
                const pct = 10 + Math.round((done / Math.max(changed.length, 1)) * 65)
                sendProgress('Uploading changes', `${relPath} (${done + 1}/${changed.length}) — ${pct}%`, pct)
                await uploadFile(path.join(wp, relPath.replace(/\//g, path.sep)), `${ONEDRIVE_FOLDER}/${w.name}/delta/${relPath}`, driveId)
                done++
              }

              const newManifest = { files: { ...oneDriveManifest.files, ...localFiles.files }, deletions: deleted, updatedAt: new Date().toISOString(), updatedBy: userName }
              const mp = path.join(require('os').tmpdir(), `manifest_${worldId}.json`)
              fs.writeFileSync(mp, JSON.stringify(newManifest, null, 2))
              await uploadFile(mp, `${ONEDRIVE_FOLDER}/${w.name}/manifest.json`, driveId)
              fs.unlinkSync(mp)
              writeLocalManifest(worldId, { files: localFiles.files })
            }

            // Update modlist.json
            try {
              const modsDir = path.join(localSavesPath, '..', 'mods')
              if (fs.existsSync(modsDir)) {
                const mods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') && !f.endsWith('.disabled')).sort()
                const modlistPath = path.join(require('os').tmpdir(), `${w.name}_modlist.json`)
                fs.writeFileSync(modlistPath, JSON.stringify({ mods, updatedAt: new Date().toISOString(), updatedBy: userName }, null, 2))
                await uploadFile(modlistPath, `${ONEDRIVE_FOLDER}/${w.name}/modlist.json`, driveId)
                fs.unlinkSync(modlistPath)
                w.hasModlist = true
              }
            } catch {}

            w.lockedBy = null
            w.lockedAt = null
            w.lastPlayer = userName
            w.lastPlayedAt = new Date().toISOString()
            w.lastUploadedAt = new Date().toISOString()
            sendProgress('Done', 'World saved', 100)
            await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, refreshed, driveId)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('mc:uploaded', { worldId })
            }
          }
        } catch (uploadErr) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mc:upload-error', { worldId, error: uploadErr.message })
          }
        }
      },
    })

    return { success: true, launched: true }
  } catch (err) {
    // Unlock world on any error including cancellation
    try {
      const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
      const world = data.worlds.find(w => w.id === worldId)
      if (world && world.lockedBy === userName) {
        world.lockedBy = null
        world.lockedAt = null
        await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)
        console.log(`World unlocked after ${err.message === 'OPERATION_CANCELLED' ? 'cancellation' : 'error'}`)
      }
    } catch {}
    if (err.message === 'OPERATION_CANCELLED') {
      return { success: false, cancelled: true, error: 'Download cancelled.' }
    }
    return { success: false, error: err.message }
  }
})

// Kill MC if it's running (e.g. force-stop button)
ipcMain.handle('mc:kill', () => {
  if (minecraftProcess && !minecraftProcess.killed) {
    minecraftProcess.kill()
    return { success: true }
  }
  return { success: false, error: 'No Minecraft process running' }
})

// Query whether MC is currently running
ipcMain.handle('mc:status', () => {
  return { running: !!(minecraftProcess && !minecraftProcess.killed) }
})

// Join a world — launch MC directly without downloading the world save.
// Essential handles the actual multiplayer join.
ipcMain.handle('worlds:join', async (_, { worldId, userName, driveId = null }) => {
  try {
    if (minecraftProcess && !minecraftProcess.killed) {
      return { success: false, error: 'Minecraft is already running' }
    }

    await refreshAccessToken()
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    if (!data?.worlds) return { success: false, error: 'Could not read worlds.json' }
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    // Resolve profile — no worldFolder needed since we're not downloading
    let gameDir, resolvedVersionId, noMatchError
    try {
      let worldModlist = []
      if (world.hasModlist) {
        try {
          const modlistData = await readJson(`${ONEDRIVE_FOLDER}/${world.name}/modlist.json`)
          worldModlist = modlistData?.mods || []
        } catch {}
      }
      ;({ gameDir, resolvedVersionId, noMatchError } = await resolveModrinthProfile(null, world.modrinthProfile, world.gameVersion, world.loaderVersion, worldModlist))
    } catch (dbErr) {
      return { success: false, error: `Could not read Modrinth database: ${dbErr.message}` }
    }

    if (noMatchError) return { success: false, error: noMatchError }
    if (!resolvedVersionId) {
      return { success: false, error: 'Could not detect Minecraft version. Please play this world in Modrinth at least once first.' }
    }

    // ── Get real Minecraft auth ───────────────────────────────
    let mcAuth
    try {
      mcAuth = await getMinecraftAuth()
    } catch (authErr) {
      return { success: false, error: `Minecraft auth failed: ${authErr.message}` }
    }

    minecraftProcess = launchMinecraft({
      versionId: resolvedVersionId,
      authInfo: mcAuth,
      gameDir,
      maxMemoryMb: 4096,
      onLog: (line) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mc:log', line)
        }
      },
      onClose: (code) => {
        minecraftProcess = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mc:join-closed', { code, worldId })
        }
      },
    })

    return { success: true, launched: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('worlds:upload', async (_, { worldId, localSavesPath, userName, driveId = null }) => {
  newCancelController()
  try {
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    const worldFolder = world.folderName || world.name
    const worldPath = path.join(localSavesPath, worldFolder)

    // ── Check if OneDrive has a manifest (i.e. full zip already exists) ──
    const oneDriveManifest = await readJson(`${ONEDRIVE_FOLDER}/${world.name}/manifest.json`, driveId)
    const hasFullUpload = !!oneDriveManifest

    if (!hasFullUpload) {
      // ── First upload — full zip + manifest ─────────────────────
      sendProgress('First upload', `Building full world zip (one-time)...`, 5)
      await uploadFolderStreaming(worldPath, `${ONEDRIVE_FOLDER}/${world.name}/world.zip`, driveId, (pct) => {
        sendProgress('Uploading world', `Full upload... ${pct}%`, 5 + Math.round(pct * 0.7))
      })

      // Write manifest to OneDrive
      sendProgress('Saving manifest', 'Recording file state...', 78)
      const manifest = { ...buildManifest(worldPath), updatedAt: new Date().toISOString(), updatedBy: userName }
      const manifestPath = path.join(app.getPath('temp'), `manifest_${worldId}.json`)
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      await uploadFile(manifestPath, `${ONEDRIVE_FOLDER}/${world.name}/manifest.json`, driveId)
      fs.unlinkSync(manifestPath)

      // Save local manifest so next upload can delta
      writeLocalManifest(worldId, manifest)
      console.log(`Full upload complete — ${Object.keys(manifest.files).length} files recorded in manifest`)

    } else {
      // ── Delta upload — only changed files ──────────────────────
      const localManifest = readLocalManifest(worldId)
      const localFiles = buildManifest(worldPath)

      // Find files that are new or changed since last sync
      const changed = []
      for (const [relPath, info] of Object.entries(localFiles.files)) {
        const prev = localManifest.files[relPath]
        if (!prev || prev.size !== info.size || prev.mtime !== info.mtime) {
          changed.push(relPath)
        }
      }
      // Find files deleted locally
      const deleted = Object.keys(oneDriveManifest.files).filter(f => !localFiles.files[f])

      console.log(`Delta upload: ${changed.length} changed, ${deleted.length} deleted out of ${Object.keys(localFiles.files).length} total files`)

      if (changed.length === 0 && deleted.length === 0) {
        sendProgress('Up to date', 'No changes to upload', 100)
      } else {
        const totalBytes = changed.reduce((sum, f) => sum + (localFiles.files[f]?.size || 0), 0)
        
        // Upload changed files individually
        let done = 0
        for (const relPath of changed) {
          checkCancelled()
          const localFile = path.join(worldPath, relPath.replace(/\//g, path.sep))
          const remotePath = `${ONEDRIVE_FOLDER}/${world.name}/delta/${relPath}`
          const pct = 5 + Math.round((done / changed.length) * 70)
          sendProgress('Uploading changes', `${relPath} (${done + 1}/${changed.length}) — ${fmtSize(totalBytes)} total`, pct)
          // Ensure parent folder exists by using the file path directly
          await uploadFile(localFile, remotePath, driveId)
          done++
        }

        // Record deletions in manifest
        for (const relPath of deleted) {
          delete oneDriveManifest.files[relPath]
        }

        // Update OneDrive manifest
        sendProgress('Saving manifest', 'Updating file record...', 78)
        const newManifest = {
          files: { ...oneDriveManifest.files, ...localFiles.files },
          deletions: deleted,
          updatedAt: new Date().toISOString(),
          updatedBy: userName,
        }
        const manifestPath = path.join(app.getPath('temp'), `manifest_${worldId}.json`)
        fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2))
        await uploadFile(manifestPath, `${ONEDRIVE_FOLDER}/${world.name}/manifest.json`, driveId)
        fs.unlinkSync(manifestPath)

        // Update local manifest
        writeLocalManifest(worldId, { files: localFiles.files })
      }
    }

    // ── Save modlist.json ─────────────────────────────────────
    sendProgress('Saving modlist', 'Updating mod list...', 85)
    try {
      const modsDir = path.join(localSavesPath, '..', 'mods')
      if (fs.existsSync(modsDir)) {
        const mods = fs.readdirSync(modsDir)
          .filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
          .sort()
        const modlist = { mods, updatedAt: new Date().toISOString(), updatedBy: userName }
        const modlistJson = JSON.stringify(modlist, null, 2)
        const modlistPath = path.join(app.getPath('temp'), `${world.name}_modlist.json`)
        fs.writeFileSync(modlistPath, modlistJson)
        await uploadFile(modlistPath, `${ONEDRIVE_FOLDER}/${world.name}/modlist.json`, driveId)
        fs.unlinkSync(modlistPath)
        world.hasModlist = true
      }
    } catch (modErr) {
      console.log('Modlist upload failed (non-fatal):', modErr.message)
    }

    // Unlock and update metadata
    world.lockedBy = null
    world.lockedAt = null
    world.lastPlayer = userName
    world.lastPlayedAt = new Date().toISOString()
    world.lastUploadedAt = new Date().toISOString()
    sendProgress('Done', 'World saved to OneDrive', 100)
    await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('worlds:delete', async (_, { worldId, userName, driveId = null }) => {
  try {
    await refreshAccessToken()
    // Block if driveId belongs to someone else's drive
    if (driveId) {
      const myDrive = await axios.get('https://graph.microsoft.com/v1.0/me/drive', { headers: apiHeaders() })
      if (driveId !== myDrive.data.id) {
        return { success: false, error: 'You can only delete your own worlds.' }
      }
    }
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    // Only the creator can delete — server-side enforcement
    if (world.createdBy && world.createdBy !== userName) {
      return { success: false, error: `Only ${world.createdBy} can delete this world` }
    }

    // Delete the world folder from OneDrive
    try {
      const url = `${driveBase()}/root:/${ONEDRIVE_FOLDER}/${world.name}`
      await axios.delete(url, { headers: apiHeaders() })
    } catch (e) {
      console.log('Folder delete error (may not exist):', e.message)
    }

    // Remove from worlds.json
    data.worlds = data.worlds.filter(w => w.id !== worldId)
    await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('worlds:download-modpack', async (_, { worldId, driveId = null }) => {
  try {
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world?.modpack) return { success: false, error: 'No modpack attached' }

    const url = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/${world.modpack.filename}`)
    const destPath = path.join(app.getPath('downloads'), world.modpack.filename)
    await downloadFile(url, destPath)

    return { success: true, path: destPath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('worlds:upload-modpack', async (_, { worldId, mrpackPath, localSavesPath, driveId = null, skipFolders = false }) => {
  newCancelController()
  try {
    await refreshAccessToken()
    if (driveId) {
      const myDrive = await axios.get('https://graph.microsoft.com/v1.0/me/drive', { headers: apiHeaders() })
      if (driveId !== myDrive.data.id) {
        return { success: false, error: 'You can only update modpacks on your own worlds.' }
      }
    }
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    const mrpackName = path.basename(mrpackPath)

    sendProgress('Uploading modpack', `Uploading ${mrpackName}...`, 10)
    await uploadFile(mrpackPath, `${ONEDRIVE_FOLDER}/${world.name}/${mrpackName}`)

    // Skip folder uploads for free accounts — just update the .mrpack file
    if (skipFolders) {
      sendProgress('Saving', 'Updating modpack info...', 95)
      world.modpack = {
        name: mrpackName.replace('.mrpack', ''),
        filename: mrpackName,
        updatedAt: new Date().toISOString(),
        overrideFolders: world.modpack?.overrideFolders || [],
        folderFingerprints: world.modpack?.folderFingerprints || {},
      }
      await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)
      sendProgress('Done', '.mrpack updated (folder sync skipped on free plan)', 100)
      return { success: true, modpack: world.modpack, uploadedFolders: [], skippedFolders: [] }
    }

    // ── Upload mod folders directly from profile ──────────────
    // Much more reliable than extracting from the zip
    const OVERRIDE_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks']
    const uploadedFolders = []

    // Find profile dir — try name match first (most reliable), then stored saves path
    let profileDir = null

    // Primary: match profile folder name against modpack name
    try {
      const modpackBaseName = mrpackName.replace('.mrpack', '').toLowerCase().trim()
      const profilesBase = path.join(process.env.APPDATA, 'ModrinthApp', 'profiles')
      const profiles = fs.readdirSync(profilesBase, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name)
      console.log('Available profiles:', profiles)
      console.log('Modpack base name:', modpackBaseName)
      const match = profiles.find(p =>
        modpackBaseName.startsWith(p.toLowerCase()) ||
        p.toLowerCase().startsWith(modpackBaseName) ||
        modpackBaseName === p.toLowerCase()
      )
      if (match) profileDir = path.join(profilesBase, match)
      console.log('Profile name match:', match, '→', profileDir)
    } catch (e) { console.log('Profile name match failed:', e.message) }

    // Fallback: derive from stored saves path
    if (!profileDir) {
      const storedSaves = localSavesPath || (() => {
        const paths = readLocalSavesPaths()
        return paths[worldId] || null
      })()
      if (storedSaves) profileDir = path.dirname(storedSaves)
      console.log('Fallback from saves path:', storedSaves, '→', profileDir)
    }

    if (!profileDir) {
      return { success: false, error: 'Could not find your Modrinth profile. Make sure the profile name matches the modpack filename (e.g. profile "Voxy" for "Voxy.mrpack").' }
    }

    console.log('Using profile dir:', profileDir)

    // Build fingerprint of a folder: sorted "filename:size" pairs joined
    const fingerprint = (folderPath) => {
      try {
        return fs.readdirSync(folderPath)
          .map(f => {
            try { return `${f}:${fs.statSync(path.join(folderPath, f)).size}` } catch { return null }
          })
          .filter(Boolean)
          .sort()
          .join('|')
      } catch { return '' }
    }

    const storedFingerprints = world.modpack?.folderFingerprints || {}
    const newFingerprints = {}
    const skipped = []

    for (const folder of OVERRIDE_FOLDERS) {
      const folderPath = path.join(profileDir, folder)
      if (!fs.existsSync(folderPath)) {
        console.log(`${folder} not found in profile at ${folderPath}`)
        continue
      }
      const files = fs.readdirSync(folderPath)
      if (files.length === 0) continue

      const fp = fingerprint(folderPath)
      newFingerprints[folder] = fp

      if (storedFingerprints[folder] && storedFingerprints[folder] === fp) {
        console.log(`${folder} unchanged — skipping upload`)
        skipped.push(folder)
        uploadedFolders.push(folder) // still available for sync even if not re-uploaded
        continue
      }

      const pctU = 30 + Math.round((uploadedFolders.length / 3) * 50)
      sendProgress(`Uploading ${folder}`, `${files.length} files...`, pctU)
      await uploadFolderStreaming(folderPath, `${ONEDRIVE_FOLDER}/${world.name}/overrides_${folder}.zip`, driveId, (p) => {
        sendProgress(`Uploading ${folder}`, `${files.length} files — ${p}%`, pctU + Math.round(p * 0.08))
      })
      uploadedFolders.push(folder)
    }

    console.log(`Uploaded: ${uploadedFolders.filter(f => !skipped.includes(f)).join(', ') || 'none'}, Skipped (unchanged): ${skipped.join(', ') || 'none'}`)

    // Update modlist.json so the play-time mod verification is accurate
    try {
      const modsDir = path.join(profileDir, 'mods')
      if (fs.existsSync(modsDir)) {
        const mods = fs.readdirSync(modsDir)
          .filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
          .sort()
        const modlistPath = path.join(app.getPath('temp'), `modlist_${world.name}.json`)
        fs.writeFileSync(modlistPath, JSON.stringify({ mods, updatedAt: new Date().toISOString() }, null, 2))
        await uploadFile(modlistPath, `${ONEDRIVE_FOLDER}/${world.name}/modlist.json`)
        fs.unlinkSync(modlistPath)
        world.hasModlist = true
      }
    } catch (e) { console.log('modlist update failed:', e.message) }

    sendProgress('Saving', 'Updating modpack info...', 95)
    const actuallyUploaded = uploadedFolders.filter(f => !skipped.includes(f))

    world.modpack = {
      name: mrpackName.replace('.mrpack', ''),
      filename: mrpackName,
      // Only bump updatedAt if files actually changed — friends won't see stale warning otherwise
      updatedAt: actuallyUploaded.length > 0 ? new Date().toISOString() : (world.modpack?.updatedAt || new Date().toISOString()),
      overrideFolders: uploadedFolders,
      folderFingerprints: { ...storedFingerprints, ...newFingerprints },
    }
    await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)

    return {
      success: true,
      modpack: world.modpack,
      uploadedFolders: actuallyUploaded,
      skippedFolders: skipped,
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Sync mod/resource/shader folders directly into the profile
ipcMain.handle('worlds:sync-mods', async (_, { worldId, localSavesPath, driveId = null }) => {
  newCancelController()
  try {
    await refreshAccessToken()
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world?.modpack) return { success: false, error: 'No modpack attached to this world' }

    const profileDir = path.dirname(localSavesPath)
    const overrideFolders = world.modpack.overrideFolders || ['mods', 'resourcepacks', 'shaderpacks']
    const synced = []
    const failed = []
    const total = overrideFolders.length

    for (const folder of overrideFolders) {
      try {
        const pct = 10 + Math.round((synced.length / total) * 80)
        sendProgress(`Syncing ${folder}`, `Downloading ${folder}...`, pct)
        const zipUrl = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/overrides_${folder}.zip`, driveId)
        const zipPath = path.join(app.getPath('temp'), `${folder}_override.zip`)
        await downloadFile(zipUrl, zipPath)

        sendProgress(`Installing ${folder}`, `Replacing local ${folder}...`, pct + 5)
        const destDir = path.join(profileDir, folder)
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true })
        fs.mkdirSync(destDir, { recursive: true })
        await unzipTo(zipPath, destDir)
        fs.unlinkSync(zipPath)
        synced.push(folder)
      } catch {
        failed.push(folder)
      }
    }

    sendProgress('Done', `Synced: ${synced.join(', ')}`, 100)

    return {
      success: synced.length > 0,
      synced,
      failed,
      message: synced.length > 0
        ? `Synced: ${synced.join(', ')}${failed.length ? ` — ${failed.join(', ')} not available` : ''}`
        : 'No override folders found on OneDrive.',
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Check if a Modrinth profile matching the modpack name exists locally
ipcMain.handle('worlds:check-profile-exists', (_, { modpackName }) => {
  try {
    const profilesDir = path.join(process.env.APPDATA, 'ModrinthApp', 'profiles')
    if (!fs.existsSync(profilesDir)) return { exists: false }
    const profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    // Match by checking if any profile name is contained in the modpack name or vice versa
    // e.g. "Voxy" matches "Voxy 1.0.0" or "Voxy"
    const match = profiles.find(p =>
      modpackName.toLowerCase().startsWith(p.toLowerCase()) ||
      p.toLowerCase().startsWith(modpackName.toLowerCase())
    )
    return { exists: !!match, profileName: match || null, profiles }
  } catch (err) {
    return { exists: false, error: err.message }
  }
})
// Voxy stores cache in two places depending on host vs join:
//   Host: <profile>/saves/<worldFolder>/voxy/<worldHash>/
//   Join: <profile>/.voxy/saves/<essentialServerId>/<worldHash>/
// We sync just the <worldHash> folder contents between both locations.
// DH: <profile>/data/DistantHorizons/ or <profile>/Distant_Horizons_server_data/

function findVoxyCacheDir(profileDir, worldSaveDir) {
  // Check host location first
  const hostVoxy = path.join(worldSaveDir, 'voxy')
  if (fs.existsSync(hostVoxy) && fs.readdirSync(hostVoxy).length > 0) {
    return { path: hostVoxy, type: 'host' }
  }

  // Check join location: <profile>/.voxy/saves/<serverId>/
  // If host folder exists but is empty, get any hash folders from it to match against
  const joinVoxyBase = path.join(profileDir, '.voxy', 'saves')
  if (!fs.existsSync(joinVoxyBase)) return null

  // Get world hash from host location if available (even if empty of data)
  let hostHashes = []
  if (fs.existsSync(hostVoxy)) {
    hostHashes = fs.readdirSync(hostVoxy, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name)
  }

  const serverDirs = fs.readdirSync(joinVoxyBase, { withFileTypes: true })
    .filter(d => d.isDirectory())

  for (const serverDir of serverDirs) {
    const serverPath = path.join(joinVoxyBase, serverDir.name)
    try {
      const serverContents = fs.readdirSync(serverPath)
      if (serverContents.length === 0) continue

      // If we have host hashes, match by hash — otherwise take first non-empty
      if (hostHashes.length > 0) {
        if (hostHashes.some(h => serverContents.includes(h))) {
          return { path: serverPath, type: 'join' }
        }
      } else {
        return { path: serverPath, type: 'join' }
      }
    } catch {}
  }
  return null
}

// Returns total size in bytes of all files in a folder recursively
function getFolderSize(folderPath) {
  let total = 0
  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else { try { total += fs.statSync(full).size } catch {} }
      }
    } catch {}
  }
  walk(folderPath)
  return total
}

ipcMain.handle('worlds:upload-cache', async (_, { worldId, localSavesPath, force = false, driveId = null }) => {
  newCancelController()
  try {
    await refreshAccessToken()
    if (driveId) {
      const myDrive = await axios.get('https://graph.microsoft.com/v1.0/me/drive', { headers: apiHeaders() })
      if (driveId !== myDrive.data.id) {
        return { success: false, error: 'You can only upload cache for your own worlds.' }
      }
    }
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    const profileDir = path.dirname(localSavesPath)
    const worldFolder = world.folderName || world.name
    const worldSaveDir = path.join(localSavesPath, worldFolder)

    const uploaded = []
    const missing = []
    const blocked = []

    // ── Voxy ─────────────────────────────────────────────────
    const voxyDir = findVoxyCacheDir(profileDir, worldSaveDir)
    if (voxyDir) {
      const localSize = getFolderSize(voxyDir.path)
      const storedSize = world.voxyCacheSize || 0
      console.log(`[Cache] Voxy: ${fmtSize(localSize)} local, ${fmtSize(storedSize)} stored on OneDrive`)

      if (!force && storedSize > 0 && localSize < storedSize) {
        const localMB = fmtSize(localSize)
        const storedMB = fmtSize(storedSize)
        blocked.push({ name: 'Voxy', localMB, storedMB })
        console.log(`[Cache] Voxy blocked — local smaller than stored`)
      } else {
        console.log(`[Cache] Voxy upload starting: ${voxyDir.path}`)
        sendProgress('Uploading Voxy cache', `Counting files... ${fmtSize(localSize)}`, 2)
        let lastVoxyLog = 0
        await uploadFolderStreaming(voxyDir.path, `${ONEDRIVE_FOLDER}/${world.name}/voxy_cache.zip`, driveId, (p) => {
          sendProgress('Uploading Voxy cache', `${fmtSize(localSize)} — ${p}%`, p)
          if (p - lastVoxyLog >= 10) { lastVoxyLog = p; console.log(`[Cache] Voxy ${p}%`) }
        })
        world.voxyCacheSize = localSize
        uploaded.push(`Voxy (${voxyDir.type})`)
        console.log(`[Cache] Voxy upload complete`)
      }
    } else {
      missing.push('Voxy')
      console.log(`[Cache] Voxy not found`)
    }

    // ── Distant Horizons ─────────────────────────────────────
    const dhPath = fs.existsSync(path.join(profileDir, 'data', 'DistantHorizons'))
      ? path.join(profileDir, 'data', 'DistantHorizons')
      : fs.existsSync(path.join(profileDir, 'Distant_Horizons_server_data'))
        ? path.join(profileDir, 'Distant_Horizons_server_data')
        : null

    if (dhPath) {
      const localSize = getFolderSize(dhPath)
      const storedSize = world.dhCacheSize || 0
      console.log(`[Cache] DH: ${fmtSize(localSize)} local, ${fmtSize(storedSize)} stored on OneDrive`)

      if (!force && storedSize > 0 && localSize < storedSize) {
        const localMB = fmtSize(localSize)
        const storedMB = fmtSize(storedSize)
        blocked.push({ name: 'Distant Horizons', localMB, storedMB })
        console.log(`[Cache] DH blocked — local smaller than stored`)
      } else {
        console.log(`[Cache] DH upload starting: ${dhPath}`)
        sendProgress('Uploading DH cache', `Counting files... ${fmtSize(localSize)}`, 2)
        let lastDHLog = 0
        await uploadFolderStreaming(dhPath, `${ONEDRIVE_FOLDER}/${world.name}/dh_cache.zip`, driveId, (p) => {
          sendProgress('Uploading DH cache', `${fmtSize(localSize)} — ${p}%`, p)
          if (p - lastDHLog >= 10) { lastDHLog = p; console.log(`[Cache] DH ${p}%`) }
        })
        world.dhCacheSize = localSize
        uploaded.push('Distant Horizons')
        console.log(`[Cache] DH upload complete`)
      }
    } else {
      missing.push('Distant Horizons')
      console.log(`[Cache] DH not found`)
    }

    if (blocked.length > 0) {
      return {
        success: false,
        blocked: true,
        blocked_caches: blocked,
        uploaded,
        error: blocked.map(b =>
          `${b.name}: your local cache is ${b.localMB} but OneDrive has ${b.storedMB} — uploading would lose data.`
        ).join('\n')
      }
    }

    if (uploaded.length > 0) {
      world.hasCache = true
      world.cacheUpdatedAt = new Date().toISOString()
      await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)
      sendProgress('Done', `Uploaded: ${uploaded.join(', ')}`, 100)
    }

    return {
      success: true,
      uploaded,
      missing,
      message: uploaded.length > 0
        ? `Uploaded: ${uploaded.join(', ')}${missing.length ? ` (${missing.join(', ')} not found locally)` : ''}`
        : `No cache folders found locally.`,
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('worlds:download-cache', async (_, { worldId, localSavesPath, mode = 'host', driveId = null }) => {
  newCancelController()
  try {
    await refreshAccessToken()
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data.worlds.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    if (!world.hasCache) {
      return { success: false, noCache: true, error: 'No cache has been uploaded for this world yet.' }
    }

    const profileDir = path.dirname(localSavesPath)
    const worldFolder = world.folderName || world.name
    const worldSaveDir = path.join(localSavesPath, worldFolder)
    const downloaded = []
    const notFound = []

    // ── Voxy ─────────────────────────────────────────────────
    try {
      // Check if local cache is already same size or larger — skip if so
      const voxyDestDir = mode === 'host'
        ? path.join(worldSaveDir, 'voxy')
        : null // guest path checked below
      const storedVoxySize = world.voxyCacheSize || 0
      const localVoxySize = voxyDestDir && fs.existsSync(voxyDestDir) ? getFolderSize(voxyDestDir) : 0

      if (storedVoxySize > 0 && localVoxySize >= storedVoxySize) {
        console.log(`[Cache] Voxy skipped — local ${fmtSize(localVoxySize)} >= stored ${fmtSize(storedVoxySize)}`)
        downloaded.push('Voxy (already up to date — skipped)')
      } else {
        console.log(`[Cache] Voxy downloading — local ${fmtSize(localVoxySize)}, stored ${fmtSize(storedVoxySize)}`)
        sendProgress('Downloading Voxy cache', 'Fetching Voxy chunks from OneDrive...', 5)
        const zipUrl = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/voxy_cache.zip`, driveId)
        const zipPath = path.join(app.getPath('temp'), 'voxy_cache.zip')
        await downloadFile(zipUrl, zipPath, (received, total) => {
          sendProgress('Downloading Voxy cache', `${fmtSize(received)} / ${fmtSize(total)}`, 5 + Math.round((received / total) * 40))
        })

        sendProgress('Extracting Voxy cache', `Installing for ${mode} mode...`, 47)
        if (mode === 'host') {
          if (!fs.existsSync(voxyDestDir)) fs.mkdirSync(voxyDestDir, { recursive: true })
          await unzipTo(zipPath, voxyDestDir)
        } else {
          const joinVoxyBase = path.join(profileDir, '.voxy', 'saves')
          if (!fs.existsSync(joinVoxyBase)) {
            fs.unlinkSync(zipPath)
            return { success: false, needsJoin: true, error: 'You need to join a hosted session of this world at least once before downloading the guest cache. Join via Essential first, then come back and download.' }
          }

          const serverDirs = fs.readdirSync(joinVoxyBase, { withFileTypes: true }).filter(d => d.isDirectory())
          if (serverDirs.length === 0) {
            fs.unlinkSync(zipPath)
            return { success: false, needsJoin: true, error: 'You need to join a hosted session of this world at least once before downloading the guest cache. Join via Essential first, then come back and download.' }
          }

          // Match server dirs by checking if they contain any of the host's voxy hash folders
          // Multiple server dirs can match if you've joined the same world from different hosts
          // — extract to ALL matching dirs so the cache works regardless of who is hosting
          const hostVoxy = path.join(worldSaveDir, 'voxy')
          const hostHashes = fs.existsSync(hostVoxy)
            ? fs.readdirSync(hostVoxy, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
            : []

          let matchedDirs = []
          for (const serverDir of serverDirs) {
            const serverPath = path.join(joinVoxyBase, serverDir.name)
            try {
              const serverContents = fs.readdirSync(serverPath)
              const matches = hostHashes.length === 0 || hostHashes.some(h => serverContents.includes(h))
              if (matches) matchedDirs.push(serverPath)
            } catch {}
          }

          // If no hash match found, fall back to all server dirs (no host voxy to compare against)
          if (matchedDirs.length === 0) {
            matchedDirs = serverDirs.map(d => path.join(joinVoxyBase, d.name))
          }

          console.log(`[Cache] Voxy guest: extracting to ${matchedDirs.length} server dir(s)`)
          for (const destDir of matchedDirs) {
            await unzipTo(zipPath, destDir).catch(e => console.log(`[Cache] Voxy guest extract failed for ${destDir}:`, e.message))
          }
        }

        fs.unlinkSync(zipPath)
        downloaded.push('Voxy')
        console.log(`[Cache] Voxy download complete`)
      }
    } catch (e) { notFound.push('Voxy'); console.log(`[Cache] Voxy download failed:`, e.message) }

    // ── Distant Horizons ─────────────────────────────────────
    try {
      const dhDestDir = path.join(profileDir, 'data', 'DistantHorizons')
      const storedDHSize = world.dhCacheSize || 0
      const localDHSize = fs.existsSync(dhDestDir) ? getFolderSize(dhDestDir) : 0

      if (storedDHSize > 0 && localDHSize >= storedDHSize) {
        console.log(`[Cache] DH skipped — local ${fmtSize(localDHSize)} >= stored ${fmtSize(storedDHSize)}`)
        downloaded.push('Distant Horizons (already up to date — skipped)')
      } else {
        console.log(`[Cache] DH downloading — local ${fmtSize(localDHSize)}, stored ${fmtSize(storedDHSize)}`)
        sendProgress('Downloading DH cache', 'Fetching Distant Horizons data from OneDrive...', 52)
        const zipUrl = await getDownloadUrl(`${ONEDRIVE_FOLDER}/${world.name}/dh_cache.zip`, driveId)
        const zipPath = path.join(app.getPath('temp'), 'dh_cache.zip')
        await downloadFile(zipUrl, zipPath, (received, total) => {
          sendProgress('Downloading DH cache', `${fmtSize(received)} / ${fmtSize(total)}`, 52 + Math.round((received / total) * 40))
        })

        sendProgress('Extracting DH cache', 'Installing Distant Horizons data...', 94)
        if (!fs.existsSync(dhDestDir)) fs.mkdirSync(dhDestDir, { recursive: true })
        await unzipTo(zipPath, dhDestDir)
        fs.unlinkSync(zipPath)
        downloaded.push('Distant Horizons')
        console.log(`[Cache] DH download complete`)
      }
    } catch { notFound.push('Distant Horizons') }

    sendProgress('Done', `Downloaded: ${downloaded.join(', ')}`, 100)

    return {
      success: downloaded.length > 0,
      downloaded,
      notFound,
      message: downloaded.length > 0
        ? `Downloaded (${mode}): ${downloaded.join(', ')}${notFound.length ? ` — ${notFound.join(', ')} not on OneDrive` : ''}`
        : 'No cache files found on OneDrive.',
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})
// Stored locally (per machine) so each user's file paths don't
// conflict with anyone else's on OneDrive.
function savePathsFile() {
  return path.join(getDataDir(), 'saves-paths.json')
}

function readLocalSavesPaths() {
  try {
    return JSON.parse(fs.readFileSync(savePathsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeLocalSavesPaths(data) {
  fs.writeFileSync(savePathsFile(), JSON.stringify(data, null, 2))
}

// ── LOCAL MANIFEST ────────────────────────────────────────────
// Per-world record of every file's size+mtime at last sync.
// Stored locally so each PC knows what it last synced.

function localManifestPath(worldId) {
  return path.join(getDataDir(), `manifest_${worldId}.json`)
}

function readLocalManifest(worldId) {
  try {
    return JSON.parse(fs.readFileSync(localManifestPath(worldId), 'utf8'))
  } catch { return { files: {} } }
}

function writeLocalManifest(worldId, manifest) {
  fs.writeFileSync(localManifestPath(worldId), JSON.stringify(manifest, null, 2))
}

// Build a manifest from a local folder — records size+mtime of every file
function buildManifest(folderPath, relBase = '') {
  const EXCLUDE = ['voxy', 'distant_horizons', 'session.lock']
  const files = {}
  function walk(dir, rel) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE.includes(entry.name.toLowerCase())) continue
        const full = path.join(dir, entry.name)
        const relPath = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(full, relPath)
        } else {
          try {
            const stat = fs.statSync(full)
            files[relPath] = { size: stat.size, mtime: stat.mtimeMs }
          } catch {}
        }
      }
    } catch {}
  }
  walk(folderPath, relBase)
  return { files }
}

// ── LOCAL FRIENDS LIST ───────────────────────────────────────
// Friends are stored locally per machine — each user manages their own.
// { __friends: [{ name, driveId, shareUrl, addedAt }] }

function readLocalFriends() {
  const data = readLocalSavesPaths()
  return data.__friends || []
}

function writeLocalFriends(friends) {
  const data = readLocalSavesPaths()
  data.__friends = friends
  writeLocalSavesPaths(data)
}

// Generate an invite code — creates a sharing link on CraftSync folder, encodes it
ipcMain.handle('friends:generate-invite', async () => {
  try {
    await refreshAccessToken()

    // Ensure CraftSync folder exists
    await ensureFolder(ONEDRIVE_FOLDER)

    // Create an edit sharing link on the folder
    const folderRes = await axios.get(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${ONEDRIVE_FOLDER}`,
      { headers: apiHeaders() }
    )
    const folderId = folderRes.data.id
    const driveId = folderRes.data.parentReference?.driveId

    const linkRes = await axios.post(
      `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/createLink`,
      { type: 'edit', scope: 'anonymous' },
      { headers: apiHeaders() }
    )

    const shareUrl = linkRes.data.link.webUrl

    // Get display name
    const meRes = await axios.get('https://graph.microsoft.com/v1.0/me', { headers: apiHeaders() })
    const displayName = meRes.data.displayName || meRes.data.userPrincipalName

    // Encode as invite code: CS- + base64({ shareUrl, driveId, name })
    const payload = JSON.stringify({ shareUrl, driveId, name: displayName })
    const code = 'CS-' + Buffer.from(payload).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    return { success: true, code, name: displayName }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Redeem an invite code — decode it, access the shared folder, save friend locally
ipcMain.handle('friends:redeem-invite', async (_, { code }) => {
  try {
    await refreshAccessToken()

    if (!code.startsWith('CS-')) return { success: false, error: 'Invalid invite code. Codes start with CS-' }

    const b64 = code.slice(3).replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const { shareUrl, driveId, name } = payload

    if (!shareUrl || !driveId) return { success: false, error: 'Invalid invite code format.' }

    // Verify we can actually access the shared folder
    const encodedUrl = Buffer.from(shareUrl).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const shareRes = await axios.get(
      `https://graph.microsoft.com/v1.0/shares/u!${encodedUrl}/driveItem`,
      { headers: apiHeaders() }
    )
    if (!shareRes.data) return { success: false, error: 'Could not access the shared folder. The invite may have expired.' }

    // Save friend locally
    const friends = readLocalFriends()
    if (friends.find(f => f.driveId === driveId)) {
      return { success: false, error: `${name} is already in your friends list.` }
    }
    friends.push({ name, driveId, shareUrl, addedAt: new Date().toISOString() })
    writeLocalFriends(friends)

    return { success: true, friend: { name, driveId } }
  } catch (err) {
    return { success: false, error: `Failed to redeem code: ${err.message}` }
  }
})

// List local friends
ipcMain.handle('friends:list-local', () => {
  try {
    return { success: true, friends: readLocalFriends() }
  } catch { return { success: true, friends: [] } }
})

// Remove a local friend
ipcMain.handle('friends:remove-local', (_, { driveId }) => {
  try {
    const friends = readLocalFriends().filter(f => f.driveId !== driveId)
    writeLocalFriends(friends)
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
})

// Update gameVersion/loaderVersion on an existing world (for worlds added before this feature)
// Lightweight etag check — returns file metadata without downloading content
// Used by background watcher to detect changes without flickering UI
ipcMain.handle('worlds:check-changed', async () => {
  try {
    await refreshAccessToken()

    // Check own OneDrive
    const [worldsMeta, membersMeta] = await Promise.all([
      axios.get(`${driveBase(null)}/root:/${ONEDRIVE_FOLDER}/worlds.json`, { headers: apiHeaders() }).catch(() => null),
      axios.get(`${driveBase(null)}/root:/${ONEDRIVE_FOLDER}/members.json`, { headers: apiHeaders() }).catch(() => null),
    ])

    // Check all friend drives too
    const paths = readLocalSavesPaths()
    const friends = (paths.__friends || []).filter(f => f.driveId)
    const friendEtags = {}
    await Promise.all(friends.map(async (friend) => {
      try {
        const meta = await axios.get(
          `${driveBase(friend.driveId)}/root:/${ONEDRIVE_FOLDER}/worlds.json`,
          { headers: apiHeaders() }
        ).catch(() => null)
        if (meta?.data) {
          friendEtags[friend.driveId] = meta.data.eTag || meta.data.lastModifiedDateTime || null
        }
      } catch {}
    }))

    return {
      worldsEtag: worldsMeta?.data?.eTag || worldsMeta?.data?.lastModifiedDateTime || null,
      membersEtag: membersMeta?.data?.eTag || membersMeta?.data?.lastModifiedDateTime || null,
      friendEtags,
    }
  } catch {
    return null
  }
})

ipcMain.handle('worlds:update-version', async (_, { worldId, localSavesPath, driveId = null }) => {
  try {
    await refreshAccessToken()
    const data = await readJson(`${ONEDRIVE_FOLDER}/worlds.json`, driveId)
    const world = data?.worlds?.find(w => w.id === worldId)
    if (!world) return { success: false, error: 'World not found' }

    const { execSync } = require('child_process')
    const DB_PATH = path.join(process.env.APPDATA, 'ModrinthApp', 'app.db')
    const MODRINTH_PROFILES = path.join(process.env.APPDATA, 'ModrinthApp', 'profiles')
    const worldFolder = world.folderName || world.name
    const allProfiles = execSync(
      `"${getSqlite3Path()}" "${DB_PATH}" "SELECT path, game_version, mod_loader_version FROM profiles ORDER BY last_played DESC;"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim()

    for (const row of allProfiles.split('\n').filter(Boolean)) {
      const [pPath, gv, mlv] = row.split('|')
      // Check saves folder in DB profile path OR in the provided localSavesPath
      const savesPath1 = path.join(MODRINTH_PROFILES, pPath?.trim(), 'saves', worldFolder)
      const savesPath2 = localSavesPath ? path.join(localSavesPath, worldFolder) : null
      if (fs.existsSync(savesPath1) || (savesPath2 && fs.existsSync(savesPath2))) {
        world.gameVersion = gv?.trim()
        world.loaderVersion = mlv?.trim()
        await writeJson(`${ONEDRIVE_FOLDER}/worlds.json`, data, driveId)
        return { success: true, gameVersion: world.gameVersion, loaderVersion: world.loaderVersion }
      }
    }
    return { success: false, error: 'Could not detect version — make sure the world is in a Modrinth profile saves folder' }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('worlds:save-saves-path', (_, { worldId, localSavesPath }) => {
  try {
    const paths = readLocalSavesPaths()
    paths[worldId] = localSavesPath
    writeLocalSavesPaths(paths)
    return { success: true }
  } catch {
    return { success: false }
  }
})

ipcMain.handle('worlds:save-modpack-downloaded', (_, { worldId }) => {
  try {
    const data = readLocalSavesPaths()
    if (!data.__modpackDownloads) data.__modpackDownloads = {}
    data.__modpackDownloads[worldId] = new Date().toISOString()
    writeLocalSavesPaths(data)
    return { success: true }
  } catch { return { success: false } }
})

ipcMain.handle('worlds:get-modpack-downloads', () => {
  try {
    const data = readLocalSavesPaths()
    return data.__modpackDownloads || {}
  } catch { return {} }
})

ipcMain.handle('worlds:get-saves-paths', () => {
  return readLocalSavesPaths()
})

ipcMain.handle('dialog:open-folder', async (_, options = {}) => {
  const defaultPath = options.defaultPath || 
    path.join(app.getPath('appData'), 'ModrinthApp', 'profiles')
  const result = await dialog.showOpenDialog(mainWindow, { 
    properties: ['openDirectory'],
    defaultPath,
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:open-mrpack', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }],
    defaultPath: app.getPath('downloads'),
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('fs:folder-size', (_, { folderPath }) => {
  try {
    // Exclude voxy/DH caches from the size estimate — same as what gets zipped
    const EXCLUDE = ['voxy', 'distant_horizons', 'distant horizons', 'dim-1', 'dim1']
    let total = 0
    function walk(dir) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (EXCLUDE.includes(entry.name.toLowerCase())) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else { try { total += fs.statSync(full).size } catch {} }
        }
      } catch {}
    }
    walk(folderPath)
    return { success: true, size: total }
  } catch (err) {
    return { success: false, size: 0 }
  }
})

ipcMain.handle('window:minimize', () => mainWindow.minimize())
ipcMain.handle('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.handle('window:close', () => mainWindow.close())

ipcMain.handle('shell:open', (_, p) => shell.openPath(p))

// ── ONEDRIVE FILE HELPERS ─────────────────────────────────────
async function getDownloadUrl(filePath, driveId = null) {
  const url = `${driveBase(driveId)}/root:/${filePath}`
  const res = await axios.get(url, { headers: apiHeaders() })
  return res.data['@microsoft.graph.downloadUrl']
}

async function downloadFile(url, destPath, onProgress = null) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 0, // no timeout for large downloads
  })

  const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
  let receivedBytes = 0
  let lastLogMB = 0

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath)

    response.data.on('data', (chunk) => {
      receivedBytes += chunk.length
      const receivedMB = receivedBytes / 1024 / 1024

      // Log every 100MB
      if (receivedMB - lastLogMB >= 100) {
        lastLogMB = Math.floor(receivedMB / 100) * 100
        if (totalBytes > 0) {
          const pct = Math.round((receivedBytes / totalBytes) * 100)
          console.log(`[downloadFile] ${fmtSize(receivedBytes)} / ${fmtSize(totalBytes)} (${pct}%) → ${path.basename(destPath)}`)
        } else {
          console.log(`[downloadFile] ${fmtSize(receivedBytes)} received → ${path.basename(destPath)}`)
        }
      }

      if (onProgress && totalBytes > 0) {
        onProgress(receivedBytes, totalBytes)
      }
    })

    response.data.on('error', reject)
    writer.on('error', reject)
    writer.on('finish', () => {
      console.log(`[downloadFile] Complete: ${fmtSize(receivedBytes)} → ${path.basename(destPath)}`)
      resolve()
    })

    response.data.pipe(writer)
  })
}

async function uploadFile(localPath, remotePath, driveId = null) {
  const fileSize = fs.statSync(localPath).size

  if (fileSize < 4 * 1024 * 1024) {
    // Small files — simple PUT with buffer
    const fileBuffer = fs.readFileSync(localPath)
    const url = `${driveBase(driveId)}/root:/${remotePath}:/content`
    await axios.put(url, fileBuffer, {
      headers: { ...apiHeaders(), 'Content-Type': 'application/octet-stream' }
    })
  } else {
    // Large files — chunked upload session using file descriptor (no full buffer)
    const createSession = async () => {
      try {
        await axios.delete(`${driveBase(driveId)}/root:/${remotePath}`, { headers: apiHeaders() })
      } catch {}
      const sessionRes = await axios.post(`${driveBase(driveId)}/root:/${remotePath}:/createUploadSession`, {
        item: { '@microsoft.graph.conflictBehavior': 'replace' }
      }, { headers: apiHeaders() })
      return sessionRes.data.uploadUrl
    }

    let uploadUrl = await createSession()
    const chunkSize = 20 * 1024 * 1024
    const fd = fs.openSync(localPath, 'r')

    try {
      let offset = 0
      while (offset < fileSize) {
        const length = Math.min(chunkSize, fileSize - offset)
        const chunk = Buffer.allocUnsafe(length)
        fs.readSync(fd, chunk, 0, length, offset)

        let success = false
        for (let attempt = 0; attempt <= 5 && !success; attempt++) {
          try {
            await axios.put(uploadUrl, chunk, {
              headers: {
                'Content-Range': `bytes ${offset}-${offset + length - 1}/${fileSize}`,
                'Content-Length': length,
              },
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
              timeout: 120000,
            })
            success = true
          } catch (err) {
            const expired = err.response?.status === 404
            const retriable = expired || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
                              err.code === 'ECONNABORTED' || (err.response?.status >= 500)
            if (retriable && attempt < 5) {
              if (expired) {
                // Session expired — recreate it and restart from current offset
                console.log(`Upload session expired at offset ${offset}, recreating...`)
                uploadUrl = await createSession()
                // Restart from beginning of new session
                offset = 0
                break
              }
              const wait = Math.min(1000 * Math.pow(2, attempt), 30000)
              console.log(`Chunk failed (${err.code || err.response?.status}), retrying in ${wait}ms`)
              await new Promise(r => setTimeout(r, wait))
            } else {
              throw err
            }
          }
        }
        if (success) offset += length
      }
    } finally {
      fs.closeSync(fd)
    }
  }
}

// ── ZIP HELPERS ───────────────────────────────────────────────

// Recursively find the newest file modification time in a folder
function getNewestMtime(folderPath) {
  let newest = 0
  const SKIP = ['voxy', 'distant_horizons', 'DIM-1', 'DIM1']
  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.some(s => entry.name.toLowerCase().includes(s.toLowerCase()))) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full) }
        else {
          try {
            const mtime = fs.statSync(full).mtimeMs
            if (mtime > newest) newest = mtime
          } catch {}
        }
      }
    } catch {}
  }
  walk(folderPath)
  return newest
}

// Check if local world folder was modified more recently than the last upload
ipcMain.handle('worlds:check-modified', (_, { worldId, localSavesPath }) => {
  try {
    // We can't read worlds.json here without async, so the caller passes lastUploadedAt
    // This is a pure local filesystem check
    return { success: true } // placeholder — actual check done in worlds:play
  } catch { return { success: false } }
})

async function zipFolder(folderPath, zipPath) {
  const archiver = require('archiver')

  const EXCLUDE = [
    'voxy',
    'distant_horizons',
    'distant horizons',
    'DIM-1', 'DIM1',
  ]

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    archive.glob('**/*', {
      cwd: folderPath,
      ignore: EXCLUDE.map(e => `**/${e}/**`).concat(EXCLUDE.map(e => `${e}/**`)),
      dot: true,
    })
    archive.finalize()
  })
}

// ── STREAMING FOLDER UPLOAD ───────────────────────────────────
// Zips the folder in store-only mode (no compression) and streams
// directly to an OneDrive upload session — no temp file needed.
// Minecraft .mca files are already internally compressed so level 0
// costs almost nothing in size but saves the full zip-to-disk pass.

async function uploadFolderStreaming(folderPath, remotePath, driveId = null, onProgress = null) {
  const archiver = require('archiver')

  const EXCLUDE = ['voxy', 'distant_horizons', 'distant horizons', 'dim-1', 'dim1']
  const excludeLower = EXCLUDE.map(e => e.toLowerCase())

  const globOptions = {
    cwd: folderPath,
    ignore: excludeLower.map(e => `**/${e}/**`).concat(excludeLower.map(e => `${e}/**`)),
    dot: true,
  }

  // ── Pass 1: count exact bytes archiver will produce ──────────
  // Pipe to a null writable — fast, no disk I/O, just counts bytes
  const { Writable } = require('stream')
  const totalSize = await new Promise((resolve, reject) => {
    let count = 0
    const counter = new Writable({
      write(chunk, enc, cb) { count += chunk.length; cb() }
    })
    const archive = archiver('zip', { store: true })
    archive.glob('**/*', globOptions)
    archive.pipe(counter)
    counter.on('finish', () => resolve(count))
    archive.on('error', reject)
    archive.finalize()
  })

  console.log(`Zip size (counted): ${fmtSize(totalSize)}`)

  // Create upload session
  try {
    await axios.delete(`${driveBase(driveId)}/root:/${remotePath}`, { headers: apiHeaders() })
  } catch {}

  const sessionUrl = `${driveBase(driveId)}/root:/${remotePath}:/createUploadSession`
  const sessionRes = await axios.post(sessionUrl, {
    item: { '@microsoft.graph.conflictBehavior': 'replace' }
  }, { headers: apiHeaders() })
  const uploadUrl = sessionRes.data.uploadUrl

  // 20MB chunks — multiple of 320KB, fewer round trips = faster for large uploads
  const CHUNK_SIZE = 64 * 320 * 1024

  let offset = 0
  let chunkBuffer = Buffer.alloc(0)

  const sendChunk = async (data, retries = 5) => {
    const start = offset
    const end = start + data.length - 1
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await axios.put(uploadUrl, data, {
          headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': data.length,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 120000,
        })
        offset += data.length
        if (onProgress) onProgress(Math.min(99, Math.round((offset / totalSize) * 100)))
        return
      } catch (err) {
        const retriable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
                          err.code === 'ECONNABORTED' || (err.response?.status >= 500)
        if (retriable && attempt < retries) {
          const wait = Math.min(1000 * Math.pow(2, attempt), 30000)
          console.log(`Chunk at ${start} failed (${err.code || err.response?.status}), retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`)
          await new Promise(r => setTimeout(r, wait))
        } else {
          throw err
        }
      }
    }
  }

  // ── Pass 2: zip again and stream directly to OneDrive ────────
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { store: true })
    archive.glob('**/*', globOptions)

    let uploadChain = Promise.resolve()

    archive.on('data', (chunk) => {
      chunkBuffer = Buffer.concat([chunkBuffer, chunk])
      while (chunkBuffer.length >= CHUNK_SIZE) {
        const toSend = chunkBuffer.slice(0, CHUNK_SIZE)
        chunkBuffer = chunkBuffer.slice(CHUNK_SIZE)
        uploadChain = uploadChain
          .then(() => { checkCancelled(); return sendChunk(toSend) })
          .catch(err => reject(err))
      }
    })

    archive.on('finish', () => {
      uploadChain = uploadChain.then(async () => {
        if (chunkBuffer.length > 0) await sendChunk(chunkBuffer)
        if (onProgress) onProgress(100)
        resolve()
      }).catch(err => reject(err))
    })

    archive.on('error', reject)
    archive.finalize()
  })
}

async function unzipTo(zipPath, destFolder) {
  const StreamZip = require('node-stream-zip')
  return new Promise((resolve, reject) => {
    const zip = new StreamZip({ file: zipPath, storeEntries: true })
    zip.on('ready', () => {
      zip.extract(null, destFolder, (err) => {
        zip.close()
        if (err) reject(err); else resolve()
      })
    })
    zip.on('error', reject)
  })
}
