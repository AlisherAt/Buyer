const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const defaultData = {
  settings: { currency: 'RUB', taxRate: 4, autoLaunch: true, showWarehouse: true, theme: 'light', categories: ['Без категории'] },
  purchases: [],
  sales: [],
  expenses: [],
  taxPayments: [],
  refunds: []
};
let storePath;
let tray;
let mainWindow;

function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch {
    try { return JSON.parse(fs.readFileSync(`${storePath}.bak`, 'utf8')); } catch { return structuredClone(defaultData); }
  }
}
function writeStore(data) {
  const serialized = JSON.stringify(data, null, 2);
  const temporaryPath = `${storePath}.tmp`;
  if (fs.existsSync(storePath)) fs.copyFileSync(storePath, `${storePath}.bak`);
  fs.writeFileSync(temporaryPath, serialized, 'utf8');
  fs.renameSync(temporaryPath, storePath);
  return data;
}
function isValidStore(data) {
  return Boolean(data && typeof data === 'object' && data.settings &&
    Array.isArray(data.purchases) && Array.isArray(data.sales) &&
    Array.isArray(data.expenses) && Array.isArray(data.taxPayments) &&
    Array.isArray(data.refunds));
}
function normalizeStore(data) {
  return {
    ...structuredClone(defaultData),
    ...data,
    settings: { ...defaultData.settings, ...(data?.settings || {}) },
    purchases: Array.isArray(data?.purchases) ? data.purchases : [],
    sales: Array.isArray(data?.sales) ? data.sales : [],
    expenses: Array.isArray(data?.expenses) ? data.expenses : [],
    taxPayments: Array.isArray(data?.taxPayments) ? data.taxPayments : [],
    refunds: Array.isArray(data?.refunds) ? data.refunds : []
  };
}
function setLaunch(enabled) { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true }); }
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 360, minHeight: 600, show: true, backgroundColor: '#f6f7f9', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  if (app.isPackaged) mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else mainWindow.loadURL('http://127.0.0.1:5173');
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => console.error(`Не удалось загрузить интерфейс: ${code} ${description}`));
  mainWindow.on('close', (event) => { if (!app.isQuitting) { event.preventDefault(); mainWindow.hide(); } });
}
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Учёт байера');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Открыть приложение', click: () => { mainWindow.show(); mainWindow.focus(); } }, { type: 'separator' }, { label: 'Выйти', click: () => { app.isQuitting = true; app.quit(); } }]));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(() => {
  storePath = path.join(app.getPath('userData'), 'buyer-finance.json');
  if (!fs.existsSync(storePath)) writeStore(defaultData);
  setLaunch(readStore().settings.autoLaunch);
  ipcMain.handle('store:get', () => normalizeStore(readStore()));
  ipcMain.handle('store:save', (_event, data) => { if (!isValidStore(data)) throw new Error('Некорректные данные'); return writeStore(normalizeStore(data)); });
  ipcMain.handle('settings:launch', (_event, enabled) => { setLaunch(enabled); return enabled; });
  ipcMain.handle('backup:save', async () => { const { filePath } = await require('electron').dialog.showSaveDialog({ defaultPath: 'buyer-finance-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] }); if (filePath) fs.copyFileSync(storePath, filePath); return filePath || null; });
  ipcMain.handle('backup:restore', async () => { const { filePaths } = await require('electron').dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] }); if (filePaths?.[0]) { let restored; try { restored = JSON.parse(fs.readFileSync(filePaths[0], 'utf8')); } catch { throw new Error('Не удалось прочитать файл резервной копии'); } if (!isValidStore(restored)) throw new Error('Некорректный файл резервной копии'); if (fs.existsSync(storePath)) fs.copyFileSync(storePath, `${storePath}.before-restore.bak`); writeStore(normalizeStore(restored)); return normalizeStore(restored); } return null; });
  ipcMain.handle('report:pdf', async (_event, html) => { const report = new BrowserWindow({ show: false }); await report.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); const pdf = await report.webContents.printToPDF({ printBackground: true }); const { filePath } = await require('electron').dialog.showSaveDialog({ defaultPath: 'buyer-report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }); if (filePath) fs.writeFileSync(filePath, pdf); report.close(); return filePath || null; });
  ipcMain.handle('report:open', (_event, url) => shell.openExternal(url));
  ipcMain.handle('rates:fetchXml', async () => {
    const response = await fetch('https://nationalbank.kz/rss/rates_all.xml');
    if (!response.ok) throw new Error('Не удалось получить курс НБРК');
    return response.text();
  });
  createWindow(); createTray();
});
app.on('window-all-closed', (event) => event.preventDefault());
app.on('activate', () => mainWindow?.show());
