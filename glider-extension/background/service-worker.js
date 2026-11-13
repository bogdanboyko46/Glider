/*
 * Glider — background service worker.
 *
 * Three small jobs:
 *  1. Forward the keyboard shortcut (Alt+L) to the content script in the
 *     active tab.
 *  3. Answer "how do you say this word" from the bundled pronunciation
 *     list, loaded once here on first use instead of once per tab.
 *  2. On install or update, inject the content scripts into tabs that are
 *     already open, so Glider works without reloading them.
 *
 * Settings are not handled here: the popup and the content scripts read and
 * write chrome.storage.local directly and react to its change events.
 */

const CONTENT_JS = [
  'content/homophones.js',
  'content/wordLevels.js',
  'content/wordParts.js',
  'content/wordData.js',
  'content/readingDifficulty.js',
  'content/syllableParser.js',
  'content/domEngine.js',
  'gaze/gaze-core.js',
  'gaze/gaze-reader.js',
  'assessment/session-logger.js',
  'simplify/simplifier.js',
  'simplify/bridge.js',
  'gaze/gaze-lab.js',
  'content/content.js',
];
const CONTENT_CSS = ['content/content.css'];

// Optional Claude rewrite of a hard paragraph; answers 'glider:simplify' messages (only with a saved API key).
importScripts('/simplify/claude.js');
// Word levels (CEFR A1..C2), word parts and the dictionary lookups.
importScripts('/content/wordLevels.js', '/content/wordParts.js', '/content/wordData.js');

const GLIDER_PAGE = 'home/home.html';

const COMMANDS = new Set(['toggle-dock']);

/** Pages the browser never lets an extension touch. */
function isInjectable(url) {
  if (!url) return false;
  if (!/^(https?|file):/i.test(url)) return false;
  return !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

async function sendCommand(tabId, command) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'glider:command', command });
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
  // A Windows checkout can turn the list's line ends into CRLF: trim the end.
  return list.slice(at + key.length, end < 0 ? undefined : end).trimEnd();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'glider:say' || typeof message.word !== 'string') return undefined;
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

/* ---- word levels ------------------------------------------------------ */

let levelTable = null;

function loadLevels() {
  if (!levelTable) {
    levelTable = fetch(chrome.runtime.getURL('data/levels.txt')).then((r) => r.text()).then((text) => GliderLevels.parse(text))
      .catch((error) => { levelTable = null; throw error; });
  }
  return levelTable;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'glider:level' || typeof message.word !== 'string') return undefined;
  loadLevels()
    .then((table) => sendResponse(GliderLevels.lookup(table, message.word.slice(0, 60))))
    .catch(() => sendResponse(null));
  return true; // answer asynchronously
});

/* ---- definitions and word parts ------------------------------------------
   data/dictionary.txt (WordNet, ~3.9 MB) loads the first time a definition is
   asked for; data/wordparts.txt (~290 KB) the first time a word is hovered. */

const lists = {};
function loadList(file) {
  if (!lists[file]) {
    lists[file] = readList(file).then((text) => GliderWordData.prepare(text.slice(1)))
      .catch((error) => { lists[file] = null; throw error; });
  }
  return lists[file];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.word !== 'string') return undefined;
  const word = message.word.slice(0, 60);
  if (message.type === 'glider:define') {
    loadList('data/dictionary.txt').then((dict) => sendResponse(GliderWordData.define(dict, word)), () => sendResponse(null));
    return true;
  }
  if (message.type === 'glider:parts') {
    loadList('data/wordparts.txt').then((table) => sendResponse(GliderWordData.partsOf(table, word)), () => sendResponse(null));
    return true;
  }
  return undefined;
});

/* ---- the Glider page ---------------------------------------------------- */

/** Open (or bring forward) the Glider page, on one of its sections. */
async function openGliderPage(section) {
  const base = chrome.runtime.getURL(GLIDER_PAGE);
  const url = base + (section ? '#' + encodeURIComponent(section) : '');
  try {
    // getContexts sees the extension's own pages without the "tabs" permission.
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const open = contexts.find((c) => c.tabId >= 0 && String(c.documentUrl || '').startsWith(base));
    if (open) {
      await chrome.tabs.update(open.tabId, { active: true, url });
      if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
  } catch (_) { /* fall through to a new tab */ }
  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'glider:open-page') return undefined;
  const section = typeof message.section === 'string' && /^[a-z-]{1,20}$/.test(message.section) ? message.section : '';
  openGliderPage(section).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
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
