/*
 * LexiLens — background service worker.
 *
 * Three small jobs:
 *  1. Forward the keyboard shortcut (Alt+L) to the content script in the
 *     active tab.
 *  3. Answer "how do you say this word" from the bundled pronunciation
 *     list, loaded once here on first use instead of once per tab.
 *  2. On install or update, inject the content scripts into tabs that are
 *     already open, so LexiLens works without reloading them.
 *
 * Settings are not handled here: the popup and the content scripts read and
 * write chrome.storage.local directly and react to its change events.
 */

const CONTENT_JS = [
  'content/homophones.js',
  'content/syllableParser.js',
  'content/domEngine.js',
  'gaze/gaze-core.js',
  'gaze/gaze-reader.js',
  'content/content.js',
];
const CONTENT_CSS = ['content/content.css'];

const COMMANDS = new Set(['toggle-dock']);

/** Pages the browser never lets an extension touch. */
function isInjectable(url) {
  if (!url) return false;
  if (!/^(https?|file):/i.test(url)) return false;
  return !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

async function sendCommand(tabId, command) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'lexilens:command', command });
    return true;
  } catch (_) {
    return false; // no content script in this tab yet
  }
}

async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!COMMANDS.has(command)) return;
  const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!target || target.id === undefined) return;

  if (await sendCommand(target.id, command)) return;

  // The tab predates the extension: inject, then retry once.
  if (!isInjectable(target.url)) return;
  try {
    await inject(target.id);
    await sendCommand(target.id, command);
  } catch (_) {
    /* the page refused injection (restricted origin) */
  }
});

/* ---- pronunciation list --------------------------------------------- */

let sayList = null;

const readList = (file) => fetch(chrome.runtime.getURL(file)).then((r) => r.text()).then((text) => '\n' + text);

/** Resolves to [respellings, voice-safe spellings of each sound]. */
function loadSayList() {
  if (!sayList) {
    sayList = Promise.all([readList('data/pronounce.txt'), readList('data/sounds.txt')])
      .catch((error) => { sayList = null; throw error; });
  }
  return sayList;
}

function findSay(list, word) {
  const key = '\n' + word + '\t';
  const at = list.indexOf(key);
  if (at < 0) return null;
  const end = list.indexOf('\n', at + key.length);
  return list.slice(at + key.length, end < 0 ? undefined : end);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'lexilens:say' || typeof message.word !== 'string') return undefined;
  const word = message.word.slice(0, 60);
  loadSayList()
    .then(([list, sounds]) => {
      const say = findSay(list, word) || findSay(list, word.replace(/'s$|s$/, ''));
      if (!say) { sendResponse({ say: null }); return; }
      sendResponse({ say, speak: say.toLowerCase().split('-').map((part) => findSay(sounds, part) || part) });
    })
    .catch(() => sendResponse({ say: null }));
  return true; // answer asynchronously
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded || !isInjectable(tab.url)) continue;
    // content.js guards against running twice, so this is safe on update.
    inject(tab.id).catch(() => {});
  }
});
