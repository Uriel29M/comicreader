const BANCADIGITAL_BASE = "https://uriel29m.github.io/bancadigital/";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const params = new URLSearchParams(location.search);
let sb = null;
const READER_END_PAGE_URL = BANCADIGITAL_BASE + "assets/somosumabiblioteca.jpg";
let state = {
  readingMode: localStorage.getItem("readingMode") || "single-page",
  readingDirection: localStorage.getItem("readingDirection") || "western",
  recentlyOpenedIds: [],
  readerItemId: null,
  session: null,
  profile: null,
  comicLikeIds: new Set(),
  comicLikeCounts: new Map()
};
let activeReaderCleanup = null;
let readerIsOpen = false;
let handlingRoute = false;
const readerFilePrefetches = new Map();
let activeEditionForPageUrls = null;
let activePageUrls = [];

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}
function extension(url) {
  const raw = String(url || "");
  const clean = /^(https?:|blob:|data:)/i.test(raw) ? raw.split("?")[0].split("#")[0] : raw;
  const filename = clean.split(/[\\/]/).pop();
  return /^.+\.[a-z0-9]{1,8}$/i.test(filename) ? filename.split(".").pop().toLowerCase() : "";
}
function readerLoadingTipMarkup() { return ""; }
function readerLoadingMarkup(message) {
  return '<div class="reader-loading" role="status"><div class="reader-loading-label">' +
    escapeHTML(message) +
    '</div><progress class="reader-progress" aria-label="Carregamento da edição"></progress></div>';
}
function showReaderPageLoading(wrapper) {
  if (!wrapper.querySelector(".reader-loading")) wrapper.insertAdjacentHTML("beforeend", readerLoadingMarkup("Carregando página…"));
  wrapper.classList.add("reader-page-loading");
}
function finishReaderPageLoading(wrapper, error = null) {
  const loading = wrapper.querySelector(".reader-loading");
  if (error && loading) loading.textContent = "Não foi possível carregar esta página.";
  else loading?.remove();
  wrapper.classList.remove("reader-page-loading");
}
function isZipSignature(bytes) {
  return bytes?.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
function hasZipEndRecord(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  const start = Math.max(0, bytes.length - 65557);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) return true;
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x06 && bytes[index + 3] === 0x06) return true;
  }
  return false;
}
function isInvalidZipError(error) {
  return /end of central directory|central directory|is this a zip file/i.test(String(error?.message || error));
}
function getReaderPages(totalPages, skipCover) {
  const firstPage = skipCover && totalPages > 1 ? 2 : 1;
  return Array.from({length: totalPages - firstPage + 1}, (_, index) => firstPage + index);
}
function getReaderSpreadPages(totalPages, spread, skipCover) {
  const pages = getReaderPages(totalPages, skipCover).slice(spread * 2, spread * 2 + 2);
  return state.readingDirection === "eastern" ? pages.reverse() : pages;
}
function getReaderSpreadIndexes(totalPages, spread, skipCover) {
  return getReaderSpreadPages(totalPages, spread, skipCover).map(page => page - 1);
}
function readerEndPageImage() {
  const image = document.createElement("img");
  image.className = "reader-image";
  image.alt = "Página final";
  image.src = READER_END_PAGE_URL;
  return image;
}
function isTelegramMediaUrl(url) {
  try {
    const u = new URL(url);
    return Boolean(window.BANCA_SUPABASE_URL) &&
      u.hostname === new URL(window.BANCA_SUPABASE_URL).hostname &&
      /\/functions\/v1\/telegram-(?:proxy|mtproto)$/.test(u.pathname);
  } catch { return false; }
}
function waitForPrefetchedBuffer(value, timeoutMs = 15000) {
  if (!value) return Promise.resolve(null);
  return Promise.race([
    Promise.resolve(value),
    new Promise(resolve => window.setTimeout(() => resolve(null), timeoutMs))
  ]).catch(() => null);
}
function createArchivePageCache(files, extract) {
  const cache = new Map(), pending = new Map();
  const thirdSize = Math.max(1, Math.ceil(files.length / 3));
  const get = index => {
    if (cache.has(index)) return Promise.resolve(cache.get(index));
    if (!pending.has(index)) {
      pending.set(index, Promise.resolve(extract(files[index])).then(value => {
        cache.set(index, value); pending.delete(index); return value;
      }).catch(error => { pending.delete(index); throw error; }));
    }
    return pending.get(index);
  };
  const prefetchThird = third => {
    if (third < 0 || third > 2) return Promise.resolve();
    const start = third * thirdSize, end = Math.min(files.length, start + thirdSize);
    return Promise.all(Array.from({length: end - start}, (_, offset) => get(start + offset))).then(() => undefined);
  };
  return {get, prefetchThird, thirdSize};
}
function directGoogleDriveUrl(url) {
  const source = String(url || "");
  let parsed;
  try { parsed = new URL(source); } catch { return source; }
  if (!/^(?:drive|docs)\.google\.com$/i.test(parsed.hostname)) return source;
  const pathId = parsed.pathname.match(/\/(?:file\/d|document\/d|spreadsheets\/d|presentation\/d)\/([^/]+)/i)?.[1];
  const id = parsed.searchParams.get("id") || pathId;
  if (!id) return source;
  const direct = new URL("https://drive.usercontent.google.com/download");
  direct.searchParams.set("id", id);
  direct.searchParams.set("export", "download");
  const resourceKey = parsed.searchParams.get("resourcekey");
  if (resourceKey) direct.searchParams.set("resourcekey", resourceKey);
  return direct.toString();
}
function proxiedFileUrl(url) {
  const source = directGoogleDriveUrl(url);
  let parsed;
  try { parsed = new URL(source); } catch { return source; }
  const host = parsed.hostname.toLowerCase();
  const isMediaFire = parsed.protocol === "https:" && (
    host === "mediafire.com" || host === "www.mediafire.com" || /^download\d+\.mediafire\.com$/.test(host)
  );
  const isMega = parsed.protocol === "https:" && (host === "mega.nz" || host === "www.mega.nz") && parsed.pathname.startsWith("/file/");
  const isGoogleDrive = parsed.protocol === "https:" && host === "drive.usercontent.google.com";
  if ((!isMediaFire && !isMega && !isGoogleDrive) || !window.BANCA_SUPABASE_URL) return source;
  const proxyName = isGoogleDrive ? "drive-proxy" : isMega ? "mega-proxy" : "mediafire-proxy";
  const proxy = new URL(String(window.BANCA_SUPABASE_URL).replace(/\/+$/, "") + "/functions/v1/" + proxyName);
  proxy.searchParams.set("url", source);
  return proxy.toString();
}
async function fetchFileArrayBuffer(url, onProgress = () => {}, onComplete = () => {}, signal = null, forceFresh = false) {
  const source = String(url || "");
  const response = await fetch(/^blob:/i.test(source) ? source : proxiedFileUrl(source), {
    method: "GET", mode: "cors", credentials: "omit",
    cache: forceFresh ? "reload" : "no-store",
    ...(signal ? {signal} : {})
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, total || buffer.byteLength);
    onComplete();
    return buffer;
  }
  const reader = response.body.getReader(), chunks = [];
  let received = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(part.value);
    received += part.value.byteLength;
    onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  chunks.forEach(chunk => {bytes.set(chunk, offset); offset += chunk.byteLength;});
  onComplete();
  return bytes.buffer;
}
async function deleteReaderFileCache() {}
async function ensureReaderDependency(format) {
  const deps = window.BancaReaderDeps;
  if (!deps?.ensure) throw new Error("O carregador original do leitor não foi encontrado.");
  await deps.ensure(format);
}
let readerFormatRenderersPromise = null;
function appAssetUrl(path) { return new URL(String(path).replace(/^\/+/, ""), BANCADIGITAL_BASE).href; }
function loadLibarchiveModule() {
  if (!window.__bancaReaderLibarchive) {
    window.__bancaReaderLibarchive = Promise.all([
      import(appAssetUrl("libarchive/libarchive.js")),
      import(appAssetUrl("libarchive/rar-reader.mjs"))
    ]).then(([module, rar]) => ({...module, Archive: rar.withSolidRarSupport(module.Archive)}));
  }
  return window.__bancaReaderLibarchive;
}
function loadReaderFormatRenderers() {
  if (!readerFormatRenderersPromise) {
    readerFormatRenderersPromise = import("./reader-formats.js?v=original-banca-renderers-20261023")
      .then(module => module.createReaderFormats({
        $, READER_END_PAGE_URL, appAssetUrl, createArchivePageCache,
        deleteReaderFileCache, ensureReaderDependency, escapeHTML,
        fetchFileArrayBuffer, finishReaderPageLoading, getReaderPages,
        getReaderSpreadIndexes, getReaderSpreadPages, hasZipEndRecord,
        isInvalidZipError, isTelegramMediaUrl, isZipSignature,
        loadLibarchiveModule, proxiedFileUrl, readerEndPageImage,
        readerLoadingMarkup, readerLoadingTipMarkup, reportFileFailure,
        setReadingMode, showReaderPageLoading, state, waitForPrefetchedBuffer
      })).catch(error => {readerFormatRenderersPromise = null; throw error;});
  }
  return readerFormatRenderersPromise;
}
async function renderPDFReader(...args) { return (await loadReaderFormatRenderers()).renderPDFReader(...args); }
async function renderCBZReader(...args) { return (await loadReaderFormatRenderers()).renderCBZReader(...args); }
async function renderCBRReader(...args) { return (await loadReaderFormatRenderers()).renderCBRReader(...args); }

