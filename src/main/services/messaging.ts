import { webContents, ipcMain, BrowserWindow, session } from 'electron';
import { getIpcExtension, sendToBackgroundPages } from '../../utils/extensions';
import { ExtensibleSession, storages } from '..';
import {
  getAllWebContentsInSession,
  webContentsToTab,
} from '../../utils/web-contents';
import { makeId } from '../../utils/string';
import { promises } from 'fs';
import { join } from 'path';
import { matchesPattern } from '../../utils/url';

export const runMessagingService = (ses: ExtensibleSession) => {
  ipcMain.on(`get-extension-${ses.id}`, (e, id: string) => {
    e.returnValue = getIpcExtension(ses.extensions[id]);
  });

  ipcMain.on(`get-blacklist-${ses.id}`, e => {
    e.returnValue = ses.blacklist;
  });

  ipcMain.on(`get-extensions-${ses.id}`, e => {
    const list = { ...ses.extensions };

    for (const key in list) {
      list[key] = getIpcExtension(list[key]);
      delete list[key].manifest.contentScripts;
    }

    e.returnValue = list;
  });

  ipcMain.on(`get-extensions-content-${ses.id}`, e => {
    const list = { ...ses.extensions };

    for (const key in list) {
      list[key] = getIpcExtension(list[key]);
    }

    e.returnValue = list;
  });

  ipcMain.handle(`api-tabs-query-${ses.id}`, e => {
    const tabs = getAllWebContentsInSession(ses.session).map(x => ({
      ...webContentsToTab(x, ses),
      lastFocusedWindow: true,
      currentWindow: true,
    }));

    return tabs;
  });

  ipcMain.on(
    `api-tabs-create-${ses.id}`,
    (e, responseId: string, data: chrome.tabs.CreateProperties) => {
      const type = e.sender.getType();

      let realWindowId = -1;
      let bw: BrowserWindow;

      if (data.windowId) {
        realWindowId = data.windowId;
      } else if (type === 'backgroundPage') {
        bw = ses.lastFocusedWindow;
      } else if (type === 'browserView' || type === 'webview') {
        bw = (e.sender as any).getOwnerBrowserWindow();
      }

      if (bw) {
        realWindowId = bw.id;
      }

      const callback = (tabId: number) => {
        e.sender.send(
          `api-tabs-create-${responseId}`,
          webContentsToTab(webContents.fromId(tabId), ses),
        );
      };

      data.windowId = realWindowId;

      ses.emit('create-tab', data, callback);
    },
  );

  ipcMain.on(`current-webcontents-to-tab-${ses.id}`, e => {
    e.returnValue = webContentsToTab(e.sender, ses);
  });

  ipcMain.handle(
    `api-tabs-insertCSS-${ses.id}`,
    async (
      e,
      tabId: number,
      details: chrome.tabs.InjectDetails,
      basePath: string,
    ) => {
      const contents = webContents.fromId(tabId);

      if (ses.blacklist.find(x => matchesPattern(x, contents.getURL()))) return;

      if (contents) {
        if (details.hasOwnProperty('file')) {
          details.code = await promises.readFile(
            join(basePath, details.file),
            'utf8',
          );
        }

        contents.insertCSS(details.code);
      }
    },
  );

  ipcMain.handle(`api-tabs-executeScript-${ses.id}`, async (e, data: any) => {
    try {
      const { tabId, details, basePath } = data;
      const contents = webContents.fromId(tabId);

      if (ses.blacklist.find(x => matchesPattern(x, contents.getURL()))) return;

      if (contents) {
        if (details.hasOwnProperty('file')) {
          details.code = await promises.readFile(
            join(basePath, details.file),
            'utf8',
          );
        }

        return await contents.executeJavaScript(details.code);
      }
    } catch (e) {
      console.error(e);
    }
  });

  ipcMain.on(`api-runtime-reload-${ses.id}`, (e, extensionId: string) => {
    const { backgroundPage } = ses.extensions[extensionId];

    if (backgroundPage) {
      const contents = webContents.fromId(e.sender.id);
      contents.reload();
    }
  });

  ipcMain.on(
    `api-runtime-connect-${ses.id}`,
    async (e, { extensionId, portId, sender, name }: any) => {
      const { backgroundPage } = ses.extensions[extensionId];
      const { webContents } = backgroundPage;

      if (e.sender.id !== webContents.id) {
        webContents.send('api-runtime-connect', {
          portId,
          sender,
          name,
        });
      }
    },
  );

  ipcMain.on(`api-runtime-sendMessage-${ses.id}`, async (e, data: any) => {
    const { extensionId } = data;
    const { backgroundPage } = ses.extensions[extensionId];

    if (e.sender.id === backgroundPage.webContents.id) return;

    backgroundPage.webContents.send(
      'api-runtime-sendMessage',
      data,
      e.sender.id,
    );
  });

  ipcMain.on(`api-tabs-sendMessage-${ses.id}`, async (e, data: any) => {
    const { tabId } = data;
    const contents = webContents.fromId(tabId);

    if (!contents) return;

    contents.send('api-tabs-sendMessage', data, e.sender.id);
  });

  ipcMain.on(
    `api-port-postMessage-${ses.id}`,
    (e, { portId, msg, tab }: any) => {
      const contents = getAllWebContentsInSession(ses.session);
      for (const content of contents) {
        if (content.id !== e.sender.id) {
          content.send(`api-port-postMessage-${portId}`, msg, tab);
        }
      }
    },
  );

  ipcMain.on(
    `api-storage-operation-${ses.id}`,
    async (e, { extensionId, id, area, type, arg }: any) => {
      const storage = storages.get(extensionId);

      const msg = `api-storage-operation-${id}`;

      if (type === 'get') {
        let res = await storage[area].get(arg);
        for (const key in res) {
          if (Buffer.isBuffer(res[key])) {
            res[key] = JSON.parse(res[key].toString());
          }
        }

        if (
          Object.entries(res).length === 0 &&
          res.constructor === Object &&
          arg instanceof Object
        ) {
          res = { ...arg };
        }

        e.sender.send(msg, res);
      } else if (type === 'set') {
        await storage[area].set(arg);
        e.sender.send(msg);
      } else if (type === 'clear') {
        await storage[area].clear();
        e.sender.send(msg);
      } else if (type === 'remove') {
        await storage[area].remove(arg);
        e.sender.send(msg);
      }
    },
  );

  ipcMain.on(`api-alarms-operation-${ses.id}`, (e, data: any) => {
    const { extensionId, type } = data;
    const contents = webContents.fromId(e.sender.id);

    if (type === 'create') {
      const extension = ses.extensions[extensionId];
      const { alarms } = extension;

      const { name, alarmInfo } = data;
      const exists = alarms.findIndex(e => e.name === name) !== -1;

      e.returnValue = null;
      if (exists) return;

      let scheduledTime = 0;

      if (alarmInfo.when != null) {
        scheduledTime = alarmInfo.when;
      }

      if (alarmInfo.delayInMinutes != null) {
        if (alarmInfo.delayInMinutes < 1) {
          return console.error(
            `Alarm delay is less than minimum of 1 minutes. In released .crx, alarm "${name}" will fire in approximately 1 minutes.`,
          );
        }

        scheduledTime = Date.now() + alarmInfo.delayInMinutes * 60000;
      }

      const alarm: chrome.alarms.Alarm = {
        periodInMinutes: alarmInfo.periodInMinutes,
        scheduledTime,
        name,
      };

      alarms.push(alarm);

      if (!alarm.periodInMinutes) {
        setTimeout(() => {
          contents.send('api-emit-event-alarms-onAlarm', alarm);
        }, alarm.scheduledTime - Date.now());
      }
    }
  });

  ipcMain.handle(
    `api-browserAction-setBadgeText-${ses.id}`,
    (
      e,
      extensionId: string,
      details: chrome.browserAction.BadgeTextDetails,
    ) => {
      ses.emit('set-badge-text', extensionId, details);
    },
  );

  ipcMain.on(
    `send-to-all-extensions-${ses.id}`,
    (e, msg: string, ...args: any[]) => {
      sendToBackgroundPages(ses, msg, ...args);

      const contents = getAllWebContentsInSession(ses.session);
      for (const content of contents) {
        content.send(msg, ...args);
      }
    },
  );

  const cookiesChangedTargets: Map<number, Electron.WebContents> = new Map();

  ipcMain.on(`api-addListener-${ses.id}`, (e, data) => {
    if (data.scope === 'cookies' && data.name === 'onChanged') {
      cookiesChangedTargets.set(data.id, e.sender);
    }
  });

  ipcMain.on(`api-removeListener-${ses.id}`, (e, data) => {
    if (data.scope === 'cookies' && data.name === 'onChanged') {
      cookiesChangedTargets.delete(data.id);
    }
  });

  ipcMain.handle(`api-cookies-getAll-${ses.id}`, async (e, details) => {
    return await ses.session.cookies.get(details);
  });

  ipcMain.handle(`api-cookies-remove-${ses.id}`, async (e, details) => {
    const cookie = (await ses.session.cookies.get(details))[0];

    if (!cookie) {
      return null;
    }

    await ses.session.cookies.remove(details.url, details.name);

    return cookie;
  });

  ipcMain.handle(`api-cookies-set-${ses.id}`, async (e, details) => {
    await ses.session.cookies.set(details);

    const cookie = (await ses.session.cookies.get(details))[0];

    if (!cookie) {
      return null;
    }

    return cookie;
  });

  ipcMain.handle(
    `api-runtime-getBackgroundPage-${ses.id}`,
    async (e, extensionId) => {
      return new Promise(resolve => {
        const { backgroundPage } = ses.extensions[extensionId];
        const id = makeId(32);

        backgroundPage.webContents.send('get-window-object', id);

        ipcMain.once(`get-window-object-${id}`, (e, window) => {
          resolve(window);
        });
      });
    },
  );

  ses.session.cookies.on(
    'changed',
    (e: any, cookie: Electron.Cookie, cause: string) => {
      cookiesChangedTargets.forEach(value => {
        value.send(`api-emit-event-cookies-onChanged`, cookie, cause);
      });
    },
  );
};
