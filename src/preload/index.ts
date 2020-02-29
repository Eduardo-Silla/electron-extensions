import { ipcRenderer, webFrame } from 'electron';

import { IpcExtension } from '../models/ipc-extension';
import { injectContentScript } from './inject';
import { parse } from 'url';
import { PROTOCOL } from '../constants';
import { getAPI } from '../api';
import { matchesPattern } from '../utils/url';

const prune = require('json-prune');

declare const global: any;

const { protocol, hostname } = parse(window.location.href);

const sessionId: number = ipcRenderer.sendSync('get-session-id');

if (protocol === `${PROTOCOL}:`) {
  global.isTab = false;

  ipcRenderer.setMaxListeners(0);

  const extensionId = hostname;

  const extension: IpcExtension = ipcRenderer.sendSync(
    `get-extension-${sessionId}`,
    extensionId,
  );

  process.once('loaded', async () => {
    const api = getAPI(extension, sessionId);

    const w: any = await webFrame.executeJavaScript('window');
    w.chrome = api;
  });

  ipcRenderer.on('get-window-object', async (e, id) => {
    const w: any = await webFrame.executeJavaScript('window');
    const win = prune(w);

    ipcRenderer.send(`get-window-object-${id}`, win);
  });
} else {
  global.isTab = true;

  if (sessionId !== -1) {
    const blacklist: string[] = ipcRenderer.sendSync(
      `get-blacklist-${sessionId}`,
    );

    if (!blacklist.find(x => matchesPattern(x, window.location.href))) {
      const extensions: { [key: string]: IpcExtension } = ipcRenderer.sendSync(
        `get-extensions-${sessionId}`,
      );

      const setImmediateTemp: any = setImmediate;

      process.once('loaded', () => {
        global.setImmediate = setImmediateTemp;

        Object.keys(extensions).forEach(key => {
          const extension = extensions[key];

          if (!extension.contentScripts) return;

          extension.contentScripts.forEach(script => {
            injectContentScript(script, extension, sessionId);
          });
        });
      });
    }
  }
}