function canViewCatalogItem() { return true; }
function isTelegramPostUrl(url) { return /^https?:\/\/(?:www\.)?t(?:elegram)?\.me\//i.test(String(url || "")); }
function isExternalArchiveLink(url) {
  return /^(?:https?:\/\/)(?:(?:www\.)?mediafire\.com\/\?|mega\.co\.nz\/#!)/i.test(String(url || ""));
}
function telegramProxyUrl(item) {
  if (!item?.id || !isTelegramPostUrl(item?.telegramUrl) || !window.BANCA_SUPABASE_URL) return "";
  const proxy = new URL(String(window.BANCA_SUPABASE_URL).replace(/\/+$/, "") + "/functions/v1/telegram-proxy");
  proxy.searchParams.set("item_id", String(item.id));
  return proxy.toString();
}
function downloadSource(item) {
  if (item?.local) return item.fileUrl || "";
  return telegramProxyUrl(item) || item?.fileUrl || (!isTelegramPostUrl(item?.telegramUrl) ? item?.telegramUrl : "") || "";
}
function readerSourceCandidates(item) {
  const primary = downloadSource(item);
  const backups = Array.isArray(item?.backupUrls) ? item.backupUrls : (item?.backupUrl ? [item.backupUrl] : []);
  return [primary, item?.fileUrl, ...backups].map(value => String(value || "").trim()).filter((value, index, values) => value && values.indexOf(value) === index);
}
async function probeReaderSource(url) { return Boolean(url); }
function activateOfflineMode() {}
function downloaded() { return null; }
function openDownloaded() {}
function setSection() {}
function navigate() { location.href = BANCADIGITAL_BASE; }
function currentRouteHistoryIndex() { return Math.max(0, history.length - 1); }
function prioritizeReaderLoading() {}
function recordComicRead() {}
function itemDisplayTitle(item) { return String(item?.title || item?.name || "Quadrinho"); }
function shouldSkipCover() { return localStorage.getItem("readerSkipCover") === "true"; }
function progressFor(item) {
  try { return JSON.parse(localStorage.getItem("reader-progress:" + String(item?.id || "")) || "null"); } catch { return null; }
}
function saveReadingProgress(item, page, total) {
  try {
    localStorage.setItem("reader-progress:" + String(item?.id || ""), JSON.stringify({
      page: Number(page) || 1, total_pages: Number(total) || 1,
      completed: Number(page) >= Number(total) && Number(total) > 0
    }));
  } catch {}
}
function saveSkipCoverPreference(value) {
  try {localStorage.setItem("readerSkipCover", value ? "true" : "false");} catch {}
}
function characterNames(item) { return Array.isArray(item?.characters) ? item.characters : []; }
function readerCustomLinksMarkup() { return ""; }
function isAdminProfile() { return false; }
function toast(message) {
  console.warn("[ComicReader]", message);
  const body = document.querySelector(".reader-body");
  if (body) {
    const note = document.createElement("div");
    note.className = "empty"; note.style.cssText = "margin:auto;max-width:650px;text-align:center;padding:24px";
    note.textContent = String(message);
    body.replaceChildren(note);
  }
}
function toggleComicLike() {}
function shareComic() {}
function openCommentsPopup() {}
function seriesEditions() { return []; }
function openSeriesSelection() {}
function openEditForm() {}
function openEntityPage() {}
function attachComments() {}
function appendSeriesNavigation() {}
function resumeCoverLoading() {}
function setReadingMode(mode) {
  state.readingMode = mode;
  try {localStorage.setItem("readingMode", mode);} catch {}
}
function setReadingDirection(direction) {
  state.readingDirection = direction;
  try {localStorage.setItem("readingDirection", direction);} catch {}
}
async function reportFileFailure(item, message, options = {}) {
  console.error("Leitor:", item?.title || item?.id || "", message);
  if (!options.silent) toast(message);
}
function loadReaderAdsFeature() {
  return Promise.resolve({createReaderController: () => null});
}
async function parseEditionPayload() {
  let edition = {};
  const decode = value => {
    try {
      const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (firstError) {
      try { return JSON.parse(decodeURIComponent(String(value))); } catch { throw firstError; }
    }
  };
  if (params.has("data")) {
    const value = params.get("data");
    edition = Object.assign(edition, value.trim().startsWith("{") ? JSON.parse(value) : decode(value));
  }
  if (params.has("manifest")) {
    const response = await fetch(params.get("manifest"), {cache:"no-store"});
    if (!response.ok) throw new Error("Não foi possível carregar os dados desta edição.");
    edition = Object.assign(edition, await response.json());
  }
  if (params.has("src")) edition.sourceUrl = params.get("src");
  if (params.has("title")) edition.title = params.get("title");
  if (params.has("format")) edition.format = params.get("format");
  if (params.has("pages")) edition.pages = decode(params.get("pages"));
  return edition;
}
function normalizeItem(edition) {
  const originalTelegramPages = Array.isArray(edition.telegramPages) && edition.telegramPages.length
    ? edition.telegramPages
    : undefined;
  activePageUrls = Array.isArray(edition.pages)
    ? edition.pages.map(value => typeof value === "string" ? value : value?.url || value?.src || "").filter(url => /^https?:\/\//i.test(url))
    : [];
  if (!activePageUrls.length && Array.isArray(edition.telegramPages)) {
    activePageUrls = edition.telegramPages
      .map(value => typeof value === "string" ? value : value?.url || value?.src || "")
      .filter(url => /^https?:\/\//i.test(url));
  }
  if (!activePageUrls.length && edition.telegramItemId && edition.telegramBaseUrl && Number(edition.pageCount) > 0) {
    const base = String(edition.telegramBaseUrl).replace(/\/+$/, "");
    activePageUrls = Array.from({length: Math.min(5000, Number(edition.pageCount))}, (_, index) => {
      const u = new URL(base + "/functions/v1/telegram-page-image");
      u.searchParams.set("item_id", String(edition.telegramItemId));
      u.searchParams.set("page", String(index + 1));
      return u.href;
    });
  }
  const sourceUrl = String(edition.fileUrl || edition.url || edition.sourceUrl || "");
  const id = String(edition.id || edition.telegramItemId || "external-edition");
  activeEditionForPageUrls = id;
  window.BancaTelegramPages = {
    imageUrl(itemId, pageNumber) {
      const index = Number(pageNumber) - 1;
      if (String(itemId) !== String(activeEditionForPageUrls) || index < 0) return "";
      if (activePageUrls[index]) return activePageUrls[index];
      const base = String(window.BANCA_SUPABASE_URL || "").replace(/\/+$/, "");
      if (!base) return "";
      const url = new URL(base + "/functions/v1/telegram-page-image");
      url.searchParams.set("item_id", String(itemId));
      url.searchParams.set("page", String(pageNumber));
      return url.href;
    }
  };
  const isImagePages = activePageUrls.length > 0;
  const format = isImagePages ? "telegram-pages" : String(edition.format || extension(sourceUrl)).toLowerCase();
  return {
    ...edition,
    id, title: String(edition.title || edition.name || "Quadrinho"),
    sourceUrl, fileUrl: sourceUrl, backupUrls: edition.backupUrls || [],
    format, local: false,
    telegramPages: isImagePages ? activePageUrls.map((url, index) => ({page:index + 1, url})) : originalTelegramPages
  };
}
function showEmptyReader(message) {
  const body = $("#reader-body");
  const title = $("#editionTitle");
  const counter = $("#reader-controls");
  if (title) title.textContent = "Leitor de quadrinhos";
  if (counter) counter.innerHTML = '<button id="previous" type="button" aria-label="Página anterior" disabled>‹</button><span class="reader-page">— / —</span><button id="next" type="button" aria-label="Próxima página" disabled>›</button>';
  if (!body) return;

  const panel = document.createElement("div");
  panel.className = "empty";
  panel.style.cssText = "width:calc(100% - 32px);max-width:650px;margin:auto;padding:28px 20px;text-align:center;box-sizing:border-box";

  const heading = document.createElement("h2");
  heading.textContent = "Abrir edição no leitor";
  heading.style.cssText = "margin:0 0 10px;color:#f1f1f3";

  const description = document.createElement("p");
  description.textContent = message || "Escolha um arquivo do computador ou cole o link de uma edição da Banca Digital.";
  description.style.cssText = "margin:0 auto 16px;max-width:520px;color:#b7b7bf";

  const formats = document.createElement("p");
  formats.textContent = "Arquivos aceitos: PDF, CBZ, CBR, JPG, PNG, WEBP e GIF.";
  formats.style.cssText = "margin:0 auto 18px;color:#92929b;font-size:12px";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "local-comic-file";
  fileInput.accept = ".pdf,.cbz,.cbr,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif";
  fileInput.setAttribute("aria-label", "Escolher arquivo de quadrinho");
  fileInput.style.cssText = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

  const chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.className = "btn btn-primary";
  chooseButton.textContent = "Escolher arquivo do computador";
  chooseButton.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 18px;cursor:pointer";
  chooseButton.addEventListener("click", () => fileInput.click());

  const fileStatus = document.createElement("div");
  fileStatus.style.cssText = "margin-top:10px;color:#b7b7bf;font-size:12px;overflow-wrap:anywhere";
  fileStatus.textContent = "O arquivo é aberto no navegador e não é enviado a um servidor.";

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileStatus.textContent = "Abrindo " + file.name + "…";
    chooseButton.disabled = true;
    void openLocalComicFile(file).catch(error => {
      chooseButton.disabled = false;
      fileStatus.textContent = error?.message || "Não foi possível abrir esse arquivo.";
    });
  });

  const separator = document.createElement("div");
  separator.style.cssText = "height:1px;background:#303036;margin:22px auto;max-width:480px";

  const linkHeading = document.createElement("h3");
  linkHeading.textContent = "Ou cole o link da edição da Banca Digital";
  linkHeading.style.cssText = "margin:0 0 10px;color:#f1f1f3;font-size:15px";

  const linkForm = document.createElement("form");
  linkForm.style.cssText = "display:flex;flex-direction:column;gap:10px;width:100%;max-width:500px;margin:0 auto";
  const linkInput = document.createElement("input");
  linkInput.type = "url";
  linkInput.id = "banca-edition-link";
  linkInput.placeholder = "https://uriel29m.github.io/bancadigital/?ler=...";
  linkInput.autocomplete = "url";
  linkInput.spellcheck = false;
  linkInput.setAttribute("aria-label", "Link da edição na Banca Digital");
  linkInput.style.cssText = "box-sizing:border-box;width:100%;min-height:42px;padding:10px 12px;border:1px solid #44444c;border-radius:7px;background:#151519;color:#f1f1f3;font:inherit";
  const linkButton = document.createElement("button");
  linkButton.type = "submit";
  linkButton.className = "btn btn-primary";
  linkButton.textContent = "Abrir link no leitor";
  linkButton.style.cssText = "min-height:42px;padding:10px 18px;cursor:pointer";
  const linkStatus = document.createElement("div");
  linkStatus.id = "banca-link-status";
  linkStatus.setAttribute("role", "status");
  linkStatus.setAttribute("aria-live", "polite");
  linkStatus.style.cssText = "min-height:18px;color:#b7b7bf;font-size:12px;overflow-wrap:anywhere";
  linkForm.append(linkInput, linkButton, linkStatus);
  linkForm.addEventListener("submit", event => {
    event.preventDefault();
    linkButton.disabled = true;
    linkStatus.textContent = "Localizando edição e preparando o leitor…";
    void openBancaEditionLink(linkInput.value).then(() => {
      linkStatus.textContent = "";
    }).catch(error => {
      linkStatus.textContent = error?.message || "Não foi possível abrir essa edição.";
      linkButton.disabled = false;
    });
  });

  panel.append(heading, description, formats, fileInput, chooseButton, fileStatus, separator, linkHeading, linkForm);
  body.replaceChildren(panel);
  body.classList.remove("continuous", "reader-grayscale", "reader-gesture-zoom");
  body.style.removeProperty("--reader-zoom");
  body.style.removeProperty("--reader-pan-x");
  body.style.removeProperty("--reader-pan-y");
}
async function openLocalComicFile(file) {
  const format = extension(file?.name || "");
  const supported = ["pdf", "cbz", "cbr", "jpg", "jpeg", "png", "webp", "gif"];
  if (!file || !supported.includes(format)) {
    showEmptyReader("Esse formato não é compatível. Escolha um PDF, CBZ, CBR ou arquivo de imagem.");
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  const item = {
    id: "local-file-" + Date.now(),
    title: file.name.replace(/\.[^.]+$/, "") || file.name,
    name: file.name,
    fileName: file.name,
    format,
    file,
    fileUrl: objectUrl,
    sourceUrl: objectUrl,
    local: true,
    backupUrls: []
  };

  try {
    state.readerItemId = item.id;
    readerIsOpen = false;
    activeReaderCleanup?.();
    activeReaderCleanup = null;
    // Mantém a tela de seleção sob o leitor para que "Voltar" retorne ao seletor.
    openReader(item, {routeSync: true, localObjectUrl: objectUrl});
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

const catalogScriptLoads = new Map();
const CATALOG_SCRIPTS = [
  "js/data/dc-comics/recentes.js",
  "js/data/dc-comics/black-label.js",
  "js/data/dc-comics/milestone.js",
  "js/data/dc-comics/novos-52.js",
  "js/catalog-identity.js"
];
function loadBancaScript(pathOrUrl) {
  const src = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : new URL(pathOrUrl, BANCADIGITAL_BASE).href;
  if (catalogScriptLoads.has(src)) return catalogScriptLoads.get(src);
  const alreadyPresent = Array.from(document.scripts).some(script => script.src === src);
  if (alreadyPresent && (src.includes("reader-deps.js") || src.includes("supabase.js"))) return Promise.resolve();
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      catalogScriptLoads.delete(src);
      reject(new Error("Não foi possível carregar " + new URL(src).pathname.split("/").pop() + " da Banca Digital."));
    };
    document.head.appendChild(script);
  });
  catalogScriptLoads.set(src, promise);
  return promise;
}
async function ensureSupabaseClient() {
  if (sb) return sb;
  if (!window.supabase?.createClient) {
    await loadBancaScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
  }
  if (!window.BANCA_SUPABASE_URL || !window.BANCA_SUPABASE_KEY) {
    await loadBancaScript("js/supabase.js");
  }
  if (!window.supabase?.createClient || !window.BANCA_SUPABASE_URL || !window.BANCA_SUPABASE_KEY) {
    throw new Error("Não foi possível conectar ao catálogo da Banca Digital.");
  }
  sb = window.supabase.createClient(window.BANCA_SUPABASE_URL, window.BANCA_SUPABASE_KEY);
  return sb;
}
function parseBancaEditionId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Cole o link de uma edição da Banca Digital.");
  // Aceita também o ID cru da edição, além do link completo.
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,180}$/.test(raw) && !raw.includes("://")) return raw;
  let url;
  try { url = new URL(raw, BANCADIGITAL_BASE); }
  catch { throw new Error("Link inválido. Cole a URL completa da edição."); }
  if (url.hostname.toLowerCase() !== "uriel29m.github.io" ||
      !/^\/bancadigital\/?$/.test(url.pathname)) {
    throw new Error("Use o link da edição na Banca Digital, no formato https://uriel29m.github.io/bancadigital/?ler=ID.");
  }
  const id = url.searchParams.get("ler") || url.searchParams.get("edicao") || url.searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,180}$/.test(id)) {
    throw new Error("Esse link não identifica uma edição. Copie o endereço da edição aberta na Banca Digital (ele deve conter ?ler=...).");
  }
  return id;
}
async function findStaticBancaEdition(id) {
  for (const path of CATALOG_SCRIPTS) {
    if (path === "js/catalog-identity.js") {
      if (!window.__comicReaderCatalogIdentityLoaded) {
        try { await loadBancaScript(path); } catch (error) { console.warn(error); }
        window.__comicReaderCatalogIdentityLoaded = true;
      }
    } else {
      await loadBancaScript(path);
    }
    const found = Array.isArray(window.DEFAULT_LIBRARY)
      ? window.DEFAULT_LIBRARY.find(item => String(item?.id || "") === String(id))
      : null;
    if (found) {
      // Identity normalization is safe and keeps the official series IDs intact.
      if (!window.__comicReaderCatalogIdentityLoaded) {
        try { await loadBancaScript("js/catalog-identity.js"); } catch (error) { console.warn(error); }
        window.__comicReaderCatalogIdentityLoaded = true;
      }
      return (window.DEFAULT_LIBRARY || []).find(item => String(item?.id || "") === String(id)) || found;
    }
  }
  return Array.isArray(window.DEFAULT_LIBRARY)
    ? window.DEFAULT_LIBRARY.find(item => String(item?.id || "") === String(id)) || null
    : null;
}
const CATALOG_OVERRIDE_FIELDS = [
  "coverUrl", "cover", "featuredCoverUrl", "fileUrl", "telegramUrl", "telegramFileId",
  "telegramFileName", "telegramFileSize", "backupUrls", "telegramPages",
  "telegramPageFiles", "telegramPagesPending", "telegramPagesMigration", "format"
];
function mergeCatalogEdition(baseItem, edition) {
  const merged = {...(baseItem || {}), ...(edition || {})};
  for (const field of CATALOG_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(edition || {}, field)) merged[field] = edition[field];
    else delete merged[field];
  }
  return merged;
}
async function loadCatalogOverride(id) {
  const client = await ensureSupabaseClient();
  const {data, error} = await client
    .from("catalog_edition_overrides")
    .select("item_id,edition,created_at,updated_at")
    .eq("item_id", String(id))
    .maybeSingle();
  if (error) throw error;
  if (!data?.edition) return null;
  if (String(data.item_id) !== String(id) || String(data.edition.id) !== String(id)) {
    throw new Error("O registro compartilhado desta edição está inconsistente.");
  }
  return data;
}
async function openBancaEditionLink(value) {
  const id = parseBancaEditionId(value);
  const status = $("#banca-link-status");
  if (status) status.textContent = "Buscando edição " + id + "…";
  const [staticResult, overrideResult] = await Promise.allSettled([
    findStaticBancaEdition(id),
    loadCatalogOverride(id)
  ]);
  const baseItem = staticResult.status === "fulfilled" ? staticResult.value : null;
  const overrideRecord = overrideResult.status === "fulfilled" ? overrideResult.value : null;
  if (staticResult.status === "rejected") console.warn("Catálogo estático indisponível:", staticResult.reason);
  if (overrideResult.status === "rejected") console.warn("Metadados atualizados indisponíveis:", overrideResult.reason);
  if (!baseItem && !overrideRecord?.edition) {
    const detail = overrideResult.status === "rejected"
      ? " Não foi possível consultar os metadados atualizados do catálogo."
      : "";
    throw new Error("Não encontrei essa edição no catálogo da Banca Digital. Confira se o ID do link está correto." + detail);
  }
  let item = overrideRecord?.edition
    ? mergeCatalogEdition(baseItem || {id, title: overrideRecord.edition.title || overrideRecord.edition.name || id}, overrideRecord.edition)
    : {...baseItem};
  if (item.catalogDeleted === true) {
    throw new Error("Essa edição foi removida do catálogo da Banca Digital.");
  }
  if (overrideRecord?.edition?.telegramBaseUrl) {
    window.BANCA_SUPABASE_URL = String(overrideRecord.edition.telegramBaseUrl).replace(/\/+$/, "");
  }
  const hasTelegramPages = Array.isArray(item.telegramPages) && item.telegramPages.length > 0;
  const hasTelegramFile = Boolean(item.telegramUrl && item.id && window.BANCA_SUPABASE_URL);
  const staticDirectSource = item.sourceUrl && /\.(pdf|cbz|cbr|jpe?g|png|webp|gif)(?:[?#]|$)/i.test(String(item.sourceUrl));
  const hasSource = Boolean(item.fileUrl || item.url || staticDirectSource || hasTelegramPages || hasTelegramFile);
  if (!hasSource) {
    throw new Error("A edição foi encontrada, mas não tem arquivo nem páginas do Telegram cadastrados para abrir.");
  }
  const directFile = String(item.fileUrl || item.url || (staticDirectSource ? item.sourceUrl : "") || "");
  const normalized = normalizeItem({...item, sourceUrl:directFile, fileUrl:directFile, url:directFile, local:false});
  // A tela inicial permanece atrás do leitor; o botão Voltar retorna ao campo de link.
  state.readerItemId = normalized.id;
  readerIsOpen = false;
  activeReaderCleanup?.();
  activeReaderCleanup = null;
  openReader(normalized, {routeSync:true, skipCover: normalized.skipCover === true, standalone:true});
}
async function bootStandaloneReader() {
  const fallback = $("#reader-overlay");
  try {
    const edition = await parseEditionPayload();
    if (edition.telegramBaseUrl && !window.BANCA_SUPABASE_URL) {
      window.BANCA_SUPABASE_URL = String(edition.telegramBaseUrl).replace(/\/+$/, "");
    }
    const hasPayload = Boolean(
      edition.sourceUrl || edition.fileUrl || edition.url ||
      (Array.isArray(edition.pages) && edition.pages.length) ||
      (edition.telegramItemId && edition.telegramBaseUrl && Number(edition.pageCount)) ||
      edition.telegramPages
    );
    if (!hasPayload) {
      showEmptyReader();
      $("#reading-mode-select")?.setAttribute("disabled", "");
      return;
    }
    const item = normalizeItem(edition);
    if (Array.isArray(edition.telegramPages) && !item.telegramPages) item.telegramPages = edition.telegramPages;
    if (edition.telegramItemId && !item.telegramPages && Number(edition.pageCount)) {
      item.telegramPages = Array.from({length:Number(edition.pageCount)}, (_, index) => ({page:index + 1}));
      activePageUrls = item.telegramPages.map((_, index) => {
        const u = new URL(String(edition.telegramBaseUrl).replace(/\/+$/, "") + "/functions/v1/telegram-page-image");
        u.searchParams.set("item_id", String(edition.telegramItemId));
        u.searchParams.set("page", String(index + 1));
        return u.href;
      });
      activeEditionForPageUrls = item.id;
    }
    fallback?.remove();
    state.readerItemId = item.id;
    activeReaderCleanup = null;
    readerIsOpen = false;
    openReader(item, {routeSync:true, skipCover: edition.skipCover === true});
  } catch (error) {
    showEmptyReader(error?.message || "Não foi possível carregar a edição.");
  }
}


async function renderTelegramPagesReader(item, body, controls, overlay, skipCover = false, resumePage = 1, onPageChange = () => {}) {
    const pages = Array.isArray(item.telegramPages) ? item.telegramPages : [];
    if (!pages.length || !window.BancaTelegramPages?.imageUrl) throw new Error("Esta edição não possui páginas JPEG válidas no Telegram.");
    const total = pages.length + 1;
    const first = skipCover && pages.length > 1 ? 2 : 1;
    let page = Math.max(first, Math.min(Number(resumePage) || first, total));
    let token = 0;
    const cache = new Map();
    const pending = new Map();
    const load = n => {
      if (n < 1 || n > pages.length) return Promise.resolve(null);
      if (cache.has(n)) return Promise.resolve(cache.get(n));
      if (!pending.has(n)) {
        const promise = (async () => {
          let lastError;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const img = await new Promise((resolve, reject) => {
                const candidate = new Image();
                let settled = false;
                const finish = (fn, value) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  candidate.onload = null;
                  candidate.onerror = null;
                  fn(value);
                };
                const timer = setTimeout(() => {
                  candidate.src = "";
                  finish(reject, new Error("Tempo esgotado ao carregar página " + n));
                }, 5000);
                candidate.decoding = "async";
                candidate.onload = () => finish(resolve, candidate);
                candidate.onerror = () => finish(reject, new Error("Falha ao carregar página " + n));
                candidate.src = window.BancaTelegramPages.imageUrl(item.id, n);
              });
              cache.set(n, img);
              return img;
            } catch (error) { lastError = error; }
          }
          throw lastError || new Error("Falha ao carregar página " + n);
        })();
        pending.set(n, promise);
        promise.then(() => pending.delete(n), () => pending.delete(n));
      }
      return pending.get(n);
    };
    const warm = n => {
      // Prioridade imediata: duas páginas anteriores e duas posteriores.
      for (const next of [n - 2, n - 1, n + 1, n + 2]) {
        if (next >= first && next <= pages.length && !cache.has(next) && !pending.has(next)) {
          void load(next).catch(() => {});
        }
      }
    };
    let backgroundStarted = false;
    const preloadAllInBackground = () => {
      if (backgroundStarted) return;
      backgroundStarted = true;
      // Carrega a edição inteira em segundo plano, sem disparar centenas de pedidos simultâneos.
      const queue = Array.from({ length: pages.length }, (_, i) => i + 1)
        .filter(n => n >= first && n <= pages.length && !cache.has(n))
        .sort((a, b) => Math.abs(a - page) - Math.abs(b - page));
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const n = queue[cursor++];
          if (cache.has(n)) continue;
          try { await load(n); } catch { /* A navegação pode tentar novamente quando a página for solicitada. */ }
        }
      };
      void Promise.all([worker(), worker()]);
    };
    const drawSingle = async () => {
      const current = ++token;
      const showControls = () => {
        controls.innerHTML = '<button data-prev ' + (page <= first ? "disabled" : "") + '>‹</button><span class="reader-page">' + page + ' / ' + total + '</span><button data-next ' + (page >= total ? "disabled" : "") + '>›</button>';
        $("[data-prev]", controls)?.addEventListener("click", () => {
          if (page > first) { page--; drawSingle(); }
        });
        $("[data-next]", controls)?.addEventListener("click", () => {
          if (page < total) { page++; drawSingle(); }
        });
      };
      showControls();
      onPageChange(item, page, total);
      if (page === total) {
        body.replaceChildren(readerEndPageImage());
        return;
      }
      // Keep the controls live while the image loads; a slow request can't lock navigation.
      body.innerHTML = '<div class="empty" style="margin:auto">Carregando página ' + page + '…</div>';
      try {
        const requestedPage = page;
        const loaded = await load(requestedPage);
        if (current !== token || requestedPage !== page) return;
        const img = document.createElement("img");
        img.className = "reader-image";
        img.alt = "Página " + requestedPage;
        img.decoding = "async";
        img.src = loaded.src;
        body.replaceChildren(img);
        warm(requestedPage);
      } catch {
        if (current !== token || page < 1 || page > pages.length) return;
        body.innerHTML = '<div class="empty" style="margin:auto">Falha ao carregar esta página. <button type="button" data-retry-page>Tentar novamente</button></div>';
        $("[data-retry-page]", body)?.addEventListener("click", () => {
          cache.delete(page);
          pending.delete(page);
          drawSingle();
        }, { once: true });
      }
      if (current !== token) return;
      showControls();
      onPageChange(item, page, total);
    };
    const drawDouble = async () => {
      const current = ++token;
      const start = page === total ? total : Math.max(first, page <= first + 1 ? first : (page % 2 ? page - 1 : page));
      const nums = start === total ? [total] : [start, Math.min(start + 1, pages.length)];
      const spread = document.createElement("div"); spread.className = "reader-double-page";
      try {
        for (const n of nums) {
          const wrapper = document.createElement("div"); wrapper.className = "double-page";
          if (n === total) wrapper.appendChild(readerEndPageImage());
          else { const loaded = await load(n); if (current !== token) return; const img = document.createElement("img"); img.className = "reader-image"; img.alt = "Página " + n; img.src = loaded.src; wrapper.appendChild(img); warm(n); }
          spread.appendChild(wrapper);
        }
      } catch { if (current === token) body.innerHTML = '<div class="empty" style="margin:auto">Não foi possível carregar as páginas do Telegram.</div>'; return; }
      if (current !== token) return;
      body.replaceChildren(spread);
      controls.innerHTML = '<button data-prev ' + (start <= first ? "disabled" : "") + '>‹</button><span class="reader-page">' + nums.join("–") + ' / ' + total + '</span><button data-next ' + (nums[nums.length - 1] >= total ? "disabled" : "") + '>›</button>';
      $("[data-prev]", controls)?.addEventListener("click", () => { if (start > first) { page = Math.max(first, start - 2); draw(); } });
      $("[data-next]", controls)?.addEventListener("click", () => { if (nums[nums.length - 1] < total) { page = Math.min(total, start + 2); draw(); } });
      onPageChange(item, start, total);
    };
    const drawScroll = () => {
      ++token;
      const container = document.createElement("div"); container.className = "image-continuous-scroll-container";
      const els = [];
      for (let n = first; n <= total; n++) {
        const wrapper = document.createElement("div"); wrapper.className = "image-page-wrapper"; wrapper.dataset.pageNum = String(n);
        if (n === total) wrapper.appendChild(readerEndPageImage());
        else { const img = document.createElement("img"); img.className = "reader-image"; img.alt = "Página " + n; img.loading = "lazy"; img.decoding = "async"; img.src = window.BancaTelegramPages.imageUrl(item.id, n); wrapper.appendChild(img); }
        container.appendChild(wrapper); els.push(wrapper);
      }
      body.replaceChildren(container);
      const update = () => {
        const visible = els.find(el => { const rect = el.getBoundingClientRect(); return rect.bottom > 0 && rect.top < window.innerHeight / 2; }) || els[0];
        if (!visible) return;
        page = Number(visible.dataset.pageNum);
        controls.innerHTML = '<button data-prev ' + (page <= first ? "disabled" : "") + '>↑</button><span class="reader-page">' + page + ' / ' + total + '</span><button data-next ' + (page >= total ? "disabled" : "") + '>↓</button>';
        $("[data-prev]", controls)?.addEventListener("click", () => els[Math.max(0, els.indexOf(visible) - 1)]?.scrollIntoView({behavior:"smooth",block:"start"}));
        $("[data-next]", controls)?.addEventListener("click", () => els[Math.min(els.length - 1, els.indexOf(visible) + 1)]?.scrollIntoView({behavior:"smooth",block:"start"}));
        onPageChange(item, page, total);
      };
      container.addEventListener("scroll", update, {passive:true}); update();
      els.find(el => Number(el.dataset.pageNum) === page)?.scrollIntoView({block:"start"});
      overlay._telegramPagesScrollCleanup = () => container.removeEventListener("scroll", update);
    };
    const draw = () => state.readingMode === "continuous-scroll" ? drawScroll() : state.readingMode === "double-page" ? void drawDouble() : void drawSingle();
    preloadAllInBackground();
    const selector = $("#reading-mode-select", overlay);
    if (selector) { selector.disabled = false; selector.addEventListener("change", event => { setReadingMode(event.target.value); draw(); }); }
    draw();
    overlay._telegramPagesCleanup = () => { token++; cache.clear(); pending.clear(); overlay._telegramPagesScrollCleanup?.(); };
    return true;
  }

function openReader(item, options = {}) {
    if (!item) return;
    const telegramPagesMode = !item.local && Array.isArray(item.telegramPages) && item.telegramPages.length > 0;
    if (!canViewCatalogItem(item)) {
      toast("Esta edição está indisponível.");
      return;
    }
    if (!telegramPagesMode && !options.standalone && !options.telegramResolved && !item.local && isTelegramPostUrl(item.telegramUrl) && navigator.onLine !== false && sb && window.BancaTelegram?.published) {
      if (readerIsOpen && activeReaderCleanup && String(state.readerItemId || "") === String(item.id || "") && document.querySelector(".reader-overlay")) return;
      void window.BancaTelegram.published(item, sb).then(canonical => {
        if (!canonical.telegramFileId && !canonical.fileUrl) {
          const published = (window.DEFAULT_LIBRARY || []).find(entry => String(entry.id) === String(item.id));
          if (published && (published.telegramFileId || published.fileUrl)) {
            openReader(mergeCatalogEdition(item, published), { ...options, telegramResolved: true });
            return;
          }
          toast("Esta postagem ainda não foi identificada pelo bot. Um administrador precisa salvar a edição novamente.");
          return;
        }
        openReader(canonical, { ...options, telegramResolved: true });
      }).catch(error => toast(`Não foi possível consultar a fonte do Telegram: ${error.message || error}`));
      return;
    }
    if (!item) return;
    if (readerIsOpen && activeReaderCleanup && String(state.readerItemId || "") === String(item.id || "") && document.querySelector(".reader-overlay")) return;
    if (!canViewCatalogItem(item)) {
      toast("Esta edição está indisponível.");
      return;
    }
    if (!telegramPagesMode && !downloadSource(item) && item?.officialUrl) {
      window.open(item.officialUrl, "_blank", "noopener");
      return;
    }
    const sourceUrl = telegramPagesMode ? window.BancaTelegramPages?.imageUrl(item.id, 1) : downloadSource(item);
    if (isExternalArchiveLink(sourceUrl)) {
      window.open(sourceUrl, "_blank", "noopener");
      return;
    }

    if (!item.local && navigator.onLine === false) {
      activateOfflineMode();
      if (downloaded(item.id)?.status === "completed") return openDownloaded(item);
      toast("Este quadrinho não está disponível offline. Abra a área de Downloads para ver os quadrinhos baixados.");
      setSection("downloads");
      return;
    }

    state.recentlyOpenedIds = [String(item.id), ...state.recentlyOpenedIds.filter(id => String(id) !== String(item.id))].slice(0, 20);
    try { localStorage.setItem("bancaDigitalRecentlyOpened", JSON.stringify(state.recentlyOpenedIds)); } catch {}

    prioritizeReaderLoading();

    if (!item.local && !options.routeSync) {
      navigate({ ler: item.id });
      return;
    }

    activeReaderCleanup?.();
    activeReaderCleanup = null;

    recordComicRead(item);
    const sourceCandidates = telegramPagesMode ? [sourceUrl].filter(Boolean) : readerSourceCandidates(item);
    let resolvedUrl = sourceCandidates[0] || "";

    if (!resolvedUrl) {
      toast(item.telegramUrl ? "Esta edição do Telegram ainda não tem o file_id do bot configurado." : "Esta edição não tem uma URL de arquivo direto.");
      return;
    }

    readerIsOpen = true;
    prioritizeReaderLoading();

    const prefetchedBuffer = isTelegramMediaUrl(resolvedUrl) ? null : readerFilePrefetches.get(resolvedUrl) || null;
    readerFilePrefetches.delete(resolvedUrl);
    const itemFormat = String(item.format || "").toLowerCase();
    const fileFormat = extension(item.file?.name || item.name || "");
    const format = telegramPagesMode ? "telegram-pages" : (/^(pdf|cbz|cbr|jpg|jpeg|png|webp|gif)$/.test(itemFormat)
      ? itemFormat
      : (fileFormat || extension(resolvedUrl)).toLowerCase());
    const skipCover = Object.prototype.hasOwnProperty.call(options, "skipCover") ? options.skipCover === true : shouldSkipCover();
    const savedProgress = progressFor(item);
    const resumePage = savedProgress?.page || (skipCover ? 2 : 1);
    let readerGrayscale = options.grayscale === true;
    const overlay = document.createElement("div");
    overlay.className = "reader-overlay";
    const supportedFormatsForModes = ["pdf", "cbz", "cbr", "telegram-pages"];
    const showModeSelector = supportedFormatsForModes.includes(format);
    overlay.innerHTML = `
      <div class="reader-top">
        <div class="reader-top-primary">
          <button class="small-btn" data-close-reader>← Voltar</button>
          <div class="reader-title">${escapeHTML(itemDisplayTitle(item))}</div>
          <button class="small-btn" data-reader-home>Início</button>
        </div>
        <div class="reader-top-reading">
          ${showModeSelector ? `
            <select class="small-btn" id="reading-mode-select" disabled>
              <option value="single-page" ${state.readingMode === 'single-page' ? 'selected' : ''}>Página por página</option>
              <option value="double-page" ${state.readingMode === 'double-page' ? 'selected' : ''}>
                Duas páginas
              </option>
              <option value="continuous-scroll" ${state.readingMode === 'continuous-scroll' ? 'selected' : ''}>Rolagem contínua</option>
            </select>
          ` : ''}
          <button class="small-btn" id="reading-direction-btn" style="display: ${showModeSelector && state.readingMode === 'double-page' ? 'inline-block' : 'none'};">
            ${state.readingDirection === 'eastern' ? '↔ Oriental' : '↔ Ocidental'}
          </button>
          ${showModeSelector ? `<button class="small-btn" data-toggle-cover>${skipCover ? 'Incluir capa' : 'Ignorar capa'}</button>` : ''}
          <button class="small-btn" data-toggle-grayscale>${readerGrayscale ? 'Cor normal' : 'Preto e branco'}</button>
          <button class="small-btn" data-reader-zoom>Zoom</button>
          ${state.session && !item.local ? `<button class="small-btn" data-toggle-read>${savedProgress?.completed ? 'Desmarcar como lida' : 'Marcar como lida'}</button>` : ''}
        </div>
        <div class="reader-top-actions">
          ${!state.session?.offline ? readerCustomLinksMarkup(item) : ""}
          ${state.profile?.plan === "admin" && !state.session?.offline ? `<button class="small-btn" data-open-external>Ver arquivo</button>` : ''}
        </div>
      </div>
      <div class="reader-body" id="reader-body"></div>
      <div class="reader-bottom-controls">
        <div class="reader-series-controls reader-series-prev" id="reader-series-prev"></div>
        <div class="reader-controls" id="reader-controls"><span class="reader-page">O primeiro carregamento costuma ser demorado.</span></div>
        <div class="reader-series-controls reader-series-next" id="reader-series-next"></div>
      </div>
      <div class="reader-footer">
        ${!item.local && !state.session?.offline && sb ? '<button type="button" class="reader-comments-toggle" data-reader-comments-toggle aria-expanded="false">＋ Comentários</button>' : '<span></span>'}
        <div class="reader-footer-actions">
          ${!state.session?.offline && characterNames(item)[0] ? `<button class="small-btn" data-browse-character="${escapeHTML(characterNames(item)[0])}">Ver personagem</button>` : ''}
          ${!state.session?.offline && item.publisher ? `<button class="small-btn" data-browse-publisher>Ver editora</button>` : ''}
          ${!item.local ? `<button class="small-btn reader-like-button ${state.comicLikeIds.has(item.id) ? "is-liked" : ""}" data-like-item="${escapeHTML(item.id)}">${state.comicLikeIds.has(item.id) ? "♥" : "♡"} ${state.comicLikeCounts.get(item.id) || 0}</button><button class="small-btn" data-share-item="${escapeHTML(item.id)}">Compartilhar</button>` : ""}
          ${item.seriesId ? `<button class="small-btn" data-view-series="${escapeHTML(item.seriesId)}">Série</button>` : ""}
          ${isAdminProfile() && !item.local && !state.session?.offline ? '<button class="small-btn" type="button" data-reader-edit>Editar</button>' : ''}
        </div>
        <div class="reader-comments" data-reader-comments-panel hidden></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const closeReaderButton = $("[data-close-reader]", overlay);
    const readerHomeButton = $("[data-reader-home]", overlay);
    let readerExitToHome = false;
    let removeReaderSwipeListeners = () => {};
    let readerSingleClickTimer = null;
    let readerAdControllerPromise = Promise.resolve(null);
    const cleanupReader = () => {
      if (activeReaderCleanup === cleanupReader) activeReaderCleanup = null;
      readerIsOpen = false;
      if (readerSingleClickTimer) window.clearTimeout(readerSingleClickTimer);
      readerSingleClickTimer = null;
      overlay._pdfDownloadController?.abort();
      overlay._cbzDownloadController?.abort();
      overlay._cbrDownloadController?.abort();
      overlay.remove();
      resumeCoverLoading();
      if (options.localObjectUrl) URL.revokeObjectURL(options.localObjectUrl);
      removeReaderSwipeListeners();
      void readerAdControllerPromise.then(controller => controller?.destroy()).catch(() => {});
    };
    activeReaderCleanup = cleanupReader;
    // Preserve the temporary Blob URL when the reader is re-opened for a
    // layout change. This is essential for files opened from offline storage.
    overlay._reopenReader = (nextOptions = {}) => {
      const localObjectUrl = options.localObjectUrl;
      options.localObjectUrl = null;
      activeReaderCleanup?.();
      openReader(item, {
        ...nextOptions,
        localObjectUrl,
        routeSync: true,
        grayscale: readerGrayscale
      });
    };
    closeReaderButton.onclick = () => {
      cleanupReader();
      if (item.local || options.standalone) {
        readerExitToHome = false;
        showEmptyReader(item.local
          ? "Arquivo fechado. Escolha outro arquivo do computador ou cole um link da Banca Digital."
          : "Edição fechada. Cole outro link da Banca Digital ou escolha um arquivo do computador.");
        return;
      }
      if (readerExitToHome) {
        readerExitToHome = false;
        navigate({ pagina: state.session?.offline ? "downloads" : "" }, true);
        return;
      }
      // A rota do leitor já foi adicionada ao histórico ao abrir o gibi.
      // Voltar de fato uma entrada evita que o botão Voltar gere um novo
      // histórico e depois reabra o leitor ao ser pressionado novamente.
      if (currentRouteHistoryIndex() > 0) window.history.back();
      else navigate({ pagina: state.session?.offline ? "downloads" : "" }, true);
    };
    readerHomeButton.onclick = () => {
      readerExitToHome = true;
      closeReaderButton.click();
    };
    $("[data-like-item]", overlay)?.addEventListener("click", event => { event.stopPropagation(); toggleComicLike(item.id); });
    $("[data-share-item]", overlay)?.addEventListener("click", event => { event.stopPropagation(); shareComic(item.id); });
    $("[data-comment-item]", overlay)?.addEventListener("click", event => { event.stopPropagation(); openCommentsPopup(item); });
    $("[data-view-series]", overlay)?.addEventListener("click", event => {
      event.stopPropagation();
      const editions = seriesEditions(item);
      cleanupReader();
      setSection("home");
      openSeriesSelection(item, editions, false, false, item);
    });
    $$('[data-reader-custom-link]', overlay).forEach(button => button.addEventListener("click", () => window.open(button.dataset.readerCustomLink, "_blank", "noopener")));
    $("[data-open-external]", overlay)?.addEventListener("click", () => window.open(resolvedUrl, "_blank", "noopener"));
    $("[data-reader-edit]", overlay)?.addEventListener("click", event => {
      event.stopPropagation();
      openEditForm(item.id);
    });
    $("[data-toggle-cover]", overlay)?.addEventListener("click", () => {
      const nextSkipCover = !skipCover;
      if (state.session?.user?.id) saveSkipCoverPreference(nextSkipCover);
      const localObjectUrl = options.localObjectUrl;
      options.localObjectUrl = null;
      cleanupReader();
      openReader(item, { skipCover: nextSkipCover, localObjectUrl, routeSync: true, grayscale: readerGrayscale });
    });

    $("[data-toggle-grayscale]", overlay)?.addEventListener("click", event => {
      readerGrayscale = !readerGrayscale;
      body.classList.toggle("reader-grayscale", readerGrayscale);
      event.currentTarget.textContent = readerGrayscale ? "Cor normal" : "Preto e branco";
    });
    $$('[data-browse-character]', overlay).forEach(button => button.addEventListener("click", () => { overlay.remove(); openEntityPage("character", button.dataset.browseCharacter); }));
    $("[data-browse-publisher]", overlay)?.addEventListener("click", () => { overlay.remove(); openEntityPage("publisher", item.publisher); });

    const body = $("#reader-body", overlay);
    const controls = $("#reader-controls", overlay);
    if (!item.local && !state.session?.offline && sb) {
      readerAdControllerPromise = loadReaderAdsFeature()
        .then(feature => feature.createReaderController(item, body))
        .catch(error => { console.warn("Propagandas do leitor indisponíveis:", error); return null; });
    }
    body.addEventListener("contextmenu", async event => {
      if (!event.target.closest("img.reader-image")) return;
      event.preventDefault();

      try {
        const imageUrl = new URL("assets/Baixarpaginas.jpg", BANCADIGITAL_BASE).href;
        const response = await fetch(imageUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const imageBlob = await response.blob();
        const downloadUrl = URL.createObjectURL(new Blob([imageBlob], { type: "image/jpeg" }));
        const downloadLink = document.createElement("a");
        downloadLink.href = downloadUrl;
        downloadLink.download = "Baixarpaginas.jpg";
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      } catch (error) {
        console.warn("Não foi possível baixar a imagem de proteção:", error);
        toast("Não foi possível baixar a imagem de proteção.");
      }
    });
    body.classList.toggle("reader-page-swipe", ["single-page", "double-page"].includes(state.readingMode));
    const toggleReadButton = $("[data-toggle-read]", overlay);
    if (toggleReadButton) toggleReadButton.disabled = true;
    const markReaderReady = () => { if (toggleReadButton) toggleReadButton.disabled = false; };
    let readerReadyObserver = null;
    if (toggleReadButton && "MutationObserver" in window) {
      readerReadyObserver = new MutationObserver(() => {
        if (body.querySelector("canvas, img, .image-continuous-scroll-container, .pdf-continuous-scroll-container, .reader-double-page")) {
          markReaderReady();
          readerReadyObserver.disconnect();
          readerReadyObserver = null;
        }
      });
      readerReadyObserver.observe(body, { childList: true, subtree: true });
    }
    toggleReadButton?.addEventListener("click", event => {
      const completed = toggleReadingCompleted(item, progressFor(item)?.total_pages || 1);
      event.currentTarget.textContent = completed ? "Desmarcar como lida" : "Marcar como lida";
    });
    overlay._readerNavigate = direction => {
      const button = direction > 0 ? $("[data-next]", controls) : $("[data-prev]", controls);
      if (button && !button.disabled) button.click();
    };
    const toggleReaderChrome = () => overlay.classList.toggle("reader-immersive");
    const readerZoomButton = $("[data-reader-zoom]", overlay);
    let readerZoom = 1;
    const READER_DEFAULT_ZOOM = 1;
    const READER_BUTTON_ZOOM = 2;
    let readerZoomOrigin = { x: "50%", y: "50%" };
    let readerPan = { x: 0, y: 0 };
    let readerPanPointer = null;
    let lastReaderZoomAt = 0;
    const setReaderZoom = (nextZoom, origin = readerZoomOrigin) => {
      readerZoom = Math.max(1, Math.min(3, nextZoom));
      readerZoomOrigin = origin;
      if (readerZoom === READER_DEFAULT_ZOOM) readerPan = { x: 0, y: 0 };
      body.style.setProperty("--reader-zoom", String(readerZoom));
      body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
      body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
      body.style.setProperty("--reader-origin-x", origin.x);
      body.style.setProperty("--reader-origin-y", origin.y);
      body.classList.toggle("reader-gesture-zoom", readerZoom > 1);
      readerZoomButton.textContent = readerZoom > 1 ? `Zoom ${Math.round(readerZoom * 100)}%` : "Zoom";
    };
    const toggleReaderZoom = (origin = readerZoomOrigin) => {
      lastReaderZoomAt = Date.now();
      lastReaderClickAt = 0;
      if (readerSingleClickTimer) {
        window.clearTimeout(readerSingleClickTimer);
        readerSingleClickTimer = null;
      }
      setReaderZoom(readerZoom >= READER_BUTTON_ZOOM ? READER_DEFAULT_ZOOM : READER_BUTTON_ZOOM, origin);
      overlay.classList.add("reader-immersive");
    };
    readerZoomButton.onclick = () => toggleReaderZoom();
    let readerSwipe = null;
    let suppressReaderClick = false;
    let lastReaderClickAt = 0;
    let ignoreReaderClicksUntil = 0;
    const activeReaderPointers = new Map();
    let readerPinchStart = null;
    let lastReaderTap = 0;
    let readerTap = null;
    const readerZoomOriginAt = (clientX, clientY) => {
      const rect = body.getBoundingClientRect();
      return { x: `${Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))}%`, y: `${Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100))}%` };
    };
    const readerPointerDistance = () => {
      const points = [...activeReaderPointers.values()];
      return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    const readerPointerCenter = () => {
      const points = [...activeReaderPointers.values()];
      return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    };
    const onReaderPointerDown = event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target.closest("button, a, select, textarea, input")) return;
      activeReaderPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      body.setPointerCapture?.(event.pointerId);
      if (activeReaderPointers.size === 2) {
        readerPanPointer = null;
        readerSwipe = null;
        readerTap = null;
        readerPinchStart = { distance: readerPointerDistance(), zoom: readerZoom };
        ignoreReaderClicksUntil = Date.now() + 600;
        body.classList.add("reader-panning");
        event.preventDefault();
        return;
      }
      if (readerZoom > 1) {
        readerPanPointer = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: readerPan.x, startY: readerPan.y };
        body.setPointerCapture?.(event.pointerId);
        body.classList.add("reader-panning");
        event.preventDefault();
        return;
      }
      readerTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      if (!["single-page", "double-page"].includes(state.readingMode)) return;
      readerSwipe = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onReaderPointerMove = event => {
      if (activeReaderPointers.has(event.pointerId)) activeReaderPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (readerPinchStart && activeReaderPointers.size >= 2) {
        const distance = readerPointerDistance();
        const center = readerPointerCenter();
        const rect = body.getBoundingClientRect();
        if (distance > 0 && rect.width && rect.height) {
          setReaderZoom(readerPinchStart.zoom * distance / readerPinchStart.distance, {
            x: `${((center.x - rect.left) / rect.width) * 100}%`,
            y: `${((center.y - rect.top) / rect.height) * 100}%`
          });
          event.preventDefault();
        }
        return;
      }
      if (readerPanPointer && event.pointerId === readerPanPointer.pointerId) {
        readerPan = {
          x: readerPanPointer.startX + event.clientX - readerPanPointer.x,
          y: readerPanPointer.startY + event.clientY - readerPanPointer.y
        };
        body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
        body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
        body.classList.add("reader-panning");
        event.preventDefault();
        return;
      }
      if (!readerSwipe || event.pointerId !== readerSwipe.pointerId) return;
      const dx = event.clientX - readerSwipe.x;
      const dy = event.clientY - readerSwipe.y;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        event.preventDefault();
        body.setPointerCapture?.(event.pointerId);
      }
    };
    const finishReaderSwipeAt = (clientX, clientY) => {
      if (!readerSwipe) return;
      const swipe = readerSwipe;
      readerSwipe = null;
      const distance = clientX - swipe.x;
      const verticalDistance = Math.abs(clientY - swipe.y);
      if (Math.abs(distance) < 45 || Math.abs(distance) <= verticalDistance) return;
      suppressReaderClick = true;
      window.setTimeout(() => { suppressReaderClick = false; }, 500);
      overlay._readerNavigate?.(distance < 0 ? 1 : -1);
    };
    const finishReaderSwipe = event => {
      activeReaderPointers.delete(event.pointerId);
      if (readerPanPointer && event.pointerId === readerPanPointer.pointerId) {
        readerPanPointer = null;
        body.classList.remove("reader-panning");
        body.releasePointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      if (readerPinchStart) {
        if (activeReaderPointers.size < 2) {
          readerPinchStart = null;
          ignoreReaderClicksUntil = Date.now() + 600;
          body.classList.remove("reader-panning");
        }
        body.releasePointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      const tap = readerTap;
      readerTap = null;
      if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 20) {
        const now = Date.now();
        if (now - lastReaderTap < 320) {
          suppressReaderClick = true;
          toggleReaderZoom(readerZoomOriginAt(event.clientX, event.clientY));
          lastReaderTap = 0;
        } else {
          lastReaderTap = now;
        }
        readerSwipe = null;
        return;
      }
      if (!readerSwipe || event.pointerId !== readerSwipe.pointerId) return;
      event.preventDefault();
      body.releasePointerCapture?.(event.pointerId);
      const now = Date.now();
      if (event.pointerType !== "mouse" && now - lastReaderTap < 320) {
        readerSwipe = null;
        suppressReaderClick = true;
        toggleReaderZoom(readerZoomOriginAt(event.clientX, event.clientY));
        lastReaderTap = 0;
        return;
      }
      lastReaderTap = now;
      finishReaderSwipeAt(event.clientX, event.clientY);
    };
    const onReaderTouchStart = event => {
      if (!["single-page", "double-page"].includes(state.readingMode) || event.touches.length !== 1) return;
      if (readerZoom > 1) return;
      if (event.target.closest("button, a, select, textarea, input")) return;
      const touch = event.touches[0];
      readerSwipe = { pointerId: null, x: touch.clientX, y: touch.clientY };
    };
    const onReaderTouchMove = event => {
      if (readerZoom > 1 && readerPanPointer && event.touches.length === 1) {
        const touch = event.touches[0];
        readerPan = {
          x: readerPanPointer.startX + touch.clientX - readerPanPointer.x,
          y: readerPanPointer.startY + touch.clientY - readerPanPointer.y
        };
        body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
        body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
        event.preventDefault();
        return;
      }
      if (!readerSwipe || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - readerSwipe.x;
      const dy = touch.clientY - readerSwipe.y;
      if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
    };
    const onReaderTouchEnd = event => {
      if (!readerSwipe) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      finishReaderSwipeAt(touch.clientX, touch.clientY);
    };
    const onReaderMouseDown = event => {
      if (event.button !== 0 || !["single-page", "double-page"].includes(state.readingMode)) return;
      if (readerZoom > 1) return;
      if (event.target.closest("button, a, select, textarea, input")) return;
      readerSwipe = { pointerId: null, x: event.clientX, y: event.clientY };
    };
    const onReaderMouseMove = event => {
      if (readerZoom > 1 && readerPanPointer) {
        readerPan = {
          x: readerPanPointer.startX + event.clientX - readerPanPointer.x,
          y: readerPanPointer.startY + event.clientY - readerPanPointer.y
        };
        body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
        body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
        event.preventDefault();
        return;
      }
      if (!readerSwipe) return;
      const dx = event.clientX - readerSwipe.x;
      const dy = event.clientY - readerSwipe.y;
      if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
    };
    const onReaderMouseUp = event => {
      if (!readerSwipe) return;
      event.preventDefault();
      finishReaderSwipeAt(event.clientX, event.clientY);
    };
    const cancelReaderSwipe = () => { readerSwipe = null; readerTap = null; readerPanPointer = null; body.classList.remove("reader-panning"); activeReaderPointers.clear(); readerPinchStart = null; };
    const preventReaderDrag = event => event.preventDefault();
    body.addEventListener("pointerdown", onReaderPointerDown);
    body.addEventListener("pointermove", onReaderPointerMove, { passive: false });
    body.addEventListener("pointerup", finishReaderSwipe);
    body.addEventListener("pointercancel", cancelReaderSwipe);
    body.addEventListener("dragstart", preventReaderDrag);
    body.addEventListener("touchstart", onReaderTouchStart, { passive: true });
    body.addEventListener("touchmove", onReaderTouchMove, { passive: false });
    body.addEventListener("touchend", onReaderTouchEnd, { passive: false });
    body.addEventListener("mousedown", onReaderMouseDown);
    document.addEventListener("mousemove", onReaderMouseMove, { passive: false });
    document.addEventListener("mouseup", onReaderMouseUp, { passive: false });
    removeReaderSwipeListeners = () => {
      body.removeEventListener("pointerdown", onReaderPointerDown);
      body.removeEventListener("pointermove", onReaderPointerMove);
      body.removeEventListener("pointerup", finishReaderSwipe);
      body.removeEventListener("pointercancel", cancelReaderSwipe);
      body.removeEventListener("dragstart", preventReaderDrag);
      body.removeEventListener("touchstart", onReaderTouchStart);
      body.removeEventListener("touchmove", onReaderTouchMove);
      body.removeEventListener("touchend", onReaderTouchEnd);
      body.removeEventListener("mousedown", onReaderMouseDown);
      document.removeEventListener("mousemove", onReaderMouseMove);
      document.removeEventListener("mouseup", onReaderMouseUp);
    };
    body.addEventListener("click", event => {
      const now = Date.now();
      if (now < ignoreReaderClicksUntil) {
        lastReaderClickAt = 0;
        return;
      }
      const isDoubleReaderClick = event.detail >= 2 || (now - lastReaderClickAt > 0 && now - lastReaderClickAt < 360);
      if (isDoubleReaderClick) {
        if (readerSingleClickTimer) {
          window.clearTimeout(readerSingleClickTimer);
          readerSingleClickTimer = null;
        }
        lastReaderClickAt = 0;
        if (suppressReaderClick) {
          suppressReaderClick = false;
          return;
        }
        toggleReaderZoom(readerZoomOriginAt(event.clientX, event.clientY));
        return;
      }
      lastReaderClickAt = now;
      if (suppressReaderClick) {
        suppressReaderClick = false;
        return;
      }
      if (event.target.closest("button, a, select, textarea")) {
        return;
      }
      if (readerSingleClickTimer) {
        window.clearTimeout(readerSingleClickTimer);
        readerSingleClickTimer = null;
        return;
      }
      readerSingleClickTimer = window.setTimeout(() => {
        readerSingleClickTimer = null;
        toggleReaderChrome();
      }, 280);
    });
    const onReaderKeydown = event => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      overlay._readerNavigate?.(direction);
    };
    document.addEventListener("keydown", onReaderKeydown);
    $("[data-close-reader]", overlay).addEventListener("click", () => document.removeEventListener("keydown", onReaderKeydown), { once: true });
    attachComments(item, overlay);
    body.classList.toggle("reader-grayscale", readerGrayscale);
    const seriesObserver = new MutationObserver(() => appendSeriesNavigation(item, controls, overlay));
    overlay._seriesObserver = seriesObserver;
    seriesObserver.observe(controls, { childList: true });
    appendSeriesNavigation(item, controls, overlay);
    $("[data-close-reader]", overlay).addEventListener("click", () => seriesObserver.disconnect(), { once: true });

    const directionButton = $("#reading-direction-btn", overlay);
    if (directionButton) {
      directionButton.onclick = () => {
        const newDirection = state.readingDirection === "western" ? "eastern" : "western";
        setReadingDirection(newDirection);
        directionButton.textContent = newDirection === "eastern" ? "↔ Oriental" : "↔ Ocidental";

        // If in double-page mode, re-render to apply the change
        if (state.readingMode === "double-page") {
          overlay._reopenReader?.({ skipCover });
        }
      };
    }


    const startReader = async () => {
      body.innerHTML = readerLoadingMarkup("Abrindo edição…");
      const isImage = ["jpg", "jpeg", "png", "webp", "gif"].includes(format) || format === "telegram-pages";
      let selectedIndex = 0;
      if (!item.local && sourceCandidates.length && !isImage) {
        selectedIndex = -1;
        for (let index = 0; index < sourceCandidates.length; index += 1) {
          if (await probeReaderSource(sourceCandidates[index])) { selectedIndex = index; break; }
          if (index === 0) {
            const fallback = sourceCandidates[1] || "nenhuma fonte reserva cadastrada";
            await reportFileFailure(item, `A fonte principal falhou ao abrir. O leitor tentou uma fonte reserva: ${fallback}`, { silent: true, automatic: true, failedUrl: sourceCandidates[0], fallbackUrl: sourceCandidates[1] });
          }
        }
        if (selectedIndex < 0) {
          body.innerHTML = `<div class="empty" style="margin:auto;max-width:650px"><h3>Arquivo indisponível</h3><p>A fonte não entregou o arquivo ao leitor. Verifique o link da edição ou relate o problema aos moderadores.</p><button class="btn btn-primary" data-report-file>Relatar arquivo</button></div>`;
          controls.innerHTML = `<span class="reader-page">${escapeHTML(format.toUpperCase())}</span>`;
          $(`[data-report-file]`, body).onclick = () => reportFileFailure(item, "O arquivo não foi encontrado na fonte cadastrada.");
          return;
        }
        resolvedUrl = sourceCandidates[selectedIndex] || resolvedUrl;
      }
      const selectedFormat = telegramPagesMode ? "telegram-pages" : (item.local ? format : String(item.format || format).toLowerCase());
      if (["pdf", "cbz", "cbr"].includes(selectedFormat)) await ensureReaderDependency(selectedFormat);
      const callback = (...args) => {
        markReaderReady();
        saveReadingProgress(...args);
        const page = Number(args[1]) || 0;
        const total = Number(args[2]) || 0;
        void readerAdControllerPromise.then(controller => controller?.onPageChange(page, total)).catch(() => {});
      };
      if (selectedFormat === "telegram-pages") {
        await renderTelegramPagesReader(item, body, controls, overlay, skipCover, resumePage, callback);
      } else if (selectedFormat === "pdf" || resolvedUrl.toLowerCase().split("?")[0].endsWith(".pdf")) {
        await renderPDFReader(item, resolvedUrl, body, controls, overlay, skipCover, resumePage, callback, selectedIndex === 0 ? prefetchedBuffer : null);
      } else if (selectedFormat === "cbz" || resolvedUrl.toLowerCase().split("?")[0].endsWith(".cbz")) {
        await renderCBZReader(item, resolvedUrl, body, controls, overlay, skipCover, resumePage, callback, selectedIndex === 0 ? prefetchedBuffer : null);
      } else if (selectedFormat === "cbr" || resolvedUrl.toLowerCase().split("?")[0].endsWith(".cbr")) {
        await renderCBRReader(item, resolvedUrl, body, controls, overlay, skipCover, resumePage, callback, selectedIndex === 0 ? prefetchedBuffer : null);
      }
    };
    if (format === "pdf" || format === "cbz" || format === "cbr" || format === "telegram-pages") {
      void startReader().then(markReaderReady).catch(() => {});
    } else if (["jpg","jpeg","png","webp","gif"].includes(format)) {
      body.innerHTML = readerLoadingMarkup("Abrindo imagem…");
      const image = document.createElement("img");
      image.className = "reader-image";
      image.alt = "";
      image.style.display = "none";
      body.appendChild(image);
      const readerImage = $(".reader-image", body);
      if (readerImage) {
        readerImage.loading = "eager";
        readerImage.fetchPriority = "high";
        readerImage.addEventListener("load", () => {
          body.querySelector(".reader-loading")?.remove();
          readerImage.style.removeProperty("display");
          markReaderReady();
        }, { once: true });
        readerImage.addEventListener("error", async () => {
          if (sourceCandidates.length && readerImage.dataset.backupTried !== "true") {
            readerImage.dataset.backupTried = "true";
            const fallback = sourceCandidates[1] || "nenhuma fonte reserva cadastrada";
            await reportFileFailure(item, `A fonte principal da imagem falhou ao abrir. O leitor tentou uma fonte reserva: ${fallback}`, { silent: true, automatic: true, failedUrl: sourceCandidates[0], fallbackUrl: sourceCandidates[1] });
            if (sourceCandidates[1]) { readerImage.src = sourceCandidates[1]; return; }
          }
          body.innerHTML = `<div class="empty" style="margin:auto;max-width:650px"><h3>Não foi possível abrir esta imagem.</h3><p>O arquivo não abriu. Relate o problema aos moderadores do site para que ele seja verificado.</p><button class="btn btn-primary" data-report-file>Relatar arquivo</button></div>`;
          controls.innerHTML = `<span class="reader-page">Imagem</span>`;
          $("[data-report-file]", body).onclick = () => reportFileFailure(item, "A imagem não abriu no leitor.");
        }, { once: true });
        readerImage.src = resolvedUrl;
      }
      controls.innerHTML = `<span class="reader-page">Imagem</span>`;
      saveReadingProgress(item, 1, 1);
      void readerAdControllerPromise.then(controller => controller?.onPageChange(1, 1)).catch(() => {});
    } else if (item.seriesUrl && !item.fileUrl && !item.telegramUrl) {
      body.innerHTML = `
        <div class="empty" style="margin:auto;max-width:650px">
          <h3>Catálogo externo</h3>
          <p>Esta entrada possui metadados, mas ainda não possui o link individual do arquivo.</p>
          <button class="btn btn-primary" data-open-series>Abrir página da série</button>
        </div>`;
      $(`[data-open-series]`, body).onclick = () => window.open(item.seriesUrl, "_blank", "noopener");
      controls.innerHTML = `<span class="reader-page">LINK EXTERNO</span>`;
    } else {
      const title = "Formato não suportado no leitor";
      const message = `O formato "${escapeHTML(format.toUpperCase())}" não pôde ser aberto pelo leitor. Relate o problema aos moderadores do site para que o arquivo seja verificado.`;
      body.innerHTML = `
        <div class="empty" style="margin:auto;max-width:650px">
          <h3>${escapeHTML(title)}</h3>
          <p>${escapeHTML(message)}</p><button class="btn btn-primary" data-report-file>Relatar arquivo</button>
        </div>`;
      controls.innerHTML = `<span class="reader-page">${escapeHTML(format.toUpperCase())}</span>`;
      $("[data-report-file]", body).onclick = () => reportFileFailure(item, message);
    }
  }

bootStandaloneReader();
